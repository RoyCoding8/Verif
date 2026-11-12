import { execFile } from 'node:child_process';
import { lstat, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import { compose, digest, evidenceKeys, hash, requireThat, safePath, text, within } from './contracts.mjs';

const execute = promisify(execFile);
const maxArtifactSize = 2 * 1024 * 1024;
const evaluator = await readFile(new URL('./evaluate.mjs', import.meta.url));
const environment = { runtime: process.version, platform: process.platform, arch: process.arch, adapter: hash(evaluator) };

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

function readReport(stdout, obligation) {
  const report = JSON.parse(stdout);
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

export function subjectFor(obligation, base, candidate) {
  if (obligation.subject === 'base') return base;
  if (obligation.subject === 'candidate') return candidate;
  return obligation.subject;
}

async function runObligation({ repo, obligation, claim, commit, oracleRoot, scratch, signal, deadline }) {
  const temp = await mkdtemp(join(scratch, 'check-'));
  try {
    const workspace = join(temp, 'subject');
    const evaluatorFile = join(temp, 'evaluate.mjs');
    const request = join(temp, 'request.json');
    const bytes = await regularFile(oracleRoot, obligation.oracle.file);
    requireThat(hash(bytes) === obligation.oracle.digest, 'Oracle digest changed for ' + obligation.id);
    const manifest = repo.materialize(commit, workspace);
    await assertMaterialization(workspace, manifest);
    const cases = JSON.parse(bytes.toString('utf8'));
    requireThat(Array.isArray(cases) && digest(cases.map(item => item.id)) === digest(obligation.cases),
      'Oracle case IDs do not match obligation ' + obligation.id);
    const inputs = cases.map(({ id, module, name, args, expected }) => {
      requireThat(safePath(module) && manifest.files.some(file => file.path === module) &&
        text(name) && Array.isArray(args) && expected !== undefined, 'Invalid oracle case ' + id);
      return { id, module, name, args };
    });
    await writeFile(evaluatorFile, evaluator, { flag: 'wx' });
    await writeFile(request, JSON.stringify(inputs), { flag: 'wx' });
    const timeout = Math.min(obligation.timeoutMs, deadline - Date.now());
    requireThat(timeout > 0, 'Task budget expired');
    const env = { LANG: 'C', TZ: 'UTC', HOME: temp, USERPROFILE: temp, TMP: temp, TEMP: temp, TMPDIR: temp };
    if (process.platform === 'win32' && process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
    const readPaths = await Promise.all([workspace, evaluatorFile, request].map(path => realpath(path)));
    const { stdout, stderr } = await execute(process.execPath, [
      '--permission', ...readPaths.map(path => '--allow-fs-read=' + path), evaluatorFile, workspace, request,
    ], {
      cwd: workspace, env, timeout, signal, killSignal: 'SIGKILL', maxBuffer: maxArtifactSize, windowsHide: true,
    });
    const observations = JSON.parse(stdout);
    requireThat(Array.isArray(observations) && observations.length === cases.length, 'Incomplete observations for ' + obligation.id);
    const observedCases = observations.map(({ id, actual }, index) => {
      requireThat(id === cases[index].id && actual !== undefined, 'Wrong observation for ' + obligation.id);
      return { id, status: digest(actual) === digest(cases[index].expected) ? 'PASS' : 'FAIL' };
    });
    const report = readReport(JSON.stringify({ cases: observedCases }), obligation);
    await assertMaterialization(workspace, manifest);
    const artifacts = Object.fromEntries(obligation.outputs.map(path => {
      const contents = Buffer.from(JSON.stringify({ cases: observedCases, observations }));
      return [path, { digest: hash(contents), base64: contents.toString('base64') }];
    }));
    return {
      id: obligation.id, ...report, commit, manifest,
      level: obligation.method === 'finite-domain' ? 'bounded' : 'tested',
      keys: evidenceKeys(obligation, claim, commit, manifest, environment),
      observation: { stdout: hash(stdout), stderr: hash(stderr), exit: 0 },
      outputs: Object.fromEntries(Object.entries(artifacts).map(([path, artifact]) => [path, artifact.digest])),
      artifacts,
    };
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

export async function verify({ repo, task, base, candidate, oracleRoot, scratch, signal, deadline }) {
  const results = [];
  for (const obligation of task.plan.obligations) {
    signal?.throwIfAborted();
    const claim = task.plan.claims.find(claim => claim.id === obligation.claim);
    const commit = subjectFor(obligation, base, candidate);
    results.push(await runObligation({ repo, obligation, claim, commit, oracleRoot, scratch, signal, deadline }));
  }
  const assurance = compose(task.plan, results);
  return { version: 1, contract: task.approval, plan: task.contract.plan, base, candidate, environment, results, assurance };
}

export async function checkFeedback({ repo, task, name, base, candidate, oracleRoot, scratch, signal, deadline }) {
  const obligation = task.plan.obligations.find(item => item.id === name);
  requireThat(obligation, 'Unknown approved check ' + name);
  const claim = task.plan.claims.find(item => item.id === obligation.claim);
  const commit = subjectFor(obligation, base, candidate);
  const { status, witness } = await runObligation({ repo, obligation, claim, commit, oracleRoot, scratch, signal, deadline });
  return witness ? status + ' (' + witness + ')' : status;
}

export function decide({ task, receipt, authority, base, candidate, manifests, changedPaths, now, deadline }) {
  try {
    const { contract, plan, approval } = task;
    requireThat(authority?.active && authority.contract === approval && authority.policy === digest(contract.policy), 'Inactive or stale authority');
    requireThat(now < deadline, 'Task budget expired');
    requireThat(digest(contract) === approval && digest(plan) === contract.plan, 'Unapproved contract or plan');
    requireThat(receipt.version === 1 && receipt.contract === approval && receipt.plan === contract.plan &&
      receipt.base === base && receipt.candidate === candidate && digest(receipt.environment) === digest(environment),
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
        digest(result.keys) === digest(evidenceKeys(obligation, claim, subject, manifest, environment)),
      'Stale evidence for ' + obligation.id);
      const report = readReport(JSON.stringify({ cases: result.cases }), obligation);
      requireThat(report.status === result.status && report.witness === result.witness, 'Receipt verdict mismatch');
      requireThat(Object.keys(result.artifacts).length === obligation.outputs.length &&
        obligation.outputs.every(path => result.artifacts[path]?.digest === result.outputs[path] &&
          hash(Buffer.from(result.artifacts[path].base64, 'base64')) === result.outputs[path]), 'Receipt artifact mismatch');
    }
    return { promote: true };
  } catch (error) {
    return { promote: false, reason: error.message };
  }
}
