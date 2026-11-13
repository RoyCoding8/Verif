import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { approve } from '../examples/setup.mjs';
import { approvedTask } from '../src/contracts.mjs';

const run = promisify(execFile);

test('the CLI returns a bound successor from the principal-approved predecessor', async t => {
  const tmp = resolve('tmp');
  await mkdir(tmp, { recursive: true });
  const directory = await mkdtemp(join(tmp, 'delegation-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const manifest = join(directory, 'manifest.json');
  const proposal = join(directory, 'proposal.json');
  const parent = approve({
    id: 'test', revision: 1, goal: 'Keep the approved behavior',
    policy: { ref: 'refs/heads/protected', budgetMs: 5000, delegation: 'monotonic' },
    scope: { read: ['src'], write: ['src'], forbidden: ['src/authority.mjs'] },
    criteria: [{ id: 'criteria', description: 'Expected output', claims: ['claim'] }],
    claims: [{ id: 'claim', statement: 'Approved behavior', required: 'tested' }],
    obligations: [{ id: 'check', claim: 'claim', subject: 'candidate', expect: 'PASS', method: 'node-test',
      oracle: { file: 'checks.json', digest: '0'.repeat(64) }, cases: ['one'], timeoutMs: 1000 }],
  });
  const proposed = { ...parent, revision: 2, approval: 'untrusted', scope: { ...parent.scope, write: ['src/behavior.mjs'] } };
  const cli = ['src/cli.mjs', 'delegate', manifest, proposal];
  const original = JSON.stringify({ tasks: [parent] });
  await writeFile(manifest, original);
  await writeFile(proposal, JSON.stringify(proposed));
  const { stdout } = await run(process.execPath, cli);
  const { task, revisionBinding } = JSON.parse(stdout);
  assert.equal(approvedTask(task).approval, task.approval);
  assert.equal(task.revision, 2);
  assert.deepEqual(task.scope.write, ['src/behavior.mjs']);
  assert.equal(revisionBinding.predecessorApproval, parent.approval);
  assert.equal(revisionBinding.successorApproval, task.approval);
  assert.equal(await readFile(manifest, 'utf8'), original);

  await writeFile(proposal, JSON.stringify({ ...proposed, scope: { ...proposed.scope, write: ['outside'] } }));
  await assert.rejects(run(process.execPath, cli), error => error.code === 1 && /scope|write/i.test(error.stderr));
  await writeFile(proposal, JSON.stringify(proposed));
  await writeFile(manifest, JSON.stringify({ tasks: [{ ...parent, approval: 'forged' }] }));
  await assert.rejects(run(process.execPath, cli), error => error.code === 1 && /approval/i.test(error.stderr));
});
