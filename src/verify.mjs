import { execFile } from 'node:child_process';
import { lstat, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { assertExhaustiveDomain, compose, digest, evidenceKeys, hash, parseLeanOracle, requireThat, safePath, text, within } from './contracts.mjs';
import { judgeLean, leanEnvironment } from './lean-judge.mjs';

const execute = promisify(execFile);
const maxArtifactSize = 2 * 1024 * 1024;
const evaluator = await readFile(new URL('./evaluate.mjs', import.meta.url));
const environment = { runtime: process.version, platform: process.platform, arch: process.arch, adapter: hash(evaluator) };
const reuseAdapter = digest(await Promise.all(['./verify.mjs', './evaluate.mjs', './contracts.mjs'].map(async path =>
  hash(await readFile(new URL(path, import.meta.url))))));
const proofEnvironment = { ...environment, lean: leanEnvironment,
  adapter: digest(await Promise.all(['./verify.mjs', './lean-judge.mjs'].map(async path =>
    hash(await readFile(new URL(path, import.meta.url)))))) };

function environmentFor(plan) {
  return plan.obligations.some(o => o.method === 'lean-comparator') ? { ...environment, proof: proofEnvironment } : environment;
}

function evidenceEnvironment(obligation) {
  return obligation.method === 'lean-comparator' ? proofEnvironment : environment;
}

function reuseEnvironment() {
  return {
    runtime: process.version, platform: process.platform, arch: process.arch,
    adapter: reuseAdapter, evaluator: { lang: 'C', timezone: 'UTC' },
    systemRoot: process.platform === 'win32' ? process.env.SystemRoot ?? null : null,
  };
}

export function evidenceReuseKey({ obligation, claim, subject, tree, manifest, oracleBytes, environment: runEnvironment }) {
  return digest({
    version: 2, method: obligation.method, oracle: obligation.oracle, oracleBytes: hash(oracleBytes),
    cases: obligation.cases, timeoutMs: obligation.timeoutMs, subject, tree, manifest,
    environment: runEnvironment, domain: obligation.method === 'finite-domain' ? claim.domain : null,
  });
}

async function regularFile(root, name, limit = maxArtifactSize) {
  const file = join(root, name);
  const actual = relative(await realpath(root), await realpath(file));
  requireThat(actual === name.split('/').join(sep) && !isAbsolute(actual), 'File resolves outside its declared path: ' + name);
  const stats = await lstat(file);
  requireThat(stats.isFile() && stats.size <= limit, 'Invalid or oversized file: ' + name);
  return readFile(file);
}

async function assertMaterialization(root, manifest) {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const paths = entries.filter(entry => !entry.isDirectory()).map(entry =>
    relative(root, join(entry.parentPath, entry.name)).split(sep).join('/')).sort();
  requireThat(digest(paths) === digest(manifest.files.map(file => file.path).sort()), 'Materialized file set changed');
  for (const { path, mode, digest: expected } of manifest.files) {
    const bytes = await regularFile(root, path, Infinity);
    const executable = ((await lstat(join(root, path))).mode & 0o111) !== 0;
    requireThat(hash(bytes) === expected &&
      (process.platform === 'win32' || executable === (mode === '100755')), 'Materialized input changed: ' + path);
  }
}

function readReport(report, obligation) {
  requireThat(Array.isArray(report?.cases) && report.cases.length === obligation.cases.length, 'Incomplete case report for ' + obligation.id);
  const observed = new Map();
  for (const item of report.cases) {
    requireThat(item && typeof item.id === 'string' && !observed.has(item.id) &&
      (item.status === 'PASS' || item.status === 'FAIL'), 'Invalid case report for ' + obligation.id);
    observed.set(item.id, item.status);
  }
  requireThat(obligation.cases.every(id => observed.has(id)), 'Required cases did not run for ' + obligation.id);
  const failures = obligation.cases.filter(id => observed.get(id) === 'FAIL');
  return { status: failures.length === 0 ? 'PASS' : 'FAIL', witness: failures.length === 1 ? failures[0] : null, cases: report.cases };
}

function stableJson(value) {
  const sort = item => Array.isArray(item) ? item.map(sort) : item && typeof item === 'object'
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, sort(item[key])])) : item;
  return JSON.stringify(sort(value));
}

export function subjectFor(obligation, base, candidate) {
  if (obligation.subject === 'base') return base;
  if (obligation.subject === 'candidate') return candidate;
  return obligation.subject;
}

function nodeInputs(cases, obligation, claim, manifest) {
  requireThat(Array.isArray(cases) && digest(cases.map(item => item.id)) === digest(obligation.cases),
    'Oracle case IDs do not match obligation ' + obligation.id);
  const inputs = cases.map(({ id, module, name, args, expected }) => {
    requireThat(safePath(module) && manifest.files.some(file => file.path === module) &&
      text(name) && Array.isArray(args) && expected !== undefined, 'Invalid oracle case ' + id);
    return { id, module, name, args };
  });
  if (obligation.method === 'finite-domain') assertExhaustiveDomain(claim.domain, inputs);
  return inputs;
}

async function prepareOracle(oracle, obligation, claim, workspace, manifest) {
  if (obligation.method !== 'lean-comparator') return { cases: oracle, inputs: nodeInputs(oracle, obligation, claim, manifest) };
  const parsed = parseLeanOracle(oracle);
  requireThat(parsed.theorem === obligation.cases[0], 'Lean theorem does not match obligation ' + obligation.id);
  requireThat(manifest.files.some(file => file.path === parsed.solution), 'Missing Lean solution: ' + parsed.solution);
  const source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await regularFile(workspace, parsed.solution));
  return { ...parsed, source };
}

async function evaluateLean({ prepared, obligation, timeout, signal, temp }) {
  const { theorem, challenge, source } = prepared;
  const { accepted, stdout, stderr } = await judgeLean({
    challenge, solution: source, theorem, timeoutMs: timeout, signal, scratch: resolve(temp),
  });
  return { version: 1, method: obligation.method, accepted, stdout, stderr, exit: accepted ? 0 : 1 };
}

async function evaluateNode({ inputs, obligation, workspace, timeout, signal, temp }) {
  const evaluatorFile = join(temp, 'evaluate.mjs');
  const request = join(temp, 'request.json');
  await writeFile(evaluatorFile, evaluator, { flag: 'wx' });
  await writeFile(request, JSON.stringify(inputs), { flag: 'wx' });
  const [realTemp, realWorkspace, realEvaluatorFile, realRequest] = await Promise.all(
    [temp, workspace, evaluatorFile, request].map(path => realpath(path)));
  const env = { LANG: 'C', TZ: 'UTC', HOME: realTemp, USERPROFILE: realTemp,
    TMP: realTemp, TEMP: realTemp, TMPDIR: realTemp };
  if (process.platform === 'win32' && process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  const { stdout, stderr } = await execute(process.execPath, [
    '--permission', ...[realWorkspace, realEvaluatorFile, realRequest].map(path => '--allow-fs-read=' + path),
    realEvaluatorFile, realWorkspace, realRequest,
  ], {
    cwd: realWorkspace, env, timeout, signal, killSignal: 'SIGKILL', maxBuffer: maxArtifactSize, windowsHide: true,
  });
  const observations = JSON.parse(stdout);
  requireThat(Array.isArray(observations) && observations.length === inputs.length, 'Incomplete observations for ' + obligation.id);
  return { version: 1, method: obligation.method, observations, stdout, stderr, exit: 0 };
}

function presentEvidence(raw, { obligation, claim, commit, manifest, cases, prepared }) {
  let level;
  let output;
  let statuses;
  if (obligation.method === 'lean-comparator') {
    requireThat(raw?.version === 1 && raw.method === obligation.method && typeof raw.accepted === 'boolean' &&
      typeof raw.stdout === 'string' && typeof raw.stderr === 'string' && raw.exit === (raw.accepted ? 0 : 1),
    'Invalid cached Lean observation for ' + obligation.id);
    level = 'formal';
    statuses = [{ id: prepared.theorem, status: raw.accepted ? 'PASS' : 'FAIL' }];
    output = { cases: statuses, theorem: prepared.theorem, stdout: raw.stdout, stderr: raw.stderr };
  } else {
    requireThat(raw?.version === 1 && raw.method === obligation.method && raw.exit === 0 &&
      typeof raw.stdout === 'string' && typeof raw.stderr === 'string' && Array.isArray(raw.observations) &&
      raw.observations.length === cases.length, 'Invalid cached Node observations for ' + obligation.id);
    const observed = raw.observations.map((item, index) => {
      requireThat(item && item.id === cases[index].id && Object.hasOwn(item, 'actual') && item.actual !== undefined,
        'Wrong cached observation for ' + obligation.id);
      return { id: item.id, status: digest(item.actual) === digest(cases[index].expected) ? 'PASS' : 'FAIL' };
    });
    level = obligation.method === 'finite-domain' ? 'bounded' : 'tested';
    statuses = observed;
    output = { cases: observed, observations: raw.observations };
  }
  const report = readReport({ cases: statuses }, obligation);
  const artifacts = Object.fromEntries(obligation.outputs.map(path => {
    const contents = Buffer.from(stableJson(output));
    return [path, { digest: hash(contents), base64: contents.toString('base64') }];
  }));
  return {
    id: obligation.id, ...report, commit, manifest, level,
    keys: evidenceKeys(obligation, claim, commit, manifest, evidenceEnvironment(obligation)),
    observation: { stdout: hash(raw.stdout), stderr: hash(raw.stderr), exit: raw.exit },
    outputs: Object.fromEntries(Object.entries(artifacts).map(([path, artifact]) => [path, artifact.digest])),
    artifacts,
  };
}

function cacheAuthority(journal, attempt, task, obligation) {
  if (!journal || !attempt || task.contract.policy.reuseEvidence !== true || obligation.method === 'lean-comparator') return false;
  const authority = journal.authority(attempt);
  return authority?.active === true && authority.contract === task.approval &&
    authority.policy === digest(task.contract.policy);
}

async function runObligation({ repo, task, obligation, claim, commit, oracleRoot, scratch, signal, deadline, journal, attempt }) {
  const temp = await mkdtemp(join(scratch, 'check-'));
  try {
    const workspace = join(temp, 'subject');
    const bytes = await regularFile(oracleRoot, obligation.oracle.file);
    requireThat(hash(bytes) === obligation.oracle.digest, 'Oracle digest changed for ' + obligation.id);
    const manifest = repo.materialize(commit, workspace);
    await assertMaterialization(workspace, manifest);
    const oracle = JSON.parse(bytes.toString('utf8'));
    const prepared = await prepareOracle(oracle, obligation, claim, workspace, manifest);
    const timeout = Math.min(obligation.timeoutMs, deadline - Date.now());
    requireThat(timeout > 0, 'Task budget expired');
    const cacheEnabled = cacheAuthority(journal, attempt, task, obligation);
    const cacheKey = cacheEnabled ? evidenceReuseKey({ obligation, claim, subject: commit, tree: repo.tree(commit), manifest,
      oracleBytes: bytes, environment: reuseEnvironment() }) : null;
    let raw = cacheEnabled ? journal.reusableEvidence(cacheKey) : null;
    let result;
    let remember = false;
    if (raw) {
      try {
        result = presentEvidence(raw, { obligation, claim, commit, manifest, cases: prepared.cases, prepared });
      } catch {
        raw = null;
      }
    }
    if (!raw) {
      const evaluate = obligation.method === 'lean-comparator' ? evaluateLean : evaluateNode;
      raw = await evaluate({ prepared, inputs: prepared.inputs, obligation, workspace, timeout, signal, temp });
      await assertMaterialization(workspace, manifest);
      result = presentEvidence(raw, { obligation, claim, commit, manifest, cases: prepared.cases, prepared });
      remember = true;
    }
    signal?.throwIfAborted();
    requireThat(Date.now() < deadline, 'Task budget expired');
    if (remember && cacheEnabled && cacheAuthority(journal, attempt, task, obligation)) journal.rememberEvidence(cacheKey, raw);
    return result;
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

export async function verify({ repo, task, base, candidate, oracleRoot, scratch, signal, deadline, journal, attempt }) {
  const results = [];
  for (const obligation of task.plan.obligations) {
    signal?.throwIfAborted();
    const claim = task.plan.claims.find(claim => claim.id === obligation.claim);
    const commit = subjectFor(obligation, base, candidate);
    results.push(await runObligation({ repo, task, obligation, claim, commit, oracleRoot, scratch, signal, deadline, journal, attempt }));
  }
  const assurance = compose(task.plan, results);
  return { version: 1, contract: task.approval, plan: task.contract.plan, base, candidate, environment: environmentFor(task.plan), results, assurance };
}

export async function checkFeedback({ repo, task, name, base, candidate, oracleRoot, scratch, signal, deadline }) {
  const obligation = task.plan.obligations.find(item => item.id === name);
  requireThat(obligation, 'Unknown approved check ' + name);
  const claim = task.plan.claims.find(item => item.id === obligation.claim);
  const commit = subjectFor(obligation, base, candidate);
  const { status, witness } = await runObligation({ repo, task, obligation, claim, commit, oracleRoot, scratch, signal, deadline });
  return witness ? status + ' (' + witness + ')' : status;
}

export function decide({ task, receipt, authority, base, candidate, manifests, changedPaths, now, deadline }) {
  try {
    const { contract, plan, approval } = task;
    requireThat(authority?.active && authority.contract === approval && authority.policy === digest(contract.policy), 'Inactive or stale authority');
    requireThat(now < deadline, 'Task budget expired');
    requireThat(digest(contract) === approval && digest(plan) === contract.plan, 'Unapproved contract or plan');
    requireThat(receipt.version === 1 && receipt.contract === approval && receipt.plan === contract.plan &&
      receipt.base === base && receipt.candidate === candidate && digest(receipt.environment) === digest(environmentFor(plan)),
    'Receipt identity mismatch');
    requireThat(changedPaths.length > 0 && changedPaths.every(path =>
      within(path, contract.scope.write) && !within(path, contract.scope.forbidden)), 'Candidate changed paths outside approved scope');
    requireThat(digest(compose(plan, receipt.results)) === digest(receipt.assurance), 'Receipt assurance mismatch');
    for (const obligation of plan.obligations) {
      const result = receipt.results.find(result => result.id === obligation.id);
      const claim = plan.claims.find(claim => claim.id === obligation.claim);
      const subject = subjectFor(obligation, base, candidate);
      const manifest = manifests.get(subject);
      requireThat(result.commit === subject && digest(result.manifest) === digest(manifest) &&
        digest(result.keys) === digest(evidenceKeys(obligation, claim, subject, manifest, evidenceEnvironment(obligation))),
      'Stale evidence for ' + obligation.id);
      const report = readReport({ cases: result.cases }, obligation);
      requireThat(report.status === result.status && report.witness === result.witness, 'Receipt verdict mismatch');
      requireThat(obligation.method !== 'lean-comparator' || result.observation?.exit === 0, 'Lean proof was not accepted');
      requireThat(Object.keys(result.artifacts).length === obligation.outputs.length &&
        obligation.outputs.every(path => result.artifacts[path]?.digest === result.outputs[path] &&
          hash(Buffer.from(result.artifacts[path].base64, 'base64')) === result.outputs[path]), 'Receipt artifact mismatch');
    }
    return { promote: true };
  } catch (error) {
    return { promote: false, reason: error.message };
  }
}
