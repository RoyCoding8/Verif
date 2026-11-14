import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hasLiveCandidate } from '../evaluation/reservation.mjs';

function result(row) {
  return { rows: [row] };
}

test('matched trials distinguish a defective candidate from no candidates', () => {
  const empty = result({ correct: null });
  const defective = result({ correct: false });
  const shape = part => ({ messages: { restricted: { normal: part, adversarial: empty } } });
  assert.equal(hasLiveCandidate({ challenges: shape(empty) }), false);
  assert.equal(hasLiveCandidate({ challenges: shape(defective) }), true);
  assert.equal(hasLiveCandidate({}), false);
});
