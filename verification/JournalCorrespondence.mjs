import { edge, replace, stateKey, explore as sharedExplore } from './explore.mjs';

export { stateKey };

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
      edges.push(edge(state, 'rejectRecheck', state, 'recheckRefused'));
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
  return sharedExplore(initialState, (state) => transitions(state), stateKey);
}

export const values = Object.freeze({ Old, Next, Other });
