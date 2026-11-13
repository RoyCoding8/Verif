import test from 'node:test';
import assert from 'node:assert/strict';
import { checkHistory, parseHistoryOracle } from '../src/history-check.mjs';

function referenceKey(value) {
  if (Array.isArray(value)) return `[${value.map(referenceKey).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${referenceKey(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function bruteForce(machine, history) {
  const order = [];
  const walk = (state, remaining) => {
    if (remaining.length === 0) return true;
    for (const index of remaining) {
      const call = history[index];
      if (history.some((prior, priorIndex) => prior.response < call.invocation && !order.includes(priorIndex))) continue;
      const transition = machine.transitions.find((candidate) =>
        referenceKey(candidate.from) === referenceKey(state)
        && candidate.operation === call.operation
        && referenceKey(candidate.input) === referenceKey(call.input)
        && referenceKey(candidate.output) === referenceKey(call.output));
      if (transition === undefined) continue;
      order.push(index);
      if (walk(transition.to, remaining.filter((other) => other !== index))) return true;
      order.pop();
    }
    return false;
  };
  return walk(machine.initial, history.map((_, index) => index));
}

function permute(values, prefix = [], results = []) {
  if (values.length === 0) results.push(prefix);
  else for (let index = 0; index < values.length; index += 1) {
    permute(values.filter((_, other) => other !== index), [...prefix, values[index]], results);
  }
  return results;
}

const counterMachine = {
  initial: 0,
  transitions: [
    ...Array.from({ length: 5 }, (_, state) => ({ from: state, operation: 'inc', input: { step: 1 }, output: 'ok', to: state + 1 })),
    ...Array.from({ length: 5 }, (_, state) => ({ from: state, operation: 'read', input: { step: 0 }, output: state, to: state })),
  ],
};

test('matches an independent permutation reference for generated overlapping histories', () => {
  let compared = 0;
  for (let length = 1; length <= 4; length += 1) {
    for (let shape = 0; shape < 2 ** length; shape += 1) {
      const operations = Array.from({ length }, (_, index) => (shape & (1 << index)) ? 'read' : 'inc');
      const readPositions = operations.flatMap((operation, index) => operation === 'read' ? [index] : []);
      for (let outputs = 0; outputs < 2 ** readPositions.length; outputs += 1) {
        const history = operations.map((operation, index) => ({
          operation,
          input: operation === 'inc' ? { step: 1 } : { step: 0 },
          output: operation === 'inc' ? 'ok' : (outputs & (1 << readPositions.indexOf(index))) ? 1 : 0,
          invocation: index,
          response: index + length,
        }));
        const expected = bruteForce(counterMachine, history);
        assert.equal(checkHistory(counterMachine, history), expected);
        compared += 1;
      }
    }
  }
  assert.equal(compared, 120);
});

test('backtracks across plausible first calls to find a valid order', () => {
  const machine = {
    initial: 'start',
    transitions: [
      { from: 'start', operation: 'x', input: null, output: 'x', to: 'dead' },
      { from: 'start', operation: 'y', input: null, output: 'y', to: 'middle' },
      { from: 'middle', operation: 'z', input: null, output: 'z', to: 'finish' },
      { from: 'finish', operation: 'x', input: null, output: 'x', to: 'done' },
    ],
  };
  const history = [
    { operation: 'x', input: null, output: 'x', invocation: 0, response: 3 },
    { operation: 'y', input: null, output: 'y', invocation: 1, response: 4 },
    { operation: 'z', input: null, output: 'z', invocation: 2, response: 5 },
  ];
  assert.equal(checkHistory(machine, history), true);
});

test('real-time precedence rejects a sequentially valid order that runs backwards', () => {
  const machine = {
    initial: 'start',
    transitions: [
      { from: 'start', operation: 'b', input: null, output: 'b', to: 'middle' },
      { from: 'middle', operation: 'a', input: null, output: 'a', to: 'done' },
    ],
  };
  const history = [
    { operation: 'a', input: null, output: 'a', invocation: 0, response: 1 },
    { operation: 'b', input: null, output: 'b', invocation: 2, response: 3 },
  ];
  assert.equal(bruteForce(machine, history), false);
  assert.equal(checkHistory(machine, history), false);
  assert.equal(checkHistory(machine, [...history].reverse()), false);
});

test('accepts any admissible order for overlapping calls and canonical JSON values', () => {
  const machine = {
    initial: { count: 0 },
    transitions: [
      { from: { count: 0 }, operation: 'put', input: { b: 2, a: 1 }, output: { ok: true }, to: { count: 1 } },
      { from: { count: 1 }, operation: 'get', input: null, output: 1, to: { count: 1 } },
    ],
  };
  const history = [
    { operation: 'get', input: null, output: 1, invocation: 0, response: 3 },
    { operation: 'put', input: { a: 1, b: 2 }, output: { ok: true }, invocation: 1, response: 2 },
  ];
  assert.equal(checkHistory(machine, history), true);
});

test('rejects malformed histories and deterministic-machine violations', () => {
  const history = [{ operation: 'inc', input: { step: 1 }, output: 'ok', invocation: 0, response: 1 }];
  assert.throws(() => checkHistory(counterMachine, [{ ...history[0], response: 0 }]), /invocation must precede/);
  assert.throws(() => checkHistory(counterMachine, [history[0], { ...history[0], invocation: 1, response: 2 }]), /globally distinct/);
  assert.throws(() => checkHistory(counterMachine, [{ ...history[0], output: undefined }]), /JSON values/);
  assert.throws(() => checkHistory(counterMachine, Array.from({ length: 19 }, (_, index) => ({ ...history[0], invocation: index, response: index + 19 }))), RangeError);
  assert.throws(() => checkHistory({ initial: 0, transitions: [
    { from: 0, operation: 'inc', input: null, output: 'a', to: 1 },
    { from: 0, operation: 'inc', input: null, output: 'b', to: 2 },
  ] }, []), /deterministic/);
  const sparseInput = [];
  sparseInput.length = 1;
  assert.throws(() => checkHistory({ initial: 0, transitions: [] }, [{ ...history[0], input: sparseInput }]), /dense/);
  const sparseHistory = [];
  sparseHistory.length = 1;
  assert.throws(() => checkHistory({ initial: 0, transitions: [] }, sparseHistory), /dense/);
  const sparseWithExtra = new Array(2);
  sparseWithExtra[0] = history[0];
  sparseWithExtra.extra = history[0];
  assert.throws(() => checkHistory({ initial: 0, transitions: [] }, sparseWithExtra), /dense/);
});

function validOracle() {
  return {
    machine: {
      initial: 0,
      transitions: [
        { from: 0, operation: 'tick', input: null, output: 'ok', to: 1 },
        { from: 1, operation: 'tick', input: null, output: 'ok', to: 2 },
      ],
    },
    cases: [{ id: 'parallel-ticks', module: 'counter', name: 'Counter', args: [], calls: [[
      { operation: 'tick', input: null }, { operation: 'tick', input: null },
    ]], expect: 'linearizable' }],
    requiredOperations: ['tick'],
    negativeControl: [{ operation: 'tick', input: null, output: 'bad', invocation: 0, response: 1 }],
  };
}

test('parses approved cases with positive coverage, overlap, and a known-bad control', () => {
  const parsed = parseHistoryOracle(validOracle());
  assert.equal(parsed.cases[0].calls[0].length, 2);
  assert.deepEqual(parsed.requiredOperations, ['tick']);
  assert.equal(checkHistory(parsed.machine, parsed.negativeControl), false);
});

test('fails closed on missing positive coverage, no overlap, and an accepted negative control', () => {
  const uncovered = validOracle();
  uncovered.requiredOperations.push('reset');
  uncovered.machine.transitions.push({ from: 2, operation: 'reset', input: null, output: 'ok', to: 0 });
  assert.throws(() => parseHistoryOracle(uncovered), /lacks positive-case coverage/);
  const serial = validOracle();
  serial.cases[0].calls = [[{ operation: 'tick', input: null }]];
  assert.throws(() => parseHistoryOracle(serial), /positive concurrent phase/);
  const acceptedNegative = validOracle();
  acceptedNegative.negativeControl = [{ operation: 'tick', input: null, output: 'ok', invocation: 0, response: 1 }];
  assert.throws(() => parseHistoryOracle(acceptedNegative), /negativeControl must be nonlinearizable/);
  const overLimit = validOracle();
  overLimit.cases = Array.from({ length: 33 }, (_, index) => ({ ...overLimit.cases[0], id: `case-${index}` }));
  assert.throws(() => parseHistoryOracle(overLimit), RangeError);
  const unmodeled = validOracle();
  unmodeled.requiredOperations.push('reset');
  unmodeled.machine.transitions.push({ from: 2, operation: 'other', input: null, output: 'ok', to: 3 });
  assert.throws(() => parseHistoryOracle(unmodeled), /not modeled/);
  const emptyCoverage = validOracle();
  emptyCoverage.requiredOperations = [];
  assert.throws(() => parseHistoryOracle(emptyCoverage), /must not be empty/);
});

test('throws when the caller deadline has expired', () => {
  assert.throws(() => checkHistory(counterMachine, [], { deadline: Date.now() - 1 }), /deadline exceeded/);
  assert.throws(() => parseHistoryOracle(validOracle(), { deadline: Date.now() - 1 }), /deadline exceeded/);
});
