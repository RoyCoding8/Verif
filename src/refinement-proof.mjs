import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { judgeLean } from './lean-judge.mjs';

const contractVersion = 'verity-refinement/1';
const identifierPattern = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const digestPattern = /^[a-f0-9]{64}$/;
const contractDefinition = (await readFile(
  new URL('../verification/lean-refinement/RefinementContract.lean', import.meta.url),
  'utf8',
)).replace(/\r\n?/g, '\n');
const contractDefinitionDigest = digestText(contractDefinition);

function digestText(text) {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

function assertRecord(value, fields, name, optional = []) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(name + ' must be an object');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(name + ' must be a plain object');
  }
  const keys = Reflect.ownKeys(value);
  const allowed = [...fields, ...optional];
  if (keys.some(key => typeof key !== 'string' || !allowed.includes(key)) ||
      fields.some(field => !Object.hasOwn(value, field))) {
    throw new TypeError(name + ' must contain required fields ' + fields.join(', ') +
      ' and no fields outside: ' + allowed.join(', '));
  }
}

function identifier(value, name) {
  if (typeof value !== 'string' || !identifierPattern.test(value)) {
    throw new TypeError(name + ' must be a simple qualified Lean identifier');
  }
  return value;
}

function digest(value, name) {
  if (typeof value !== 'string' || !digestPattern.test(value)) {
    throw new TypeError(name + ' must be a lowercase SHA-256 digest');
  }
  return value;
}

function assumptions(value, name) {
  if (!Array.isArray(value) || value.length > 64) {
    throw new TypeError(name + ' must be an array of at most 64 labels');
  }
  const labels = [];
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) throw new TypeError(name + ' must not contain holes');
    const label = value[index];
    if (typeof label !== 'string' || Buffer.from(label, 'utf8').toString('utf8') !== label) {
      throw new TypeError(name + ' labels must be valid UTF-8 strings');
    }
    const normalized = label.normalize('NFC').trim();
    if (normalized.length === 0 || Buffer.byteLength(normalized, 'utf8') > 256 ||
        /[\u0000-\u001f\u007f]/u.test(normalized)) {
      throw new TypeError(name + ' labels must be non-empty plain text of at most 256 UTF-8 bytes');
    }
    labels.push(normalized);
  }
  if (new Set(labels).size !== labels.length) {
    throw new TypeError(name + ' must not contain duplicate labels after normalization');
  }
  return labels.sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
}

function normalizeContract(contract) {
  assertRecord(contract, ['definitionDigest', 'domain', 'old', 'new'], 'contract');
  assertRecord(contract.old, ['precondition', 'guarantee', 'assumptions'], 'contract.old');
  assertRecord(contract.new, ['precondition', 'guarantee', 'assumptions'], 'contract.new');

  const old = {
    precondition: identifier(contract.old.precondition, 'contract.old.precondition'),
    guarantee: identifier(contract.old.guarantee, 'contract.old.guarantee'),
    assumptions: assumptions(contract.old.assumptions, 'contract.old.assumptions'),
  };
  const next = {
    precondition: identifier(contract.new.precondition, 'contract.new.precondition'),
    guarantee: identifier(contract.new.guarantee, 'contract.new.guarantee'),
    assumptions: assumptions(contract.new.assumptions, 'contract.new.assumptions'),
  };
  const oldAssumptions = new Set(old.assumptions);
  if (next.assumptions.some(label => !oldAssumptions.has(label))) {
    throw new TypeError('contract.new.assumptions must be a subset of contract.old.assumptions');
  }

  return Object.freeze({
    definitionDigest: digest(contract.definitionDigest, 'contract.definitionDigest'),
    domain: identifier(contract.domain, 'contract.domain'),
    old: Object.freeze(old),
    new: Object.freeze(next),
  });
}

function assertTrustedDefinitions(source, expectedDigest) {
  if (typeof source !== 'string' || Buffer.from(source, 'utf8').toString('utf8') !== source ||
      source.trim().length === 0 || source.includes('\0')) {
    throw new TypeError('trustedDefinitions must be non-empty valid UTF-8 Lean declarations');
  }
  if (/^\s*import(?:\s|$)/m.test(source)) {
    throw new TypeError('trustedDefinitions must contain declarations only, without imports');
  }
  const actualDigest = digestText(source);
  if (actualDigest !== expectedDigest) {
    throw new TypeError('trustedDefinitions SHA-256 does not match contract.definitionDigest');
  }
  return actualDigest;
}

export function digestLeanDefinitions(source) {
  if (typeof source !== 'string' || Buffer.from(source, 'utf8').toString('utf8') !== source) {
    throw new TypeError('source must be a valid UTF-8 string');
  }
  return digestText(source);
}

export function refinementContractDigest(contract) {
  const normalized = normalizeContract(contract);
  const payload = {
    version: contractVersion,
    contractDefinitionDigest,
    definitionDigest: normalized.definitionDigest,
    domain: normalized.domain,
    old: normalized.old,
    new: normalized.new,
  };
  return digestText(JSON.stringify(payload));
}

export function buildRefinementChallenge(request) {
  assertRecord(request, ['contract', 'trustedDefinitions'], 'challenge request');
  const { contract, trustedDefinitions } = request;
  const normalized = normalizeContract(contract);
  const definitionDigest = assertTrustedDefinitions(trustedDefinitions, normalized.definitionDigest);
  const contractDigest = refinementContractDigest(normalized);
  const namespace = 'VerityRefinementWitness_c' + contractDigest;
  if (trustedDefinitions.includes(namespace)) {
    throw new TypeError('trustedDefinitions may not declare the generated witness namespace');
  }
  const theorem = namespace + '.target';
  const challenge = contractDefinition + (contractDefinition.endsWith('\n') ? '' : '\n') +
    trustedDefinitions + (trustedDefinitions.endsWith('\n') ? '' : '\n') + [
    'namespace ' + namespace,
    'theorem target :',
    '    VerityRefinement.Refines (Domain := ' + normalized.domain + ')',
    '      ' + normalized.old.precondition,
    '      ' + normalized.new.precondition,
    '      ' + normalized.old.guarantee,
    '      ' + normalized.new.guarantee + ' := by',
    '  sorry',
    'end ' + namespace,
    '',
  ].join('\n');

  return Object.freeze({
    challenge,
    theorem,
    contractDigest,
    definitionDigest,
    contract: normalized,
  });
}

export async function verifyRefinement(request) {
  assertRecord(request,
    ['contract', 'approvedDigest', 'trustedDefinitions', 'solution', 'timeoutMs', 'scratch'],
    'request', ['signal']);
  const { contract, approvedDigest, trustedDefinitions, solution, timeoutMs, signal, scratch } = request;
  const built = buildRefinementChallenge({ contract, trustedDefinitions });
  if (digest(approvedDigest, 'approvedDigest') !== built.contractDigest) {
    throw new TypeError('approvedDigest does not match the normalized refinement contract');
  }
  const judgment = await judgeLean({
    challenge: built.challenge,
    solution,
    theorem: built.theorem,
    timeoutMs,
    signal,
    scratch,
  });
  return Object.freeze({
    ...judgment,
    contractDigest: built.contractDigest,
    definitionDigest: built.definitionDigest,
    theorem: built.theorem,
  });
}
