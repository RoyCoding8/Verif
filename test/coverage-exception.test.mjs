import assert from 'node:assert/strict';
import { test } from 'node:test';
import { approvedTask, digest, makeContract, planVerification } from '../src/contracts.mjs';
import { reviseApprovedTask } from '../src/delegation-policy.mjs';
import { runCoverageExceptionModel } from '../verification/CoverageException.mjs';

function task(overrides = {}) {
  const claims = [{ id: 'correct', statement: 'The output is correct.', required: 'tested', dependencies: [] }];
  return {
    id: 'coverage-task', revision: 1, goal: 'Preserve approved coverage.', base: 'head-at-dispatch', dependencies: [],
    scope: { read: ['src'], write: ['src/output.mjs'], forbidden: ['src/private'] },
    policy: { ref: 'refs/heads/protected', budgetMs: 1000, maxRepairs: 1, delegation: 'monotonic' },
    criteria: [
      { id: 'acceptance', description: 'The output is correct.', claims: ['correct'] },
      { id: 'waiver', description: 'The exception remains visible.', exception: { risk: 'Manual review is incomplete.' } },
    ], claims,
    obligations: [{
      id: 'smoke', claim: 'correct', subject: 'candidate', expect: 'PASS', witness: null,
      oracle: { file: 'oracle.json', digest: 'a'.repeat(64) }, outputs: [], cases: ['smoke'], timeoutMs: 100,
    }],
    ...overrides,
  };
}

function approve(input) {
  return { ...input, approval: digest(makeContract(input, planVerification(input))) };
}

function successor(parent) {
  return { ...structuredClone(parent), revision: parent.revision + 1 };
}

test('normalizes and approves an exception without treating it as evidence', () => {
  const input = task();
  input.criteria[0].metadata = { source: 'existing manifest extension' };
  const approvedInput = approve(input);
  const result = approvedTask(approvedInput);
  assert.deepEqual(result.plan.criteria[1], {
    id: 'waiver', description: 'The exception remains visible.', exception: { risk: 'Manual review is incomplete.' },
  });
  assert.equal(digest(result.plan.criteria[0]), digest({
    id: 'acceptance', description: 'The output is correct.', claims: ['correct'],
  }));

  assert.throws(() => planVerification(task({ criteria: [
    { id: 'waiver', description: 'Only an exception.', exception: { risk: 'No proof.' } },
  ] })), /Every claim must support an acceptance criterion/);
  const noPositive = task();
  noPositive.obligations[0] = { ...noPositive.obligations[0], expect: 'FAIL', witness: 'smoke' };
  assert.throws(() => planVerification(noPositive), /Claim lacks a positive candidate obligation/);
});

test('rejects ambiguous, malformed, or empty-risk exception forms', () => {
  const malformed = [
    { id: 'waiver', description: 'Ambiguous.', claims: ['correct'], exception: { risk: 'risk' } },
    { id: 'waiver', description: 'Missing both.' },
    { id: 'waiver', description: 'No risk.', exception: {} },
    { id: 'waiver', description: 'Blank risk.', exception: { risk: '  ' } },
    { id: 'waiver', description: 'Unknown exception field.', exception: { risk: 'risk', owner: 'nobody' } },
    { id: 'waiver', description: 'Claims on exception form.', claims: ['correct'], exception: { risk: 'risk' } },
  ];
  for (const criterion of malformed) {
    assert.throws(() => planVerification(task({ criteria: [
      { id: 'acceptance', description: 'The output is correct.', claims: ['correct'] }, criterion,
    ] })), undefined, JSON.stringify(criterion));
  }
});

test('delegation carries approved exceptions verbatim and rejects every exception mutation', () => {
  const parent = approve(task());
  const carried = reviseApprovedTask(parent, successor(parent));
  assert.deepEqual(carried.plan.criteria[1], parent.criteria[1]);

  const mutations = [
    proposal => { proposal.criteria[1].exception.risk = 'Changed risk.'; },
    proposal => { proposal.criteria[1].description = 'Changed description.'; },
    proposal => { delete proposal.criteria[1].exception; proposal.criteria[1].claims = ['correct']; },
    proposal => { proposal.criteria.splice(1, 1); },
    proposal => { proposal.criteria.push({ id: 'new-waiver', description: 'New exception.', exception: { risk: 'New risk.' } }); },
  ];
  for (const mutate of mutations) {
    const proposal = successor(parent);
    mutate(proposal);
    assert.throws(() => reviseApprovedTask(parent, proposal));
  }
});

test('only a fresh exact approval accepts a directly revised exception record', () => {
  const parent = approve(task());
  const revised = successor(parent);
  revised.criteria[1].exception.risk = 'Reviewed and accepted residual risk.';
  revised.approval = digest(makeContract(revised, planVerification(revised)));
  assert.equal(approvedTask(revised).plan.criteria[1].exception.risk, 'Reviewed and accepted residual risk.');

  const copiedApproval = successor(parent);
  copiedApproval.criteria[1].exception.risk = 'Unreviewed risk change.';
  copiedApproval.approval = parent.approval;
  assert.throws(() => approvedTask(copiedApproval), /Missing or mismatched principal approval/);
});

test('the finite independent relation agrees with production and detects a weakened rule', () => {
  assert.deepEqual(runCoverageExceptionModel(), {
    checked: 75,
    accepted: 4,
    rejected: 71,
    weakeningCounterexample: {
      state: 3,
      parentRisk: 'Manual review is incomplete.',
      proposalRisk: 'changed risk',
    },
  });
});
