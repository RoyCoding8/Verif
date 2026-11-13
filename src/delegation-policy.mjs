import { approvedTask, digest, makeContract, planVerification, requireThat } from './contracts.mjs';

const policyFields = new Set(['budgetMs', 'delegation', 'maxRepairs', 'ref', 'reuseEvidence']);

function same(left, right) {
  return digest(left) === digest(right);
}

function pathRules(paths, label) {
  requireThat(Array.isArray(paths), 'Invalid ' + label + ' path rules');
  const rules = paths.map(path => {
    requireThat(typeof path === 'string' && path.length > 0 && !path.includes('\\') &&
      path.split('/').every(part => part !== '.' && part !== '..'), 'Unsafe ' + label + ' path rule');
    return { path, identity: path.normalize('NFC').toLowerCase() };
  });
  requireThat(new Set(rules.map(rule => rule.identity)).size === rules.length, 'Duplicate ' + label + ' path rule');
  return rules;
}

function covers(rules, path) {
  return rules.some(rule => path === rule.path || path.startsWith(rule.path + '/'));
}

function requireScopeDoesNotExpand(parentScope, candidateScope) {
  for (const access of ['read', 'write']) {
    const parent = pathRules(parentScope[access], access);
    const candidate = pathRules(candidateScope[access], access);
    requireThat(candidate.every(({ path }) => covers(parent, path)), 'Delegation expands ' + access + ' scope');
  }
  const forbidden = pathRules(candidateScope.forbidden, 'forbidden');
  const previouslyForbidden = pathRules(parentScope.forbidden, 'forbidden');
  requireThat(previouslyForbidden.every(({ path }) => covers(forbidden, path)), 'Delegation shrinks forbidden scope');
}

function requirePolicyDoesNotWeaken(parent, candidate) {
  requireThat(parent.delegation === 'monotonic' && candidate.delegation === 'monotonic',
    'Parent task does not authorize monotonic delegation');
  requireThat(candidate.ref === parent.ref && candidate.budgetMs <= parent.budgetMs &&
    (candidate.maxRepairs ?? 0) <= (parent.maxRepairs ?? 0), 'Delegation weakens task policy');
  requireThat(same(candidate.reuseEvidence ?? null, parent.reuseEvidence ?? null), 'Delegation changes evidence reuse policy');
  for (const key of Object.keys(parent)) {
    if (!policyFields.has(key)) requireThat(Object.hasOwn(candidate, key) && same(candidate[key], parent[key]),
      'Delegation changes unknown policy field ' + key);
  }
  for (const key of Object.keys(candidate)) {
    if (!policyFields.has(key)) requireThat(Object.hasOwn(parent, key) && same(candidate[key], parent[key]),
      'Delegation adds unknown policy field ' + key);
  }
}

function byId(items) {
  return new Map(items.map(item => [item.id, item]));
}

function requirePlanDoesNotReplace(parentPlan, candidatePlan, semantic) {
  const nextClaims = byId(candidatePlan.claims);
  const nextObligations = byId(candidatePlan.obligations);
  for (const claim of parentPlan.claims) {
    if (claim.id === semantic?.claim) continue;
    requireThat(nextClaims.has(claim.id) && same(claim, nextClaims.get(claim.id)),
      'Delegation removes or changes claim ' + claim.id);
  }
  for (const obligation of parentPlan.obligations) {
    requireThat(nextObligations.has(obligation.id) && same(obligation, nextObligations.get(obligation.id)),
      'Delegation removes or changes obligation ' + obligation.id);
  }

  const nextCriteria = byId(candidatePlan.criteria);
  for (const criterion of parentPlan.criteria) {
    const next = nextCriteria.get(criterion.id);
    requireThat(next && criterion.description === next.description &&
      criterion.claims.every(claim => next.claims.includes(claim)),
    'Delegation removes or weakens criterion ' + criterion.id);
  }
}

function revision(parentInput, proposal, semantic) {
  const parent = approvedTask(parentInput);
  requireThat(parent.contract.policy.delegation === 'monotonic', 'Parent task does not authorize monotonic delegation');

  const plan = planVerification(proposal);
  const contract = makeContract(proposal, plan);
  requireThat(contract.id === parent.contract.id && contract.goal === parent.contract.goal &&
    contract.base === parent.contract.base && same(contract.dependencies, parent.contract.dependencies) &&
    contract.revertOperation === parent.contract.revertOperation,
  'Delegation replaces task identity, goal, base, or dependencies');
  requireThat(contract.revision === parent.contract.revision + 1, 'Delegation revision must advance exactly once');
  requirePolicyDoesNotWeaken(parent.contract.policy, contract.policy);
  requireScopeDoesNotExpand(parent.contract.scope, contract.scope);
  requirePlanDoesNotReplace(parent.plan, plan, semantic);

  const approval = digest(contract);
  const task = {
    id: contract.id,
    revision: contract.revision,
    goal: contract.goal,
    base: contract.base,
    dependencies: contract.dependencies,
    scope: contract.scope,
    policy: contract.policy,
    criteria: plan.criteria,
    claims: plan.claims,
    obligations: plan.obligations,
    approval,
    ...(contract.revertOperation ? { revertOperation: contract.revertOperation } : {}),
  };
  const binding = {
    version: 1,
    predecessorApproval: parent.approval,
    successorApproval: approval,
    predecessorRevision: parent.contract.revision,
    revision: contract.revision,
  };
  const revisionBinding = { ...binding, digest: digest(binding) };
  return { parent, result: { task, contract, plan, approval, revisionBinding } };
}

export function reviseApprovedTask(parentInput, proposal) {
  return revision(parentInput, proposal).result;
}

export function prepareSemanticRevision(parentInput, proposal, claimId) {
  const { parent, result } = revision(parentInput, proposal, { claim: claimId });
  const previous = parent.plan.claims.find(claim => claim.id === claimId);
  const next = result.plan.claims.find(claim => claim.id === claimId);
  requireThat(previous?.lean && next?.lean, 'Semantic delegation requires a bound Lean claim');
  const { lean: old, ...oldClaim } = previous;
  const { lean: successor, ...nextClaim } = next;
  requireThat(same(oldClaim, nextClaim) && ['source', 'definitionDigest', 'domain', 'implementation'].every(key => old[key] === successor[key]),
    'Semantic delegation changes the frozen claim or implementation binding');
  requireThat(!parent.plan.obligations.some(item => item.id === successor.obligation),
    'Semantic delegation requires a new candidate proof obligation');
  const predicate = ({ precondition, guarantee, assumptions }) => ({ precondition, guarantee, assumptions });
  const contract = { definitionDigest: old.definitionDigest, domain: old.domain, old: predicate(old), new: predicate(successor) };
  const binding = { predecessorApproval: parent.approval, successorApproval: result.approval, claim: claimId };
  return { parent, result, contract, binding, old, successor };
}
