const Old = 'old';
const Next = 'next';
const Other = 'other';

export const initialState = Object.freeze({
  head: Old,
  status: 'none',
  attemptActive: true,
  policyEpoch: 0,
  operationEpoch: null,
});

export function stateKey(state) {
  return JSON.stringify(state);
}

function edge(state, action, nextState, outcome = 'ok') {
  return { from: state, action, to: nextState, outcome };
}

function replace(state, patch) {
  return { ...state, ...patch };
}

export function transitions(state, { unsafeAuthorization = false } = {}) {
  const edges = [];
  if (state.status === 'none' && state.head === Old && state.attemptActive) {
    edges.push(edge(state, 'prepare', replace(state, {
      status: 'prepared',
      operationEpoch: state.policyEpoch,
    })));
  }
  if (state.policyEpoch === 0) {
    edges.push(edge(state, 'changePolicy', replace(state, { policyEpoch: 1 })));
  }
  if (state.attemptActive) {
    edges.push(edge(state, 'revokeAttempt', replace(state, { attemptActive: false })));
  }
  if (state.status === 'prepared' && state.head === Old) {
    edges.push(edge(state, 'moveHeadElsewhere', replace(state, { head: Other })));
    if (authorized(state)) {
      edges.push(edge(state, 'crashAfterRefWrite', replace(state, { head: Next }), 'throwsAfterWrite'));
    }
  }
  if (state.status === 'prepared' || state.status === 'promoted') {
    if (state.status === 'promoted') {
      edges.push(edge(state, 'promote', state, 'idempotent'));
    } else if (state.head === Next) {
      edges.push(edge(state, 'promote', replace(state, { status: 'promoted' }), 'recovered'));
    } else if (state.head === Other) {
      edges.push(edge(state, 'promote', state, 'refused'));
    } else if (authorized(state)) {
      edges.push(edge(state, 'promote', replace(state, { head: Next, status: 'promoted' })));
    } else if (unsafeAuthorization) {
      edges.push(edge(state, 'promote', replace(state, { head: Next, status: 'promoted' }), 'unsafe'));
    } else {
      edges.push(edge(state, 'promote', state, 'refused'));
    }
  }
  return edges;
}

export function authorized(state) {
  return state.attemptActive && state.operationEpoch === state.policyEpoch;
}

export function promotionInvariant(edgeValue) {
  return edgeValue.from.head !== Old ||
    edgeValue.to.head !== Next ||
    authorized(edgeValue.from);
}

export function explore() {
  const states = new Map([[stateKey(initialState), initialState]]);
  const paths = new Map([[stateKey(initialState), []]]);
  const edges = [];
  const queue = [initialState];
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

export const values = Object.freeze({ Old, Next, Other });
