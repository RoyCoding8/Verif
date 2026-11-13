#!/usr/bin/env node
import { lstat, readFile, realpath } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { digest, hash, makeContract, planVerification, requireThat, safePath } from './contracts.mjs';
import { reviseApprovedTask } from './delegation-policy.mjs';
import { Journal } from './journal.mjs';
import { proposeTask } from './planner.mjs';
import { verifyRefinement } from './refinement-proof.mjs';
import { authorizeSemanticRevision } from './semantic-delegation.mjs';
import { inspectRun, recoverOperation, runTasks } from './verity.mjs';

const usage = 'Usage: verity propose <manifest> | plan <manifest> | delegate <manifest> <proposed-task.json> | refinement <manifest> <witness-request.json> | run <manifest> | status <manifest> | requeue <manifest> <task> | receipt <manifest> <operation> | cancel <manifest> <attempt> | recover <manifest> <operation> [--abandon]';

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
  requireThat(filename && ['propose', 'plan', 'delegate', 'refinement', 'run', 'status', 'requeue', 'receipt', 'cancel', 'recover'].includes(command) && !rest.length, usage);
  requireThat(['propose', 'plan', 'run', 'status'].includes(command) ? !id : id, usage);
  requireThat(option === undefined || (command === 'recover' && option === '--abandon'), usage);
  const manifest = JSON.parse(await readFile(filename, 'utf8'));
  const directory = dirname(resolve(filename));
  const oracleRoot = resolve(directory, manifest.oracles ?? 'oracles');
  const scratch = resolve(directory, manifest.scratch ?? '.verity');
  if (command === 'delegate') {
    const input = JSON.parse(await readFile(id, 'utf8'));
    requireThat(input && typeof input === 'object', 'Invalid delegation request');
    const proposal = input.task ?? input;
    requireThat(Array.isArray(manifest.tasks), 'Missing approved tasks');
    const matching = manifest.tasks.filter(task => task.id === proposal?.id);
    requireThat(matching.length === 1, 'Expected one approved predecessor for the proposed task');
    if (input.witness) {
      const controller = new AbortController();
      const interrupt = () => controller.abort(new Error('Interrupted'));
      process.once('SIGINT', interrupt);
      try {
        return await authorizeSemanticRevision({ parent: matching[0], proposal, claim: input.witness.claim,
          solution: input.witness.solution, oracleRoot, scratch, signal: controller.signal });
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
    journalPath: resolve(directory, manifest.journal ?? '.verity/journal.sqlite'),
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
