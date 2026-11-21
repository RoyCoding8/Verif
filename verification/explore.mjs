// Shared breadth-first state-space driver for the finite models in
// verification/. Each model keeps its own initialState, stateKey,
// transitions, and invariants; this module owns only the traversal.
//
// step(state) returns an iterable of edge objects `{ to, ... }`, and
// key(state) returns the state's dedupe key. The result is
// `{ states, paths, edges }` exactly as the previously duplicated bodies
// returned: `states` in first-discovery order, `paths` keyed by state key
// holding the edge sequence from the initial state, and `edges` holding
// every edge in traversal order.
export function explore(initial, step, key) {
  const initialKey = key(initial);
  const states = new Map([[initialKey, initial]]);
  const paths = new Map([[initialKey, []]]);
  const edges = [];
  const queue = [initial];
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const state = queue[cursor];
    for (const next of step(state)) {
      edges.push(next);
      const stateKey = key(next.to);
      if (!states.has(stateKey)) {
        states.set(stateKey, next.to);
        paths.set(stateKey, [...paths.get(key(state)), next]);
        queue.push(next.to);
      }
    }
  }
  return { states: [...states.values()], paths, edges };
}
