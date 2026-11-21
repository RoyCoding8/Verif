import assert from 'node:assert/strict';
import { test } from 'node:test';
import { admissionPlan, readOpenRouterKey, runRejectionProbe } from '../evaluation/cost-admission.mjs';
import { boundFromCatalog, requestBoundMicros } from '../src/cost-ceiling.mjs';

const catalogModel = {
  provider: 'openrouter', id: 'google/gemini-2.5-flash', maxTokens: 65_536,
  cost: { input: 0.3, output: 2.5, cacheRead: 0.075, cacheWrite: 0.375 },
};
const requestBound = boundFromCatalog(catalogModel);
const boundMicros = requestBoundMicros(requestBound, 1024);

function metadataFetch({ usage, after = usage, status = 200, body = '' }) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith('/api/v1/key')) {
      return { ok: true, status: 200, json: async () => ({ data: { label: 'capped', limit: 5, usage: calls.length > 1 ? after : usage } }) };
    }
    return { ok: status === 200, status, text: async () => body, json: async () => ({}) };
  };
  return { fetchImpl, calls };
}

test('an uncapped key blocks paid runs and any probe', () => {
  const plan = admissionPlan({ keyState: { limitUsd: null, usageUsd: 1 }, boundMicros, ceilingUsd: 5 });
  assert.equal(plan.ok, false);
  assert.equal(plan.probeable, false);
  assert.match(plan.reasons.join(' '), /no credit cap/);
});

test('a capped key within the approved ceiling is ready for paid runs', () => {
  const plan = admissionPlan({ keyState: { limitUsd: 5, usageUsd: 1 }, boundMicros, ceilingUsd: 5 });
  assert.equal(plan.ok, true);
  assert.equal(plan.probeable, false);
  assert.deepEqual(plan.reasons, []);
  assert.ok(plan.remainingMicros > boundMicros, 'the remaining credit covers the request bound');
});

test('a key cap above the approved ceiling is refused', () => {
  const plan = admissionPlan({ keyState: { limitUsd: 50, usageUsd: 1 }, boundMicros, ceilingUsd: 5 });
  assert.equal(plan.ok, false);
  assert.match(plan.reasons.join(' '), /exceeds the approved dollar ceiling/);
});

test('without an approved ceiling the plan refuses', () => {
  const plan = admissionPlan({ keyState: { limitUsd: 5, usageUsd: 1 }, boundMicros, ceilingUsd: NaN });
  assert.equal(plan.ok, false);
  assert.match(plan.reasons.join(' '), /No approved dollar ceiling/);
});

test('the probe is only possible when the request bound exceeds the remaining credit', () => {
  assert.equal(admissionPlan({ keyState: { limitUsd: 5, usageUsd: 4.9999 }, boundMicros, ceilingUsd: 5 }).probeable, true);
  assert.equal(admissionPlan({ keyState: { limitUsd: 5, usageUsd: 1 }, boundMicros, ceilingUsd: 5 }).probeable, false);
  assert.equal(admissionPlan({ keyState: null, boundMicros, ceilingUsd: 5 }).probeable, false);
});

test('the probe refuses to send a request the provider would admit and charge', async () => {
  const { fetchImpl, calls } = metadataFetch({ usage: 1 });
  await assert.rejects(runRejectionProbe({
    fetchImpl, key: 'k', requestBound, keyState: { limitUsd: 5, usageUsd: 1 }, ceilingUsd: 5,
  }), /Refusing to send/);
  assert.deepEqual(calls, []);
});

test('an over-budget request is rejected before charging', async () => {
  const { fetchImpl, calls } = metadataFetch({ usage: 4.9999, after: 4.9999, status: 402 });
  const result = await runRejectionProbe({
    fetchImpl, key: 'k', requestBound, keyState: { limitUsd: 5, usageUsd: 4.9999 }, ceilingUsd: 5,
  });
  assert.equal(result.status, 402);
  assert.equal(result.rejectedBeforeCharge, true);
  assert.equal(result.usageDeltaMicros, 0);
  assert.equal(calls.length, 2, 'one probe request and one metadata re-read');
  assert.match(calls[0].url, /chat\/completions/);
  assert.equal(calls[0].options.method, 'POST');
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.max_tokens, requestBound.maxOutputTokens);
});

test('an admitted probe request fails the check and reports the charge', async () => {
  const { fetchImpl } = metadataFetch({ usage: 4.9999, after: 5, status: 200 });
  const result = await runRejectionProbe({
    fetchImpl, key: 'k', requestBound, keyState: { limitUsd: 5, usageUsd: 4.9999 }, ceilingUsd: 5,
  });
  assert.equal(result.status, 200);
  assert.equal(result.rejectedBeforeCharge, false);
  assert.ok(result.usageDeltaMicros > 0);
});

test('key metadata normalizes the provider payload', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ data: { label: 'capped', limit: 5, usage: 2 } }) });
  assert.deepEqual(await readOpenRouterKey(fetchImpl, 'k'), { label: 'capped', limitUsd: 5, usageUsd: 2 });
  const uncapped = async () => ({ ok: true, status: 200, json: async () => ({ data: { label: 'local' } }) });
  assert.deepEqual(await readOpenRouterKey(uncapped, 'k'), { label: 'local', limitUsd: null, usageUsd: 0 });
});
