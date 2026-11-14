// Finite model of the hard cross-run cost ledger.
//
// One approved ceiling, worst-case pre-request bounds from a fixed bound set,
// and a durable reservation that survives restarts. The invariants are an
// independent rule recomputed from each transition, so the unsafe mutations
// must be caught by exploring the graph.

export const boundSet = Object.freeze([1, 2]);
export const caps = Object.freeze([2, 3]);

export function initialState(cap) {
  if (!caps.includes(cap)) throw new RangeError('cap must be one of ' + caps.join(', '));
  return Object.freeze({ cap, reserved: 0, admittedTotal: 0, issuedTotal: 0, raised: false });
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

export function transitions(state, {
  unsafeLateReservation = false,
  unsafeEstimateEnforcement = false,
  unsafeRefundRelease = false,
  unsafeCeilingRaise = false,
} = {}) {
  const edges = [];
  const consistent = state.issuedTotal <= state.admittedTotal;

  for (const bound of boundSet) {
    const fits = bound <= state.cap - state.reserved;
    if (fits) {
      edges.push(edge(state, 'request', replace(state, {
        reserved: state.reserved + bound,
        admittedTotal: state.admittedTotal + bound,
        issuedTotal: state.issuedTotal + bound,
      }), 'admitted', { bound }));
    } else {
      edges.push(edge(state, 'request', state, 'refused', { bound }));
      if (unsafeLateReservation && consistent) {
        // The request goes out before anything is reserved.
        edges.push(edge(state, 'request', replace(state, {
          issuedTotal: state.issuedTotal + bound,
        }), 'unsafeLateReservation', { bound }));
      }
      const estimate = Math.floor(bound / 2);
      if (unsafeEstimateEnforcement && consistent && estimate <= state.cap - state.reserved) {
        // Enforcement prices the request at an estimate below its bound.
        edges.push(edge(state, 'request', replace(state, {
          reserved: state.reserved + estimate,
          admittedTotal: state.admittedTotal + estimate,
          issuedTotal: state.issuedTotal + bound,
        }), 'unsafeEstimateEnforcement', { bound, estimate }));
      }
      if (unsafeRefundRelease && state.reserved === state.admittedTotal && state.reserved > 0) {
        // A refusal wrongly releases an earlier reservation.
        edges.push(edge(state, 'request', replace(state, {
          reserved: state.reserved - 1,
        }), 'unsafeRefundRelease', { bound }));
      }
      if (unsafeCeilingRaise && !state.raised) {
        // The ceiling is raised instead of refusing.
        edges.push(edge(state, 'request', replace(state, {
          cap: state.cap + 1,
          reserved: state.reserved + bound,
          admittedTotal: state.admittedTotal + bound,
          issuedTotal: state.issuedTotal + bound,
          raised: true,
        }), 'unsafeCeilingRaise', { bound }));
      }
    }
  }

  // A restart replays the same durable ledger; the ceiling and the
  // reservation carry over unchanged.
  edges.push(edge(state, 'restart', state, 'recovered', {}));

  return edges;
}

// Independent rule: the ledger equals the sum of admitted bounds, no request
// is issued without its reservation, and the ceiling holds.
export function accountingInvariant(transition) {
  const { from, to, outcome, bound, estimate } = transition;
  const reservedDelta = to.reserved - from.reserved;
  const admittedDelta = to.admittedTotal - from.admittedTotal;
  const issuedDelta = to.issuedTotal - from.issuedTotal;
  const stateLevel = to.reserved === to.admittedTotal && to.issuedTotal <= to.admittedTotal &&
    to.issuedTotal >= from.issuedTotal && to.reserved >= 0 && to.reserved <= to.cap;
  let exact;
  switch (outcome) {
    case 'admitted':
    case 'unsafeCeilingRaise':
      exact = reservedDelta === bound && admittedDelta === bound && issuedDelta === bound;
      break;
    case 'unsafeLateReservation':
      exact = reservedDelta === 0 && admittedDelta === 0 && issuedDelta === bound;
      break;
    case 'unsafeEstimateEnforcement':
      exact = reservedDelta === estimate && admittedDelta === estimate && issuedDelta === bound;
      break;
    case 'unsafeRefundRelease':
      exact = reservedDelta === -1 && admittedDelta === 0 && issuedDelta === 0;
      break;
    case 'refused':
    case 'recovered':
      exact = reservedDelta === 0 && admittedDelta === 0 && issuedDelta === 0;
      break;
    default:
      return false;
  }
  return stateLevel && exact;
}

// Independent rule: a request is admitted only when its worst-case bound
// fits the remaining ceiling.
export function admissionInvariant(transition) {
  const { from, outcome, bound, estimate } = transition;
  if (outcome === 'admitted' || outcome === 'unsafeCeilingRaise' || outcome === 'unsafeLateReservation' ||
    outcome === 'unsafeEstimateEnforcement') {
    return bound <= from.cap - from.reserved;
  }
  if (outcome === 'refused') return bound > from.cap - from.reserved;
  return true;
}

// Independent rule: the approved ceiling never moves.
export function ceilingInvariant(transition) {
  return transition.to.cap === transition.from.cap;
}

export function explore(cap, options = {}) {
  const initial = initialState(cap);
  const states = new Map([[stateKey(initial), initial]]);
  const paths = new Map([[stateKey(initial), []]]);
  const edges = [];
  const queue = [initial];
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const state = queue[cursor];
    for (const next of transitions(state, options)) {
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
