import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { approve, createDemo } from '../examples/setup.mjs';
import { approvedTask, digest, hash } from '../src/contracts.mjs';
import { GitRepo } from '../src/git.mjs';
import { decide, verify } from '../src/verify.mjs';
import { runTasks } from '../src/verity.mjs';

async function fixture(t, candidateSource, baseSource = 'export function value(n) { return { a: n, b: 2 }; }\n') {
  const scratch = resolve('tmp', 'differential-route');
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, 'case-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const settings = await createDemo(root);
  await mkdir(settings.scratch, { recursive: true });
  const oracleRoot = join(root, 'oracles');
  await mkdir(oracleRoot);
  const repo = new GitRepo(settings.repository);
  const base = repo.readRef('refs/heads/protected');
  const baseWorkspace = join(root, 'base-workspace');
  repo.fork(base, baseWorkspace);
  await writeFile(join(baseWorkspace, 'probe.mjs'), baseSource);
  const baseCommit = repo.capture(baseWorkspace, base);
  const candidateWorkspace = join(root, 'candidate-workspace');
  repo.fork(baseCommit, candidateWorkspace);
  await writeFile(join(candidateWorkspace, 'probe.mjs'), candidateSource);
  const candidate = repo.capture(candidateWorkspace, baseCommit);
  const oracleBytes = Buffer.from(JSON.stringify([{ id: 'value', module: 'probe.mjs', name: 'value', args: [7] }]));
  await writeFile(join(oracleRoot, 'cases.json'), oracleBytes);
  const intent = {
    id: 'differential-route', revision: 1,
    goal: 'Preserve all approved finite outputs while refactoring the implementation.', base: baseCommit,
    scope: { read: ['probe.mjs'], write: ['probe.mjs'], forbidden: [] },
    policy: { ref: 'refs/heads/protected', budgetMs: 30_000, reuseEvidence: true },
    claims: [{ id: 'outputs', statement: 'Every approved case has the same output as the base.', required: 'tested' }],
    criteria: [{ id: 'preservation', description: 'Approved outputs are preserved.', claims: ['outputs'] }],
    obligations: [{ id: 'compare', claim: 'outputs', subject: 'candidate', expect: 'PASS', method: 'node-differential',
      oracle: { file: 'cases.json', digest: hash(oracleBytes) }, cases: ['value'], timeoutMs: 8_000, outputs: ['cases.json'] }],
  };
  const task = approvedTask(approve(intent));
  return { settings, repo, base: baseCommit, candidate, oracleRoot, task, intent };
}

async function evidenceFor(f, candidate = f.candidate) {
  return verify({ repo: f.repo, task: f.task, base: f.base, candidate, oracleRoot: f.oracleRoot,
    scratch: f.settings.scratch, deadline: Date.now() + 20_000 });
}

function decisionInput(f, receipt) {
  return { task: f.task, receipt, base: f.base, candidate: f.candidate, now: Date.now(), deadline: Date.now() + 10_000,
    authority: { active: true, contract: f.task.approval, policy: digest(f.task.contract.policy) },
    manifests: new Map([[f.base, f.repo.manifest(f.base)], [f.candidate, f.repo.manifest(f.candidate)]]),
    changedPaths: ['probe.mjs'] };
}

test('a refactor with equal base outputs passes and stale baseline identity is rejected', async t => {
  const f = await fixture(t, 'export function value(n) { return { b: 2, a: n }; }\n');
  const receipt = await evidenceFor(f);
  assert.equal(receipt.results[0].status, 'PASS');
  assert.deepEqual(receipt.results[0].cases, [{ id: 'value', status: 'PASS' }]);
  assert.deepEqual(receipt.results[0].differential.comparisons, [{ id: 'value', baseOutput: { a: 7, b: 2 }, candidateOutput: { a: 7, b: 2 } }]);
  assert.deepEqual(receipt.results[0].artifacts['cases.json'] && JSON.parse(Buffer.from(receipt.results[0].artifacts['cases.json'].base64, 'base64')),
    { cases: [{ id: 'value', status: 'PASS' }], comparisons: receipt.results[0].differential.comparisons });
  assert.equal(receipt.results[0].keys.run.length, 64);
  const input = decisionInput(f, receipt);
  assert.deepEqual(decide(input), { promote: true });
  const stale = structuredClone(receipt);
  stale.results[0].differential.manifest.tree = '0'.repeat(40);
  assert.match(decide({ ...input, receipt: stale }).reason, /Differential baseline identity mismatch/);
});

test('different outputs fail, and a false positive verdict cannot override the observations', async t => {
  const f = await fixture(t, 'export function value(n) { return { b: 2, a: n }; }\n');
  const receipt = await evidenceFor(f);
  const input = decisionInput(f, receipt);
  const falsePositive = structuredClone(receipt);
  falsePositive.results[0].differential.comparisons[0].candidateOutput.b = 3;
  assert.match(decide({ ...input, receipt: falsePositive }).reason, /Differential verdict mismatch/);
});

test('different candidate outputs refuse the approved PASS obligation', async t => {
  const f = await fixture(t, 'export function value(n) { return { a: n, b: 3 }; }\n');
  await assert.rejects(evidenceFor(f), /Unexpected verdict for compare/);
});

test('lossy JavaScript outputs are rejected instead of comparing their JSON coercions', async t => {
  const f = await fixture(t, 'export function value() { return null; }\n', 'export function value() { return NaN; }\n');
  await assert.rejects(evidenceFor(f), /Operation output must be JSON/);
});

test('runTasks compares the dispatch base with its exact integrated candidate', async t => {
  const source = 'export function value(n) { return { b: 2, a: n }; }\n';
  const f = await fixture(t, source);
  const results = await runTasks({ ...f.settings, oracleRoot: f.oracleRoot,
    tasks: [{ ...f.intent, approval: f.task.approval }], worker: async ({ workspace }) => {
    await writeFile(join(workspace, 'probe.mjs'), source);
  } });
  assert.equal(results[0].status, 'promoted', JSON.stringify(results[0]));
  assert.equal(results[0].assurance.outputs, 'tested');
});

test('differential obligations reject projections and non-candidate expectations', async t => {
  const f = await fixture(t, 'export function value(n) { return { a: n, b: 2 }; }\n');
  const obligation = f.task.plan.obligations[0];
  assert.throws(() => approvedTask(approve({ ...f.intent,
    obligations: [{ ...obligation, inputPaths: ['probe.mjs'] }] })), /full snapshot/);
  assert.throws(() => approvedTask(approve({ ...f.intent,
    obligations: [{ ...obligation, expect: 'FAIL', witness: 'value' }] })), /positive candidate PASS/);
});
