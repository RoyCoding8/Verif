import test from 'node:test';
import assert from 'node:assert/strict';
import { expandSampledCases, sampleGenerator } from '../src/sampled-cases.mjs';

const oracle = {
  module: 'oracle.mjs',
  name: 'check',
  axes: [[0, 1, 2], ['a', 'b']],
  expected: { ok: true },
  seed: 7,
  samples: 8,
};

test('sampled cases are reproducible, versioned, and stay inside each approved axis', () => {
  const cases = expandSampledCases(oracle);
  assert.equal(sampleGenerator, 'sha256-counter-v1');
  assert.deepEqual(expandSampledCases(oracle), cases);
  assert.deepEqual(cases.map(({ id }) => id), Array.from({ length: 8 }, (_, index) => String(index)));
  for (const item of cases) {
    assert.equal(item.module, oracle.module);
    assert.equal(item.name, oracle.name);
    assert.deepEqual(item.expected, oracle.expected);
    assert.equal(item.args.length, oracle.axes.length);
    item.args.forEach((value, position) => assert.ok(oracle.axes[position].some(candidate =>
      JSON.stringify(candidate) === JSON.stringify(value))));
  }
  assert.notDeepEqual(expandSampledCases({ ...oracle, seed: 8 }), cases);
  const shorter = expandSampledCases({ ...oracle, samples: 3 });
  assert.equal(shorter.length, 3);
  assert.notDeepEqual(shorter, cases);
});

test('sampled cases match the pinned known vector', () => {
  assert.deepEqual(expandSampledCases(oracle).map(({ args }) => args), [
    [2, 'a'], [1, 'a'], [1, 'b'], [0, 'a'], [1, 'b'], [1, 'a'], [1, 'b'], [1, 'a'],
  ]);
});

test('zero input axes still produce the requested zero-argument calls', () => {
  assert.deepEqual(expandSampledCases({ ...oracle, axes: [], samples: 2 }).map(({ args }) => args), [[], []]);
});

test('malformed sampled oracles are rejected at the boundary', () => {
  const invalid = [
    { ...oracle, module: '../escape.mjs' },
    { ...oracle, module: 'C:/escape.mjs' },
    { ...oracle, axes: [[]] },
    { ...oracle, axes: [[1, 1]] },
    { ...oracle, axes: [[{ a: 1 }, { a: 1 }]] },
    { ...oracle, axes: [[{ a: 1, b: 2 }, { b: 2, a: 1 }]] },
    { ...oracle, axes: [[{ a: 1 }, { a: 2 }]], expected: undefined },
    { ...oracle, axes: [[undefined]] },
    { ...oracle, expected: undefined },
    { ...oracle, expected: Infinity },
    { ...oracle, seed: -1 },
    { ...oracle, seed: 0x1_0000_0000 },
    { ...oracle, seed: 1.5 },
    { ...oracle, samples: 0 },
    { ...oracle, samples: 1001 },
    { ...oracle, samples: 2.5 },
  ];
  for (const candidate of invalid) assert.throws(() => expandSampledCases(candidate));
  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(() => expandSampledCases({ ...oracle, axes: [[cyclic]] }));
});
