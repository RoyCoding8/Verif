export const maximumClaims = 3;
export const attemptSlots = Object.freeze(['a', 'b']);

export function initialState(cap) {
  if (![1, 2, 3].includes(cap)) throw new RangeError('cap must be 1, 2, or 3');
  return Object.freeze({ cap, claim: 0, spent: 0, active: null, grants: [] });
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

export function transitions(state, { unsafeRefundSpent = false, unsafeStaleGrant = false } = {}) {
  const edges = [];

  if (state.claim < maximumClaims && state.active === null) {
    edges.push(edge(state, 'claim', replace(state, { claim: state.claim + 1 })));
  }

  if (state.claim > 0) {
    const requeued = replace(state, { active: null });
    edges.push(edge(state, 'requeue', requeued, state.active ? 'released' : 'recoveredBeforeGrant'));
    if (unsafeRefundSpent && state.spent > 0) {
      edges.push(edge(state, 'requeue', replace(state, { active: null, spent: 0 }), 'unsafeRefund'));
    }
  }

  for (let claim = 1; claim <= maximumClaims; claim += 1) {
    for (const slot of attemptSlots) {
      const id = attemptId(claim, slot);
      const existing = grantRecord(state, id);
      if (existing && state.active?.id === id && state.active.claim === claim) {
        edges.push(edge(state, 'grant', state, 'idempotent', { id, claim }));
        continue;
      }

      const valid = claim === state.claim && claim === Number(id.split('-')[0]) &&
        state.active === null && state.spent < state.cap && !existing;
      if (valid) {
        const grant = { id, claim };
        edges.push(edge(state, 'grant', replace(state, {
          spent: state.spent + 1,
          active: grant,
          grants: [...state.grants, grant],
        }), 'granted', { id, claim }));
      } else {
        edges.push(edge(state, 'grant', state, 'refused', { id, claim }));
        if (unsafeStaleGrant && claim !== state.claim && state.active === null && state.spent < state.cap && !existing) {
          const grant = { id, claim };
          edges.push(edge(state, 'grant', replace(state, {
            spent: state.spent + 1,
            active: grant,
            grants: [...state.grants, grant],
          }), 'unsafeStaleGrant', { id, claim }));
        }
      }
    }
  }

  return edges;
}

export function accountingInvariant(transition) {
  const { from, to, action, outcome } = transition;
  const expectedSpent = outcome === 'granted' || outcome === 'unsafeStaleGrant'
    ? from.spent + 1
    : outcome === 'unsafeRefund' ? 0 : from.spent;
  return to.spent === expectedSpent && to.spent === to.grants.length &&
    to.spent >= from.spent && to.spent <= to.cap &&
    (action === 'grant' || to.grants.length === from.grants.length);
}

export function authorizationInvariant(transition) {
  if (transition.outcome !== 'granted' && transition.outcome !== 'unsafeStaleGrant') return true;
  const { from, to, action, id, claim } = transition;
  if (action !== 'grant' || claim !== from.claim || claim !== Number(id.split('-')[0])) return false;
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
