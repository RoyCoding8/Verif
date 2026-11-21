import assert from 'node:assert/strict';
import test from 'node:test';
import {
  accountingInvariant,
  admissionInvariant,
  caps,
  ceilingInvariant,
  explore,
} from '../verification/CostCeiling.mjs';

const expected = new Map([[2, [3, 9]], [3, [4, 12]]]);

function violations(graph) {
  return graph.edges.filter(edge => !accountingInvariant(edge) || !admissionInvariant(edge) || !ceilingInvariant(edge));
}

test('the cost ledger model admits exactly the bounds that fit and never exceeds the ceiling', () => {
  for (const cap of caps) {
    const graph = explore(cap);
    assert.deepEqual([graph.states.length, graph.edges.length], expected.get(cap), `cap ${cap} graph shape`);
    assert.deepEqual(violations(graph), [], `cap ${cap} satisfies every invariant`);

    for (const state of graph.states) {
      assert.equal(state.reserved, state.admittedTotal);
      assert.ok(state.issuedTotal <= state.admittedTotal);
      assert.ok(state.reserved >= 0 && state.reserved <= state.cap);
    }

    for (const edge of graph.edges) {
      assert.equal(accountingInvariant(edge), true, `cap ${cap}: ${edge.action}/${edge.outcome}`);
      assert.equal(admissionInvariant(edge), true, `cap ${cap}: ${edge.action}/${edge.outcome}`);
      assert.equal(ceilingInvariant(edge), true, `cap ${cap}: ${edge.action}/${edge.outcome}`);
      if (edge.outcome === 'admitted') assert.ok(edge.bound <= edge.from.cap - edge.from.reserved);
      if (edge.outcome === 'refused') assert.ok(edge.bound > edge.from.cap - edge.from.reserved);
    }

    assert.ok(graph.edges.some(edge => edge.outcome === 'admitted' && edge.bound === 2), 'a maximal bound is admitted');
    assert.ok(graph.edges.some(edge => edge.outcome === 'refused'), 'the boundary refuses');
    assert.ok(graph.edges.some(edge => edge.outcome === 'recovered'), 'a restart carries the ledger over');
    assert.ok(graph.states.some(state => state.reserved === state.cap), 'the ceiling is reachable');
  }
});

for (const [mutation, expectedViolations] of Object.entries({
  unsafeLateReservation: { accounting: 12, admission: 3, ceiling: 0 },
  unsafeEstimateEnforcement: { accounting: 5, admission: 2, ceiling: 0 },
  unsafeRefundRelease: { accounting: 12, admission: 0, ceiling: 0 },
  unsafeCeilingRaise: { accounting: 4, admission: 3, ceiling: 3 },
})) {
  for (const cap of caps) {
    test(`${mutation} is killed by the invariants at cap ${cap}`, () => {
      const graph = explore(cap, { [mutation]: true });
      const accounting = graph.edges.filter(edge => !accountingInvariant(edge)).length;
      const admission = graph.edges.filter(edge => !admissionInvariant(edge)).length;
      const ceiling = graph.edges.filter(edge => !ceilingInvariant(edge)).length;
      assert.deepEqual({ accounting, admission, ceiling }, expectedViolations, mutation);
    });
  }
}
