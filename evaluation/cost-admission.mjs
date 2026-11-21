// Live admission check for the hard cost ceiling.
//
// The provider-side backstop is a capped key: OpenRouter documents worst-case
// admission for a key with a credit limit, so a request whose worst-case cost
// exceeds the remaining credit is rejected before it is charged. This check
// verifies that documented behavior on the real route. It refuses to send any
// request the provider would admit, because that request would charge.

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { boundFromCatalog, normalizeRequestBound, requestBoundMicros } from '../src/cost-ceiling.mjs';

const MICRO_USD = 1_000_000;

function toMicros(usd) {
  return Math.round(usd * MICRO_USD);
}

// keyState: { limitUsd, usageUsd } from the provider's key metadata.
// limitUsd === null means the key has no credit cap.
export function admissionPlan({ keyState, boundMicros, ceilingUsd }) {
  const reasons = [];
  if (!(Number.isFinite(ceilingUsd) && ceilingUsd > 0)) reasons.push('No approved dollar ceiling is configured');
  if (!keyState) {
    reasons.push('No provider key metadata is available');
    return { ok: false, probeable: false, reasons };
  }
  const { limitUsd, usageUsd } = keyState;
  if (!Number.isFinite(usageUsd) || usageUsd < 0) reasons.push('The provider reports unusable key usage');
  if (!Number.isFinite(limitUsd)) {
    reasons.push('The key has no credit cap, so the hard ceiling has no provider-side backstop');
    return { ok: false, probeable: false, reasons };
  }
  if (limitUsd <= usageUsd) reasons.push('The key credit is already exhausted');
  if (Number.isFinite(ceilingUsd) && limitUsd > ceilingUsd) {
    reasons.push('The key cap exceeds the approved dollar ceiling');
  }
  const remainingMicros = toMicros(limitUsd - usageUsd);
  const probeable = Number.isSafeInteger(boundMicros) && boundMicros > remainingMicros;
  return { ok: reasons.length === 0, probeable, remainingMicros, boundMicros, reasons };
}

export async function readOpenRouterKey(fetchImpl, key) {
  const response = await fetchImpl('https://openrouter.ai/api/v1/key', {
    headers: { authorization: `Bearer ${key}` },
  });
  if (!response.ok) throw new Error('Key metadata request failed with status ' + response.status);
  const { data } = await response.json();
  return {
    label: data.label ?? null,
    limitUsd: data.limit ?? null,
    usageUsd: data.usage ?? 0,
  };
}

// Sends exactly one over-budget request and verifies the provider rejects it
// before charging. Refuses to send when the plan does not guarantee rejection:
// an admitted request would charge the key.
export async function runRejectionProbe({ fetchImpl, key, requestBound, keyState, ceilingUsd }) {
  const record = normalizeRequestBound(requestBound);
  const body = {
    model: record.model,
    messages: [{ role: 'user', content: '.' }],
    max_tokens: record.maxOutputTokens,
  };
  const serialized = JSON.stringify(body);
  const boundMicros = requestBoundMicros(record, Buffer.byteLength(serialized, 'utf8'));
  const plan = admissionPlan({ keyState, boundMicros, ceilingUsd });
  if (!plan.probeable) {
    throw new Error('Refusing to send a request the provider may admit and charge: ' +
      (plan.reasons.join('; ') || 'the remaining credit covers the request bound'));
  }
  const response = await fetchImpl('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: serialized,
  });
  const after = await readOpenRouterKey(fetchImpl, key);
  const usageDeltaMicros = toMicros(after.usageUsd - keyState.usageUsd);
  const charged = usageDeltaMicros > 0;
  const rejected = response.status === 402 || (response.status === 403 && /credit/i.test(await response.text()));
  return {
    model: record.model,
    requestBound: record,
    boundMicros,
    remainingMicros: plan.remainingMicros,
    status: response.status,
    rejectedBeforeCharge: rejected && !charged,
    usageDeltaMicros,
  };
}

async function loadCatalogModel(provider, modelId) {
  const { ModelRuntime } = await import('@earendil-works/pi-coding-agent');
  const runtime = await ModelRuntime.create({ allowModelNetwork: true, modelRefreshTimeoutMs: 20_000 });
  const model = runtime.getModel(provider, modelId);
  if (!model) throw new Error('The selected model is absent from the Pi model catalog');
  return model;
}

async function providerKeyState(provider) {
  const key = process.env.OPENROUTER_API_KEY;
  if (provider === 'openrouter') {
    if (!key) throw new Error('OPENROUTER_API_KEY is not configured');
    return { key, state: await readOpenRouterKey(fetch, key) };
  }
  return {
    key: null,
    state: null,
    note: `No provider-side credit cap is documented for ${provider}; live matched trials require the capped OpenRouter route`,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [mode, provider, modelId] = process.argv.slice(2);
  if (!['--check', '--probe'].includes(mode) || !provider || !modelId) {
    throw new Error('Usage: node evaluation/cost-admission.mjs --check|--probe <provider> <model>');
  }
  const ceilingUsd = Number(process.env.VERITY_COST_CEILING_USD);
  const model = await loadCatalogModel(provider, modelId);
  const requestBound = boundFromCatalog(model);
  const { key, state, note } = await providerKeyState(provider);
  if (note) console.error(note);
  const plan = admissionPlan({ keyState: state, boundMicros: requestBoundMicros(requestBound, 1024), ceilingUsd });
  if (mode === '--check') {
    console.log(JSON.stringify({ provider, model: modelId, ceilingUsd, requestBound, keyState: state, plan }, null, 2));
    if (!plan.ok) process.exitCode = 1;
  } else {
    const result = await runRejectionProbe({ fetchImpl: fetch, key, requestBound, keyState: state, ceilingUsd });
    console.log(JSON.stringify(result, null, 2));
    if (!result.rejectedBeforeCharge) process.exitCode = 1;
  }
}
