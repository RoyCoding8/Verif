import assert from 'node:assert/strict';
import { test } from 'node:test';
import { approvedTask, digest, makeContract, planVerification } from '../src/contracts.mjs';
import { reviseApprovedTask } from '../src/delegation-policy.mjs';
import { runDelegationPolicyModel } from '../verification/DelegationPolicy.mjs';

const claim = {
  id: 'correct', statement: 'The candidate preserves the required output.', required: 'tested', dependencies: [],
};

function obligation(id = 'smoke') {
  return {
    id, claim: id === 'smoke' ? 'correct' : id, subject: 'candidate', expect: 'PASS', witness: null,
    oracle: { file: 'oracle.json', digest: 'a'.repeat(64) }, outputs: [], cases: ['smoke'], timeoutMs: 100,
  };
}

function task(overrides = {}) {
  return {
    id: 'task-a', revision: 1, goal: 'Preserve the required output.', base: 'head-at-dispatch', dependencies: [],
    scope: { read: ['src'], write: ['src/output.mjs'], forbidden: ['src/private'] },
    policy: { ref: 'refs/heads/protected', budgetMs: 1000, maxRepairs: 2, delegation: 'monotonic', reuseEvidence: false },
    criteria: [{ id: 'acceptance', description: 'The task remains acceptable.', claims: ['correct'] }],
    claims: [claim], obligations: [obligation()], ...overrides,
  };
}

function approve(input) {
  return { ...input, approval: digest(makeContract(input, planVerification(input))) };
}

function successor(parentInput) {
  return { ...structuredClone(parentInput), revision: parentInput.revision + 1 };
}

test('creates a deterministic, normalized successor and lineage binding without trusting proposal approval', () => {
  const parent = approve(task());
  const proposal = successor(parent);
  proposal.approval = 'untrusted proposal approval';
  proposal.policy.budgetMs = 800;
  proposal.policy.maxRepairs = 1;
  proposal.scope.read = ['src/output.mjs'];
  proposal.scope.forbidden = ['src/private', 'secrets'];
  const first = reviseApprovedTask(parent, proposal);
  const second = reviseApprovedTask(parent, proposal);

  assert.deepEqual(first, second);
  assert.equal(first.task.approval, first.approval);
  assert.equal(approvedTask(first.task).approval, first.approval);
  assert.equal(first.revisionBinding.predecessorApproval, parent.approval);
  assert.equal(first.revisionBinding.successorApproval, first.approval);
  assert.equal(first.revisionBinding.predecessorRevision, parent.revision);
  assert.equal(first.revisionBinding.revision, proposal.revision);
  const { digest: bindingDigest, ...binding } = first.revisionBinding;
  assert.equal(bindingDigest, digest(binding));
});

test('allows additive claims, obligations, and criterion coverage', () => {
  const parent = approve(task());
  const proposal = successor(parent);
  const addedClaim = { id: 'security', statement: 'Private files remain protected.', required: 'tested', dependencies: [] };
  proposal.claims.push(addedClaim);
  proposal.obligations.push({ ...obligation('security'), id: 'security-pass', claim: 'security' });
  proposal.criteria[0].claims.push('security');

  const result = reviseApprovedTask(parent, proposal);
  assert.deepEqual(result.plan.claims.map(item => item.id), ['correct', 'security']);
  assert.deepEqual(result.plan.criteria[0].claims, ['correct', 'security']);
});

test('refuses successors without explicit parent delegation opt-in', () => {
  const noOptIn = task({ policy: { ref: 'refs/heads/protected', budgetMs: 1000 } });
  const parent = approve(noOptIn);
  assert.throws(() => reviseApprovedTask(parent, successor(parent)), /does not authorize monotonic delegation/);
});

test('delegation can add or shorten approval validity', () => {
  const parent = approve(task());
  const proposal = successor(parent);
  proposal.policy.validUntilMs = 10_000;
  const bound = reviseApprovedTask(parent, proposal).task;
  const next = successor(bound);
  next.policy.validUntilMs = 9_999;
  assert.equal(reviseApprovedTask(bound, next).contract.policy.validUntilMs, 9_999);
  next.policy.validUntilMs = 10_001;
  assert.throws(() => reviseApprovedTask(bound, next), /extends approval validity/);
  delete next.policy.validUntilMs;
  assert.throws(() => reviseApprovedTask(bound, next), /extends approval validity/);
  next.policy.validUntilMs = '10000';
  assert.throws(() => reviseApprovedTask(bound, next), /Invalid approval expiration time/);
});

test('rejects identity, authorization, policy, scope, and frozen-plan substitutions', () => {
  const parent = approve(task());
  const badProposals = [
    ['revision skip', proposal => { proposal.revision += 1; }],
    ['task identity', proposal => { proposal.id = 'task-b'; }],
    ['goal replacement', proposal => { proposal.goal += ' Changed'; }],
    ['base replacement', proposal => { proposal.base = 'a'.repeat(40); }],
    ['dependency replacement', proposal => { proposal.dependencies = ['task-prerequisite']; }],
    ['target reference', proposal => { proposal.policy.ref = 'refs/heads/other'; }],
    ['budget increase', proposal => { proposal.policy.budgetMs += 1; }],
    ['repair increase', proposal => { proposal.policy.maxRepairs += 1; }],
    ['evidence reuse change', proposal => { proposal.policy.reuseEvidence = true; }],
    ['unknown policy addition', proposal => { proposal.policy.allowUnsafe = true; }],
    ['read expansion', proposal => { proposal.scope.read = ['src', 'outside']; }],
    ['write expansion', proposal => { proposal.scope.write = ['src/output.mjs', 'outside/new.mjs']; }],
    ['forbidden shrink', proposal => { proposal.scope.forbidden = []; }],
    ['claim replacement', proposal => { proposal.claims[0].statement = 'Different statement.'; }],
    ['obligation replacement', proposal => { proposal.obligations[0].timeoutMs += 1; }],
    ['criterion description replacement', proposal => { proposal.criteria[0].description = 'Different acceptance rule.'; }],
    ['criterion coverage shrink', proposal => { proposal.criteria[0].claims = []; }],
    ['criterion removal', proposal => { proposal.criteria = []; }],
  ];
  for (const [label, mutate] of badProposals) {
    const proposal = successor(parent);
    mutate(proposal);
    assert.throws(() => reviseApprovedTask(parent, proposal), undefined, label);
  }
  const withUnknownPolicy = approve(task({ policy: { ...task().policy, owner: 'trusted' } }));
  const removedUnknown = successor(withUnknownPolicy);
  delete removedUnknown.policy.owner;
  assert.throws(() => reviseApprovedTask(withUnknownPolicy, removedUnknown), /unknown policy field owner/);
});

test('rejects an unapproved or tampered parent and ambiguous portable path identities', () => {
  const parent = approve(task());
  assert.throws(() => reviseApprovedTask({ ...parent, approval: '0'.repeat(64) }, successor(parent)), /approval/);
  const duplicate = successor(parent);
  duplicate.scope.read = ['src/A', 'SRC/a'];
  assert.throws(() => reviseApprovedTask(parent, duplicate), /Duplicate read path rule/);
  const traversal = successor(parent);
  traversal.scope.read = ['src/../outside'];
  assert.throws(() => reviseApprovedTask(parent, traversal), /Invalid contract path scope/);
});

test('requires exact path spelling for allow and forbid containment across platforms', () => {
  const changedReadParent = approve(task({ scope: {
    read: ['src/Foo'], write: ['src/output.mjs'], forbidden: [],
  } }));
  const changedRead = successor(changedReadParent);
  changedRead.scope.read = ['src/foo/child'];
  assert.throws(() => reviseApprovedTask(changedReadParent, changedRead), /expands read scope/);

  const changedWriteParent = approve(task({ scope: {
    read: ['src'], write: ['src/Foo'], forbidden: [],
  } }));
  const changedWrite = successor(changedWriteParent);
  changedWrite.scope.write = ['src/foo/child'];
  assert.throws(() => reviseApprovedTask(changedWriteParent, changedWrite), /expands write scope/);

  const changedForbiddenParent = approve(task({ scope: {
    read: ['src'], write: ['src/output.mjs'], forbidden: ['locked/Foo'],
  } }));
  const changedForbidden = successor(changedForbiddenParent);
  changedForbidden.scope.forbidden = ['LOCKED'];
  assert.throws(() => reviseApprovedTask(changedForbiddenParent, changedForbidden), /shrinks forbidden scope/);

  const composed = '\u00e9';
  const decomposed = 'e\u0301';
  const unicodeParent = approve(task({ scope: {
    read: ['src/' + composed], write: ['src/output.mjs'], forbidden: ['locked/' + composed],
  } }));
  const unicodeAllow = successor(unicodeParent);
  unicodeAllow.scope.read = ['src/' + decomposed + '/child'];
  assert.throws(() => reviseApprovedTask(unicodeParent, unicodeAllow), /expands read scope/);
  const unicodeForbid = successor(unicodeParent);
  unicodeForbid.scope.forbidden = ['locked/' + decomposed];
  assert.throws(() => reviseApprovedTask(unicodeParent, unicodeForbid), /shrinks forbidden scope/);
});

test('runs the finite policy model against production decisions', () => {
  assert.deepEqual(runDelegationPolicyModel(), { checked: 8192, accepted: 1, rejected: 8191, mutationSensitive: true });
});
