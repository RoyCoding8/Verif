export const maximumClaims = 3;
export const attemptSlots = Object.freeze(['a', 'b']);

export function initialState(cap) {
  if (![1, 2, 3].includes(cap)) throw new RangeError('cap must be 1, 2, or 3');
  return Object.freeze({ cap, status: 'queued', claim: 0, spent: 0, active: null, grants: [] });
}

export function stateKey(state) {
  return JSON.stringify(state);
}

function edge(state, action, next, outcome = 'ok', details = {}) {
  return { from: state, action, to: next, outcome, ...details };
}

function replace(state, patch) {
  return { ...state, ...patch };
}

function attemptId(claim, slot) {
  return `${claim}-${slot}`;
}

function grantRecord(state, id) {
  return state.grants.find(grant => grant.id === id);
}

export function transitions(state, {
  unsafeRefundSpent = false,
  unsafeStaleGrant = false,
  unsafeQueuedGrant = false,
} = {}) {
  const edges = [];

  if (state.status === 'queued' && state.claim < maximumClaims) {
    edges.push(edge(state, 'startTask', replace(state, {
      status: 'running',
      claim: state.claim + 1,
    })));
  }

  if (state.status === 'running') {
    edges.push(edge(state, 'requeue', replace(state, {
      status: 'queued',
      active: null,
    }), state.active || state.grants.some(grant => grant.claim === state.claim)
      ? 'requeuedAfterAttempt'
      : 'recoveredBeforeGrant'));
    if (unsafeRefundSpent && state.spent > 0) {
      edges.push(edge(state, 'requeue', replace(state, {
        status: 'queued',
        active: null,
        spent: 0,
      }), 'unsafeRefund'));
    }
    if (state.active) {
      edges.push(edge(state, 'invalidate', replace(state, { active: null }), 'invalidated'));
    }
  }

  for (let claim = 1; claim <= maximumClaims; claim += 1) {
    for (const slot of attemptSlots) {
      const id = attemptId(claim, slot);
      const existing = grantRecord(state, id);
      if (existing) {
        edges.push(edge(state, 'grant', state, 'idempotent', {
          id,
          claim,
          attemptActive: state.active?.id === id && state.active.claim === claim,
        }));
        continue;
      }

      const currentGrantAllowed = state.status === 'running' && claim === state.claim &&
        claim === Number(id.split('-')[0]) && state.active === null && state.spent < state.cap;
      if (currentGrantAllowed) {
        const grant = { id, claim };
        edges.push(edge(state, 'grant', replace(state, {
          spent: state.spent + 1,
          active: grant,
          grants: [...state.grants, grant],
        }), 'granted', { id, claim }));
      } else {
        edges.push(edge(state, 'grant', state, 'refused', { id, claim }));
        if (unsafeStaleGrant && state.status === 'running' && claim < state.claim &&
          state.active === null && state.spent < state.cap) {
          const grant = { id, claim };
          edges.push(edge(state, 'grant', replace(state, {
            spent: state.spent + 1,
            active: grant,
            grants: [...state.grants, grant],
          }), 'unsafeStaleGrant', { id, claim }));
        }
        if (unsafeQueuedGrant && state.status === 'queued' && claim === state.claim &&
          state.active === null && state.spent < state.cap) {
          const grant = { id, claim };
          edges.push(edge(state, 'grant', replace(state, {
            spent: state.spent + 1,
            active: grant,
            grants: [...state.grants, grant],
          }), 'unsafeQueuedGrant', { id, claim }));
        }
      }
    }
  }

  return edges;
}

export function accountingInvariant(transition) {
  const { from, to, action, outcome } = transition;
  const spendsToken = outcome === 'granted' || outcome === 'unsafeStaleGrant' || outcome === 'unsafeQueuedGrant';
  const expectedSpent = spendsToken ? from.spent + 1 : outcome === 'unsafeRefund' ? 0 : from.spent;
  return to.spent === expectedSpent && to.spent === to.grants.length &&
    to.spent >= from.spent && to.spent <= to.cap &&
    (action === 'grant' || to.grants.length === from.grants.length);
}

export function authorizationInvariant(transition) {
  if (transition.outcome !== 'granted' && transition.outcome !== 'unsafeStaleGrant' &&
    transition.outcome !== 'unsafeQueuedGrant') return true;
  const { from, to, action, id, claim } = transition;
  if (action !== 'grant' || from.status !== 'running' || to.status !== 'running' || claim !== from.claim ||
    claim !== Number(id.split('-')[0])) return false;
  return to.active?.id === id && to.active.claim === claim;
}

export function explore(cap) {
  const initial = initialState(cap);
  const states = new Map([[stateKey(initial), initial]]);
  const paths = new Map([[stateKey(initial), []]]);
  const edges = [];
  const queue = [initial];
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const state = queue[cursor];
    for (const next of transitions(state)) {
      edges.push(next);
      const key = stateKey(next.to);
      if (!states.has(key)) {
        states.set(key, next.to);
        paths.set(key, [...paths.get(stateKey(state)), next]);
        queue.push(next.to);
      }
    }
  }
  return { states: [...states.values()], paths, edges };
}
