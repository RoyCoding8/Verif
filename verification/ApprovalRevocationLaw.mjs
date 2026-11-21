import { edge, replace as changed, stateKey, explore as sharedExplore } from './explore.mjs';

export { stateKey };

const approvalA = 'a'.repeat(64);
const approvalB = 'b'.repeat(64);

export const values = Object.freeze({ approvalA, approvalB, old: 'old', next: 'next' });

export const initialState = Object.freeze({
  revoked: [],
  attempts: [],
  operation: null,
  ref: 'old',
});

export function effectiveAuthority(state, attemptId, { ignoreRevocation = false } = {}) {
  const attempt = state.attempts.find(item => item.id === attemptId);
  return Boolean(attempt?.active && (ignoreRevocation || !state.revoked.includes(attempt.approval)));
}

export function transition(state, action, { ignoreRevocation = false } = {}) {
  if (action.type === 'revoke') {
    const existed = state.revoked.includes(action.approval);
    const revoked = existed ? state.revoked : [...state.revoked, action.approval].sort();
    return {
      state: changed(state, { revoked }),
      outcome: existed ? 'already_revoked' : 'revoked',
    };
  }

  if (action.type === 'register') {
    const exists = state.attempts.some(item => item.id === action.id);
    if (!ignoreRevocation && state.revoked.includes(action.approval)) {
      return { state, outcome: 'revoked' };
    }
    if (exists) return { state, outcome: 'already_registered' };
    const attempts = [...state.attempts, { id: action.id, approval: action.approval, active: true }]
      .sort((left, right) => left.id.localeCompare(right.id));
    return { state: changed(state, { attempts }), outcome: 'registered' };
  }

  if (action.type === 'cancel') {
    const attempts = state.attempts.map(attempt => attempt.id === action.id
      ? { ...attempt, active: false }
      : attempt);
    return { state: changed(state, { attempts }), outcome: 'cancelled' };
  }

  if (action.type === 'prepare') {
    if (state.operation || !effectiveAuthority(state, action.attemptId, { ignoreRevocation })) {
      return { state, outcome: 'refused' };
    }
    const attempt = state.attempts.find(item => item.id === action.attemptId);
    const operation = { status: 'prepared', attemptId: attempt.id, approval: attempt.approval, receipt: 'frozen-receipt' };
    return { state: changed(state, { operation }), outcome: 'prepared' };
  }

  if (action.type === 'loseWriteResponse') {
    if (state.operation?.status !== 'prepared' || state.ref !== 'old' ||
        !effectiveAuthority(state, state.operation?.attemptId, { ignoreRevocation })) {
      return { state, outcome: 'refused' };
    }
    return { state: changed(state, { ref: 'next' }), outcome: 'lost_response' };
  }

  if (action.type === 'promote') {
    if (state.operation?.status === 'promoted') return { state, outcome: 'idempotent' };
    if (state.operation?.status !== 'prepared') return { state, outcome: 'refused' };
    if (state.ref === 'next') {
      const operation = { ...state.operation, status: 'promoted' };
      return { state: changed(state, { operation }), outcome: 'recovered' };
    }
    if (state.ref !== 'old') return { state, outcome: 'refused' };
    if (!effectiveAuthority(state, state.operation.attemptId, { ignoreRevocation })) {
      return { state, outcome: state.revoked.includes(state.operation.approval) ? 'revoked' : 'inactive' };
    }
    const operation = { ...state.operation, status: 'promoted' };
    return { state: changed(state, { operation, ref: 'next' }), outcome: 'promoted' };
  }

  throw new Error('unknown reference action ' + action.type);
}

export function transitions(state) {
  const edges = [];
  const approval = approvalA;
  const id = 'attempt-a';
  edges.push(edge(state, { type: 'revoke', approval },
    transition(state, { type: 'revoke', approval }).state,
    transition(state, { type: 'revoke', approval }).outcome));
  if (!state.attempts.some(attempt => attempt.id === id)) {
    const action = { type: 'register', id, approval };
    const result = transition(state, action);
    edges.push(edge(state, action, result.state, result.outcome));
  } else if (state.attempts.find(attempt => attempt.id === id).active) {
    const action = { type: 'cancel', id };
    const result = transition(state, action);
    edges.push(edge(state, action, result.state, result.outcome));
  }
  if (state.operation === null) {
    for (const attempt of state.attempts) {
      const action = { type: 'prepare', attemptId: attempt.id };
      const result = transition(state, action);
      if (result.outcome === 'prepared') edges.push(edge(state, action, result.state, result.outcome));
    }
  } else if (state.operation.status === 'prepared') {
    const action = { type: 'promote', attemptId: state.operation.attemptId };
    const result = transition(state, action);
    edges.push(edge(state, action, result.state, result.outcome));
    const write = { type: 'loseWriteResponse', attemptId: state.operation.attemptId };
    const lost = transition(state, write);
    if (lost.outcome === 'lost_response') edges.push(edge(state, write, lost.state, lost.outcome));
  }
  return edges;
}

export function explore() {
  const graph = sharedExplore(initialState, (state) => transitions(state), stateKey);
  return {
    states: graph.states,
    edges: graph.edges,
    paths: new Map([...graph.paths].map(([key, path]) => [key, path.map((edge) => edge.action)])),
  };
}

export function promotionInvariant(transitionValue) {
  const { from, to, action, outcome } = transitionValue;
  if (action.type === 'loseWriteResponse' && from.ref === 'old' && to.ref === 'next') {
    return effectiveAuthority(from, from.operation.attemptId);
  }
  if (action.type !== 'promote' || !['promoted', 'recovered'].includes(outcome)) return true;
  if (outcome === 'recovered') return from.ref === 'next' && to.ref === 'next';
  return effectiveAuthority(from, action.attemptId) && from.ref === 'old' && to.ref === 'next';
}
