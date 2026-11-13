const approvalA = 'a'.repeat(64);
const approvalB = 'b'.repeat(64);

export const values = Object.freeze({ approvalA, approvalB, old: 'old', next: 'next' });

export const initialState = Object.freeze({
  revoked: [],
  attempts: [],
  operation: null,
  ref: 'old',
});

export function stateKey(state) {
  return JSON.stringify(state);
}

export function effectiveAuthority(state, attemptId, { ignoreRevocation = false } = {}) {
  const attempt = state.attempts.find(item => item.id === attemptId);
  return Boolean(attempt?.active && (ignoreRevocation || !state.revoked.includes(attempt.approval)));
}

function edge(state, action, next, outcome) {
  return { from: state, action, to: next, outcome };
}

function changed(state, patch) {
  return { ...state, ...patch };
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
  for (const approval of [approvalA]) {
    edges.push(edge(state, { type: 'revoke', approval },
      transition(state, { type: 'revoke', approval }).state,
      transition(state, { type: 'revoke', approval }).outcome));
    const id = approval === approvalA ? 'attempt-a' : 'attempt-b';
    if (!state.attempts.some(attempt => attempt.id === id)) {
      const action = { type: 'register', id, approval };
      const result = transition(state, action);
      edges.push(edge(state, action, result.state, result.outcome));
    } else if (state.attempts.find(attempt => attempt.id === id).active) {
      const action = { type: 'cancel', id };
      const result = transition(state, action);
      edges.push(edge(state, action, result.state, result.outcome));
    }
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
        paths.set(key, [...paths.get(stateKey(state)), next.action]);
        queue.push(next.to);
      }
    }
  }
  return { states: [...states.values()], paths, edges };
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
