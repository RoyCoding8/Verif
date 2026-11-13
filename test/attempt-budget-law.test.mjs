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
  return graph.states.find(state => state.status === 'running' && state.spent > 0 && state.active === null);
}

test('all finite states preserve token accounting and current-claim authorization', () => {
  const expected = new Map([[1, [37, 258]], [2, [111, 776]], [3, [223, 1560]]]);

  for (const cap of caps) {
    const graph = explore(cap);
    assert.deepEqual([graph.states.length, graph.edges.length], expected.get(cap));
    assert.ok(graph.states.some(state => state.claim >= 2), `cap ${cap} reaches at least two claims`);

    for (const state of graph.states) {
      assert.equal(state.spent, state.grants.length);
      assert.ok(state.spent >= 0 && state.spent <= cap);
      if (state.status === 'queued') assert.equal(state.active, null);
      if (state.active) {
        assert.equal(state.status, 'running');
        assert.equal(state.active.claim, state.claim);
        assert.ok(state.grants.some(grant => grant.id === state.active.id && grant.claim === state.active.claim));
      }
    }

    for (const transition of graph.edges) {
      assert.equal(accountingInvariant(transition), true, `${cap}: ${transition.action}/${transition.outcome}`);
      assert.equal(authorizationInvariant(transition), true, `${cap}: ${transition.action}/${transition.outcome}`);
      if (transition.outcome === 'granted') {
        assert.equal(transition.from.status, 'running');
        assert.equal(transition.to.status, 'running');
      }
      if (transition.action === 'startTask') {
        assert.equal(transition.from.status, 'queued');
        assert.equal(transition.to.claim, transition.from.claim + 1);
        assert.equal(transition.to.status, 'running');
        assert.equal(transition.to.spent, transition.from.spent);
        assert.equal(transition.to.active, null);
      }
    }
  }
});

test('an existing ID replays idempotently without restoring an inactive attempt', () => {
  const graph = explore(3);
  const activeReplay = graph.edges.find(transition => transition.outcome === 'idempotent' && transition.attemptActive);
  const inactiveReplay = graph.edges.find(transition => transition.outcome === 'idempotent' && !transition.attemptActive);
  assert.ok(activeReplay);
  assert.ok(inactiveReplay);
  for (const replay of [activeReplay, inactiveReplay]) {
    assert.equal(replay.to.spent, replay.from.spent);
    assert.deepEqual(replay.to, replay.from);
  }
  assert.equal(inactiveReplay.to.active, null);

  const blocked = graph.edges.find(transition =>
    transition.action === 'grant' && transition.outcome === 'refused' && transition.from.active !== null);
  assert.ok(blocked);
  assert.equal(blocked.to, blocked.from);
});

test('invalidation stays running; requeue returns to queued without refunding tokens', () => {
  const graph = explore(3);
  const invalidated = graph.edges.find(transition => transition.action === 'invalidate');
  assert.ok(invalidated);
  assert.equal(invalidated.from.status, 'running');
  assert.equal(invalidated.to.status, 'running');
  assert.equal(invalidated.to.active, null);
  assert.equal(invalidated.to.spent, invalidated.from.spent);
  assert.ok(transitions(invalidated.to).some(transition =>
    transition.action === 'requeue' && transition.outcome === 'requeuedAfterAttempt'));

  const requeued = graph.edges.find(transition => transition.action === 'requeue' && transition.outcome === 'requeuedAfterAttempt');
  assert.ok(requeued);
  assert.equal(requeued.from.status, 'running');
  assert.equal(requeued.to.status, 'queued');
  assert.equal(requeued.to.active, null);
  assert.equal(requeued.to.spent, requeued.from.spent);
  const restarted = graph.edges.find(transition =>
    transition.action === 'startTask' && transition.from === requeued.to);
  assert.ok(restarted);
  assert.equal(restarted.to.claim, requeued.from.claim + 1);
  assert.equal(restarted.to.status, 'running');
});

test('exhausted caps stay unavailable across later claims', () => {
  for (const cap of caps) {
    const graph = explore(cap);
    const released = graph.edges.find(transition => transition.action === 'requeue' && transition.outcome === 'requeuedAfterAttempt');
    assert.ok(released, `cap ${cap} has a requeue after a grant`);
    assert.equal(released.to.spent, released.from.spent);
    assert.equal(released.to.active, null);

    const exhausted = graph.states.find(state => state.spent === cap && state.status === 'running' && state.active === null);
    assert.ok(exhausted, `cap ${cap} reaches an exhausted idle state`);
    assert.ok(transitions(exhausted).some(transition => transition.action === 'grant' && transition.outcome === 'refused'));
    assert.ok(graph.edges.some(transition => transition.outcome === 'recoveredBeforeGrant'));
    assert.ok(graph.states.some(state => state.claim >= 2 && state.spent === cap));
  }
});

test('a queued grant is refused and the checker detects a mutation that grants it', () => {
  const graph = explore(2);
  const queued = graph.states.find(state => state.status === 'queued' && state.claim > 0 && state.spent < state.cap);
  assert.ok(queued);
  assert.ok(transitions(queued).some(transition => transition.action === 'grant' && transition.outcome === 'refused'));

  const unsafe = transitions(queued, { unsafeQueuedGrant: true })
    .find(transition => transition.outcome === 'unsafeQueuedGrant');
  assert.ok(unsafe);
  assert.equal(accountingInvariant(unsafe), true);
  assert.equal(authorizationInvariant(unsafe), false);
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
    return state.status === 'running' && state.claim >= 2 && state.active === null && state.spent > 0 &&
      state.spent < state.cap && state.grants.some(grant => grant.claim < state.claim) &&
      path.some(transition => transition.action === 'requeue');
  });
  assert.ok(staleState);
  assert.ok(graph.edges.some(transition =>
    transition.from === staleState && transition.action === 'grant' && transition.outcome === 'idempotent' &&
    transition.claim < staleState.claim && !transition.attemptActive));
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
