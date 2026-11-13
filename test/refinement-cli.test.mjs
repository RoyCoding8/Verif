import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { hash } from '../src/contracts.mjs';
import { buildRefinementChallenge, refinementContractDigest } from '../src/refinement-proof.mjs';

const execute = promisify(execFile);
const cli = resolve('src/cli.mjs');

async function fixture(t) {
  await mkdir(resolve('tmp'), { recursive: true });
  const root = await mkdtemp(resolve('tmp/refinement-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const definitions = 'namespace Scope\ndef Domain := Unit\ndef Accept (_ : Domain) : Prop := True\nend Scope\n';
  const contract = { definitionDigest: hash(definitions), domain: 'Scope.Domain',
    old: { precondition: 'Scope.Accept', guarantee: 'Scope.Accept', assumptions: [] },
    new: { precondition: 'Scope.Accept', guarantee: 'Scope.Accept', assumptions: [] } };
  const source = 'definitions.lean';
  const id = 'unchanged-contract';
  await writeFile(join(root, source), definitions);
  await writeFile(join(root, 'manifest.json'), JSON.stringify({ oracles: '.',
    refinements: [{ id, source, contract, approvedDigest: refinementContractDigest(contract), timeoutMs: 60_000 }] }));
  const { challenge } = buildRefinementChallenge({ contract, trustedDefinitions: definitions });
  const solution = challenge.replace('  sorry\n', '  exact ⟨fun _ h => h, fun _ _ h => h, ⟨(), True.intro⟩⟩\n');
  await writeFile(join(root, 'request.json'), JSON.stringify({ id, solution }));
  return { root, source, run: () => execute(process.execPath, [cli, 'refinement', 'manifest.json', 'request.json'], { cwd: root }) };
}

test('refinement CLI refuses changed controller-owned definitions before proof execution', async t => {
  const { root, source, run } = await fixture(t);
  const path = join(root, source);
  await writeFile(path, (await readFile(path, 'utf8')) + '-- unapproved change\n');
  await assert.rejects(run(), error => error.code === 1 && /Refinement definitions digest changed/.test(error.stderr));
});

test('refinement CLI returns a verified binding from the pinned comparator', {
  skip: process.env.VERITY_LEAN_SMOKE !== '1',
}, async t => {
  const { run } = await fixture(t);
  const { stdout } = await run();
  const result = JSON.parse(stdout);
  assert.equal(result.accepted, true);
  assert.match(result.contractDigest, /^[a-f0-9]{64}$/);
  assert.match(result.theorem, new RegExp(result.contractDigest));
});
