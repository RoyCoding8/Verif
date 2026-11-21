import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import test from 'node:test';
import { approve, createDemo } from '../examples/setup.mjs';
import { approvedTask, digest, evidenceKeys, hash } from '../src/contracts.mjs';
import { GitRepo } from '../src/git.mjs';
import { Journal } from '../src/journal.mjs';
import { decide, evidenceReuseKey, verify } from '../src/verify.mjs';
import { explore, invariant, keyNegativeControl, negativeControl } from '../verification/EvidenceReuse.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'verity-evidence-reuse-'));
  const settings = await createDemo(root);
  await mkdir(settings.scratch, { recursive: true });
  const oracleRoot = join(root, 'oracles');
  await mkdir(oracleRoot);
  const probe = [
    'export function clock() { return Math.floor(Date.now() / 1000); }',
    'export function constant() { return { z: 1, a: { y: 2, b: 3 } }; }',
    'export function identity(value) { return value; }',
    '',
  ].join('\n');
  const repo = new GitRepo(settings.repository);
  const base = repo.readRef('refs/heads/protected');
  const workspace = join(root, 'candidate-workspace');
  repo.fork(base, workspace);
  await writeFile(join(workspace, 'probe.mjs'), probe);
  const candidate = repo.capture(workspace, base);
  const oracle = async (file, cases) => {
    const bytes = Buffer.from(JSON.stringify(cases));
    await writeFile(join(oracleRoot, file), bytes);
    return { file, digest: hash(bytes) };
  };
  return {
    root, cleanup: () => rm(root, { recursive: true, force: true }),
    settings: { ...settings, oracleRoot }, repo, base, candidate, oracleRoot,
    clockOracle: await oracle('clock.json', [{ id: 'clock', module: 'probe.mjs', name: 'clock', args: [], expected: 0 }]),
    constantOracle: await oracle('constant.json', [{ id: 'constant', module: 'probe.mjs', name: 'constant', args: [],
      expected: { z: 1, a: { y: 2, b: 3 } } }]),
    finiteOracle: await oracle('finite.json', [0, 1].map(value => ({
      id: String(value), module: 'probe.mjs', name: 'identity', args: [value], expected: value,
    }))),
  };
}

function probeTask({ id, claimId, base, clockOracle, constantOracle, clockOutputs = [], constantOutputs = ['cases.json'], inputPaths }) {
  const intent = {
    id, revision: 1, goal: 'Verify deterministic probe behavior.', base,
    scope: { read: ['probe.mjs'], write: ['probe.mjs'], forbidden: [] },
    policy: { ref: 'refs/heads/protected', budgetMs: 60_000, reuseEvidence: true },
    claims: [{ id: claimId, statement: `Probe behavior for ${id}.`, required: 'tested' }],
    criteria: [{ id: 'probe', description: 'Probe checks pass.', claims: [claimId] }],
    obligations: [
      { id: 'clock-' + id, claim: claimId, subject: 'candidate', expect: 'FAIL', witness: 'clock', method: 'node-test',
        oracle: clockOracle, cases: ['clock'], timeoutMs: 5_000, outputs: clockOutputs },
      { id: 'constant-' + id, claim: claimId, subject: 'candidate', expect: 'PASS', method: 'node-test',
        oracle: constantOracle, cases: ['constant'], timeoutMs: 5_000, outputs: constantOutputs,
        ...(inputPaths ? { inputPaths } : {}) },
    ],
  };
  return approvedTask(approve(intent));
}

function finiteTask({ id, claimId, base, oracle, domain }) {
  return approvedTask(approve({
    id, revision: 1, goal: 'Verify the entire finite identity domain.', base,
    scope: { read: ['probe.mjs'], write: ['probe.mjs'], forbidden: [] },
    policy: { ref: 'refs/heads/protected', budgetMs: 30_000, reuseEvidence: true },
    claims: [{ id: claimId, statement: `Identity over ${id}.`, required: 'bounded', domain }],
    criteria: [{ id: 'finite', description: 'All approved values match.', claims: [claimId] }],
    obligations: [{ id: 'finite-' + id, claim: claimId, subject: 'candidate', expect: 'PASS', method: 'finite-domain',
      oracle, cases: ['0', '1'], timeoutMs: 5_000, outputs: [] }],
  }));
}

function beginAttempt(journal, task, label) {
  const run = 'run-' + label;
  journal.registerRun(run, [{ id: task.contract.id, approval: task.approval }]);
  const current = journal.startTask(run, task.contract.id);
  const attempt = 'attempt-' + label;
  journal.registerAttempt({ id: attempt, contract: task.approval, policy: digest(task.contract.policy),
    runId: run, taskId: task.contract.id, claim: current.claim });
  return attempt;
}

function verifyTask(fixtureSettings, task, journal, attempt, deadline = Date.now() + 60_000) {
  return verify({ repo: fixtureSettings.repo, task, base: fixtureSettings.base, candidate: fixtureSettings.candidate,
    oracleRoot: fixtureSettings.oracleRoot, scratch: fixtureSettings.settings.scratch, deadline, journal, attempt });
}

test('approved Node projection reuses only the same executed files and checks the current receipt', async t => {
  const settings = await fixture(t);
  const { repo, root, base } = settings;
  const journal = new Journal(join(root, 'projection.sqlite'));
  t.after(async () => { journal.close(); await settings.cleanup(); });
  const lookedUp = [];
  const observedJournal = {
    authority: journal.authority.bind(journal),
    rememberEvidence: journal.rememberEvidence.bind(journal),
    reusableEvidence: key => {
      const value = journal.reusableEvidence(key);
      lookedUp.push(Boolean(value));
      return value;
    },
  };
  const original = probeTask({ ...settings, id: 'projected', claimId: 'projection', inputPaths: ['probe.mjs', 'dependency.mjs'] });
  const workspace = join(root, 'candidate-workspace');
  await writeFile(join(workspace, 'probe.mjs'), [
    "import { value } from './dependency.mjs';",
    'export const constant = () => value;',
    'export const clock = () => 1;',
  ].join('\n'));
  await writeFile(join(workspace, 'dependency.mjs'), 'export const value = { z: 1, a: { y: 2, b: 3 } };');
  const candidate = () => repo.capture(workspace, base);
  const attempt = beginAttempt(journal, original, 'projection');
  const run = (task = original, attemptId = attempt, subject = candidate()) =>
    verifyTask({ ...settings, candidate: subject }, task, observedJournal, attemptId);
  const first = await run();
  assert.deepEqual(lookedUp.splice(0), [false, false]);
  await writeFile(join(workspace, 'independent.txt'), 'unrelated');
  const second = await run();
  assert.deepEqual(lookedUp.splice(0), [false, true]);
  assert.notEqual(second.candidate, first.candidate);
  assert.deepEqual(second.results[1].manifest.files.map(file => file.path), ['dependency.mjs', 'probe.mjs']);
  assert.deepEqual(second.results[1].keys, first.results[1].keys);
  const decision = receipt => decide({ task: original, receipt, authority: journal.authority(attempt), base,
    candidate: second.candidate, manifests: new Map([[second.candidate, repo.manifest(second.candidate)]]),
    changedPaths: ['probe.mjs'], now: 0, deadline: 1 });
  assert.deepEqual(decision(second), { promote: true });
  assert.match(decision(first).reason, /Receipt identity mismatch/);
  await writeFile(join(workspace, 'dependency.mjs'), 'export const value = { z: 1, a: { y: 2, b: 3 } }; // changed');
  const third = await run();
  assert.deepEqual(lookedUp.splice(0), [false, false]);
  assert.notEqual(third.results[1].keys.run, second.results[1].keys.run);
  const bytes = (await readFile(join(settings.oracleRoot, settings.constantOracle.file), 'utf8')) + '\n';
  await writeFile(join(settings.oracleRoot, 'revised.json'), bytes);
  const changedOracle = probeTask({ ...settings, id: 'revised', claimId: 'projection', inputPaths: ['probe.mjs', 'dependency.mjs'],
    constantOracle: { file: 'revised.json', digest: hash(bytes) } });
  await run(changedOracle, beginAttempt(journal, changedOracle, 'revised'), third.candidate);
  assert.deepEqual(lookedUp.splice(0), [true, false]);
  const omitted = probeTask({ ...settings, id: 'omitted', claimId: 'projection', inputPaths: ['probe.mjs'] });
  await assert.rejects(run(omitted, beginAttempt(journal, omitted, 'omitted')), /ERR_MODULE_NOT_FOUND/);
});

test('raw evidence is reused across approvals, then current artifacts and authority are checked', async t => {
  const settings = await fixture(t);
  const journalPath = join(settings.root, 'controller.sqlite');
  let journal = new Journal(journalPath);
  t.after(async () => { journal.close(); await settings.cleanup(); });
  const first = probeTask({ id: 'reuse-one', claimId: 'claim-one', base: settings.base,
    clockOracle: settings.clockOracle, constantOracle: settings.constantOracle,
    clockOutputs: [], constantOutputs: ['cases.json'] });
  const second = probeTask({ id: 'reuse-two', claimId: 'claim-two', base: settings.base,
    clockOracle: settings.clockOracle, constantOracle: settings.constantOracle,
    clockOutputs: ['cases.json'], constantOutputs: ['cases.json'] });
  const firstAttempt = beginAttempt(journal, first, 'one');
  const firstReceipt = await verifyTask(settings, first, journal, firstAttempt);
  assert.equal(firstReceipt.results[0].status, 'FAIL');
  assert.equal(firstReceipt.results[0].witness, 'clock');
  assert.deepEqual(Object.keys(firstReceipt.results[0].artifacts), []);
  assert.deepEqual(Object.keys(firstReceipt.results[1].artifacts), ['cases.json']);

  await setTimeout(1_200);
  journal.close();
  journal = new Journal(journalPath);
  const secondAttempt = beginAttempt(journal, second, 'two');
  const secondReceipt = await verifyTask(settings, second, journal, secondAttempt);
  assert.equal(secondReceipt.results[0].observation.stdout, firstReceipt.results[0].observation.stdout);
  assert.deepEqual(Object.keys(secondReceipt.results[0].artifacts), ['cases.json']);
  assert.deepEqual(Object.keys(secondReceipt.results[1].artifacts), ['cases.json']);
  assert.equal(secondReceipt.results[1].outputs['cases.json'], firstReceipt.results[1].outputs['cases.json']);
  assert.notEqual(secondReceipt.results[0].keys.authorization, firstReceipt.results[0].keys.authorization);
  assert.notEqual(secondReceipt.results[1].keys.authorization, firstReceipt.results[1].keys.authorization);

  const manifests = new Map(secondReceipt.results.map(result => [result.commit, result.manifest]));
  const changedPaths = settings.repo.changedPaths(settings.base, settings.candidate);
  const decisionDeadline = Date.now() + 5_000;
  assert.deepEqual(decide({ task: second, receipt: secondReceipt, authority: journal.authority(secondAttempt),
    base: settings.base, candidate: settings.candidate, manifests, changedPaths, now: Date.now(), deadline: decisionDeadline }),
  { promote: true });

  journal.invalidate(secondAttempt);
  assert.deepEqual(decide({ task: second, receipt: secondReceipt, authority: journal.authority(secondAttempt),
    base: settings.base, candidate: settings.candidate, manifests, changedPaths, now: Date.now(), deadline: decisionDeadline }),
  { promote: false, reason: 'Inactive or stale authority' });

  const db = new DatabaseSync(join(settings.root, 'controller.sqlite'));
  const cached = db.prepare('SELECT run_key, payload FROM evidence_reuse').all();
  const clockEntry = cached.find(row => JSON.parse(row.payload).observations?.[0]?.id === 'clock');
  assert.ok(clockEntry);
  db.prepare('UPDATE evidence_reuse SET payload = ?, payload_digest = ? WHERE run_key = ?')
    .run('{', '0'.repeat(64), clockEntry.run_key);
  db.close();
  assert.equal(journal.reusableEvidence(clockEntry.run_key), null);

  await setTimeout(1_200);
  const third = probeTask({ id: 'reuse-three', claimId: 'claim-three', base: settings.base,
    clockOracle: settings.clockOracle, constantOracle: settings.constantOracle });
  const thirdAttempt = beginAttempt(journal, third, 'three');
  const thirdReceipt = await verifyTask(settings, third, journal, thirdAttempt);
  assert.notEqual(thirdReceipt.results[0].observation.stdout, secondReceipt.results[0].observation.stdout);
  assert.notEqual(journal.reusableEvidence(clockEntry.run_key), null);

  await setTimeout(1_200);
  const fourth = probeTask({ id: 'reuse-four', claimId: 'claim-four', base: settings.base,
    clockOracle: settings.clockOracle, constantOracle: settings.constantOracle });
  const fourthAttempt = beginAttempt(journal, fourth, 'four');
  const fourthReceipt = await verifyTask(settings, fourth, journal, fourthAttempt);
  assert.equal(fourthReceipt.results[0].observation.stdout, thirdReceipt.results[0].observation.stdout);
  assert.equal(fourthReceipt.results[1].outputs['cases.json'], thirdReceipt.results[1].outputs['cases.json']);
});

test('oracle, subject, tree, method, and environment changes miss; authorization changes reuse raw identity', () => {
  const base = {
    obligation: { id: 'one', method: 'node-test', oracle: { file: 'oracle.json', digest: 'a'.repeat(64) },
      cases: ['case'], timeoutMs: 1_000, expect: 'PASS', witness: null, outputs: [] },
    claim: { id: 'claim-one', statement: 'first claim', required: 'tested', domain: null },
    subject: 'commit-one', tree: 'tree-one', manifest: { files: [{ path: 'module.mjs', digest: 'b'.repeat(64) }] },
    oracleBytes: Buffer.from('approved oracle bytes'),
    environment: { runtime: 'node-24', platform: 'linux', arch: 'x64', adapter: 'adapter-one' },
  };
  const key = evidenceReuseKey(base);
  assert.notEqual(evidenceReuseKey({ ...base, oracleBytes: Buffer.from('changed oracle bytes') }), key, 'oracle byte change');
  assert.notEqual(evidenceReuseKey({ ...base, subject: 'commit-two' }), key, 'subject change');
  assert.notEqual(evidenceReuseKey({ ...base, tree: 'tree-two' }), key, 'tree change');
  assert.notEqual(evidenceReuseKey({ ...base, environment: { ...base.environment, adapter: 'adapter-two' } }), key,
    'environment or adapter change');
  assert.notEqual(evidenceReuseKey({ ...base, obligation: { ...base.obligation, method: 'finite-domain' },
    claim: { ...base.claim, domain: { module: 'module.mjs', name: 'f', axes: [[0]] } } }), key, 'method change');

  const sameExecution = {
    ...base,
    obligation: { ...base.obligation, id: 'two', expect: 'FAIL', witness: 'case', outputs: ['cases.json'] },
    claim: { ...base.claim, id: 'claim-two', statement: 'second claim' },
  };
  assert.equal(evidenceReuseKey(sameExecution), key);
  assert.notEqual(evidenceKeys(base.obligation, base.claim, base.subject, base.manifest, base.environment).authorization,
    evidenceKeys(sameExecution.obligation, sameExecution.claim, sameExecution.subject, sameExecution.manifest,
      sameExecution.environment).authorization);

  const finite = { ...base, obligation: { ...base.obligation, method: 'finite-domain' },
    claim: { ...base.claim, domain: { module: 'module.mjs', name: 'f', axes: [[0, 1]] } } };
  assert.notEqual(evidenceReuseKey({ ...finite, claim: { ...finite.claim, domain: { ...finite.claim.domain, axes: [[0, 2]] } } }),
    evidenceReuseKey(finite), 'finite-domain change');
  assert.equal(evidenceReuseKey({ ...base, claim: { ...base.claim, domain: { module: 'other.mjs', name: 'g', axes: [[1]] } } }), key,
    'non-finite claim domain is not part of raw execution identity');
});

test('journal evidence is immutable by key, rejects swapped rows, and repairs corruption', async t => {
  const root = await mkdtemp(join(tmpdir(), 'verity-evidence-journal-'));
  const path = join(root, 'controller.sqlite');
  const journal = new Journal(path);
  t.after(async () => { journal.close(); await rm(root, { recursive: true, force: true }); });
  const firstKey = '1'.repeat(64);
  const secondKey = '2'.repeat(64);
  const first = { version: 1, method: 'node-test', observations: [{ id: 'one', actual: 1 }] };
  const second = { version: 1, method: 'node-test', observations: [{ id: 'two', actual: 2 }] };
  assert.equal(journal.rememberEvidence(firstKey, first), true);
  assert.equal(journal.rememberEvidence(firstKey, second), false);
  assert.deepEqual(journal.reusableEvidence(firstKey), first);
  assert.equal(journal.rememberEvidence(secondKey, second), true);
  const isolated = new Journal(join(root, 'separate-controller.sqlite'));
  try {
    assert.equal(isolated.reusableEvidence(firstKey), null);
  } finally {
    isolated.close();
  }

  const db = new DatabaseSync(path);
  const firstRow = db.prepare('SELECT payload, payload_digest FROM evidence_reuse WHERE run_key = ?').get(firstKey);
  db.prepare('UPDATE evidence_reuse SET payload = ?, payload_digest = ? WHERE run_key = ?')
    .run(firstRow.payload, firstRow.payload_digest, secondKey);
  db.close();
  assert.equal(journal.reusableEvidence(secondKey), null);
  assert.equal(journal.rememberEvidence(secondKey, second), true);
  assert.deepEqual(journal.reusableEvidence(secondKey), second);
});

test('finite-domain inputs are revalidated before cache lookup', async t => {
  const settings = await fixture(t);
  const journal = new Journal(join(settings.root, 'controller.sqlite'));
  t.after(async () => { journal.close(); await settings.cleanup(); });
  const domain = { module: 'probe.mjs', name: 'identity', axes: [[0, 1]] };
  const valid = finiteTask({ id: 'finite-one', claimId: 'finite-claim-one', base: settings.base,
    oracle: settings.finiteOracle, domain });
  const attempt = beginAttempt(journal, valid, 'finite-one');
  await verifyTask(settings, valid, journal, attempt);

  let lookups = 0;
  const reusableEvidence = journal.reusableEvidence.bind(journal);
  journal.reusableEvidence = key => { lookups += 1; return reusableEvidence(key); };
  const lookupsBefore = lookups;
  const invalid = finiteTask({ id: 'finite-two', claimId: 'finite-claim-two', base: settings.base,
    oracle: settings.finiteOracle, domain: { ...domain, axes: [[0, 2]] } });
  const invalidAttempt = beginAttempt(journal, invalid, 'finite-two');
  await assert.rejects(verifyTask(settings, invalid, journal, invalidAttempt), /Case lies outside the approved finite domain/);
  assert.equal(lookups, lookupsBefore);
});

test('infrastructure failure cannot populate the persistent cache', async t => {
  const settings = await fixture(t);
  const journal = new Journal(join(settings.root, 'controller.sqlite'));
  t.after(async () => { journal.close(); await settings.cleanup(); });
  const missingBytes = Buffer.from(JSON.stringify([{ id: 'missing', module: 'probe.mjs', name: 'missing', args: [], expected: 1 }]));
  await writeFile(join(settings.oracleRoot, 'missing.json'), missingBytes);
  const task = approvedTask(approve({
    id: 'infrastructure-failure', revision: 1, goal: 'Run a deliberately missing export.', base: settings.base,
    scope: { read: ['probe.mjs'], write: ['probe.mjs'], forbidden: [] },
    policy: { ref: 'refs/heads/protected', budgetMs: 30_000, reuseEvidence: true },
    claims: [{ id: 'missing-claim', statement: 'A missing export cannot verify.', required: 'tested' }],
    criteria: [{ id: 'missing', description: 'The export exists.', claims: ['missing-claim'] }],
    obligations: [{ id: 'missing-check', claim: 'missing-claim', subject: 'candidate', expect: 'PASS', method: 'node-test',
      oracle: { file: 'missing.json', digest: hash(missingBytes) }, cases: ['missing'], timeoutMs: 5_000, outputs: [] }],
  }));
  const attempt = beginAttempt(journal, task, 'infrastructure');
  await assert.rejects(verifyTask(settings, task, journal, attempt), /Required export is missing/);
  const db = new DatabaseSync(join(settings.root, 'controller.sqlite'));
  assert.equal(db.prepare('SELECT count(*) AS count FROM evidence_reuse').get().count, 0);
  db.close();
});

test('finite evidence reuse contract explores only safe cache and authority transitions', () => {
  const explored = explore();
  assert.equal(explored.states.length, 60);
  assert.equal(explored.edges.length, 174);
  assert.ok(explored.edges.every(invariant));
  assert.ok(explored.states.some(state => state.source === 'reused' && state.promoted));
  const unsafe = negativeControl();
  assert.ok(unsafe.path.some(step => step.action === 'lookupHit'));
  assert.ok(unsafe.path.some(step => step.action === 'revokeAuthority'));
  assert.equal(unsafe.transition.action, 'promote');
  assert.equal(invariant(unsafe.transition), false);
  const staleKey = keyNegativeControl();
  assert.deepEqual(staleKey.path.map(step => step.action), ['completeExecution', 'changeExecutionKey']);
  assert.equal(staleKey.transition.action, 'promote');
  assert.equal(invariant(staleKey.transition), false);
});
