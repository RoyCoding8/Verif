import { execFile } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { assertExhaustiveDomain, compose, digest, evidenceKeys, evidenceSubject, hash, leanModuleDigests, parseLeanOracle, requireThat, safePath, text, within } from './contracts.mjs';
import { judgeLean, leanEnvironment } from './lean-judge.mjs';
import { leanClaimChallenge, readLeanDefinitions } from './lean-claim.mjs';
import { proofSources } from './proof-dependencies.mjs';
import { expandSampledCases, sampleGenerator } from './sampled-cases.mjs';
import { checkHistory, parseHistoryOracle } from './history-check.mjs';

const execute = promisify(execFile);
const maxArtifactSize = 2 * 1024 * 1024;
const evaluator = await readFile(new URL('./evaluate.mjs', import.meta.url));
const environment = { runtime: process.version, platform: process.platform, arch: process.arch, adapter: hash(evaluator) };
const reuseAdapter = digest(await Promise.all(['./verify.mjs', './evaluate.mjs', './contracts.mjs', './git.mjs'].map(async path =>
  hash(await readFile(new URL(path, import.meta.url))))));
const samplingAdapter = hash(await readFile(new URL('./sampled-cases.mjs', import.meta.url)));
const historyAdapter = hash(await readFile(new URL('./history-check.mjs', import.meta.url)));
const proofEnvironment = { ...environment, lean: leanEnvironment,
  adapter: digest(await Promise.all(['./verify.mjs', './contracts.mjs', './lean-judge.mjs', './lean-claim.mjs', './proof-dependencies.mjs'].map(async path =>
    hash(await readFile(new URL(path, import.meta.url)))))) };

function environmentFor(plan) {
  return plan.obligations.some(o => o.method === 'lean-comparator') ? { ...environment, proof: proofEnvironment } : environment;
}

function evidenceEnvironment(obligation) {
  if (obligation.method === 'lean-comparator') return proofEnvironment;
  if (obligation.method === 'node-differential') return reuseEnvironment();
  if (obligation.method === 'node-property') return { ...reuseEnvironment(), samplingAdapter };
  if (obligation.method === 'node-history') return { ...reuseEnvironment(), historyAdapter };
  return obligation.inputPaths ? reuseEnvironment() : environment;
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
    cases: obligation.cases, timeoutMs: obligation.timeoutMs,
    ...evidenceSubject(obligation, subject, manifest), ...(obligation.inputPaths ? {} : { tree }),
    environment: runEnvironment, domain: obligation.method === 'finite-domain' ? claim.domain : null,
  });
}

function restrictManifest(manifest, inputPaths) {
  if (!inputPaths) return manifest;
  const allowed = new Set(inputPaths);
  const files = manifest.files.filter(file => allowed.has(file.path));
  requireThat(files.length === allowed.size, 'Approved input projection is missing files');
  return { tree: manifest.tree, files };
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

function nodeDifferentialInputs(cases, obligation, baseManifest, candidateManifest) {
  requireThat(Array.isArray(cases) && digest(cases.map(item => item.id)) === digest(obligation.cases),
    'Oracle case IDs do not match obligation ' + obligation.id);
  return cases.map(item => {
    requireThat(item && Object.keys(item).sort().join(',') === 'args,id,module,name' &&
      safePath(item.module) && baseManifest.files.some(file => file.path === item.module) &&
      candidateManifest.files.some(file => file.path === item.module) && text(item.name) && Array.isArray(item.args),
    'Invalid differential oracle case ' + item?.id);
    return { id: item.id, module: item.module, name: item.name, args: item.args };
  });
}

function differentialCases(obligation, comparisons) {
  requireThat(Array.isArray(comparisons) && comparisons.length === obligation.cases.length &&
    digest(comparisons.map(item => item?.id)) === digest(obligation.cases) &&
    comparisons.every(item => item && Object.keys(item).sort().join(',') === 'baseOutput,candidateOutput,id' &&
      item.baseOutput !== undefined && item.candidateOutput !== undefined), 'Invalid differential observations');
  return comparisons.map(({ id, baseOutput, candidateOutput }) => ({
    id, status: digest(baseOutput) === digest(candidateOutput) ? 'PASS' : 'FAIL',
  }));
}

async function runNodeDifferential({ repo, obligation, claim, base, candidate, manifest, oracle, workspace, temp,
  signal, deadline, reserveVerification }) {
  const checkDeadline = Math.min(deadline, Date.now() + obligation.timeoutMs);
  const baselineWorkspace = join(temp, 'base');
  const baseManifest = repo.materialize(base, baselineWorkspace);
  const inputs = nodeDifferentialInputs(oracle, obligation, baseManifest, manifest);
  await Promise.all([assertMaterialization(baselineWorkspace, baseManifest), assertMaterialization(workspace, manifest)]);
  reserveVerification?.(checkDeadline - Date.now());
  const baseline = await evaluateNode({ inputs, obligation, workspace: baselineWorkspace,
    signal, temp, runName: 'base-run', strictJson: true, deadline: checkDeadline });
  const current = await evaluateNode({ inputs, obligation, workspace, signal, temp,
    runName: 'candidate-run', strictJson: true, deadline: checkDeadline });
  await Promise.all([assertMaterialization(baselineWorkspace, baseManifest), assertMaterialization(workspace, manifest)]);
  requireThat(Date.now() < checkDeadline, 'Differential verification deadline expired');
  requireThat([baseline, current].every(run => run.observations.every((item, index) =>
    item?.id === inputs[index].id && Object.hasOwn(item, 'actual') && item.actual !== undefined)),
  'Wrong differential observation order or output');
  const comparisons = inputs.map((input, index) => ({ id: input.id,
    baseOutput: baseline.observations[index].actual, candidateOutput: current.observations[index].actual }));
  const cases = differentialCases(obligation, comparisons);
  const report = readReport({ cases }, obligation);
  const output = { cases, comparisons };
  const artifacts = Object.fromEntries(obligation.outputs.map(path => {
    const contents = Buffer.from(stableJson(output));
    return [path, { digest: hash(contents), base64: contents.toString('base64') }];
  }));
  return { id: obligation.id, ...report, commit: candidate, manifest, level: 'tested',
    keys: evidenceKeys(obligation, claim, candidate, manifest, evidenceEnvironment(obligation), undefined,
      { commit: base, manifest: baseManifest }),
    differential: { base, manifest: baseManifest, comparisons },
    observation: { stdout: hash(stableJson([baseline.stdout, current.stdout])),
      stderr: hash(stableJson([baseline.stderr, current.stderr])), exit: 0 },
    outputs: Object.fromEntries(Object.entries(artifacts).map(([path, artifact]) => [path, artifact.digest])), artifacts };
}

function historyInputs(oracle, obligation, claim, manifest, deadline) {
  const history = parseHistoryOracle(oracle, { deadline });
  const inputs = nodeInputs(history.cases.map(item => ({ ...item, expected: item.expect })), obligation, claim, manifest);
  return { ...history, inputs: inputs.map((input, index) => ({ ...input, calls: history.cases[index].calls })) };
}

async function prepareOracle(oracle, obligation, claim, workspace, manifest, dependencies, oracleRoot, deadline) {
  if (obligation.method === 'node-history') return historyInputs(oracle, obligation, claim, manifest, deadline);
  if (obligation.method === 'node-property') {
    const cases = expandSampledCases(oracle);
    const { seed, samples } = oracle;
    return { cases, inputs: nodeInputs(cases, obligation, claim, manifest), sampling: { generator: sampleGenerator, seed, samples } };
  }
  if (obligation.method !== 'lean-comparator') return { cases: oracle, inputs: nodeInputs(oracle, obligation, claim, manifest) };
  const parsed = parseLeanOracle(oracle);
  requireThat(parsed.theorem === obligation.cases[0], 'Lean theorem does not match obligation ' + obligation.id);
  if (claim.lean?.obligation === obligation.id) {
    const definitions = await readLeanDefinitions(oracleRoot, claim.lean);
    requireThat(parsed.challenge === leanClaimChallenge(claim.lean, parsed.theorem, definitions),
      'Lean oracle does not prove the bound claim ' + claim.id);
  }
  const modules = leanModuleDigests(parsed.modules);
  requireThat(digest(modules) === digest(obligation.leanModules ?? []), 'Approved Lean module list does not match oracle');
  const proof = proofSources(parsed.theorem, parsed.solution, dependencies, manifest, modules);
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  const source = (await Promise.all(proof.sources.map(async ({ path }) => decoder.decode(await regularFile(workspace, path))))).join('\n\n');
  return { ...parsed, source, proof, dependencies };
}

async function evaluateLean({ prepared, obligation, timeout, signal, temp }) {
  const { theorem, challenge, source, proof } = prepared;
  const target = proof.theorems.length > 1 ? { theorems: proof.theorems } : { theorem };
  const { accepted, stdout, stderr } = await judgeLean({
    challenge, solution: source, modules: prepared.modules, ...target, timeoutMs: timeout, signal, scratch: resolve(temp),
  });
  return { version: 1, method: obligation.method, accepted, stdout, stderr, exit: accepted ? 0 : 1 };
}

async function evaluateNode({ inputs, obligation, workspace, signal, temp, runName = 'node', strictJson = false, deadline }) {
  const runDirectory = join(temp, runName);
  await mkdir(runDirectory);
  const evaluatorFile = join(runDirectory, 'evaluate.mjs');
  const request = join(runDirectory, 'request.json');
  await writeFile(evaluatorFile, evaluator, { flag: 'wx' });
  await writeFile(request, JSON.stringify(inputs), { flag: 'wx' });
  const [realTemp, realWorkspace, realEvaluatorFile, realRequest] = await Promise.all(
    [runDirectory, workspace, evaluatorFile, request].map(path => realpath(path)));
  const env = { LANG: 'C', TZ: 'UTC', HOME: realTemp, USERPROFILE: realTemp,
    TMP: realTemp, TEMP: realTemp, TMPDIR: realTemp };
  if (process.platform === 'win32' && process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  const executionTimeout = deadline - Date.now();
  requireThat(executionTimeout > 0, 'Verification deadline expired');
  const { stdout, stderr } = await execute(process.execPath, [
    '--permission', ...[realWorkspace, realEvaluatorFile, realRequest].map(path => '--allow-fs-read=' + path),
    realEvaluatorFile, realWorkspace, realRequest, ...(strictJson ? ['--strict-json'] : []),
  ], {
    cwd: realWorkspace, env, timeout: executionTimeout, signal, killSignal: 'SIGKILL', maxBuffer: maxArtifactSize, windowsHide: true,
  });
  const observations = JSON.parse(stdout);
  requireThat(Array.isArray(observations) && observations.length === inputs.length, 'Incomplete observations for ' + obligation.id);
  return { version: 1, method: obligation.method, observations, stdout, stderr, exit: 0 };
}

function historyVerdict(machine, scenario, observed, deadline) {
  const linearizable = checkHistory(machine, observed, { deadline });
  const calls = scenario.calls.flat();
  requireThat(observed.length === calls.length && observed.every(({ operation, input, invocation }, index) =>
    operation === calls[index].operation && digest(input) === digest(calls[index].input) &&
    (index === 0 || observed[index - 1].invocation < invocation)), 'Observed history does not match approved calls');
  let overlapping = false;
  let offset = 0;
  let lastResponse = -1;
  for (const phase of scenario.calls) {
    const phaseHistory = observed.slice(offset, offset + phase.length);
    requireThat(phaseHistory[0].invocation > lastResponse, 'Observed history crossed approved call phases');
    for (const call of phaseHistory) {
      overlapping ||= lastResponse > call.invocation;
      lastResponse = Math.max(lastResponse, call.response);
    }
    offset += phase.length;
  }
  const expected = scenario.expect === 'linearizable';
  return { status: linearizable === expected ? 'PASS' : 'FAIL', overlapping: expected && overlapping };
}

function presentEvidence(raw, { obligation, claim, commit, manifest, cases, prepared, deadline }) {
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
    const history = obligation.method === 'node-history';
    let overlap = false;
    const observed = raw.observations.map((item, index) => {
      requireThat(item && item.id === cases[index].id && Object.hasOwn(item, 'actual') && item.actual !== undefined,
        'Wrong cached observation for ' + obligation.id);
      if (!history) return { id: item.id, status: digest(item.actual) === digest(cases[index].expected) ? 'PASS' : 'FAIL' };
      const verdict = historyVerdict(prepared.machine, cases[index], item.actual, deadline);
      overlap ||= verdict.overlapping;
      return { id: item.id, status: verdict.status };
    });
    requireThat(!history || overlap, 'No overlapping calls observed in approved positive histories');
    level = obligation.method === 'finite-domain' ? 'bounded' : 'tested';
    statuses = observed;
    output = { cases: observed, observations: raw.observations,
      ...(prepared.sampling ? { sampling: prepared.sampling } : {}) };
  }
  const report = readReport({ cases: statuses }, obligation);
  const artifacts = Object.fromEntries(obligation.outputs.map(path => {
    const contents = Buffer.from(stableJson(output));
    return [path, { digest: hash(contents), base64: contents.toString('base64') }];
  }));
  return {
    id: obligation.id, ...report, commit, manifest, level,
    keys: evidenceKeys(obligation, claim, commit, manifest, evidenceEnvironment(obligation), prepared.dependencies),
    ...(prepared.proof ? { proof: prepared.proof } : {}),
    ...(prepared.sampling ? { sampling: prepared.sampling } : {}),
    ...(obligation.proofDependencies ? { proofDependencies: prepared.dependencies } : {}),
    observation: { stdout: hash(raw.stdout), stderr: hash(raw.stderr), exit: raw.exit },
    outputs: Object.fromEntries(Object.entries(artifacts).map(([path, artifact]) => [path, artifact.digest])),
    artifacts,
  };
}

function cacheAuthority(journal, attempt, task, obligation) {
  if (!journal || !attempt || task.contract.policy.reuseEvidence !== true ||
    ['lean-comparator', 'node-history', 'node-differential'].includes(obligation.method)) return false;
  const authority = journal.authority(attempt);
  return authority?.active === true && authority.contract === task.approval &&
    authority.policy === digest(task.contract.policy);
}

async function runObligation({ repo, task, obligation, claim, base, commit, oracleRoot, scratch, signal, deadline, journal, attempt,
  reserveVerification, dependencies = [] }) {
  const temp = await mkdtemp(join(scratch, 'check-'));
  try {
    const workspace = join(temp, 'subject');
    const bytes = await regularFile(oracleRoot, obligation.oracle.file);
    requireThat(hash(bytes) === obligation.oracle.digest, 'Oracle digest changed for ' + obligation.id);
    const manifest = repo.materialize(commit, workspace, obligation.inputPaths);
    await assertMaterialization(workspace, manifest);
    const oracle = JSON.parse(bytes.toString('utf8'));
    requireThat(dependencies.length === (obligation.proofDependencies?.length ?? 0), 'Missing verified proof dependencies');
    if (obligation.method === 'node-differential') {
      return await runNodeDifferential({ repo, obligation, claim, base, candidate: commit, manifest, oracle, workspace, temp,
        signal, deadline, reserveVerification });
    }
    const history = obligation.method === 'node-history';
    const started = Date.now();
    const checkDeadline = Math.min(deadline, started + obligation.timeoutMs);
    if (history) {
      requireThat(checkDeadline > started, 'Task budget expired');
      reserveVerification?.(checkDeadline - started);
    }
    const prepared = await prepareOracle(oracle, obligation, claim, workspace, manifest, dependencies, oracleRoot, checkDeadline);
    const timeout = history ? checkDeadline - Date.now() : Math.min(obligation.timeoutMs, deadline - Date.now());
    requireThat(timeout > 0, 'Task budget expired');
    const cacheEnabled = cacheAuthority(journal, attempt, task, obligation);
    const cacheKey = cacheEnabled ? evidenceReuseKey({ obligation, claim, subject: commit, tree: manifest.tree, manifest,
      oracleBytes: bytes, environment: obligation.method === 'node-property' ? evidenceEnvironment(obligation) : reuseEnvironment() }) : null;
    let raw = cacheEnabled ? journal.reusableEvidence(cacheKey) : null;
    let result;
    let remember = false;
    if (raw) {
      try {
        result = presentEvidence(raw, { obligation, claim, commit, manifest, cases: prepared.cases, prepared, deadline: checkDeadline });
      } catch {
        raw = null;
      }
    }
    if (!raw) {
      const evaluate = obligation.method === 'lean-comparator' ? evaluateLean : evaluateNode;
      if (!history) reserveVerification?.(timeout);
      const executionDeadline = history ? checkDeadline : Math.min(deadline, Date.now() + timeout);
      raw = obligation.method === 'lean-comparator'
        ? await evaluate({ prepared, inputs: prepared.inputs, obligation, workspace, timeout, signal, temp })
        : await evaluate({ prepared, inputs: prepared.inputs, obligation, workspace, signal, temp, deadline: executionDeadline });
      await assertMaterialization(workspace, manifest);
      result = presentEvidence(raw, { obligation, claim, commit, manifest, cases: prepared.cases, prepared, deadline: checkDeadline });
      remember = true;
    }
    signal?.throwIfAborted();
    requireThat(Date.now() < (history ? checkDeadline : deadline), history ? 'History verification deadline expired' : 'Task budget expired');
    if (remember && cacheEnabled && cacheAuthority(journal, attempt, task, obligation)) journal.rememberEvidence(cacheKey, raw);
    return result;
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

export async function verify({ repo, task, base, candidate, oracleRoot, scratch, signal, deadline, journal, attempt,
  reserveVerification, proofDependencies, onVerdict }) {
  const results = [];
  for (const obligation of task.plan.obligations) {
    signal?.throwIfAborted();
    const claim = task.plan.claims.find(claim => claim.id === obligation.claim);
    const commit = subjectFor(obligation, base, candidate);
    const result = await runObligation({ repo, task, obligation, claim, base, commit, oracleRoot, scratch, signal, deadline, journal, attempt,
      reserveVerification, dependencies: proofDependencies?.get(obligation.id) });
    results.push(result);
    if (result.status !== obligation.expect || (obligation.expect === 'FAIL' && result.witness !== obligation.witness)) {
      onVerdict?.({ obligation: obligation.id, claim: claim.id, subject: commit, expected: obligation.expect,
        observed: result.status, expectedWitness: obligation.witness, observedWitness: result.witness, evidence: result.keys.authorization });
    }
  }
  const assurance = compose(task.plan, results);
  return { version: 1, contract: task.approval, plan: task.contract.plan, base, candidate, environment: environmentFor(task.plan), results, assurance };
}

export async function checkFeedback({ repo, task, name, base, candidate, oracleRoot, scratch, signal, deadline,
  reserveVerification, proofDependencies }) {
  const obligation = task.plan.obligations.find(item => item.id === name);
  requireThat(obligation, 'Unknown approved check ' + name);
  const claim = task.plan.claims.find(item => item.id === obligation.claim);
  const commit = subjectFor(obligation, base, candidate);
  const { status, witness } = await runObligation({ repo, task, obligation, claim, base, commit, oracleRoot, scratch, signal, deadline,
    reserveVerification, dependencies: proofDependencies?.get(name) });
  return witness ? status + ' (' + witness + ')' : status;
}

export function decide({ task, receipt, authority, base, candidate, manifests, changedPaths, now, deadline, proofDependencies }) {
  try {
    const { contract, plan, approval } = task;
    requireThat(authority?.active && authority.contract === approval && authority.policy === digest(contract.policy), 'Inactive or stale authority');
    requireThat(now < (contract.policy.validUntilMs ?? Infinity), 'Approval expired');
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
      const manifest = restrictManifest(manifests.get(subject), obligation.inputPaths);
      const dependencies = proofDependencies?.get(obligation.id);
      let keys;
      if (obligation.method === 'node-differential') {
        const baselineManifest = manifests.get(base);
        requireThat(result.differential?.base === base && baselineManifest &&
          digest(result.differential.manifest) === digest(baselineManifest), 'Differential baseline identity mismatch');
        const comparisons = result.differential.comparisons;
        const cases = differentialCases(obligation, comparisons);
        const report = readReport({ cases }, obligation);
        requireThat(report.status === result.status && report.witness === result.witness &&
          digest(result.cases) === digest(cases), 'Differential verdict mismatch');
        if (obligation.outputs.includes('cases.json')) {
          const artifact = result.artifacts?.['cases.json'];
          const expected = Buffer.from(stableJson({ cases, comparisons }));
          requireThat(artifact && Buffer.from(artifact.base64, 'base64').equals(expected), 'Differential artifact mismatch');
        }
        keys = evidenceKeys(obligation, claim, subject, manifest, evidenceEnvironment(obligation), undefined,
          { commit: base, manifest: baselineManifest });
      }
      if (obligation.method === 'lean-comparator') {
        requireThat(digest(result.proof?.modules ?? []) === digest(obligation.leanModules ?? []), 'Stale Lean module evidence');
      }
      if (obligation.proofDependencies) {
        requireThat(dependencies?.length === obligation.proofDependencies.length, 'Missing verified proof dependencies');
        requireThat(digest(result.proofDependencies) === digest(dependencies), 'Stale proof dependency for ' + obligation.id);
        const source = result.proof?.sources.at(-1)?.path;
        requireThat(source && digest(result.proof) === digest(proofSources(obligation.cases[0], source, dependencies, manifest, obligation.leanModules)),
          'Stale linked proof source for ' + obligation.id);
      }
      requireThat(result.commit === subject && digest(result.manifest) === digest(manifest) &&
        digest(result.keys) === digest(keys ?? evidenceKeys(obligation, claim, subject, manifest,
          evidenceEnvironment(obligation), dependencies)),
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
