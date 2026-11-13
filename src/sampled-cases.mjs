import { createHash } from 'node:crypto';
import { digest, requireThat, safePath, text } from './contracts.mjs';

export const sampleGenerator = 'sha256-counter-v1';

function canonicalJson(value, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  const valid = Array.isArray(value)
    ? Object.keys(value).length === value.length &&
      Object.keys(value).every((key, index) => key === String(index)) && value.every(item => canonicalJson(item, seen))
    : (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null) &&
      Reflect.ownKeys(value).every(key => {
        const descriptor = typeof key === 'string' && Object.getOwnPropertyDescriptor(value, key);
        return descriptor?.enumerable && 'value' in descriptor && canonicalJson(descriptor.value, seen);
      });
  seen.delete(value);
  return valid;
}

function sampleIndex(seed, sample, axis, length) {
  const counter = `${sampleGenerator}\0${seed}\0${sample}\0${axis}`;
  const word = createHash('sha256').update(counter, 'utf8').digest().readUInt32BE(0);
  return word % length;
}

export function expandSampledCases(oracle) {
  requireThat(oracle !== null && typeof oracle === 'object' && !Array.isArray(oracle), 'Invalid sampled oracle');
  const { module, name, axes, expected, seed, samples } = oracle;
  requireThat(safePath(module) && text(name), 'Invalid sampled oracle target');
  requireThat(Array.isArray(axes) && axes.every(axis =>
    Array.isArray(axis) && axis.length > 0 && axis.every(value => canonicalJson(value)) &&
    new Set(axis.map(digest)).size === axis.length), 'Sampled oracle axes need nonempty arrays of unique canonical JSON values');
  requireThat(canonicalJson(expected), 'Sampled oracle expected value must be canonical JSON');
  requireThat(Number.isInteger(seed) && seed >= 0 && seed <= 0xffffffff, 'Sampled oracle seed must be uint32');
  requireThat(Number.isInteger(samples) && samples >= 1 && samples <= 1000, 'Sampled oracle samples must be between 1 and 1000');

  return Array.from({ length: samples }, (_, sample) => ({
    id: String(sample),
    module,
    name,
    args: axes.map((axis, position) => axis[sampleIndex(seed, sample, position, axis.length)]),
    expected,
  }));
}
