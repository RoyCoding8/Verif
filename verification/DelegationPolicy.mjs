import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest, makeContract, planVerification } from '../src/contracts.mjs';
import { reviseApprovedTask } from '../src/delegation-policy.mjs';

const dimensions = [
  proposal => { proposal.id = 'task-b'; },
  proposal => { proposal.goal += ' Changed'; },
  proposal => { proposal.revision += 1; },
  proposal => { proposal.base = 'a'.repeat(40); },
  proposal => { proposal.dependencies = ['prerequisite']; },
  proposal => { proposal.policy.ref = 'refs/heads/other'; },
  proposal => { proposal.policy.budgetMs += 1; },
  proposal => { proposal.policy.maxRepairs += 1; },
  proposal => { proposal.scope.read = ['outside']; },
  proposal => { proposal.scope.write = ['outside/output.mjs']; },
  proposal => { proposal.scope.forbidden = []; },
  proposal => { proposal.claims[0].statement = 'A substituted claim.'; },
  proposal => { proposal.policy.unrecognizedGrant = true; },
];

function parentTask() {
  return {
    id: 'task-a', revision: 1, goal: 'Preserve the required output.', base: 'head-at-dispatch', dependencies: [],
    scope: { read: ['src'], write: ['src/output.mjs'], forbidden: ['src/private'] },
    policy: { ref: 'refs/heads/protected', budgetMs: 1000, maxRepairs: 2, delegation: 'monotonic' },
    criteria: [{ id: 'acceptance', description: 'The task remains acceptable.', claims: ['correct'] }],
    claims: [{ id: 'correct', statement: 'The candidate preserves the required output.', required: 'tested', dependencies: [] }],
    obligations: [{
      id: 'smoke', claim: 'correct', subject: 'candidate', expect: 'PASS', witness: null,
      oracle: { file: 'oracle.json', digest: 'a'.repeat(64) }, outputs: [], cases: ['smoke'], timeoutMs: 100,
    }],
  };
}

function approved(input) {
  return { ...input, approval: digest(makeContract(input, planVerification(input))) };
}

function modelAccepts(vector) {
  // This finite model contains only one approved parent and one proposal per bit vector.
  // Each set bit selects a counterexample to a distinct monotonicity obligation.
  return vector.every(bit => bit === 0);
}

export function runDelegationPolicyModel() {
  const parent = approved(parentTask());
  let checked = 0;
  let accepted = 0;
  let mutationSensitive = true;
  const size = 2 ** dimensions.length;
  for (let state = 0; state < size; state++) {
    const vector = dimensions.map((_, bit) => (state >> bit) & 1);
    const proposal = structuredClone(parent);
    proposal.revision = parent.revision + 1;
    for (const [bit, mutate] of dimensions.entries()) if (vector[bit]) mutate(proposal);
    const expected = modelAccepts(vector);
    let actual = true;
    try {
      reviseApprovedTask(parent, proposal);
    } catch {
      actual = false;
    }
    if (expected !== actual) throw new Error('Finite model disagrees with production at state ' + state);
    checked++;
    accepted += Number(actual);
  }
  for (let bit = 0; bit < dimensions.length; bit++) {
    const vector = dimensions.map((_, index) => Number(index === bit));
    if (modelAccepts(vector)) mutationSensitive = false;
  }
  if (checked !== size || accepted !== 1 || !mutationSensitive) throw new Error('Delegation finite model did not cover its configured domain');
  return { checked, accepted, rejected: checked - accepted, mutationSensitive };
}

if (fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  console.log(JSON.stringify(runDelegationPolicyModel()));
}
