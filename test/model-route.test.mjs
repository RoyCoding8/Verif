import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeModelRoute, selectModelRoute } from '../src/model-route.mjs';

const identity = (index) => ({ provider: `provider-${index}`, model: `model-${index}` });

test('model route selection stays within the approved prefix and repeats the last identity', () => {
  for (let count = 1; count <= 3; count++) {
    const route = Array.from({ length: count }, (_, index) => identity(index + 1));
    const normalized = normalizeModelRoute(route);
    assert.deepEqual(normalized, route);
    for (let attempt = 1; attempt <= count + 3; attempt++) {
      const selected = selectModelRoute(normalized, attempt);
      assert.ok(normalized.some(approved => approved.provider === selected.provider && approved.model === selected.model),
        `attempt ${attempt} selected an identity outside the approved route`);
      assert.deepEqual(selected, route[Math.min(attempt - 1, count - 1)]);
    }
  }
});

test('an absent route remains absent', () => {
  assert.equal(normalizeModelRoute(undefined), undefined);
  assert.equal(selectModelRoute(undefined, 1), undefined);
});

test('route normalization rejects duplicate identities and malformed entries', () => {
  const duplicate = [identity(1), identity(1)];
  assert.throws(() => normalizeModelRoute(duplicate), /duplicates an approved model/);
  assert.throws(() => normalizeModelRoute([]), /nonempty array/);
  assert.throws(() => normalizeModelRoute([{ ...identity(1), fallback: identity(2) }]), /only provider and model/);
  assert.throws(() => normalizeModelRoute([{ provider: ' provider-1', model: 'model-1' }]), /trimmed string/);
  assert.throws(() => normalizeModelRoute([{ provider: 'provider-1\n', model: 'model-1' }]), /control characters/);
  assert.throws(() => normalizeModelRoute([{ provider: 'provider-1', model: '' }]), /nonempty trimmed string/);
});

test('selection requires a positive integer attempt number', () => {
  for (const attempt of [0, -1, 1.5, NaN, Infinity]) {
    assert.throws(() => selectModelRoute([identity(1)], attempt), /positive integer/);
  }
});
