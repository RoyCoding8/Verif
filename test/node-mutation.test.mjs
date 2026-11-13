import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { approve, createDemo } from '../examples/setup.mjs';
import { hash } from '../src/contracts.mjs';
import { GitRepo } from '../src/git.mjs';
import { Journal } from '../src/journal.mjs';
import { checkMutationRun } from '../src/node-mutation.mjs';
import { runTasks } from '../src/verity.mjs';

test('mutation decisions match the finite witness and threshold rule', () => {
  const cases = [{ id: 'cap', expected: 0 }, { id: 'other', expected: 0 }];
  const path = 'limit.mjs';
  const mutants = [{ id: 'a', path, witness: 'cap' }, { id: 'b', path, witness: 'other' }];
  const vectors = [[0, 0], [1, 0], [0, 1], [1, 1], [undefined, 0]];
  const observations = values => cases.map(({ id }, i) => ({ id, actual: values[i] }));
  for (const a of vectors) for (const b of vectors) for (const minimumKills of [1, 2]) {
    const run = { pristine: observations(vectors[0]), mutants: mutants.map(({ id }, i) => ({
      id, digest: 'f'.repeat(64), cases: observations([a, b][i]),
    })) };
    const judge = () => checkMutationRun({ cases, mutants, minimumKills }, run, [path]);
    const kills = Number(a === vectors[1]) + Number(b === vectors[2]);
    if ([vectors[0], vectors[1]].includes(a) && [vectors[0], vectors[2]].includes(b) && kills >= minimumKills) {
      assert.equal(judge().filter(result => result.status === 'killed').length, kills);
    } else {
      assert.throws(judge);
    }
  }
});

test('a real killed mutant and survivor satisfy only the approved threshold', async t => {
  const scratch = resolve('tmp');
  await mkdir(scratch, { recursive: true });
  const folder = await mkdtemp(join(scratch, 'node-mutation-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const fixture = await createDemo(folder);
  const oracleRoot = join(folder, 'oracles');
  await mkdir(oracleRoot);
  const ref = 'refs/heads/protected';
  const repo = new GitRepo(fixture.repository);
  const head = repo.readRef(ref);
  const run = async (id, minimumKills, witness = 'cap') => {
    const bytes = JSON.stringify({ kind: 'node-mutation-v1', minimumKills,
      cases: [
        { id: 'cap', module: 'limit.mjs', name: 'cap', args: [11], expected: 10 },
        { id: 'unchanged', module: 'limit.mjs', name: 'cap', args: [4], expected: 4 },
      ],
      mutants: [
        { id: 'remove-cap', path: 'limit.mjs', before: 'n > 10 ? 10 : n', after: 'n', witness },
        { id: 'same-value', path: 'limit.mjs', before: '? 10 :', after: '? (5 + 5) :', witness: 'cap' },
      ] });
    await writeFile(join(oracleRoot, 'mutants.json'), bytes);
    return (await runTasks({ ...fixture, oracleRoot, tasks: [approve({
      id, revision: 1, goal: 'Cap the output at ten.', scope: { read: [], write: ['limit.mjs'], forbidden: [] },
      policy: { ref, budgetMs: 60_000 }, claims: [{ id: 'cap', statement: 'Output is capped', required: 'tested' }],
      criteria: [{ id: 'acceptance', description: 'Cap check detects regressions', claims: ['cap'] }],
      obligations: [{ id: 'mutate', claim: 'cap', method: 'node-mutation', subject: 'candidate', expect: 'PASS',
        oracle: { file: 'mutants.json', digest: hash(bytes) }, cases: ['cap', 'unchanged'],
        outputs: ['cases.json'], timeoutMs: 35_000 }],
    })], worker: ({ workspace }) => writeFile(join(workspace, 'limit.mjs'),
      'export const cap = n => n > 10 ? 10 : n;\n') }))[0];
  };
  assert.match((await run('strict-mutation', 2)).reason, /kill threshold unmet/);
  assert.match((await run('wrong-witness', 1, 'unchanged')).reason, /Unrelated failure/);
  assert.equal(repo.readRef(ref), head);
  const accepted = await run('approved-mutation', 1);
  assert.equal(accepted.status, 'promoted', accepted.reason);
  const journal = new Journal(fixture.journalPath);
  try {
    const evidence = journal.getOperation(accepted.operation).receipt.evidence.results[0];
    const { results } = evidence.mutation;
    assert.deepEqual(results.map(({ id, status }) => [id, status]), [['remove-cap', 'killed'], ['same-value', 'survived']]);
    assert.notEqual(results[0].digest, results[1].digest);
    assert.deepEqual(JSON.parse(Buffer.from(evidence.artifacts['cases.json'].base64, 'base64')).mutants, results);
  } finally {
    journal.close();
  }
});
