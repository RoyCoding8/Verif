import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { approve, createDemo, fixtureWorker } from '../examples/setup.mjs';
import { GitRepo } from '../src/git.mjs';
import { runTasks } from '../src/verity.mjs';

const exec = promisify(execFile);

test('exports and verifies a promotion without sharing the journal or private key', async t => {
  const scratch = resolve('tmp');
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, 'attestation-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const settings = await createDemo(root);
  const originalTask = settings.tasks[1];
  const task = approve({ ...originalTask, criteria: [...originalTask.criteria,
    { id: 'manual-review', description: 'Review localization', exception: { risk: 'Private review note' } },
  ] });
  const repo = new GitRepo(settings.repository);
  const original = repo.readRef(task.policy.ref);
  const [promotion] = await runTasks({ ...settings, tasks: [task], worker: fixtureWorker });
  assert.equal(promotion.status, 'promoted', JSON.stringify(promotion));

  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const manifest = join(root, 'manifest.json');
  const envelopeFile = join(root, 'envelope.json');
  const privateKeyFile = join(root, 'private.pem');
  const publicKeyFile = join(root, 'public.pem');
  await Promise.all([
    writeFile(manifest, JSON.stringify({ repository: settings.repository, journal: settings.journalPath })),
    writeFile(privateKeyFile, privateKey.export({ type: 'pkcs8', format: 'pem' })),
    writeFile(publicKeyFile, publicKey.export({ type: 'spki', format: 'pem' })),
  ]);
  const cli = (...args) => exec(process.execPath, ['src/cli.mjs', ...args]);
  const signed = await cli('attest', manifest, promotion.operation, privateKeyFile);
  await writeFile(envelopeFile, signed.stdout);
  const verify = commit => cli('verify-attestation', settings.repository, commit, envelopeFile, publicKeyFile);
  const { stdout } = await verify(promotion.commit);
  const verified = JSON.parse(stdout);
  assert.equal(verified.subject[0].digest.gitCommit, promotion.commit);
  assert.equal(verified.subject[0].digest.gitTree, repo.tree(promotion.commit));
  assert.equal(verified.predicate.operation, promotion.operation);
  assert.deepEqual(verified.predicate.approvedExceptionIds, ['manual-review']);
  assert.doesNotMatch(stdout, /declined-message|journal\.sqlite|Private review note/);
  await assert.rejects(verify(original), error => error.code === 1 && /commit|subject/i.test(error.stderr));
});
