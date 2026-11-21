// Hard cross-run cost admission.
//
// The enforced budget is the sum of worst-case pre-request bounds, never
// provider-reported estimates (those stay in the model_usage ledger). A bound
// is provider-backed: catalog rates are USD per million tokens and every
// request's worst-case cost follows from documented token limits.

export class CostExhausted extends Error {}

const MICRO_USD_PER_MILLION_TOKENS = 1_000_000;

function requireFiniteNumber(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new TypeError('Invalid ' + label);
  return value;
}

function requireIdentifier(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value || /\p{Cc}/u.test(value)) {
    throw new TypeError('Invalid ' + label);
  }
  return value;
}

export function costCeilingMicros(usd) {
  requireFiniteNumber(usd, 'cost ceiling');
  const micros = Math.round(usd * MICRO_USD_PER_MILLION_TOKENS);
  if (micros < 1 || !Number.isSafeInteger(micros)) throw new RangeError('Invalid cost ceiling');
  return micros;
}

export function normalizeRequestBound(record) {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) throw new TypeError('Invalid request bound record');
  const { provider, model, inputUsdPerMTok, outputUsdPerMTok, maxOutputTokens, source } = record;
  requireIdentifier(provider, 'request bound provider');
  requireIdentifier(model, 'request bound model');
  requireIdentifier(source, 'request bound source');
  requireFiniteNumber(inputUsdPerMTok, 'request bound inputUsdPerMTok');
  requireFiniteNumber(outputUsdPerMTok, 'request bound outputUsdPerMTok');
  if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1) throw new TypeError('Invalid request bound maxOutputTokens');
  return Object.freeze({ provider, model, inputUsdPerMTok, outputUsdPerMTok, maxOutputTokens, source });
}

// Derives the typed bound record from a pinned Pi model catalog entry: the
// provider's documented per-token rates and output limit. Every input-side
// billing mode (plain input, cache read, cache write, and the doubled long
// write rate pi applies) is covered by the maximum rate.
export function boundFromCatalog(model, source = 'pi-model-catalog') {
  if (!model || typeof model !== 'object') throw new TypeError('Invalid model catalog entry');
  const cost = model.cost;
  if (!cost || typeof cost !== 'object') throw new TypeError('Model catalog entry lacks cost rates');
  const rates = [cost, ...(Array.isArray(cost.tiers) ? cost.tiers : [])];
  for (const rate of rates) {
    for (const field of ['input', 'output', 'cacheRead', 'cacheWrite']) requireFiniteNumber(rate[field], 'catalog rate ' + field);
  }
  const inputUsdPerMTok = Math.max(...rates.flatMap(rate => [rate.input, rate.cacheRead, rate.cacheWrite, rate.input * 2]));
  const outputUsdPerMTok = Math.max(...rates.map(rate => rate.output));
  return normalizeRequestBound({
    provider: model.provider, model: model.id, inputUsdPerMTok, outputUsdPerMTok,
    maxOutputTokens: model.maxTokens, source,
  });
}

// A pinned record is an upper bound on the runtime catalog: upward drift in
// prices or output limits invalidates the hard guarantee and must fail closed.
export function checkedRequestBound(pinned, derived) {
  if (pinned.provider !== derived.provider || pinned.model !== derived.model) {
    throw new CostExhausted('Pinned request bound does not match the approved model');
  }
  if (derived.inputUsdPerMTok > pinned.inputUsdPerMTok || derived.outputUsdPerMTok > pinned.outputUsdPerMTok ||
    derived.maxOutputTokens > pinned.maxOutputTokens) {
    throw new CostExhausted('Model catalog exceeds the pinned request bound');
  }
  return pinned;
}

// Worst-case cost of one model request in micro-USD. Token counts are
// over-approximated by bytes (each token spans at least one byte), and output
// by the documented maximum. Rounding is always upward.
export function requestBoundMicros(bound, inputBytes) {
  const record = normalizeRequestBound(bound);
  if (!Number.isSafeInteger(inputBytes) || inputBytes < 0) throw new TypeError('Invalid request input size');
  return Math.ceil(inputBytes * record.inputUsdPerMTok) + Math.ceil(record.maxOutputTokens * record.outputUsdPerMTok);
}

// Pure admission decision over the durable ledger state. A request is
// admitted only when its worst-case bound fits under the ceiling, so no
// admitted request can push actual spend past the ceiling.
export function admitRequest({ ceilingMicros, reservedMicros, boundMicros }) {
  for (const [value, label] of [[ceilingMicros, 'cost ceiling'], [reservedMicros, 'reserved cost'], [boundMicros, 'request bound']]) {
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('Invalid ' + label);
  }
  if (boundMicros < 1) throw new TypeError('Invalid request bound');
  if (reservedMicros > ceilingMicros) throw new CostExhausted('Cost ceiling already exceeded');
  if (boundMicros > ceilingMicros - reservedMicros) {
    return Object.freeze({
      admitted: false,
      reason: `Cost ceiling exhausted: request bound ${boundMicros} micro-USD exceeds the remaining ${ceilingMicros - reservedMicros}`,
    });
  }
  return Object.freeze({ admitted: true });
}
