const initialState = Object.freeze({
  cache: 'empty', storedIdentity: 'none', identity: 'same', authority: 'fresh',
  source: 'none', evidenceIdentity: 'none', promoted: false,
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
  if (state.source === 'none') {
    edges.push(edge(state, 'completeExecution', replace(state, {
      cache: state.cache === 'empty' ? 'raw' : state.cache,
      storedIdentity: state.cache === 'empty' ? state.identity : state.storedIdentity,
      source: 'executed', evidenceIdentity: state.identity,
    })));
    edges.push(edge(state, 'infrastructureFailure', state, 'noEvidence'));
  }
  if (state.cache === 'raw' && state.source === 'none' && state.storedIdentity === state.identity && state.authority === 'fresh') {
    edges.push(edge(state, 'lookupHit', replace(state, { source: 'reused', evidenceIdentity: state.identity })));
  }
  if (state.cache === 'raw' && state.source === 'none' && state.storedIdentity !== state.identity) {
    edges.push(edge(state, 'lookupMiss', state, 'noEvidence'));
  }
  if (state.source !== 'none') edges.push(edge(state, 'beginAttempt', replace(state, {
    source: 'none', evidenceIdentity: 'none', promoted: false,
  })));
  if (state.identity === 'same') edges.push(edge(state, 'changeExecutionKey', replace(state, { identity: 'different' })));
  if (state.identity === 'different') edges.push(edge(state, 'restoreExecutionKey', replace(state, { identity: 'same' })));
  if (state.authority === 'fresh') edges.push(edge(state, 'revokeAuthority', replace(state, { authority: 'stale' })));
  if (state.source !== 'none' && !state.promoted && state.authority === 'fresh' && state.evidenceIdentity === state.identity) {
    edges.push(edge(state, 'promote', replace(state, { promoted: true })));
  }
  if (state.source !== 'none' && !state.promoted && unsafeAuthorization &&
      (state.authority !== 'fresh' || state.evidenceIdentity !== state.identity)) {
    edges.push(edge(state, 'promote', replace(state, { promoted: true }), 'unsafe'));
  }
  return edges;
}

export function invariant(transition) {
  const { from, action, to, outcome } = transition;
  if (action === 'infrastructureFailure' && (to.cache !== from.cache || to.source !== from.source)) return false;
  if (action === 'lookupHit' && (from.cache !== 'raw' || from.storedIdentity !== from.identity || from.authority !== 'fresh')) return false;
  if (action === 'promote' && (from.authority !== 'fresh' || from.evidenceIdentity !== from.identity)) return false;
  return outcome !== 'unsafe';
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

export function negativeControl() {
  const { paths } = explore();
  const stale = [...paths.keys()].map(key => JSON.parse(key)).find(state =>
    state.source === 'reused' && state.authority === 'stale' && !state.promoted);
  return {
    path: paths.get(stateKey(stale)),
    transition: transitions(stale, { unsafeAuthorization: true }).find(next => next.outcome === 'unsafe'),
  };
}

export function keyNegativeControl() {
  const { paths } = explore();
  const stale = [...paths.keys()].map(key => JSON.parse(key)).find(state =>
    state.source !== 'none' && state.evidenceIdentity !== state.identity && !state.promoted);
  return {
    path: paths.get(stateKey(stale)),
    transition: transitions(stale, { unsafeAuthorization: true }).find(next => next.outcome === 'unsafe'),
  };
}

export const initial = initialState;
