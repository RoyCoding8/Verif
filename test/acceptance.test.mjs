import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { approve, createDemo, fixtureWorker } from '../examples/setup.mjs';
import { planVerification } from '../src/contracts.mjs';
import { GitRepo } from '../src/git.mjs';
import { Journal } from '../src/journal.mjs';
import { runTasks } from '../src/verity.mjs';

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
    const receipt = journal.getOperation(results[0].operation).receipt.evidence;
    assert.deepEqual(receipt.results.map(result => [result.status, result.witness]), [['FAIL', '0/1'], ['PASS', null]]);
    assert.equal(receipt.results[1].cases.length, 15);
    assert.ok(receipt.results[1].artifacts['cases.json'].digest);
  } finally {
    journal.close();
  }
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
