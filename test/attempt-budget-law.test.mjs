import assert from 'node:assert/strict';
import test from 'node:test';
import {
  accountingInvariant,
  authorizationInvariant,
  explore,
  initialState,
  stateKey,
  transitions,
} from '../verification/AttemptBudget.mjs';

const caps = [1, 2, 3];

function stateWithSpentToken(cap) {
  const graph = explore(cap);
  return graph.states.find(state => state.spent > 0 && state.active === null);
}

test('all finite states preserve token accounting and current-claim authorization', () => {
  const expected = new Map([[1, [22, 162]], [2, [68, 494]], [3, [140, 1006]]]);

  for (const cap of caps) {
    const graph = explore(cap);
    assert.deepEqual([graph.states.length, graph.edges.length], expected.get(cap));
    assert.ok(graph.states.some(state => state.claim >= 2), `cap ${cap} reaches at least two claims`);

    for (const state of graph.states) {
      assert.equal(state.spent, state.grants.length);
      assert.ok(state.spent >= 0 && state.spent <= cap);
      if (state.active) {
        assert.equal(state.active.claim, state.claim);
        assert.ok(state.grants.some(grant => grant.id === state.active.id && grant.claim === state.active.claim));
      }
    }

    for (const transition of graph.edges) {
      assert.equal(accountingInvariant(transition), true, `${cap}: ${transition.action}/${transition.outcome}`);
      assert.equal(authorizationInvariant(transition), true, `${cap}: ${transition.action}/${transition.outcome}`);
      if (transition.action === 'claim') {
        assert.equal(transition.to.claim, transition.from.claim + 1);
        assert.equal(transition.to.spent, transition.from.spent);
        assert.equal(transition.to.active, null);
      }
    }
  }
});

test('a repeated grant for the active ID is idempotent and an active attempt blocks another ID', () => {
  const graph = explore(3);
  const duplicate = graph.edges.find(transition => transition.outcome === 'idempotent');
  assert.ok(duplicate);
  assert.equal(duplicate.to.spent, duplicate.from.spent);
  assert.deepEqual(duplicate.to, duplicate.from);

  const blocked = graph.edges.find(transition =>
    transition.action === 'grant' && transition.outcome === 'refused' && transition.from.active !== null);
  assert.ok(blocked);
  assert.equal(blocked.to, blocked.from);
});

test('requeue retains spent tokens and exhausted caps stay unavailable across later claims', () => {
  for (const cap of caps) {
    const graph = explore(cap);
    const released = graph.edges.find(transition => transition.action === 'requeue' && transition.outcome === 'released');
    assert.ok(released, `cap ${cap} has a requeue after a grant`);
    assert.equal(released.to.spent, released.from.spent);
    assert.equal(released.to.active, null);

    const exhausted = graph.states.find(state => state.spent === cap && state.active === null);
    assert.ok(exhausted, `cap ${cap} reaches an exhausted idle state`);
    assert.ok(transitions(exhausted).some(transition => transition.action === 'grant' && transition.outcome === 'refused'));
    assert.ok(graph.edges.some(transition => transition.outcome === 'recoveredBeforeGrant'));
    assert.ok(graph.states.some(state => state.claim >= 2 && state.spent === cap));
  }
});

test('the checker rejects a refund of already-spent tokens', () => {
  const state = stateWithSpentToken(2);
  assert.ok(state);
  const refund = transitions(state, { unsafeRefundSpent: true })
    .find(transition => transition.outcome === 'unsafeRefund');
  assert.ok(refund);
  assert.equal(accountingInvariant(refund), false);
});

test('the checker rejects a grant carrying an earlier claim after requeue', () => {
  const graph = explore(2);
  const staleState = graph.states.find(state => {
    const path = graph.paths.get(stateKey(state));
    return state.claim >= 2 && state.active === null && state.spent < state.cap &&
      path.some(transition => transition.action === 'requeue');
  });
  assert.ok(staleState);
  assert.ok(graph.edges.some(transition =>
    transition.from === staleState && transition.action === 'grant' && transition.outcome === 'refused' &&
    transition.claim < staleState.claim));
  const stale = transitions(staleState, { unsafeStaleGrant: true })
    .find(transition => transition.outcome === 'unsafeStaleGrant');
  assert.ok(stale);
  assert.ok(stale.claim < stale.from.claim);
  assert.equal(stale.to.active.claim, stale.claim);
  assert.equal(accountingInvariant(stale), true);
  assert.equal(authorizationInvariant(stale), false);
});

test('caps outside the finite model are rejected', () => {
  assert.throws(() => initialState(0), /cap must be 1, 2, or 3/);
  assert.throws(() => initialState(4), /cap must be 1, 2, or 3/);
});
