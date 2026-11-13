import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { approve, createDemo } from '../examples/setup.mjs';
import { hash, leanModuleDigests, planVerification } from '../src/contracts.mjs';
import { GitRepo } from '../src/git.mjs';
import { Journal } from '../src/journal.mjs';
import { proposeTask } from '../src/planner.mjs';
import { runTasks } from '../src/verity.mjs';
import { decide } from '../src/verify.mjs';

const theorem = 'Warranty.addZero';
const statement = 'theorem Warranty.addZero (n : Nat) : n + 0 = n';
const solution = 'Proof.lean';
const oracle = { theorem, solution, challenge: statement + ' := by rfl\n' };
const policy = { ref: 'refs/heads/protected', budgetMs: 240_000, maxRepairs: 1 };
const claim = { id: 'identity', statement: 'Adding zero to any natural number leaves it unchanged', required: 'formal' };
const bytes = JSON.stringify(oracle);
const obligation = { id: 'proof', claim: claim.id, method: 'lean-comparator', subject: 'candidate', expect: 'PASS',
  cases: [theorem], oracle: { file: 'proof.json', digest: hash(bytes) }, timeoutMs: 75_000, outputs: ['cases.json'] };
const intent = { id: 'identity', revision: 1, goal: statement, policy,
  scope: { read: [], write: [solution], forbidden: [] }, claims: [claim], obligations: [obligation],
  criteria: [{ id: 'identity', description: claim.statement, claims: [claim.id] }] };

async function fixture(t) {
  const scratch = resolve('tmp');
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, 'lean-obligation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const settings = await createDemo(root);
  const oracleRoot = join(root, 'oracles');
  await mkdir(oracleRoot);
  await writeFile(join(oracleRoot, 'proof.json'), bytes);
  return { ...settings, oracleRoot, tasks: [approve(intent)] };
}

test('Lean plans bind a single named theorem and proposals match the approved oracle format', async t => {
  assert.throws(() => planVerification({ ...intent, obligations: [{ ...obligation, cases: ['bad name'] }] }), /one named theorem/);
  assert.throws(() => planVerification({ ...intent, obligations: [{ ...obligation, expect: 'FAIL', witness: theorem }] }), /expected PASS/);
  const settings = await fixture(t);
  const draft = { ...intent, oracleFiles: ['proof.json'] };
  const propose = method => proposeTask({ ...settings, draft, worker: async ({ workspace, scope, goal }) => {
    assert.ok(goal.includes(theorem));
    await writeFile(join(workspace, scope.write[0]), JSON.stringify({ ...intent, obligations: [
      { ...obligation, method, oracleFile: 'proof.json' },
    ] }));
  } });
  assert.deepEqual((await propose('lean-comparator')).plan, planVerification(intent));
  await assert.rejects(propose('node-test'), /Oracle format does not match method/);
});

test('a changed oracle is refused before a proof can affect the protected ref', async t => {
  const settings = await fixture(t);
  const repo = new GitRepo(settings.repository);
  const head = repo.readRef(policy.ref);
  await writeFile(join(settings.oracleRoot, 'proof.json'), JSON.stringify({ ...oracle, challenge: 'theorem Warranty.addZero : True := by trivial\n' }));
  const [result] = await runTasks({ ...settings, tasks: [approve({ ...intent, policy: { ...policy, maxRepairs: 0 } })],
    worker: ({ workspace }) => writeFile(join(workspace, solution), statement + ' := by rfl\n'),
  });
  assert.equal(result.status, 'refused');
  assert.match(JSON.stringify(result), /Oracle digest changed for proof/);
  assert.equal(repo.readRef(policy.ref), head);
});

test('approved Lean helper source is bound to the plan, proof and final receipt', {
  skip: process.env.VERITY_LEAN_SMOKE !== '1',
}, async t => {
  const settings = await fixture(t);
  const repo = new GitRepo(settings.repository);
  const head = repo.readRef(policy.ref);
  const helper = { name: 'VerityWarranty', source: 'def permitted (n : Nat) : Prop := n + 0 = n\n' };
  const challenge = 'import VerityWarranty\n\ntheorem Warranty.addZero (n : Nat) : permitted n := by rfl\n';
  const packed = JSON.stringify({ ...oracle, challenge, modules: [helper] });
  await writeFile(join(settings.oracleRoot, 'proof.json'), packed);
  const checked = { ...obligation, oracle: { ...obligation.oracle, digest: hash(packed) }, leanModules: leanModuleDigests([helper]) };
  const draft = { ...intent, obligations: [checked], oracleFiles: ['proof.json'], policy: { ...policy, maxRepairs: 0 } };
  const proposal = await proposeTask({ ...settings, draft, worker: async ({ workspace, scope }) => {
    await writeFile(join(workspace, scope.write[0]), JSON.stringify({ ...intent,
      obligations: [{ ...checked, oracleFile: 'proof.json', leanModules: [{ name: 'VerityFake', digest: '0'.repeat(64) }] }] }));
  } });
  assert.deepEqual(proposal.plan.obligations[0].leanModules, checked.leanModules);
  const worker = ({ workspace }) => writeFile(join(workspace, solution), challenge);
  const [refused] = await runTasks({ ...settings, worker, tasks: [approve({ ...draft,
    obligations: [{ ...checked, leanModules: [{ name: helper.name, digest: '0'.repeat(64) }] }] })] });
  assert.match(refused.reason, /Approved Lean module list does not match oracle/);
  assert.equal(repo.readRef(policy.ref), head);
  const [accepted] = await runTasks({ ...settings, worker, tasks: [approve({ ...proposal.intent, revision: 2 })] });
  assert.equal(accepted.status, 'promoted', JSON.stringify(accepted));
  const journal = new Journal(settings.journalPath);
  try {
    const operation = journal.getOperation(accepted.operation);
    const { task, evidence: receipt, base, candidate, deadline } = operation.receipt;
    assert.deepEqual(receipt.results[0].proof.modules, checked.leanModules);
    const gate = { task, receipt, base, candidate, deadline, now: deadline - 1,
      authority: { active: true, contract: operation.contract, policy: operation.policy },
      manifests: new Map([[candidate, repo.manifest(candidate)]]), changedPaths: [solution] };
    assert.deepEqual(decide(gate), { promote: true });
    const corrupted = structuredClone(receipt);
    corrupted.results[0].proof.modules[0].digest = '0'.repeat(64);
    assert.deepEqual(decide({ ...gate, receipt: corrupted }), { promote: false, reason: 'Stale Lean module evidence' });
  } finally {
    journal.close();
  }
});

test('a rejected proof triggers repair and only the accepted proof advances the protected ref', {
  skip: process.env.VERITY_LEAN_SMOKE !== '1',
}, async t => {
  const settings = await fixture(t);
  const repo = new GitRepo(settings.repository);
  const head = repo.readRef(policy.ref);
  let attempts = 0;
  const [result] = await runTasks({ ...settings, worker: async ({ workspace, goal }) => {
    assert.equal(repo.readRef(policy.ref), head);
    attempts++;
    if (attempts === 2) {
      assert.match(goal, /Previous attempt was refused/);
      assert.doesNotMatch(goal, /Unexpected verdict/);
    }
    const source = attempts === 1 ? 'theorem Warranty.addZero : True := by trivial\n' : statement + ' := by rfl\n';
    await writeFile(join(workspace, solution), source);
  } });
  assert.equal(attempts, 2);
  assert.equal(result.status, 'promoted', JSON.stringify(result));
  assert.deepEqual(result.assurance, { identity: 'formal' });
  assert.equal(repo.readRef(policy.ref), result.commit);
  assert.deepEqual(repo.changedPaths(head, result.commit), [solution]);

  const journal = new Journal(settings.journalPath);
  try {
    const operation = journal.getOperation(result.operation);
    const { task, evidence: receipt, base, candidate, deadline } = operation.receipt;
    assert.equal(receipt.results[0].observation.exit, 0);
    assert.deepEqual(receipt.results[0].cases, [{ id: theorem, status: 'PASS' }]);
    const decision = { task, receipt, base, candidate, deadline, now: deadline - 1,
      authority: { active: true, contract: operation.contract, policy: operation.policy },
      manifests: new Map([[candidate, repo.manifest(result.commit)]]), changedPaths: [solution] };
    assert.deepEqual(decide(decision), { promote: true });
    const corrupted = structuredClone(receipt);
    corrupted.results[0].observation.exit = 1;
    assert.equal(decide({ ...decision, receipt: corrupted }).promote, false);
    assert.equal(decide({ ...decision, manifests: new Map([[candidate, repo.manifest(head)]]) }).promote, false);
  } finally {
    journal.close();
  }
});
