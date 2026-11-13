import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { approve, createDemo, fixtureWorker } from '../examples/setup.mjs';
import { assertExhaustiveDomain, hash, planVerification } from '../src/contracts.mjs';
import { GitRepo } from '../src/git.mjs';
import { Journal } from '../src/journal.mjs';
import { proposeTask } from '../src/planner.mjs';
import { inspectRun, recoverOperation, runTasks } from '../src/verity.mjs';
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
      assert.deepEqual(job.approvedChecks, []);
      assert.equal(job.runCheck, undefined);
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

test('orthogonal scheduling dispatches projected siblings together and serializes overlapping inputs', async t => {
  for (const overlap of [false, true]) {
    const settings = await fixture(t);
    const [reserve, messages] = settings.tasks;
    const tasks = [reserve, messages].map(task => approve({ ...task, obligations: task.obligations.map(obligation =>
      obligation.subject !== 'candidate' ? obligation : { ...obligation,
        inputPaths: [...task.scope.write, ...(overlap && task.id === messages.id ? reserve.scope.write : [])] }) }));
    let active = 0;
    let peak = 0;
    const results = await runTasks({ ...settings, tasks, orthogonalOnly: true, worker: async job => {
      peak = Math.max(peak, ++active);
      await setTimeout(30);
      await fixtureWorker(job);
      active--;
    } });
    assert.deepEqual(results.map(result => result.status), ['promoted', 'promoted'], JSON.stringify(results));
    assert.equal(peak, overlap ? 1 : 2);
  }
});

test('requeue cannot restore an attempt spent before a controller interruption', async t => {
  const settings = await fixture(t);
  const task = settings.tasks[0];
  const context = { ...settings, tasks: [task] };
  const repo = new GitRepo(settings.repository);
  const initial = repo.readRef(task.policy.ref);
  const result = await runTasks({ ...context, worker: async () => {
    // Simulate a controller handoff while the first worker still holds its checkout.
    inspectRun({ ...context, requeue: task.id });
  } }).catch(error => error);
  assert.match(result.message, /is not current|does not accept a claim/);
  assert.equal(inspectRun(context).tasks[0].status, 'queued');
  const [refused] = await runTasks({ ...context, worker: async () => assert.fail('Spent attempt was dispatched again') });
  assert.equal(refused.status, 'refused');
  assert.match(refused.reason, /attempt budget exhausted/);
  assert.equal(repo.readRef(task.policy.ref), initial);
});

test('retry dispatch uses the next approved model and binds the route to approval', async t => {
  const settings = await fixture(t);
  const original = settings.tasks[0];
  const modelRoute = [{ provider: 'first', model: 'a' }, { provider: 'second', model: 'b' }];
  const task = approve({ ...original, policy: { ...original.policy, maxRepairs: 1, modelRoute } });
  const seen = [];
  const events = [];
  const [result] = await runTasks({ ...settings, tasks: [task], onEvent: event => events.push(event), worker: async job => {
    seen.push(job.route);
    if (seen.length === 1) {
      job.recordUsage({ tokens: { total: 4 }, estimatedCost: 0 });
      throw new Error('fixture refused the first model');
    }
    await fixtureWorker(job);
    return { usage: { tokens: { total: 46 }, estimatedCost: 0.004 } };
  } });
  assert.equal(result.status, 'promoted', JSON.stringify(result));
  assert.deepEqual(seen, modelRoute);
  assert.deepEqual(events.filter(event => event.type === 'attempt_started').map(event => event.route), modelRoute);
  assert.deepEqual(inspectRun({ ...settings, tasks: [task] }).modelUsage, { reportedAttempts: 2, tokens: 50, estimatedCost: 0.004 });
  await assert.rejects(runTasks({ ...settings, tasks: [{ ...task, policy: { ...task.policy, modelRoute: [...modelRoute].reverse() } }] }),
    /principal approval/);
});

test('rollback is an approved candidate with its own checks and preserves later unrelated changes', async t => {
  const settings = await fixture(t);
  const [reserve, messages] = settings.tasks;
  const repo = new GitRepo(settings.repository);
  const initial = repo.readRef(reserve.policy.ref);
  const promoted = await runTasks({ ...settings, tasks: [reserve, messages], worker: fixtureWorker });
  assert.deepEqual(promoted.map(result => result.status), ['promoted', 'promoted']);
  const head = repo.readRef(reserve.policy.ref);
  const rollback = {
    ...reserve, id: 'rollback-message', goal: 'Restore the prior decline wording.', scope: messages.scope,
    criteria: messages.criteria, claims: messages.claims, revertOperation: promoted[1].operation,
  };
  const noWorker = async () => assert.fail('Rollback dispatched a model');
  const [refused] = await runTasks({ ...settings, worker: noWorker, tasks: [approve({ ...rollback, obligations: messages.obligations })] });
  assert.equal(refused.status, 'refused');
  assert.match(refused.reason, /Unexpected verdict/);
  assert.equal(repo.readRef(reserve.policy.ref), head);
  const oracleRoot = join(settings.scratch, 'rollback-oracles');
  await mkdir(oracleRoot);
  const bytes = JSON.stringify([{ id: 'restore', module: 'response.mjs', name: 'response', args: ['declined'], expected: 'declined' }]);
  await writeFile(join(oracleRoot, 'restore.json'), bytes);
  const task = approve({ ...rollback, claims: [{ ...messages.claims[0], statement: 'Declined reservations use the prior wording' }],
    obligations: [{ ...messages.obligations[0], cases: ['restore'], oracle: { file: 'restore.json', digest: hash(bytes) } }] });
  const [reverted] = await runTasks({ ...settings, oracleRoot, worker: noWorker, tasks: [task] });
  assert.equal(reverted.status, 'promoted', JSON.stringify(reverted));
  assert.equal(repo.readRef(reserve.policy.ref), reverted.commit);
  assert.deepEqual(repo.changedPaths(initial, reverted.commit), ['reserve.mjs']);
});

test('recorded histories reject overselling and missing overlap before promotion', async t => {
  const settings = await fixture(t);
  const oracleRoot = join(settings.scratch, 'history-oracles');
  await mkdir(oracleRoot, { recursive: true });
  const reserve = { operation: 'reserve', input: 1 };
  const bytes = JSON.stringify({
    machine: { initial: 'available', transitions: [
      { ...reserve, from: 'available', to: 'empty', output: true },
      { ...reserve, from: 'empty', to: 'empty', output: false },
    ] },
    cases: [{ id: 'two-reservations', module: 'reserve.mjs', name: 'openStock', args: [1], calls: [[reserve, reserve]], expect: 'linearizable' }],
    requiredOperations: ['reserve'],
    negativeControl: [
      { ...reserve, invocation: 0, response: 2, output: true },
      { ...reserve, invocation: 1, response: 3, output: true },
    ],
  });
  await writeFile(join(oracleRoot, 'history.json'), bytes);
  const task = {
    ...settings.tasks[0], claims: [{ id: 'stock', required: 'tested', statement: 'Concurrent reservations cannot oversell one unit' }],
    obligations: [{ ...settings.tasks[0].obligations[1], method: 'node-history', cases: ['two-reservations'],
      oracle: { file: 'history.json', digest: hash(bytes) } }],
  };
  const proposal = await proposeTask({ ...settings, oracleRoot, draft: { ...task, oracleFiles: ['history.json'] },
    worker: async ({ workspace, scope, goal }) => {
      assert.match(goal, /"calls"/);
      assert.doesNotMatch(goal, /"negativeControl"/);
      await writeFile(join(workspace, scope.write[0]), JSON.stringify({ criteria: task.criteria, claims: task.claims,
        obligations: task.obligations.map(obligation => ({ ...obligation, oracleFile: 'history.json' })) }));
    } });
  assert.deepEqual(proposal.plan.obligations[0].oracle, task.obligations[0].oracle);
  const repo = new GitRepo(settings.repository);
  const initial = repo.readRef(task.policy.ref);
  const run = (revision, body) => runTasks({ ...settings, oracleRoot, tasks: [approve({ ...task, revision })],
    worker: async ({ workspace }) => writeFile(join(workspace, 'reserve.mjs'),
      `export function openStock(stock) { return { ${body} }; }\n`) });
  const [race] = await run(1, 'async reserve(quantity) { const available = stock; await Promise.resolve(); if (available < quantity) return false; stock -= quantity; return true; }');
  assert.match(race.reason, /Unexpected verdict/);
  const [serial] = await run(2, 'reserve(quantity) { if (stock < quantity) return false; stock -= quantity; return true; }');
  assert.match(serial.reason, /No overlapping calls observed/);
  assert.equal(repo.readRef(task.policy.ref), initial);
  const [accepted] = await run(3, 'async reserve(quantity) { await Promise.resolve(); if (stock < quantity) return false; stock -= quantity; return true; }');
  assert.equal(accepted.status, 'promoted', JSON.stringify(accepted));
  assert.deepEqual(accepted.assurance, { stock: 'tested' });
  const journal = new Journal(settings.journalPath);
  try {
    const { evidence } = journal.getOperation(accepted.operation).receipt;
    const artifact = JSON.parse(Buffer.from(evidence.results[0].artifacts['cases.json'].base64, 'base64'));
    const [first, second] = artifact.observations[0].actual;
    assert.ok(first.invocation < second.invocation && second.invocation < first.response);
    assert.deepEqual([first.output, second.output], [true, false]);
  } finally {
    journal.close();
  }
});

test('seeded property checks execute generated cases and retain the sampling recipe', async t => {
  const settings = await fixture(t);
  const oracleRoot = join(settings.scratch, 'property-oracles');
  await mkdir(oracleRoot, { recursive: true });
  const seed = 234;
  const samples = 12;
  const oracle = { module: 'reserve.mjs', name: 'reserve', axes: [[0], [1, 2, 3]], expected: 0, seed, samples };
  const bytes = JSON.stringify(oracle);
  await writeFile(join(oracleRoot, 'property.json'), bytes);
  const original = settings.tasks[0];
  const obligation = { ...original.obligations[1], method: 'node-property',
    cases: Array.from({ length: samples }, (_, index) => String(index)), oracle: { file: 'property.json', digest: hash(bytes) } };
  const task = approve({ ...original, claims: [{ id: 'stock', required: 'tested', statement: 'Zero stock stays zero' }], obligations: [obligation] });
  const [refused] = await runTasks({ ...settings, oracleRoot, tasks: [task], worker: async ({ workspace }) => {
    await writeFile(join(workspace, 'reserve.mjs'), 'export const reserve = () => -1;\n');
  } });
  assert.match(refused.reason, /Unexpected verdict/);
  const [failure] = inspectRun({ ...settings, tasks: [task] }).verifierRefusals;
  assert.equal(failure.obligation, obligation.id);
  assert.equal(failure.observed, 'FAIL');
  assert.equal(failure.expected, 'PASS');
  assert.match(failure.evidence, /^[0-9a-f]{64}$/);
  const lesson = { attempt: failure.attempt, evidence: failure.evidence, diagnosis: 'Zero stock must remain zero.', regression: obligation.id };
  const learned = { ...task, revision: 2, policy: { ...task.policy, lessons: [lesson] } };
  const fabricated = approve({ ...learned, policy: { ...learned.policy, lessons: [{ ...lesson, evidence: '0'.repeat(64) }] } });
  const [blocked] = await runTasks({ ...settings, oracleRoot, tasks: [fabricated], worker: async () => assert.fail('Missing lesson dispatched a worker') });
  assert.match(blocked.reason, /lacks a recorded verifier refusal/);
  const [result] = await runTasks({ ...settings, oracleRoot, tasks: [approve(learned)], worker: async job => {
    assert.match(job.goal, /Approved lesson: Zero stock must remain zero/);
    assert.doesNotMatch(job.goal, new RegExp(failure.evidence));
    await fixtureWorker(job);
  } });
  assert.equal(result.status, 'promoted', JSON.stringify(result));
  assert.deepEqual(result.assurance, { stock: 'tested' });
  const journal = new Journal(settings.journalPath);
  try {
    const { evidence } = journal.getOperation(result.operation).receipt;
    const checked = evidence.results[0];
    assert.equal(typeof checked.sampling.generator, 'string');
    assert.deepEqual({ seed: checked.sampling.seed, samples: checked.sampling.samples }, { seed, samples });
    assert.equal(checked.cases.length, samples);
    assert.ok(checked.cases.every(item => item.status === 'PASS'));
    const artifact = JSON.parse(Buffer.from(checked.artifacts['cases.json'].base64, 'base64'));
    assert.deepEqual(artifact.sampling, checked.sampling);
    assert.equal(artifact.observations.length, samples);
  } finally {
    journal.close();
  }
});

test('feedback and final verification draw on the same durable task budget', async t => {
  const settings = await fixture(t);
  const original = settings.tasks[0];
  const task = approve({ ...original, policy: { ...original.policy, maxVerificationMs: 10_000, feedbackChecks: ['stock-before'] } });
  const repo = new GitRepo(settings.repository);
  const initial = repo.readRef(task.policy.ref);
  const [result] = await runTasks({ ...settings, tasks: [task], worker: async job => {
    assert.equal(await job.runCheck('stock-before'), 'FAIL (0/1)');
    await fixtureWorker(job);
  } });
  assert.equal(result.status, 'refused');
  assert.match(result.reason, /budget exhausted for verification time/);
  assert.equal(repo.readRef(task.policy.ref), initial);
});

test('a changed policy immediately fences the prior feedback grant', async t => {
  const settings = await fixture(t);
  const original = settings.tasks[0];
  const task = approve({ ...original, policy: { ...original.policy, feedbackChecks: ['stock-before'] } });
  let attempt;
  const [result] = await runTasks({ ...settings, tasks: [task], onEvent: event => { attempt = event.attempt; }, worker: async job => {
    const journal = new Journal(settings.journalPath);
    try { journal.setPolicy(attempt, 'replacement'); } finally { journal.close(); }
    await assert.rejects(job.runCheck('stock-before'), /no longer authorizes/);
    assert.throws(() => job.reserveToolCall(), /no longer authorizes/);
    await fixtureWorker(job);
  } });
  assert.equal(result.status, 'refused');
  assert.match(result.reason, /no longer authorizes verification/);
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
  const partial = structuredClone(task);
  partial.obligations[1].cases.pop();
  assert.throws(() => planVerification(partial), /case for every input/);
  task.obligations[0].witness = '1/1';
  const [result] = await runTasks({ ...settings, tasks: [approve(task)], worker: fixtureWorker });
  assert.equal(result.status, 'refused');
  assert.match(result.reason, /Wrong failure witness/);
  task.claims[0].required = 'formal';
  assert.throws(() => planVerification(task), /Insufficient assurance/);
});

test('worker feedback requires an explicit grant and private acceptance failures stay out of repairs', async t => {
  const settings = await fixture(t);
  const input = settings.tasks[0];
  assert.throws(() => approve({ ...input, policy: { ...input.policy, feedbackChecks: ['absent'] } }), /Feedback checks/);
  assert.throws(() => approve({ ...input, policy: { ...input.policy, feedbackChecks: ['stock-before', 'stock-before'] } }), /Feedback checks/);
  const task = approve({ ...input, policy: { ...input.policy, maxRepairs: 1, feedbackChecks: ['stock-before'] } });
  let attempts = 0;
  const [result] = await runTasks({ ...settings, tasks: [task], worker: async job => {
    attempts++;
    assert.deepEqual(job.approvedChecks, ['stock-before']);
    await assert.rejects(job.runCheck('stock-after'), /Unknown approved check/);
    if (attempts === 1) {
      assert.equal(await job.runCheck('stock-before'), 'FAIL (0/1)');
      await writeFile(join(job.workspace, 'reserve.mjs'), 'export function reserve() { return -2; }\n');
    } else {
      assert.match(job.goal, /Previous attempt was refused/);
      assert.doesNotMatch(job.goal, /stock-after|Unexpected verdict/);
      await fixtureWorker(job);
    }
  } });
  assert.equal(attempts, 2);
  assert.equal(result.status, 'promoted', JSON.stringify(result));
});

test('rejects a finite oracle that repeats a tuple under different case IDs', () => {
  const domain = { module: 'program.mjs', name: 'value', axes: [[1, 2]] };
  const cases = [1, 1].map((value, index) => ({ id: String(index), module: domain.module, name: domain.name, args: [value] }));
  assert.throws(() => assertExhaustiveDomain(domain, cases), /does not enumerate/);
});

test('refuses a dependent task whose pinned base omits the prerequisite commit', async t => {
  const settings = await fixture(t);
  const repo = new GitRepo(settings.repository);
  const [messages, api] = settings.tasks.slice(1);
  const child = approve({ ...api, base: repo.readRef(api.policy.ref), dependencies: ['messages'] });
  const results = await runTasks({
    ...settings, tasks: [messages, child],
    worker: async job => {
      assert.deepEqual(job.scope.write, ['response.mjs']);
      await fixtureWorker(job);
    },
  });
  assert.deepEqual(results.map(result => result.status), ['promoted', 'refused'], JSON.stringify(results));
  assert.match(results[1].reason, /lacks promoted prerequisite messages/);
});

test('planner binds approved oracle bytes without granting task approval', async t => {
  const settings = await fixture(t);
  const draft = { ...settings.tasks[1], oracleFiles: ['messages.json'] };
  const original = draft.obligations[0];
  const proposer = criteria => async ({ workspace, scope, goal }) => {
    assert.match(goal, /declined-message/);
    assert.doesNotMatch(goal, /"expected"/);
    await writeFile(join(workspace, scope.write[0]), JSON.stringify({
      criteria,
      claims: draft.claims,
      obligations: [{ ...original, oracleFile: 'messages.json', oracle: { digest: 'agent supplied' } }],
    }));
  };
  const worker = proposer(draft.criteria);
  const proposal = await proposeTask({ ...settings, draft, worker });
  assert.equal(proposal.intent.approval, undefined);
  assert.deepEqual(proposal.plan.obligations[0].oracle, original.oracle);
  await assert.rejects(runTasks({ ...settings, tasks: [proposal.intent], worker }), /principal approval/);
  const exception = { id: 'review', description: 'Manual review complete', exception: { risk: 'Review pending' } };
  await assert.rejects(proposeTask({ ...settings, draft, worker: proposer([...draft.criteria, exception]) }),
    /A principal can record an exception/);
});

test('records an approved coverage exception while still requiring the candidate check', async t => {
  const settings = await fixture(t);
  const task = settings.tasks[1];
  const exception = { id: 'review', description: 'Manual review complete', exception: { risk: 'Review pending' } };
  const proposed = { ...task, criteria: [...task.criteria, exception] };
  const repo = new GitRepo(settings.repository);
  const head = repo.readRef(task.policy.ref);
  await assert.rejects(runTasks({ ...settings, tasks: [proposed], worker: fixtureWorker }), /principal approval/);

  const approved = approve(proposed);
  const [refused] = await runTasks({ ...settings, tasks: [approved],
    worker: ({ workspace }) => writeFile(join(workspace, 'response.mjs'), "export const response = () => 'incorrect';\n") });
  assert.equal(refused.status, 'refused');
  assert.match(refused.reason, /Unexpected verdict/);
  assert.equal(repo.readRef(task.policy.ref), head);

  const [promoted] = await runTasks({ ...settings, tasks: [approve({ ...approved, revision: 2 })], worker: fixtureWorker });
  assert.equal(promoted.status, 'promoted');
  assert.equal(repo.readRef(task.policy.ref), promoted.commit);
  const journal = new Journal(settings.journalPath);
  try {
    const { receipt } = journal.getOperation(promoted.operation);
    assert.deepEqual(receipt.task.plan.criteria.at(-1), exception);
    assert.deepEqual(receipt.evidence.assurance, { message: 'tested' });
  } finally {
    journal.close();
  }
});

test('recovers a real Git ref update interrupted before the journal commit', async t => {
  const fixtureSettings = await fixture(t);
  const settings = { ...fixtureSettings, tasks: [fixtureSettings.tasks[1]], worker: fixtureWorker };
  const updateRef = GitRepo.prototype.updateRef;
  GitRepo.prototype.updateRef = function (...args) {
    updateRef.apply(this, args);
    throw new Error('Injected crash after Git ref update');
  };
  try {
    await assert.rejects(runTasks(settings), /Promotion requires recovery/);
  } finally {
    GitRepo.prototype.updateRef = updateRef;
  }
  const journal = new Journal(settings.journalPath);
  const ref = 'refs/heads/protected';
  let prepared;
  try {
    prepared = journal.getPending(ref);
    assert.equal(prepared.status, 'prepared');
    assert.equal(new GitRepo(settings.repository).readRef(ref), prepared.next);
  } finally {
    journal.close();
  }
  assert.equal(inspectRun(settings).tasks[0].status, 'running');
  const recovered = recoverOperation({ ...settings, operation: prepared.id });
  assert.equal(recovered.status, 'promoted');
  const [result] = await runTasks({ ...settings, worker: async () => assert.fail('Recovery dispatched the worker again') });
  assert.equal(result.commit, prepared.next);
  assert.equal(result.operation, prepared.id);
});
