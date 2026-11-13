import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { approvedTask, digest, makeContract, planVerification } from '../src/contracts.mjs';
import { reviseApprovedTask } from '../src/delegation-policy.mjs';

const coverageVariants = [
  criterion => criterion,
  criterion => ({ ...criterion, claims: [...criterion.claims, 'b'] }),
  criterion => ({ ...criterion, claims: ['b'] }),
  criterion => ({ ...criterion, description: 'Changed acceptance rule.' }),
  criterion => ({ id: criterion.id, description: criterion.description, exception: { risk: 'replacement risk' } }),
];
const exceptionVariants = [
  criterion => criterion,
  criterion => ({ ...criterion, exception: { risk: 'changed risk' } }),
  criterion => ({ ...criterion, description: 'Changed exception description.' }),
  () => null,
  criterion => ({ id: criterion.id, description: criterion.description, claims: ['a'] }),
];
const additionVariants = [
  () => null,
  () => ({ id: 'new-covered', description: 'Additional reviewed coverage.', claims: ['a'] }),
  () => ({ id: 'new-exception', description: 'Unapproved exception.', exception: { risk: 'new risk' } }),
];

function parentInput() {
  const claims = ['a', 'b'].map(id => ({ id, statement: 'Claim ' + id + ' holds.', required: 'tested', dependencies: [] }));
  const obligations = claims.map(({ id }) => ({
    id: 'pass-' + id, claim: id, subject: 'candidate', expect: 'PASS', witness: null,
    oracle: { file: 'oracle.json', digest: 'a'.repeat(64) }, outputs: [], cases: ['case-' + id], timeoutMs: 100,
  }));
  return {
    id: 'coverage-task', revision: 1, goal: 'Preserve approved coverage.', base: 'head-at-dispatch', dependencies: [],
    scope: { read: ['src'], write: ['src/output.mjs'], forbidden: ['src/private'] },
    policy: { ref: 'refs/heads/protected', budgetMs: 1000, maxRepairs: 1, delegation: 'monotonic' },
    criteria: [
      { id: 'covered', description: 'The output is correct.', claims: ['a'] },
      { id: 'covered-b', description: 'The second output is correct.', claims: ['b'] },
      { id: 'waiver', description: 'The recorded exception remains visible.', exception: { risk: 'Manual review is incomplete.' } },
    ], claims, obligations,
  };
}

function approved(input) {
  return { ...input, approval: digest(makeContract(input, planVerification(input))) };
}

function modelAllows(parent, candidate, requireSameRisk = true) {
  const next = new Map(candidate.criteria.map(criterion => [criterion.id, criterion]));
  const oldIds = new Set();
  for (const criterion of parent.criteria) {
    oldIds.add(criterion.id);
    const successor = next.get(criterion.id);
    if (!successor || successor.description !== criterion.description ||
      Object.hasOwn(criterion, 'exception') !== Object.hasOwn(successor, 'exception')) return false;
    if (Object.hasOwn(criterion, 'exception')) {
      if (requireSameRisk && successor.exception.risk !== criterion.exception.risk) return false;
    } else if (!criterion.claims.every(id => successor.claims.includes(id))) return false;
  }
  return candidate.criteria.every(criterion => oldIds.has(criterion.id) || Object.hasOwn(criterion, 'claims'));
}

export function runCoverageExceptionModel() {
  const parent = approved(parentInput());
  const parentCriteria = parent.criteria;
  const variants = [];
  for (const coverage of coverageVariants) {
    for (const exception of exceptionVariants) {
      for (const addition of additionVariants) {
        const criteria = [coverage(structuredClone(parentCriteria[0])), structuredClone(parentCriteria[1]),
          exception(structuredClone(parentCriteria[2]))]
          .filter(Boolean);
        const extra = addition();
        if (extra) criteria.push(extra);
        variants.push(criteria);
      }
    }
  }

  let accepted = 0;
  let rejected = 0;
  let invalid = 0;
  let weakeningCounterexample = null;
  for (const [state, criteria] of variants.entries()) {
    const proposal = structuredClone(parent);
    proposal.revision++;
    proposal.criteria = criteria;
    const expected = modelAllows(parent, proposal);
    const weakened = modelAllows(parent, proposal, false);
    let actual = true;
    try {
      reviseApprovedTask(parent, proposal);
    } catch {
      actual = false;
    }
    if (actual !== expected) throw new Error(`Coverage exception relation disagrees at state ${state}: expected ${expected}, got ${actual}`);
    accepted += Number(actual);
    rejected += Number(!actual);
    if (weakened && !expected && !weakeningCounterexample) {
      const changed = criteria.find(item => item?.id === 'waiver');
      weakeningCounterexample = { state, parentRisk: parent.criteria[2].exception.risk, proposalRisk: changed?.exception?.risk ?? null };
    }
  }
  if (!weakeningCounterexample) throw new Error('Weakened relation did not produce its expected risk-change counterexample');
  if (accepted === 0 || rejected === 0) throw new Error('Finite model lacks positive or negative controls');
  return { checked: variants.length, accepted, rejected, weakeningCounterexample };
}

if (fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  console.log(JSON.stringify(runCoverageExceptionModel()));
}
