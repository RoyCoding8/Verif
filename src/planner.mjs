import { randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { digest, hash, makeContract, planVerification, requireThat, safePath, text } from './contracts.mjs';
import { GitRepo } from './git.mjs';
import { runPiWorker } from './pi-worker.mjs';

async function catalogFor(root, files) {
  requireThat(Array.isArray(files) && files.length > 0 && files.every(safePath) &&
    new Set(files).size === files.length, 'Supply unique approved oracleFiles');
  const canonicalRoot = await realpath(root);
  return new Map(await Promise.all(files.map(async file => {
    const path = join(canonicalRoot, file);
    requireThat(file.endsWith('.json') && relative(canonicalRoot, await realpath(path)) === file.split('/').join(sep),
      'Oracle must resolve to its approved path: ' + file);
    const stats = await lstat(path);
    requireThat(stats.isFile() && stats.size < 2 * 1024 * 1024, 'Invalid oracle file ' + file);
    const bytes = await readFile(path);
    const records = JSON.parse(bytes.toString('utf8'));
    requireThat(Array.isArray(records) && records.length > 0 && records.every(record => text(record?.id)), 'Missing oracle cases');
    const inputs = records.map(({ id, module, name, args }) => ({ id, module, name, args }));
    return [file, { file, digest: hash(bytes), cases: records.map(record => record.id), inputs }];
  })));
}

export async function proposeTask({ repository, oracleRoot, scratch, draft, worker = runPiWorker, signal }) {
  requireThat(text(draft?.goal) && Array.isArray(draft.scope?.read) && draft.scope.read.every(safePath) &&
    Array.isArray(draft.scope?.forbidden) && draft.scope.forbidden.every(safePath) &&
    text(draft.policy?.ref), 'Planner requires a goal, path scope, and target ref');
  const catalog = await catalogFor(oracleRoot, draft.oracleFiles);
  const repo = new GitRepo(resolve(repository));
  const base = draft.base && draft.base !== 'head-at-dispatch' ? draft.base : repo.readRef(draft.policy.ref);
  requireThat(base, 'Cannot find a base for the planning checkout');
  const scratchRoot = resolve(scratch);
  await mkdir(scratchRoot, { recursive: true });
  const temporary = await mkdtemp(join(scratchRoot, 'plan-'));
  const workspace = join(temporary, 'worker');
  const output = 'verity-plan-' + randomUUID() + '.json';
  const timer = AbortSignal.timeout(120_000);
  const stop = signal ? AbortSignal.any([timer, signal]) : timer;
  try {
    repo.fork(base, workspace);
    const instructions = [
      'Propose a verification plan for this goal. Write JSON to ' + output + '.',
      'Do not edit implementation files. Proposed claims need meaningful coverage and an approved oracle.',
      'Return an object with criteria [{id,description,claims:[claimId]}], claims [{id,statement,required,domain?,dependencies?:[{claim,statement}]}],',
      'and obligations [{id,claim,subject,expect,witness?,method?,oracleFile,outputs?,timeoutMs}].',
      'Use node-test for sampled claims or finite-domain for a complete Cartesian product. For a finite domain, supply domain: {module,name,axes:[allowedValuesForArg1,allowedValuesForArg2,...]}. The subject can be candidate or base.',
      'The plan needs a positive candidate obligation for each claim. A FAIL obligation must name its expected failing case ID.',
      'Supported optional output: cases.json. Budget in milliseconds: ' + draft.policy.budgetMs + '.',
      'Approved oracle choices and inputs: ' + JSON.stringify([...catalog.values()].map(({ file, inputs }) => ({ file, inputs }))),
      'Goal: ' + draft.goal,
    ];
    await worker({
      workspace, goal: instructions.join('\n'), signal: stop,
      scope: { read: draft.scope.read, write: [output], forbidden: draft.scope.forbidden },
    });
    stop.throwIfAborted();
    const proposedPath = join(workspace, output);
    const stats = await lstat(proposedPath);
    requireThat(stats.isFile() && !stats.isSymbolicLink() && stats.size < 1024 * 1024, 'Invalid plan proposal file');
    const proposed = JSON.parse(await readFile(proposedPath, 'utf8'));
    requireThat(Array.isArray(proposed.obligations), 'No proposed obligations');
    const obligations = proposed.obligations.map(({ oracleFile, ...fields }) => {
      const oracle = catalog.get(oracleFile);
      requireThat(oracle, 'Planner selected an unapproved oracle ' + oracleFile);
      return { ...fields, oracle: { file: oracle.file, digest: oracle.digest }, cases: oracle.cases };
    });
    const { approval: previousApproval, ...settings } = draft;
    const intent = { ...settings, criteria: proposed.criteria, claims: proposed.claims, obligations };
    const plan = planVerification(intent);
    const contract = makeContract(intent, plan);
    return { intent, contract, plan, approvalDigest: digest(contract) };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
