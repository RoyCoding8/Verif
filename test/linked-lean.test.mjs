import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { approve, createDemo } from '../examples/setup.mjs';
import { hash, leanModuleDigests } from '../src/contracts.mjs';
import { GitRepo } from '../src/git.mjs';
import { Journal } from '../src/journal.mjs';
import { resolveProofDependencies } from '../src/proof-dependencies.mjs';
import { decide } from '../src/verify.mjs';
import { runTasks } from '../src/verity.mjs';

const upstream = 'theorem Link.upstream (n : Nat) : n + 0 = n := by rfl\n';
const downstream = 'theorem Link.downstream (n : Nat) : n + 0 + 0 = n := by\n  rw [Link.upstream (n + 0), Link.upstream n]\n';

async function fixture(t, mode) {
  await mkdir('tmp', { recursive: true });
  const root = await mkdtemp(resolve('tmp/linked-lean-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const settings = await createDemo(root);
  const oracleRoot = join(root, 'oracles');
  await mkdir(oracleRoot);
  const helper = { name: 'VerityLinked', source: 'def linkedResult (n : Nat) : Prop := n + 0 = n\n' };
  async function task(id, source, challenge, dependencies = [], links) {
    const theorem = 'Link.' + id;
    const file = id + '.json';
    const modules = mode === 'module-changed' && links ? [{ ...helper, source: helper.source + '-- changed\n' }] : [helper];
    const oracle = JSON.stringify({ theorem, solution: source, challenge, modules });
    await writeFile(join(oracleRoot, file), oracle);
    return { id, revision: 1, goal: 'Prove ' + theorem, dependencies,
      scope: { read: ['Up.lean'], write: mode === 'changed' && links ? [source, 'Up.lean'] : [source], forbidden: [] },
      policy: { ref: 'refs/heads/protected', budgetMs: 180_000 },
      criteria: [{ id, description: theorem, claims: [id] }],
      claims: [{ id, statement: theorem, required: 'formal' }],
      obligations: [{ id, claim: id, subject: 'candidate', expect: 'PASS', method: 'lean-comparator', timeoutMs: 110_000,
        cases: [theorem], oracle: { file, digest: hash(oracle) }, leanModules: leanModuleDigests(modules),
        ...(links ? { proofDependencies: links } : {}) }] };
  }
  const first = await task('upstream', 'Up.lean', upstream);
  const sealed = mode === 'drift'
    ? 'theorem Link.upstream : True := by trivial\ntheorem Link.downstream (n : Nat) : n + 0 + 0 = n := by rfl\n'
    : upstream + downstream;
  const second = await task('downstream', 'Down.lean', sealed, ['upstream'], [
    { task: 'upstream', obligation: mode === 'missing' ? 'absent' : 'upstream', theorem: 'Link.upstream' },
  ]);
  return { settings: { ...settings, oracleRoot }, first, second };
}

test('a linked proof plan must name a direct task prerequisite', async t => {
  const { second } = await fixture(t);
  assert.throws(() => approve({ ...second, dependencies: [] }), /direct prerequisite/);
});

test('controller composes promoted Lean evidence and refuses missing, changed, or incompatible prerequisites', {
  skip: process.env.VERITY_LEAN_SMOKE !== '1',
}, async t => {
  for (const mode of ['valid', 'missing', 'changed', 'drift', 'module-changed']) {
    await t.test(mode, async t => {
      const { settings, first, second } = await fixture(t, mode);
      const tasks = [approve(first), approve(second)];
      const results = await runTasks({ ...settings, tasks, worker: async ({ workspace, scope }) => {
        const file = scope.write[0];
        await writeFile(join(workspace, file), file === 'Up.lean' ? upstream : downstream);
        if (scope.write.length > 1) await writeFile(join(workspace, 'Up.lean'), upstream + '-- changed\n');
      } });
      assert.equal(results[0].status, 'promoted', JSON.stringify(results));
      const head = new GitRepo(settings.repository).readRef('refs/heads/protected');
      if (mode !== 'valid') {
        const reasons = { missing: /lacks the approved theorem/, changed: /changed prerequisite proof source/, drift: /Unexpected verdict/,
          'module-changed': /Missing or changed prerequisite Lean module/ };
        assert.equal(results[1].status, 'refused', JSON.stringify(results));
        assert.match(results[1].reason, reasons[mode]);
        assert.equal(head, results[0].commit);
        return;
      }
      assert.equal(results[1].status, 'promoted', JSON.stringify(results));
      assert.equal(head, results[1].commit);
      const journal = new Journal(settings.journalPath);
      try {
        const operation = journal.getOperation(results[1].operation);
        const { evidence, task, base, candidate, deadline, runId, prerequisites } = operation.receipt;
        assert.deepEqual(evidence.results[0].proof.theorems, ['Link.upstream', 'Link.downstream']);
        assert.deepEqual(evidence.results[0].proof.sources.map(source => source.path), ['Up.lean', 'Down.lean']);
        const repo = new GitRepo(settings.repository);
        const dependencies = resolveProofDependencies(task, runId, prerequisites, journal);
        const input = { task, receipt: evidence, base, candidate, deadline, now: deadline - 1,
          authority: { active: true, contract: operation.contract, policy: operation.policy }, changedPaths: ['Down.lean'],
          manifests: new Map([[candidate, repo.manifest(operation.next)]]), proofDependencies: dependencies };
        assert.deepEqual(decide(input), { promote: true });
        dependencies.get('downstream')[0].receipt = '0'.repeat(64);
        assert.deepEqual(decide(input), { promote: false, reason: 'Stale proof dependency for downstream' });
      } finally {
        journal.close();
      }
    });
  }
});
