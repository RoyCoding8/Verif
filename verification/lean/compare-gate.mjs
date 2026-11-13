import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createDemo, fixtureWorker } from '../../examples/setup.mjs';
import { digest, approvedTask } from '../../src/contracts.mjs';
import { GitRepo } from '../../src/git.mjs';
import { decide, verify } from '../../src/verify.mjs';

const scratch = resolve('../../tmp');
await mkdir(scratch, { recursive: true });
const root = await mkdtemp(join(scratch, 'gate-comparison-'));
try {
  const settings = await createDemo(root);
  const repo = new GitRepo(settings.repository);
  const base = repo.readRef('refs/heads/protected');
  const workspace = join(root, 'candidate');
  const task = approvedTask(settings.tasks.find(task => task.id === 'messages'));
  repo.fork(base, workspace);
  await fixtureWorker({ workspace, scope: task.contract.scope });
  const candidate = repo.capture(workspace, base);
  await mkdir(settings.scratch, { recursive: true });
  const deadline = Date.now() + 45_000;
  const receipt = await verify({ ...settings, repo, task, base, candidate, deadline });
  const input = {
    task, receipt, base, candidate, deadline, now: deadline - 1,
    authority: { active: true, contract: task.approval, policy: digest(task.contract.policy) },
    manifests: new Map([[candidate, repo.manifest(candidate)]]), changedPaths: ['response.mjs'],
  };
  const invalidate = [
    data => { data.authority.active = false; },
    data => { data.now = data.deadline; },
    data => { data.task.contract.revision += 1; },
    data => { data.receipt.candidate = data.base; },
    data => { data.changedPaths = ['outside-scope']; },
    data => { data.receipt.assurance.message = 'formal'; },
    data => { data.receipt.results[0].keys.run = '0'.repeat(64); },
    data => { data.receipt.results[0].cases[0].status = 'FAIL'; },
    data => { data.receipt.results[0].artifacts.extra = {}; },
  ];
  const reasons = ['Inactive or stale authority', 'Task budget expired', 'Unapproved contract or plan',
    'Receipt identity mismatch', 'Candidate changed paths outside approved scope', 'Receipt assurance mismatch',
    'Stale evidence for decline-message', 'Receipt verdict mismatch', 'Receipt artifact mismatch'];
  for (const [bit, mutate] of invalidate.entries()) {
    const data = structuredClone(input);
    mutate(data);
    assert.deepEqual(decide(data), { promote: false, reason: reasons[bit] });
  }
  const actual = [decide({}).promote];
  for (let mask = 0; mask < 512; mask++) {
    const data = structuredClone(input);
    for (const [bit, mutate] of invalidate.entries()) {
      if (!(mask & (1 << bit))) mutate(data);
    }
    actual.push(decide(data).promote);
  }
  const expected = JSON.parse(await readFile(process.argv[2], 'utf8'));
  assert.equal(expected.filter(Boolean).length, 1, 'the abstract decision has an authorized witness');
  assert.deepEqual(actual, expected);
  console.log('Gate agrees on 512 predicate combinations and a missing bundle');
} finally {
  await rm(root, { recursive: true, force: true });
}
