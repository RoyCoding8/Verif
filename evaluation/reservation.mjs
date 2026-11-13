import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { approve, createDemo } from '../examples/setup.mjs';
import { approvedTask, hash } from '../src/contracts.mjs';
import { GitRepo } from '../src/git.mjs';
import { verify } from '../src/verify.mjs';
import { runTasks } from '../src/verity.mjs';

const ref = 'refs/heads/protected';
const module = 'response.mjs';
const expected = 'Reservation declined';
const probes = [
  { id: 'correct', source: `export const response = status => status === 'declined' ? '${expected}' : status;\n` },
  { id: 'overfit', source: `export const response = () => '${expected}';\n` },
  { id: 'wrong-output', source: "export const response = () => 'wrong';\n", refusal: 'Unexpected verdict for decline-message' },
  { id: 'scope-violation', source: `export const response = status => status === 'declined' ? '${expected}' : status;\n`,
    extra: true, refusal: 'Candidate has no changes or changed paths outside approved scope' },
];

async function approvedOracle(root, task, checks) {
  await mkdir(root);
  const bytes = JSON.stringify(checks);
  const file = 'checks.json';
  await writeFile(join(root, file), bytes);
  return approve({ ...task, obligations: [{ ...task.obligations[0], cases: checks.map(check => check.id), oracle: { file, digest: hash(bytes) } }] });
}

function oracleCase(id, argument, expected) {
  return { id, module, name: 'response', args: [argument], expected };
}

async function trial(root, arm, probe) {
  await mkdir(root);
  const settings = await createDemo(root);
  const repo = new GitRepo(settings.repository);
  const base = repo.readRef(ref);
  const task = settings.tasks.find(task => task.id === 'messages');
  const gateRoot = join(root, 'acceptance');
  const shadowRoot = join(root, 'shadow');
  const gateTask = await approvedOracle(gateRoot, task, [oracleCase('acceptance-declined', 'declined', expected)]);
  const shadowTask = await approvedOracle(shadowRoot, task, [
    oracleCase('shadow-accepted', 'accepted', 'accepted'),
    oracleCase('shadow-arbitrary', 'pending', 'pending'),
  ]);
  let candidate;
  const worker = async ({ workspace }) => {
    await writeFile(join(workspace, module), probe.source);
    if (probe.extra) await writeFile(join(workspace, 'outside-scope'), 'extra change\n');
    candidate = repo.capture(workspace, base);
  };
  let admitted;
  if (arm === 'verity') {
    const [result] = await runTasks({ ...settings, tasks: [gateTask], oracleRoot: gateRoot, worker, maxWorkers: 1 });
    admitted = result.status === 'promoted';
    if (admitted) {
      assert.equal(repo.readRef(ref), result.commit);
      candidate = result.commit;
    } else {
      assert.equal(result.reason, probe.refusal, 'Unexpected refusal in ' + probe.id);
      assert.equal(repo.readRef(ref), base);
    }
  } else {
    const workspace = join(root, 'worker');
    repo.fork(base, workspace);
    await worker({ workspace });
    admitted = true;
  }
  if (!candidate) throw new Error('No candidate to evaluate for ' + probe.id);
  await mkdir(settings.scratch, { recursive: true });
  let correct = true;
  try {
    await verify({ repo, task: approvedTask(shadowTask), base, candidate, oracleRoot: shadowRoot,
      scratch: settings.scratch, deadline: Date.now() + shadowTask.policy.budgetMs });
  } catch (error) {
    if (error.message !== 'Unexpected verdict for ' + shadowTask.obligations[0].id) throw error;
    correct = false;
  }
  return { arm, probe: probe.id, admitted, correct };
}

async function evaluateReservation(parent) {
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'reservation-eval-'));
  try {
    const rows = [];
    for (const arm of ['verity', 'baseline']) {
      for (const probe of probes) rows.push(await trial(join(root, arm + '-' + probe.id), arm, probe));
    }
    return Object.fromEntries(['verity', 'baseline'].map(arm => {
      const counts = { admittedCorrect: 0, admittedDefective: 0, refusedCorrect: 0, refusedDefective: 0 };
      for (const { admitted, correct } of rows.filter(row => row.arm === arm)) {
        counts[(admitted ? 'admitted' : 'refused') + (correct ? 'Correct' : 'Defective')]++;
      }
      return [arm, counts];
    }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const results = await evaluateReservation(resolve('tmp'));
assert.deepEqual(results, {
  verity: { admittedCorrect: 1, admittedDefective: 1, refusedCorrect: 1, refusedDefective: 1 },
  baseline: { admittedCorrect: 2, admittedDefective: 2, refusedCorrect: 0, refusedDefective: 0 },
});
console.log(JSON.stringify(results, null, 2));
