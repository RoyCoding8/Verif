import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hasLiveCandidate } from '../evaluation/reservation.mjs';

test('matched trials distinguish a defective candidate from no candidates', () => {
  const empty = { rows: [{ correct: null }, { correct: null }] };
  assert.equal(hasLiveCandidate({ normal: empty, adversarial: empty }), false);
  assert.equal(hasLiveCandidate({ normal: empty, adversarial: { rows: [{ correct: false }] } }), true);
});
