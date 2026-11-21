export function stateKey(state) {
  return JSON.stringify(state);
}

export function edge(state, action, to, outcome = 'ok', details = {}) {
  return { from: state, action, to, outcome, ...details };
}

export function replace(state, patch) {
  return { ...state, ...patch };
}

export function explore(initial, step, key = stateKey) {
  const initialKey = key(initial);
  const states = new Map([[initialKey, initial]]);
  const paths = new Map([[initialKey, []]]);
  const edges = [];
  const queue = [initial];
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const state = queue[cursor];
    for (const next of step(state)) {
      edges.push(next);
      const nextKey = key(next.to);
      if (!states.has(nextKey)) {
        states.set(nextKey, next.to);
        paths.set(nextKey, [...paths.get(key(state)), next]);
        queue.push(next.to);
      }
    }
  }
  return { states: [...states.values()], paths, edges };
}
