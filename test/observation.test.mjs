import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { approve, createDemo } from '../examples/setup.mjs';
import { approvedTask, digest, hash } from '../src/contracts.mjs';
import { GitRepo } from '../src/git.mjs';
import { Journal } from '../src/journal.mjs';
import { verify } from '../src/verify.mjs';

const PROBE = [
  'export function nothing() {}',
  'export function nan() { return NaN; }',
  'export function nully() { return null; }',
  'export function value() { return 42; }',
  'export function markerLike() { return { unrepresentable: "undefined" }; }',
  '',
].join('\n');

async function observationFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'verity-observation-'));
  const settings = await createDemo(root);
  await mkdir(settings.scratch, { recursive: true });
  const oracleRoot = join(root, 'oracles');
  await mkdir(oracleRoot);
  const oracle = async (file, cases) => {
    const bytes = Buffer.from(JSON.stringify(cases));
    await writeFile(join(oracleRoot, file), bytes);
    return { file, digest: hash(bytes) };
  };
  const oracles = {
    undefValue: await oracle('undef-value.json', [{ id: 'c1', module: 'probe.mjs', name: 'nothing', args: [], expected: 42 }]),
    undefNull: await oracle('undef-null.json', [{ id: 'c5', module: 'probe.mjs', name: 'nothing', args: [], expected: null }]),
    nanNull: await oracle('nan-null.json', [{ id: 'c3', module: 'probe.mjs', name: 'nan', args: [], expected: null }]),
    nullNull: await oracle('null-null.json', [{ id: 'c4', module: 'probe.mjs', name: 'nully', args: [], expected: null }]),
    marker: await oracle('marker.json', [{ id: 'c6', module: 'probe.mjs', name: 'markerLike', args: [],
      expected: { unrepresentable: 'undefined' } }]),
    value: await oracle('value.json', [{ id: 'c2', module: 'probe.mjs', name: 'value', args: [], expected: 42 }]),
  };
  const repo = new GitRepo(settings.repository);
  const seeded = repo.readRef('refs/heads/protected');
  const seedWorkspace = join(root, 'seed-ws');
  repo.fork(seeded, seedWorkspace);
  await writeFile(join(seedWorkspace, 'probe.mjs'), PROBE);
  const base = repo.capture(seedWorkspace, seeded);
  const candidateWorkspace = join(root, 'candidate-ws');
  repo.fork(base, candidateWorkspace);
  const candidate = repo.capture(candidateWorkspace, base);
  return {
    cleanup: () => rm(root, { recursive: true, force: true }),
    repo, base, candidate, oracleRoot, scratch: settings.scratch, oracles,
  };
}

function probeTask({ base, oracles }, obligations) {
  return approvedTask(approve({
    id: 'observation', revision: 1, goal: 'Unrepresentable subject outputs fail closed per case.',
    claims: [{ id: 'probe', statement: 'Probe outputs compare exactly or fail closed.', required: 'tested' }],
    criteria: [{ id: 'probe', description: 'All probe legs hold.', claims: ['probe'] }],
    scope: { read: ['probe.mjs'], write: ['probe.mjs'], forbidden: [] },
    policy: { ref: 'refs/heads/protected', budgetMs: 45_000, reuseEvidence: true },
    obligations: obligations.map(({ id, oracle: oracleKey, cases, subject, expect, witness }) => ({
      id, claim: 'probe', subject, expect, ...(witness ? { witness } : {}), method: 'node-test',
      oracle: oracles[oracleKey], cases, timeoutMs: 5_000, outputs: [],
    })),
  }));
}

function verifyPlan(fixture, task, journal, attempt, onVerdict) {
  return verify({ repo: fixture.repo, task, base: fixture.base, candidate: fixture.candidate,
    oracleRoot: fixture.oracleRoot, scratch: fixture.scratch, deadline: Date.now() + 60_000, journal, attempt, onVerdict });
}

const FAIL_LEGS = [
  { id: 'undef-before', oracle: 'undefValue', cases: ['c1'], subject: 'base', expect: 'FAIL', witness: 'c1' },
  { id: 'undef-vs-null', oracle: 'undefNull', cases: ['c5'], subject: 'candidate', expect: 'FAIL', witness: 'c5' },
  { id: 'nan-vs-null', oracle: 'nanNull', cases: ['c3'], subject: 'candidate', expect: 'FAIL', witness: 'c3' },
  { id: 'null-pass', oracle: 'nullNull', cases: ['c4'], subject: 'candidate', expect: 'PASS' },
  { id: 'marker-exact', oracle: 'marker', cases: ['c6'], subject: 'candidate', expect: 'PASS' },
  { id: 'valid-pass', oracle: 'value', cases: ['c2'], subject: 'candidate', expect: 'PASS' },
];

const EXPECTED_VERDICTS = Object.fromEntries(FAIL_LEGS.map(leg => [leg.id, leg.expect === 'FAIL'
  ? { status: 'FAIL', witness: leg.witness } : { status: 'PASS' }]));

test('unrepresentable subject outputs fail their exact case without aborting siblings', async t => {
  const fixture = await observationFixture(t);
  t.after(fixture.cleanup);
  const receipt = await verifyPlan(fixture, probeTask(fixture, FAIL_LEGS));
  assert.deepEqual(receipt.results.map(result => result.id), FAIL_LEGS.map(leg => leg.id));
  for (const result of receipt.results) {
    const expected = EXPECTED_VERDICTS[result.id];
    assert.equal(result.status, expected.status, result.id);
    if ('witness' in expected) assert.equal(result.witness, expected.witness, result.id);
    assert.deepEqual(result.cases.map(item => [item.id, item.status]),
      FAIL_LEGS.find(leg => leg.id === result.id).cases.map(id => [id, expected.status]));
  }
});

test('a positive PASS expectation over an unrepresentable output completes as a case failure', async t => {
  const fixture = await observationFixture(t);
  t.after(fixture.cleanup);
  const legs = [
    { id: 'undef-after', oracle: 'undefValue', cases: ['c1'], subject: 'candidate', expect: 'PASS' },
    { id: 'valid-pass', oracle: 'value', cases: ['c2'], subject: 'candidate', expect: 'PASS' },
  ];
  const verdicts = [];
  await assert.rejects(verifyPlan(fixture, probeTask(fixture, legs), undefined, undefined,
    verdict => verdicts.push(verdict)), /Unexpected verdict for undef-after/);
  assert.deepEqual(verdicts.map(({ obligation, expected, observed, observedWitness }) =>
    ({ obligation, expected, observed, observedWitness })),
    [{ obligation: 'undef-after', expected: 'PASS', observed: 'FAIL', observedWitness: 'c1' }]);
});

test('structurally broken cached observations are rejected and re-executed', async t => {
  const fixture = await observationFixture(t);
  t.after(fixture.cleanup);
  const journal = new Journal(join(await mkdtemp(join(tmpdir(), 'verity-observation-j-')), 'journal.sqlite'));
  t.after(() => journal.close());
  const task = probeTask(fixture, FAIL_LEGS);
  journal.registerRun('run-observation', [{ id: task.contract.id, approval: task.approval }]);
  const current = journal.startTask('run-observation', task.contract.id);
  const attempt = 'attempt-observation';
  journal.registerAttempt({ id: attempt, contract: task.approval, policy: digest(task.contract.policy), runId: 'run-observation',
    taskId: task.contract.id, claim: current.claim });
  const broken = [
    { version: 1, method: 'node-test', exit: 0, stdout: '', stderr: '', observations: [{ id: 'c1' }] },
    { version: 1, method: 'node-test', exit: 0, stdout: '', stderr: '', observations: [{ id: 'c1', actual: undefined }] },
    { version: 1, method: 'node-test', exit: 0, stdout: '', stderr: '', observations: [{ id: 'other', actual: 42 }] },
    { version: 1, method: 'node-test', exit: 0, stdout: '', stderr: '', observations: [] },
    { version: 1, method: 'node-test', exit: 0, stdout: '', stderr: '', observations: [{ id: 'c1', actual: { unrepresentable: 'undefined' } }] },
  ];
  let offered = 0;
  const observedJournal = {
    authority: journal.authority.bind(journal),
    rememberEvidence: journal.rememberEvidence.bind(journal),
    reusableEvidence: key => {
      assert.ok(key);
      return broken[Math.min(offered++, broken.length - 1)];
    },
  };
  const receipt = await verifyPlan(fixture, task, observedJournal, attempt);
  assert.ok(offered >= broken.length, 'each malformed cached receipt was consulted');
  for (const result of receipt.results) {
    const expected = EXPECTED_VERDICTS[result.id];
    assert.equal(result.status, expected.status, result.id);
    if ('witness' in expected) assert.equal(result.witness, expected.witness, result.id);
  }
});
