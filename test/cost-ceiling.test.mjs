import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import {
  admitRequest,
  boundFromCatalog,
  checkedRequestBound,
  costCeilingMicros,
  CostExhausted,
  normalizeRequestBound,
  requestBoundMicros,
} from '../src/cost-ceiling.mjs';
import { approve, createDemo, fixtureWorker } from '../examples/setup.mjs';
import { GitRepo } from '../src/git.mjs';
import { Journal } from '../src/journal.mjs';
import { runTasks } from '../src/verity.mjs';

const requestBound = normalizeRequestBound({
  provider: 'google', model: 'gemini-2.5-flash', inputUsdPerMTok: 0.6, outputUsdPerMTok: 2.5,
  maxOutputTokens: 65_536, source: 'provider pricing documentation',
});

const catalogModel = {
  provider: 'google', id: 'gemini-2.5-flash', maxTokens: 65_536,
  cost: { input: 0.3, output: 2.5, cacheRead: 0.075, cacheWrite: 0.375 },
};

async function fixture(t) {
  const scratch = resolve('tmp');
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, 'cost-ceiling-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return createDemo(root);
}

function journalFixture(t, name) {
  const root = resolve('tmp', name + '-' + process.pid + '-' + Date.now());
  mkdirSync(root, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  return join(root, 'journal.sqlite');
}

function standaloneAttempt(journal, id = '11111111-2222-4333-8444-555555555555') {
  journal.registerAttempt({ id, contract: 'a'.repeat(64), policy: 'approved-policy' });
  return id;
}

test('a dollar ceiling is exact in micro-USD and rejects unusable values', () => {
  assert.equal(costCeilingMicros(0.05), 50_000);
  assert.equal(costCeilingMicros(1), 1_000_000);
  assert.throws(() => costCeilingMicros(0), RangeError);
  assert.throws(() => costCeilingMicros(-1), TypeError);
  assert.throws(() => costCeilingMicros(NaN), TypeError);
  assert.throws(() => costCeilingMicros('0.05'), TypeError);
});

test('a request bound record is a typed, pinned provider record', () => {
  assert.deepEqual({ ...requestBound }, {
    provider: 'google', model: 'gemini-2.5-flash', inputUsdPerMTok: 0.6, outputUsdPerMTok: 2.5,
    maxOutputTokens: 65_536, source: 'provider pricing documentation',
  });
  for (const drop of ['provider', 'model', 'inputUsdPerMTok', 'outputUsdPerMTok', 'maxOutputTokens', 'source']) {
    const partial = { ...requestBound };
    delete partial[drop];
    assert.throws(() => normalizeRequestBound(partial), TypeError, drop);
  }
  assert.throws(() => normalizeRequestBound({ ...requestBound, maxOutputTokens: 0 }), TypeError);
  assert.throws(() => normalizeRequestBound({ ...requestBound, inputUsdPerMTok: -1 }), TypeError);
  assert.throws(() => normalizeRequestBound({ ...requestBound, source: ' padded ' }), TypeError);
});

test('the catalog bound covers every input billing mode and the output limit', () => {
  const derived = boundFromCatalog(catalogModel);
  assert.equal(derived.maxOutputTokens, 65_536);
  assert.equal(derived.inputUsdPerMTok, 0.6); // doubled input rate, pi's long-cache-write billing
  assert.equal(derived.outputUsdPerMTok, 2.5);
  const tiered = boundFromCatalog({
    ...catalogModel,
    cost: { input: 0.3, output: 2.5, cacheRead: 0.075, cacheWrite: 0.375, tiers: [
      { input: 2, output: 10, cacheRead: 0.5, cacheWrite: 2.5, inputTokensAbove: 200_000 },
    ] },
  });
  assert.equal(tiered.inputUsdPerMTok, 4); // doubled long-write rate of the tier
  assert.equal(tiered.outputUsdPerMTok, 10);
});

test('a pinned bound fails closed on upward catalog drift', () => {
  const derived = boundFromCatalog(catalogModel);
  assert.equal(checkedRequestBound(requestBound, derived), requestBound);
  assert.throws(() => checkedRequestBound(requestBound, { ...derived, inputUsdPerMTok: 0.7 }), CostExhausted);
  assert.throws(() => checkedRequestBound(requestBound, { ...derived, outputUsdPerMTok: 2.6 }), CostExhausted);
  assert.throws(() => checkedRequestBound(requestBound, { ...derived, maxOutputTokens: 65_537 }), CostExhausted);
  assert.throws(() => checkedRequestBound(requestBound, { ...derived, model: 'other-model' }), CostExhausted);
});

test('the worst-case request bound over-approximates the priced request cost', () => {
  const derived = boundFromCatalog(catalogModel);
  const inputRates = [catalogModel.cost.input, catalogModel.cost.cacheRead, catalogModel.cost.cacheWrite, catalogModel.cost.input * 2];
  const outputRates = [catalogModel.cost.output];
  for (let index = 0; index < 50; index++) {
    const inputBytes = index * 517;
    const outputTokens = index % 2 ? derived.maxOutputTokens : (index * 977) % derived.maxOutputTokens;
    const boundMicros = requestBoundMicros(derived, inputBytes);
    for (const inputRate of inputRates) {
      for (const outputRate of outputRates) {
        const pricedMicros = (inputBytes * inputRate) + (outputTokens * outputRate);
        assert.ok(boundMicros >= pricedMicros, `bound ${boundMicros} covers ${pricedMicros} at ${inputBytes} bytes`);
      }
    }
    assert.ok(boundMicros <= (inputBytes * derived.inputUsdPerMTok) + (derived.maxOutputTokens * derived.outputUsdPerMTok) + 2);
  }
});

test('admission fits exactly at the ceiling and refuses one micro-USD over', () => {
  assert.deepEqual(admitRequest({ ceilingMicros: 1_000, reservedMicros: 400, boundMicros: 600 }), { admitted: true });
  const refused = admitRequest({ ceilingMicros: 1_000, reservedMicros: 400, boundMicros: 601 });
  assert.equal(refused.admitted, false);
  assert.match(refused.reason, /Cost ceiling exhausted/);
  assert.throws(() => admitRequest({ ceilingMicros: 1_000, reservedMicros: 1_001, boundMicros: 1 }), CostExhausted);
  assert.throws(() => admitRequest({ ceilingMicros: 1_000, reservedMicros: 0, boundMicros: 0 }), TypeError);
});

test('the cross-run ledger reserves bounds durably and refuses before the boundary', t => {
  const path = journalFixture(t, 'cost-journal');
  const journal = new Journal(path);
  journal.setCostCeiling(1_000);
  const attempt = standaloneAttempt(journal);
  journal.reserveCost(attempt, 400, requestBound);
  journal.reserveCost(attempt, 600, requestBound);
  assert.throws(() => journal.reserveCost(attempt, 1, requestBound), CostExhausted);
  assert.deepEqual(journal.costCeiling(), { ceilingMicros: 1_000, reservedMicros: 1_000 });
  assert.equal(journal.costAdmissions(attempt).length, 2);
  journal.close();

  const reopened = new Journal(path);
  assert.deepEqual(reopened.costCeiling(), { ceilingMicros: 1_000, reservedMicros: 1_000 });
  assert.throws(() => reopened.setCostCeiling(2_000), /cannot change/);
  assert.throws(() => reopened.reserveCost(attempt, 1, requestBound), CostExhausted);
  reopened.close();
});

test('concurrent journal connections cannot overcommit the ceiling', t => {
  const path = journalFixture(t, 'cost-concurrent');
  const left = new Journal(path);
  left.setCostCeiling(500);
  const leftAttempt = standaloneAttempt(left, '11111111-2222-4333-8444-555555555555');
  const right = new Journal(path);
  const rightAttempt = standaloneAttempt(right, '66666666-7777-4888-8999-aaaaaaaaaaaa');
  left.reserveCost(leftAttempt, 300, requestBound);
  right.reserveCost(rightAttempt, 200, requestBound);
  assert.throws(() => left.reserveCost(leftAttempt, 1, requestBound), CostExhausted);
  assert.throws(() => right.reserveCost(rightAttempt, 1, requestBound), CostExhausted);
  assert.deepEqual(right.costCeiling(), { ceilingMicros: 500, reservedMicros: 500 });
  left.close();
  right.close();
});

test('a request that cannot fit the remaining ceiling is refused before dispatch', async t => {
  const settings = await fixture(t);
  const task = settings.tasks.find(task => task.id === 'messages');
  const bounds = [800, 300];
  let dispatched = 0;
  const [result] = await runTasks({
    ...settings, tasks: [task], maxWorkers: 1, costCeilingUsd: 0.001,
    worker: async job => {
      assert.equal(typeof job.admitRequest, 'function');
      for (const boundMicros of bounds) {
        job.admitRequest({ boundMicros, requestBound });
        dispatched++;
      }
      await fixtureWorker(job);
    },
  });
  assert.equal(result.status, 'refused');
  assert.match(result.reason, /Cost ceiling exhausted/);
  assert.equal(dispatched, 1);
  const repo = new GitRepo(settings.repository);
  assert.ok(repo.readRef('refs/heads/protected'));
  const journal = new Journal(settings.journalPath);
  try {
    assert.deepEqual(journal.costCeiling(), { ceilingMicros: 1_000, reservedMicros: 800 });
  } finally {
    journal.close();
  }
});

test('an admitted session promotes and records its worst-case reservations', async t => {
  const settings = await fixture(t);
  const task = settings.tasks.find(task => task.id === 'messages');
  let attempt;
  const [result] = await runTasks({
    ...settings, tasks: [task], maxWorkers: 1, costCeilingUsd: 0.001,
    onEvent: event => { if (event.type === 'attempt_started') attempt = event.attempt; },
    worker: async job => {
      job.admitRequest({ boundMicros: 400, requestBound });
      job.admitRequest({ boundMicros: 600, requestBound });
      await fixtureWorker(job);
    },
  });
  assert.equal(result.status, 'promoted');
  const journal = new Journal(settings.journalPath);
  try {
    assert.deepEqual(journal.costCeiling(), { ceilingMicros: 1_000, reservedMicros: 1_000 });
    const admissions = journal.costAdmissions(attempt);
    assert.deepEqual(admissions.map(entry => entry.boundMicros), [400, 600]);
    assert.deepEqual(admissions.map(entry => entry.reservedMicros), [400, 1_000]);
    assert.deepEqual(admissions.map(entry => entry.requestBound), [requestBound, requestBound]);
  } finally {
    journal.close();
  }
});

test('the cross-run ceiling cannot be changed by a later run', async t => {
  const settings = await fixture(t);
  const task = settings.tasks.find(task => task.id === 'messages');
  const run = costCeilingUsd => runTasks({
    ...settings, tasks: [task], maxWorkers: 1, costCeilingUsd,
    worker: async job => {
      job.admitRequest({ boundMicros: 100, requestBound });
      await fixtureWorker(job);
    },
  });
  assert.equal((await run(0.002))[0].status, 'promoted');
  await assert.rejects(run(0.003), /cannot change/);
  assert.equal((await run(0.002))[0].status, 'promoted');
});

test('cost exhaustion is terminal instead of spending repair rounds', async t => {
  const settings = await fixture(t);
  const original = settings.tasks.find(task => task.id === 'messages');
  const task = approve({ ...original, policy: { ...original.policy, maxRepairs: 2 } });
  let attempts = 0;
  const [result] = await runTasks({
    ...settings, tasks: [task], maxWorkers: 1, costCeilingUsd: 0.001,
    worker: async job => {
      attempts++;
      job.admitRequest({ boundMicros: 5_000, requestBound });
      await fixtureWorker(job);
    },
  });
  assert.equal(result.status, 'refused');
  assert.match(result.reason, /Cost ceiling exhausted/);
  assert.equal(attempts, 1);
});

test('no admission callback is offered without an approved ceiling', async t => {
  const settings = await fixture(t);
  const task = settings.tasks.find(task => task.id === 'messages');
  const [result] = await runTasks({
    ...settings, tasks: [task], maxWorkers: 1,
    worker: async job => {
      assert.equal(job.admitRequest, undefined);
      await fixtureWorker(job);
    },
  });
  assert.equal(result.status, 'promoted');
});

test('a pinned request bound is approved with the contract', async t => {
  const settings = await fixture(t);
  const original = settings.tasks.find(task => task.id === 'messages');
  const route = [{ provider: 'google', model: 'gemini-2.5-flash' }];
  const pinned = policy => approve({ ...original, policy });
  assert.equal(typeof pinned({ ...original.policy, modelRoute: route, cost: { requestBound } }).approval, 'string');
  assert.throws(() => pinned({ ...original.policy, modelRoute: route,
    cost: { requestBound: { ...requestBound, maxOutputTokens: 0 } } }), TypeError);
  assert.throws(() => pinned({ ...original.policy, modelRoute: route,
    cost: { requestBound, extra: 1 } }), /Invalid cost policy/);
  const mismatched = normalizeRequestBound({ ...requestBound, provider: 'openrouter' });
  assert.throws(() => pinned({ ...original.policy, modelRoute: route,
    cost: { requestBound: mismatched } }), /does not match the approved model route/);
});
