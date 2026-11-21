#!/usr/bin/env node
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { lstat, mkdir, readFile, realpath } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { approvedTask, digest, hash, makeContract, planVerification, requireThat, safePath } from './contracts.mjs';
import { reviseApprovedTask } from './delegation-policy.mjs';
import { GitRepo } from './git.mjs';
import { Journal } from './journal.mjs';
import { proposeTask } from './planner.mjs';
import { createPromotionAttestation, verifyPromotionAttestation } from './promotion-attestation.mjs';
import { verifyRefinement } from './refinement-proof.mjs';
import { authorizeSemanticRevision } from './semantic-delegation.mjs';
import { inspectRun, recoverOperation, runTasks } from './verity.mjs';

const usage = 'Usage: verity propose <manifest> | plan <manifest> | delegate <manifest> <proposed-task.json> | refinement <manifest> <witness-request.json> | run <manifest> | status <manifest> | requeue <manifest> <task> | receipt <manifest> <operation> | cancel <manifest> <attempt> | revoke <manifest> <approval-digest> | recover <manifest> <operation> [--abandon]\n' +
  '       verity attest <manifest> <operation> <private-key.pem> | verify-attestation <repository> <commit> <envelope.json> <public-key.pem>';

async function checkAttestation([repository, expectedCommit, envelopeFile, publicKeyFile, ...extra]) {
  requireThat(repository && expectedCommit && envelopeFile && publicKeyFile && !extra.length, usage);
  const stats = await lstat(envelopeFile);
  requireThat(stats.isFile() && stats.size <= 2 * 1024 * 1024, 'Invalid or oversized attestation envelope');
  const envelope = JSON.parse(await readFile(envelopeFile, 'utf8'));
  const publicKey = createPublicKey(await readFile(publicKeyFile));
  return verifyPromotionAttestation({ repo: new GitRepo(resolve(repository)), envelope, publicKey, expectedCommit });
}

async function requireDelegationAuthority(journalPath, parent) {
  requireThat(Date.now() < (parent.contract.policy.validUntilMs ?? Infinity), 'Predecessor approval expired');
  try {
    await lstat(journalPath);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  const journal = new Journal(journalPath);
  try {
    requireThat(!journal.isApprovalRevoked(parent.approval), 'Predecessor approval revoked');
  } finally {
    journal.close();
  }
}

async function checkRefinement(settings, entries, filename) {
  const requestFile = await lstat(filename);
  requireThat(requestFile.isFile() && requestFile.size <= 2 * 1024 * 1024, 'Invalid or oversized witness request');
  const request = JSON.parse(await readFile(filename, 'utf8'));
  requireThat(Array.isArray(entries) && typeof request?.id === 'string', 'Missing approved refinement');
  const matches = entries.filter(entry => entry.id === request.id);
  requireThat(matches.length === 1, 'Expected one approved refinement for ' + request.id);
  const { contract, approvedDigest, source, timeoutMs } = matches[0];
  requireThat(safePath(source) && source.endsWith('.lean'), 'Invalid approved Lean definitions path');
  const root = await realpath(settings.oracleRoot);
  const file = resolve(root, source);
  requireThat(relative(root, await realpath(file)) === source.split('/').join(sep), 'Refinement definitions must resolve to their approved path');
  const info = await lstat(file);
  requireThat(info.isFile() && info.size <= 2 * 1024 * 1024, 'Invalid or oversized refinement definitions');
  const bytes = await readFile(file);
  requireThat(hash(bytes) === contract?.definitionDigest, 'Refinement definitions digest changed');
  const trustedDefinitions = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  const controller = new AbortController();
  const interrupt = () => controller.abort(new Error('Interrupted'));
  process.once('SIGINT', interrupt);
  let result;
  try {
    result = await verifyRefinement({ contract, approvedDigest, trustedDefinitions,
      solution: request.solution, timeoutMs, scratch: settings.scratch, signal: controller.signal });
  } finally {
    process.off('SIGINT', interrupt);
  }
  if (!result.accepted) process.exitCode = 1;
  return result;
}

async function main() {
  const [command, filename, id, option, ...rest] = process.argv.slice(2);
  if (command === '--help' || command === '-h') {
    console.log(usage);
    return;
  }
  if (command === 'verify-attestation') return checkAttestation([filename, id, option, ...rest]);
  requireThat(filename && ['propose', 'plan', 'delegate', 'refinement', 'run', 'status', 'requeue', 'receipt', 'cancel', 'revoke', 'recover', 'attest'].includes(command) && !rest.length, usage);
  requireThat(['propose', 'plan', 'run', 'status'].includes(command) ? !id : id, usage);
  requireThat(command === 'attest' ? option : option === undefined || (command === 'recover' && option === '--abandon'), usage);
  const manifest = JSON.parse(await readFile(filename, 'utf8'));
  const directory = dirname(resolve(filename));
  const oracleRoot = resolve(directory, manifest.oracles ?? 'oracles');
  const scratch = resolve(directory, manifest.scratch ?? '.verity');
  const journalPath = resolve(directory, manifest.journal ?? '.verity/journal.sqlite');
  if (command === 'revoke') {
    await mkdir(dirname(journalPath), { recursive: true });
    const journal = new Journal(journalPath);
    try {
      return journal.revokeApproval(id);
    } finally {
      journal.close();
    }
  }
  if (command === 'delegate') {
    const input = JSON.parse(await readFile(id, 'utf8'));
    requireThat(input && typeof input === 'object', 'Invalid delegation request');
    const proposal = input.task ?? input;
    requireThat(Array.isArray(manifest.tasks), 'Missing approved tasks');
    const matching = manifest.tasks.filter(task => task.id === proposal?.id);
    requireThat(matching.length === 1, 'Expected one approved predecessor for the proposed task');
    const parent = approvedTask(matching[0]);
    await requireDelegationAuthority(journalPath, parent);
    if (input.witness) {
      const controller = new AbortController();
      const interrupt = () => controller.abort(new Error('Interrupted'));
      process.once('SIGINT', interrupt);
      try {
        const result = await authorizeSemanticRevision({ parent: matching[0], proposal, claim: input.witness.claim,
          solution: input.witness.solution, oracleRoot, scratch, signal: controller.signal });
        await requireDelegationAuthority(journalPath, parent);
        return result;
      } finally {
        process.off('SIGINT', interrupt);
      }
    }
    return reviseApprovedTask(matching[0], proposal);
  }
  if (command === 'plan') {
    requireThat(Array.isArray(manifest.tasks) && manifest.tasks.length > 0, 'Missing tasks');
    return manifest.tasks.map(task => {
      const plan = planVerification(task);
      const contract = makeContract(task, plan);
      return { id: contract.id, approval: digest(contract), contract, plan };
    });
  }
  if (command === 'refinement') return checkRefinement({ oracleRoot, scratch }, manifest.refinements, id);
  const settings = {
    repository: resolve(directory, manifest.repository),
    journalPath,
    oracleRoot,
    scratch,
    tasks: manifest.tasks,
    maxWorkers: manifest.maxWorkers,
    orthogonalOnly: manifest.orthogonalOnly,
  };
  if (command === 'propose') {
    requireThat(Array.isArray(manifest.tasks) && manifest.tasks.length > 0, 'Missing tasks');
    const proposals = [];
    for (const draft of manifest.tasks) proposals.push(await proposeTask({ ...settings, draft }));
    return proposals;
  }
  if (command === 'run') {
    const controller = new AbortController();
    process.once('SIGINT', () => controller.abort(new Error('Interrupted')));
    const results = await runTasks({
      ...settings, signal: controller.signal,
      onEvent: event => console.error(JSON.stringify(event)),
    });
    if (results.some(result => result.status !== 'promoted')) process.exitCode = 1;
    return results;
  }
  if (command === 'status' || command === 'requeue') return inspectRun({ ...settings, requeue: id });
  if (command === 'recover') return recoverOperation({ ...settings, operation: id, abandon: option === '--abandon' });
  const journal = new Journal(settings.journalPath);
  try {
    if (command === 'cancel') {
      journal.invalidate(id);
      return journal.authority(id);
    }
    const operation = journal.getOperation(id);
    requireThat(operation, 'Unknown operation ' + id);
    if (command === 'attest') {
      const repository = await realpath(settings.repository);
      requireThat(operation.receipt.repository === repository, 'Operation does not belong to this repository');
      const privateKey = createPrivateKey(await readFile(option));
      return createPromotionAttestation({ repo: new GitRepo(repository), operation, privateKey });
    }
    return operation;
  } finally {
    journal.close();
  }
}

try {
  const result = await main();
  if (result !== undefined) console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
