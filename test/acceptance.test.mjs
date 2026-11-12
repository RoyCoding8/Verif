import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { approve, createDemo, fixtureWorker } from '../examples/setup.mjs';
import { planVerification } from '../src/contracts.mjs';
import { GitRepo } from '../src/git.mjs';
import { Journal } from '../src/journal.mjs';
import { proposeTask } from '../src/planner.mjs';
import { inspectRun, runTasks } from '../src/verity.mjs';
import { decide } from '../src/verify.mjs';

async function fixture(t) {
  const scratch = resolve('tmp');
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, 'acceptance-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return createDemo(root);
}

test('parallel candidates integrate against current head and unlock the dependent task', async t => {
  const settings = await fixture(t);
  const repo = new GitRepo(settings.repository);
  const initial = repo.readRef('refs/heads/protected');
  let inProgress = 0;
  let peak = 0;
  const results = await runTasks({
    ...settings,
    worker: async job => {
      inProgress++;
      peak = Math.max(peak, inProgress);
      await setTimeout(30);
      await fixtureWorker(job);
      inProgress--;
    },
  });
  assert.deepEqual(results.map(result => result.status), ['promoted', 'promoted', 'promoted'], JSON.stringify(results));
  assert.equal(peak, 2);
  assert.deepEqual(results[2].assurance, { stock: 'bounded', api: 'tested' });
  const head = repo.readRef('refs/heads/protected');
  assert.equal(head, results[2].commit);
  assert.deepEqual(repo.changedPaths(initial, head), ['api.mjs', 'reserve.mjs', 'response.mjs']);
  const journal = new Journal(settings.journalPath);
  try {
    const operation = journal.getOperation(results[0].operation);
    const { evidence: receipt, task, base, candidate, deadline } = operation.receipt;
    assert.deepEqual(receipt.results.map(result => [result.status, result.witness]), [['FAIL', '0/1'], ['PASS', null]]);
    assert.equal(receipt.results[1].cases.length, 15);
    assert.ok(receipt.results[1].artifacts['cases.json'].digest);
    const decisionInput = {
      task, receipt, base, candidate, now: deadline - 1, deadline,
      authority: { active: true, contract: operation.contract, policy: operation.policy },
      manifests: new Map(receipt.results.map(result => [result.commit, result.manifest])),
      changedPaths: ['reserve.mjs'],
    };
    assert.deepEqual(decide(decisionInput), { promote: true });
    const modified = structuredClone(receipt);
    modified.results[1].artifacts['cases.json'].base64 = 'dGFtcGVyZWQ=';
    assert.deepEqual(decide({ ...decisionInput, receipt: modified }), { promote: false, reason: 'Receipt artifact mismatch' });
    modified.results[1].manifest.files[0].digest = '0'.repeat(64);
    assert.deepEqual(decide({ ...decisionInput, receipt: modified }), { promote: false, reason: 'Stale evidence for stock-after' });
  } finally {
    journal.close();
  }
  assert.deepEqual(inspectRun(settings).tasks.map(task => task.status), ['promoted', 'promoted', 'promoted']);
  const replay = await runTasks({
    ...settings,
    worker: async () => assert.fail('A completed approved run must not dispatch a worker again'),
  });
  assert.deepEqual(replay, results);
});

test('out-of-scope edit and failed oracle do not advance the protected ref', async t => {
  const settings = await fixture(t);
  const repo = new GitRepo(settings.repository);
  const head = repo.readRef('refs/heads/protected');
  const results = await runTasks({
    ...settings,
    worker: async job => {
      if (job.scope.write[0] === 'reserve.mjs') {
        await fixtureWorker(job);
        await writeFile(join(job.workspace, 'out-of-scope'), 'scope error');
      } else {
        await writeFile(join(job.workspace, 'response.mjs'), "export const response = () => 'Wrong';\n");
      }
    },
  });
  assert.deepEqual(results.map(result => result.status), ['refused', 'refused', 'blocked']);
  assert.match(results[0].reason, /outside approved scope/);
  assert.match(results[1].reason, /Unexpected verdict/);
  assert.equal(repo.readRef('refs/heads/protected'), head);
});

test('verification rejects a non-discriminating baseline and an infeasible assurance plan', async t => {
  const settings = await fixture(t);
  const task = structuredClone(settings.tasks[0]);
  task.obligations[0].witness = '1/1';
  const [result] = await runTasks({ ...settings, tasks: [approve(task)], worker: fixtureWorker });
  assert.equal(result.status, 'refused');
  assert.match(result.reason, /Wrong failure witness/);
  task.claims[0].required = 'formal';
  assert.throws(() => planVerification(task), /Insufficient assurance/);
});

test('planner binds approved oracle bytes without granting task approval', async t => {
  const settings = await fixture(t);
  const draft = { ...settings.tasks[1], oracleFiles: ['messages.json'] };
  const original = draft.obligations[0];
  const worker = async ({ workspace, scope, goal }) => {
    assert.match(goal, /declined-message/);
    assert.doesNotMatch(goal, /"expected"/);
    await writeFile(join(workspace, scope.write[0]), JSON.stringify({
      criteria: draft.criteria,
      claims: draft.claims,
      obligations: [{ ...original, oracleFile: 'messages.json', oracle: { digest: 'agent supplied' } }],
    }));
  };
  const proposal = await proposeTask({ ...settings, draft, worker });
  assert.equal(proposal.intent.approval, undefined);
  assert.deepEqual(proposal.plan.obligations[0].oracle, original.oracle);
  await assert.rejects(runTasks({ ...settings, tasks: [proposal.intent], worker }), /principal approval/);
});
