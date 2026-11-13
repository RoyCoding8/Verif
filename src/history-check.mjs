import { safePath } from './contracts.mjs';

const MAX_HISTORY_CALLS = 18;
const MAX_SEARCH_STATES = 500_000;
const MAX_ORACLE_CASES = 32;
const MAX_ORACLE_CALLS = 128;

const own = (value, key) => Object.hasOwn(value, key);
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function requireDenseArray(value, label) {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  const keys = Object.keys(value);
  if (keys.length !== value.length || keys.some((key, index) => key !== String(index)) || Reflect.ownKeys(value).length !== value.length + 1) {
    throw new TypeError(`${label} must be a dense JSON array`);
  }
}

function jsonKey(value, label) {
  const active = new Set();
  const encode = (item) => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return JSON.stringify(item);
    if (typeof item === 'number' && Number.isFinite(item)) return JSON.stringify(item);
    if (Array.isArray(item)) {
      if (active.has(item)) throw new TypeError(`${label} must be acyclic JSON`);
      const keys = Object.keys(item);
      if (keys.length !== item.length || keys.some((key, index) => key !== String(index)) || Reflect.ownKeys(item).length !== item.length + 1) {
        throw new TypeError(`${label} arrays must be dense and have no extra properties`);
      }
      active.add(item);
      const result = `[${item.map(encode).join(',')}]`;
      active.delete(item);
      return result;
    }
    if (isRecord(item)) {
      if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) {
        throw new TypeError(`${label} must contain only JSON objects`);
      }
      if (Reflect.ownKeys(item).length !== Object.keys(item).length) throw new TypeError(`${label} objects must have only enumerable string keys`);
      if (active.has(item)) throw new TypeError(`${label} must be acyclic JSON`);
      active.add(item);
      const keys = Object.keys(item).sort();
      const result = `{${keys.map((key) => `${JSON.stringify(key)}:${encode(item[key])}`).join(',')}}`;
      active.delete(item);
      return result;
    }
    throw new TypeError(`${label} must contain only JSON values`);
  };
  return encode(value);
}

function requireName(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} must be a nonempty string`);
  return value;
}

function resolveDeadline(options) {
  if (options === undefined) return Infinity;
  if (!isRecord(options) || !(options.deadline === Infinity || Number.isFinite(options.deadline))) {
    throw new TypeError('options.deadline must be a finite timestamp or Infinity');
  }
  return options.deadline;
}

function checkDeadline(deadline) {
  if (Date.now() >= deadline) throw new RangeError('history checking deadline exceeded');
}

function validateMachine(machine, deadline = Infinity) {
  checkDeadline(deadline);
  if (!isRecord(machine) || !own(machine, 'initial') || !Array.isArray(machine.transitions)) {
    throw new TypeError('machine must have initial and transitions');
  }
  requireDenseArray(machine.transitions, 'machine.transitions');
  const initialKey = jsonKey(machine.initial, 'machine.initial');
  const transitions = new Map();
  for (const [index, transition] of machine.transitions.entries()) {
    if ((index & 255) === 0) checkDeadline(deadline);
    const label = `machine.transitions[${index}]`;
    if (!isRecord(transition) || !own(transition, 'from') || !own(transition, 'input') || !own(transition, 'output') || !own(transition, 'to')) {
      throw new TypeError(`${label} must have from, operation, input, output, and to`);
    }
    const operation = requireName(transition.operation, `${label}.operation`);
    const key = JSON.stringify([jsonKey(transition.from, `${label}.from`), operation, jsonKey(transition.input, `${label}.input`)]);
    const result = [jsonKey(transition.output, `${label}.output`), jsonKey(transition.to, `${label}.to`)];
    const previous = transitions.get(key);
    if (previous !== undefined && (previous[0] !== result[0] || previous[1] !== result[1])) throw new TypeError('machine transitions must be deterministic');
    transitions.set(key, result);
  }
  return { initialKey, transitions };
}

function validateHistory(history, deadline = Infinity) {
  checkDeadline(deadline);
  requireDenseArray(history, 'history');
  if (history.length > MAX_HISTORY_CALLS) throw new RangeError(`history exceeds ${MAX_HISTORY_CALLS} calls`);
  const events = new Set();
  const calls = history.map((call, index) => {
    if ((index & 255) === 0) checkDeadline(deadline);
    const label = `history[${index}]`;
    if (!isRecord(call) || !own(call, 'operation') || !own(call, 'input') || !own(call, 'output')) {
      throw new TypeError(`${label} must have operation, input, output, invocation, and response`);
    }
    const operation = requireName(call.operation, `${label}.operation`);
    for (const field of ['invocation', 'response']) {
      if (!own(call, field) || !Number.isSafeInteger(call[field]) || call[field] < 0) {
        throw new TypeError(`${label}.${field} must be a nonnegative safe integer`);
      }
    }
    if (call.invocation >= call.response) throw new TypeError(`${label}.invocation must precede response`);
    for (const event of [call.invocation, call.response]) {
      if (events.has(event)) throw new TypeError('history event indices must be globally distinct');
      events.add(event);
    }
    return {
      operation,
      inputKey: jsonKey(call.input, `${label}.input`),
      outputKey: jsonKey(call.output, `${label}.output`),
      invocation: call.invocation,
      response: call.response,
    };
  });
  return calls;
}

function checkPrepared(compiledMachine, history, deadline = Infinity) {
  checkDeadline(deadline);
  const { initialKey, transitions } = compiledMachine;
  const calls = validateHistory(history, deadline);
  const length = calls.length;
  const all = (1 << length) - 1;
  const predecessors = calls.map((call, index) => {
    let mask = 0;
    for (let other = 0; other < length; other += 1) {
      if (calls[other].response < call.invocation) mask |= 1 << other;
    }
    return mask;
  });
  const memo = new Map();
  let explored = 0;
  const visit = (stateKey, remaining) => {
    if (remaining === 0) return true;
    const memoKey = `${stateKey}\u0000${remaining}`;
    if (memo.has(memoKey)) return memo.get(memoKey);
    explored += 1;
    if ((explored & 255) === 0) checkDeadline(deadline);
    if (explored > MAX_SEARCH_STATES) throw new RangeError(`history search exceeds ${MAX_SEARCH_STATES} states`);
    for (let index = 0; index < length; index += 1) {
      const bit = 1 << index;
      if ((remaining & bit) === 0 || (predecessors[index] & remaining) !== 0) continue;
      const call = calls[index];
      const transition = transitions.get(JSON.stringify([stateKey, call.operation, call.inputKey]));
      if (transition === undefined) continue;
      const [outputKey, nextStateKey] = transition;
      if (outputKey !== call.outputKey) continue;
      if (visit(nextStateKey, remaining ^ bit)) {
        memo.set(memoKey, true);
        return true;
      }
    }
    memo.set(memoKey, false);
    return false;
  };
  return visit(initialKey, all);
}

export function checkHistory(machine, history, options) {
  const deadline = resolveDeadline(options);
  return checkPrepared(validateMachine(machine, deadline), history, deadline);
}

export function parseHistoryOracle(oracle, options) {
  const deadline = resolveDeadline(options);
  checkDeadline(deadline);
  if (!isRecord(oracle) || !Array.isArray(oracle.cases) || !own(oracle, 'machine') || !Array.isArray(oracle.requiredOperations) || !own(oracle, 'negativeControl')) {
    throw new TypeError('oracle must have machine, cases, requiredOperations, and negativeControl');
  }
  if (oracle.cases.length > MAX_ORACLE_CASES) throw new RangeError(`oracle exceeds ${MAX_ORACLE_CASES} cases`);
  const compiledMachine = validateMachine(oracle.machine, deadline);
  requireDenseArray(oracle.cases, 'oracle.cases');
  requireDenseArray(oracle.requiredOperations, 'oracle.requiredOperations');
  const requiredOperations = oracle.requiredOperations.map((name, index) => requireName(name, `requiredOperations[${index}]`));
  if (requiredOperations.length === 0) throw new TypeError('requiredOperations must not be empty');
  if (new Set(requiredOperations).size !== requiredOperations.length) throw new TypeError('requiredOperations must be unique');
  const modeled = new Set(oracle.machine.transitions.map((transition) => transition.operation));
  for (const operation of requiredOperations) {
    if (!modeled.has(operation)) throw new TypeError(`required operation ${operation} is not modeled by the machine`);
  }
  const ids = new Set();
  let totalCalls = 0;
  const cases = oracle.cases.map((entry, index) => {
    if ((index & 255) === 0) checkDeadline(deadline);
    const label = `cases[${index}]`;
    if (!isRecord(entry) || !Array.isArray(entry.args) || !Array.isArray(entry.calls) || !['linearizable', 'nonlinearizable'].includes(entry.expect)) {
      throw new TypeError(`${label} must have id, module, name, args, calls, and a valid expect`);
    }
    const id = requireName(entry.id, `${label}.id`);
    if (!safePath(entry.module)) throw new TypeError(`${label}.module must be a safe module path`);
    requireName(entry.name, `${label}.name`);
    if (ids.has(id)) throw new TypeError(`duplicate case id ${id}`);
    ids.add(id);
    jsonKey(entry.args, `${label}.args`);
    requireDenseArray(entry.calls, `${label}.calls`);
    let caseCalls = 0;
    const calls = entry.calls.map((phase, phaseIndex) => {
      if (!Array.isArray(phase) || phase.length === 0) throw new TypeError(`${label}.calls[${phaseIndex}] must be a nonempty phase`);
      requireDenseArray(phase, `${label}.calls[${phaseIndex}]`);
      if (phase.length > MAX_HISTORY_CALLS) throw new RangeError(`${label}.calls[${phaseIndex}] exceeds ${MAX_HISTORY_CALLS} calls`);
      caseCalls += phase.length;
      if (caseCalls > MAX_HISTORY_CALLS) throw new RangeError(`${label} exceeds ${MAX_HISTORY_CALLS} calls across phases`);
      totalCalls += phase.length;
      if (totalCalls > MAX_ORACLE_CALLS) throw new RangeError(`oracle exceeds ${MAX_ORACLE_CALLS} total calls`);
      return phase.map((call, callIndex) => {
        const callLabel = `${label}.calls[${phaseIndex}][${callIndex}]`;
        if (!isRecord(call) || !own(call, 'input')) throw new TypeError(`${callLabel} must have operation and input`);
        const operation = requireName(call.operation, `${callLabel}.operation`);
        jsonKey(call.input, `${callLabel}.input`);
        return { operation, input: call.input };
      });
    });
    if (calls.length === 0) throw new TypeError(`${label}.calls must contain at least one phase`);
    return { id, module: entry.module, name: entry.name, args: entry.args, calls, expect: entry.expect };
  });
  const positive = cases.filter((entry) => entry.expect === 'linearizable');
  const covered = new Set(positive.flatMap((entry) => entry.calls.flatMap((phase) => phase.map((call) => call.operation))));
  for (const operation of requiredOperations) {
    if (!covered.has(operation)) throw new TypeError(`required operation ${operation} lacks positive-case coverage`);
  }
  if (!positive.some((entry) => entry.calls.some((phase) => phase.length > 1))) {
    throw new TypeError('oracle requires a positive concurrent phase');
  }
  const negativeControl = oracle.negativeControl;
  if (checkPrepared(compiledMachine, negativeControl, deadline)) throw new TypeError('negativeControl must be nonlinearizable');
  checkDeadline(deadline);
  return {
    machine: oracle.machine,
    cases,
    requiredOperations,
    negativeControl,
  };
}
