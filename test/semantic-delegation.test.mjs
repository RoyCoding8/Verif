import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { approve, createDemo } from '../examples/setup.mjs';
import { approvedTask, hash } from '../src/contracts.mjs';
import { leanClaimChallenge } from '../src/lean-claim.mjs';
import { runTasks } from '../src/verity.mjs';

const execute = promisify(execFile);
const cli = resolve('src/cli.mjs');
const definitions = `namespace Law
def Pold (x : Bool) : Prop := x = true
def Pnew (_ : Bool) : Prop := True
def Qold (_ : Bool) : Prop := True
def Qnew (x : Bool) : Prop := x = true
def Implements (x : Bool) : Prop := x = true
end Law
`;

async function fixture(t) {
  await mkdir('tmp', { recursive: true });
  const root = await mkdtemp(resolve('tmp/semantic-delegation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const base = join(root, 'fixture');
  await mkdir(base);
  const settings = await createDemo(base);
  const oracleRoot = join(root, 'oracles');
  await mkdir(oracleRoot);
  const source = 'frozen.lean';
  await writeFile(join(oracleRoot, source), definitions);
  const common = { source, definitionDigest: hash(definitions), domain: 'Bool', implementation: 'Law.Implements', assumptions: [] };
  const old = { ...common, precondition: 'Law.Pold', guarantee: 'Law.Qold', obligation: 'old-proof' };
  const next = { ...common, precondition: 'Law.Pnew', guarantee: 'Law.Qnew', obligation: 'new-proof' };
  async function obligation(id, theorem, solution, binding, wrong = false) {
    const file = id + '.json';
    const challenge = wrong ? `theorem ${theorem} : True := by trivial\n` : leanClaimChallenge(binding, theorem, definitions);
    const oracle = JSON.stringify({ theorem, solution, challenge });
    await writeFile(join(oracleRoot, file), oracle);
    return { id, claim: 'law', subject: 'candidate', expect: 'PASS', method: 'lean-comparator', timeoutMs: 90_000,
      cases: [theorem], oracle: { file, digest: hash(oracle) } };
  }
  const claims = lean => [{ id: 'law', statement: 'The approved law holds', required: 'formal', lean }];
  const oldProof = await obligation(old.obligation, 'Law.oldProof', 'Old.lean', old);
  const parent = approve({ id: 'law', revision: 1, goal: 'Prove the law', claims: claims(old), obligations: [oldProof],
    scope: { read: [], write: ['Old.lean', 'New.lean'], forbidden: [] },
    criteria: [{ id: 'law', description: 'Prove the law', claims: ['law'] }],
    policy: { ref: 'refs/heads/protected', budgetMs: 240_000, delegation: 'monotonic' } });
  const proposal = { ...parent, revision: 2, claims: claims(next), obligations: [oldProof,
    await obligation(next.obligation, 'Law.newProof', 'New.lean', next)] };
  await writeFile(join(root, 'manifest.json'), JSON.stringify({ tasks: [parent] }));
  const delegate = async (task, solution) => {
    await writeFile(join(root, 'proposal.json'), JSON.stringify({ task, witness: { claim: 'law', solution } }));
    const { stdout } = await execute(process.execPath, [cli, 'delegate', 'manifest.json', 'proposal.json'], { cwd: root });
    return JSON.parse(stdout);
  };
  return { settings: { ...settings, oracleRoot }, proposal, old, next, obligation, delegate };
}

test('semantic delegation challenge binds the revision and refuses an unrelated successor oracle', async t => {
  const { proposal, next, obligation, delegate } = await fixture(t);
  const prepared = await delegate(proposal);
  const changed = { ...proposal, policy: { ...proposal.policy, budgetMs: proposal.policy.budgetMs - 1 } };
  assert.notEqual((await delegate(changed)).theorem, prepared.theorem);
  assert.equal(Object.hasOwn(prepared, 'approval'), false);
  const wrong = await obligation(next.obligation, 'Law.newProof', 'New.lean', next, true);
  await assert.rejects(delegate({ ...proposal, obligations: [proposal.obligations[0], wrong] }), /does not prove the bound claim/);
});

test('checked semantic delegation issues only the bound revision and its proofs promote', {
  skip: process.env.VERITY_LEAN_SMOKE !== '1',
}, async t => {
  const { settings, proposal, old, next, delegate } = await fixture(t);
  const { challenge, binding } = await delegate(proposal);
  const solution = challenge.replace('  sorry\n', '  exact ⟨fun _ _ => True.intro, fun _ _ _ => True.intro, ⟨true, rfl⟩⟩\n');
  const revised = await delegate(proposal, solution);
  assert.equal(approvedTask(revised.task).approval, binding.successorApproval);
  assert.equal(revised.revisionBinding.predecessorApproval, binding.predecessorApproval);
  const changed = { ...proposal, policy: { ...proposal.policy, budgetMs: proposal.policy.budgetMs - 1 } };
  await assert.rejects(delegate(changed, solution), /Semantic refinement witness refused/);
  const proof = (binding, theorem, term) => leanClaimChallenge(binding, theorem, definitions).replace('  sorry\n', '  exact ' + term + '\n');
  const [result] = await runTasks({ ...settings, tasks: [revised.task], worker: async ({ workspace }) => {
    await writeFile(join(workspace, 'Old.lean'), proof(old, 'Law.oldProof', 'fun _ _ _ => True.intro'));
    await writeFile(join(workspace, 'New.lean'), proof(next, 'Law.newProof', 'fun _ _ h => h'));
  } });
  assert.equal(result.status, 'promoted', JSON.stringify(result));
  assert.deepEqual(result.assurance, { law: 'formal' });
});
