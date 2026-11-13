import { createHash } from 'node:crypto';
import { normalizeModelRoute } from './model-route.mjs';

const levels = new Map([['tested', 0], ['bounded', 1], ['formal', 2]]);
const methods = new Map([['node-test', 'tested'], ['node-property', 'tested'], ['node-history', 'tested'], ['node-differential', 'tested'],
  ['finite-domain', 'bounded'], ['kani', 'bounded'], ['lean-comparator', 'formal']]);

export function requireThat(condition, message) {
  if (!condition) throw new Error(message);
}

function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  }
  requireThat(value === null || ['boolean', 'string'].includes(typeof value) || Number.isFinite(value), 'Expected a canonical JSON value');
  return JSON.stringify(value);
}

export function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function digest(record) {
  return hash(canonical(record));
}

export function text(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function leanName(value) {
  return typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(value);
}

function leanClaim(binding) {
  requireThat(binding && safePath(binding.source) && binding.source.endsWith('.lean') &&
    /^[a-f0-9]{64}$/.test(binding.definitionDigest) && text(binding.obligation) &&
    ['domain', 'precondition', 'guarantee', 'implementation'].every(field => leanName(binding[field])) &&
    Array.isArray(binding.assumptions) && binding.assumptions.every(label => text(label) && label === label.normalize('NFC').trim()) &&
    new Set(binding.assumptions).size === binding.assumptions.length, 'Invalid refinable Lean claim');
  const { source, definitionDigest, domain, precondition, guarantee, implementation, obligation } = binding;
  return { source, definitionDigest, domain, precondition, guarantee, implementation, obligation, assumptions: [...binding.assumptions].sort() };
}

function validLeanModuleName(name) {
  return typeof name === 'string' && /^Verity[A-Za-z0-9_]+$/.test(name) && name.length <= 80;
}

function orderLeanModules(first, second) {
  return first.name < second.name ? -1 : Number(first.name > second.name);
}

export function normalizeLeanModules(modules = []) {
  requireThat(Array.isArray(modules) && modules.length <= 16, 'Lean accepts at most 16 approved local modules');
  const names = new Set();
  return [...modules].map(module => {
    const { name, source } = module ?? {};
    requireThat(validLeanModuleName(name) &&
      !names.has(name.toLowerCase()) && text(source) && source.isWellFormed() &&
      Buffer.byteLength(source, 'utf8') <= 2 * 1024 * 1024, 'Invalid or duplicate approved Lean module');
    names.add(name.toLowerCase());
    return { name, source };
  }).sort(orderLeanModules);
}

export function leanModuleDigests(modules = []) {
  return modules.map(({ name, source }) => ({ name, digest: hash(source) }));
}

export function parseLeanOracle(oracle) {
  requireThat(leanName(oracle?.theorem) && safePath(oracle.solution) && oracle.solution.endsWith('.lean') &&
    text(oracle.challenge) && oracle.challenge.isWellFormed(), 'Lean oracle needs a theorem name, solution path, and challenge source');
  const { theorem, solution, challenge } = oracle;
  return { theorem, solution, challenge, ...(Object.hasOwn(oracle, 'modules') ? { modules: normalizeLeanModules(oracle.modules) } : {}) };
}

export function safePath(value) {
  return typeof value === 'string' && value.split('/').every(part =>
    part.length > 0 && !/[\\:*?"<>|\x00-\x1f]/.test(part) &&
    !/[. ]$/.test(part) && part.toLowerCase() !== '.git' &&
    !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(part));
}

export function within(path, rules) {
  if (process.platform === 'win32') return rules.some(rule => {
    const folded = path.toLowerCase();
    const prefix = rule.toLowerCase();
    return folded === prefix || folded.startsWith(prefix + '/');
  });
  return rules.some(rule => path === rule || path.startsWith(rule + '/'));
}

function index(items, label) {
  requireThat(Array.isArray(items) && items.length > 0, 'Missing ' + label);
  const records = new Map();
  for (const item of items) {
    requireThat(text(item?.id) && !records.has(item.id), 'Invalid or duplicate ' + label + ' ID');
    records.set(item.id, item);
  }
  return records;
}

function weakest(levelsToCompare) {
  return levelsToCompare.reduce((a, b) => levels.get(a) <= levels.get(b) ? a : b);
}

function normalizeDomain(domain) {
  if (domain == null) return null;
  requireThat(safePath(domain.module) && text(domain.name) && Array.isArray(domain.axes), 'Invalid finite domain');
  for (const values of domain.axes) {
    requireThat(Array.isArray(values) && values.length > 0 &&
      new Set(values.map(digest)).size === values.length, 'Finite domain axes need unique values');
  }
  requireThat(Number.isSafeInteger(domainSize(domain)), 'Finite domain is too large');
  return { module: domain.module, name: domain.name, axes: domain.axes };
}

function domainSize(domain) {
  return domain.axes.reduce((size, values) => size * values.length, 1);
}

export function assertExhaustiveDomain(domain, cases) {
  const values = domain.axes.map(axis => new Set(axis.map(digest)));
  const inputs = new Set();
  for (const { id, module, name, args } of cases) {
    requireThat(module === domain.module && name === domain.name && args.length === values.length &&
      args.every((value, position) => values[position].has(digest(value))), 'Case lies outside the approved finite domain: ' + id);
    inputs.add(digest(args));
  }
  requireThat(cases.length === domainSize(domain) && inputs.size === cases.length, 'Oracle does not enumerate the finite domain');
}

function assurance(plan, levelOf) {
  const claims = index(plan.claims, 'claim');
  const visiting = new Set();
  const complete = new Map();
  function visit(id) {
    if (complete.has(id)) return complete.get(id);
    requireThat(!visiting.has(id), 'Cyclic claim dependency at ' + id);
    const claim = claims.get(id);
    requireThat(claim, 'Unknown claim ' + id);
    visiting.add(id);
    const levelsToCompare = [levelOf(claim)];
    for (const link of claim.dependencies) {
      const dependency = claims.get(link.claim);
      requireThat(dependency && link.statement === dependency.statement, 'Unbound claim dependency for ' + id);
      const effective = visit(link.claim);
      if (effective === 'bounded') {
        requireThat(digest(claim.domain) === digest(dependency.domain), 'Incompatible finite domains for ' + id);
      }
      levelsToCompare.push(effective);
    }
    const effective = weakest(levelsToCompare);
    requireThat(levels.get(effective) >= levels.get(claim.required), 'Insufficient assurance for ' + id);
    visiting.delete(id);
    complete.set(id, effective);
    return effective;
  }
  for (const id of claims.keys()) visit(id);
  return Object.fromEntries(complete);
}

function normalizeObligation(obligation, claims) {
  const { claim, subject, expect, witness = null, outputs = [], oracle } = obligation;
  const specification = claims.get(claim);
  requireThat(specification, 'Unknown obligation claim ' + claim);
  const method = obligation.method ?? (specification.required === 'bounded' ? 'finite-domain' : 'node-test');
  requireThat(methods.has(method), 'Unsupported verification method ' + method);
  requireThat(method !== 'node-differential' || (subject === 'candidate' && expect === 'PASS'),
    'Node differential obligations require a positive candidate PASS');
  requireThat(subject === 'candidate' || subject === 'base' || /^[a-f0-9]{40}([a-f0-9]{24})?$/.test(subject), 'Invalid obligation subject');
  requireThat((expect === 'PASS' && witness === null) || (expect === 'FAIL' && text(witness)), 'Invalid expected verdict');
  requireThat(safePath(oracle?.file) && oracle.file.endsWith('.json') &&
    /^[a-f0-9]{64}$/.test(oracle.digest), 'Oracle must be an approved JSON file with a digest');
  requireThat(Array.isArray(outputs) && (outputs.length === 0 || (outputs.length === 1 && outputs[0] === 'cases.json')),
    'Supported output is cases.json');
  requireThat(Number.isSafeInteger(obligation.timeoutMs) && obligation.timeoutMs > 0, 'Invalid verification timeout');
  const cases = obligation.cases;
  requireThat(Array.isArray(cases) && cases.length > 0 && cases.every(text) &&
    new Set(cases).size === cases.length, 'Every obligation needs unique declared case IDs');
  requireThat(expect !== 'FAIL' || cases.includes(witness), 'Expected failure must name a declared case');
  requireThat(method !== 'finite-domain' || (specification.domain && cases.length === domainSize(specification.domain)),
    'Finite-domain obligations must list a case for every input in the declared domain');
  requireThat(method !== 'lean-comparator' || (expect === 'PASS' && cases.length === 1 && leanName(cases[0])),
    'Lean obligations require one named theorem and an expected PASS');
  requireThat(method !== 'kani' || (cases.length === 1 && /^[a-zA-Z_][a-zA-Z_0-9]*$/.test(cases[0]) &&
    (expect === 'PASS' || subject !== 'candidate')), 'Kani obligations need one named harness and a positive candidate verdict');
  const normalized = { id: obligation.id, claim, subject, expect, witness, method, oracle, outputs, cases, timeoutMs: obligation.timeoutMs };
  if (Object.hasOwn(obligation, 'leanModules')) {
    const { leanModules } = obligation;
    requireThat(method === 'lean-comparator' && Array.isArray(leanModules) && leanModules.length > 0 && leanModules.length <= 16,
      'Only Lean obligations can name approved local modules');
    const names = new Set();
    normalized.leanModules = [...leanModules].map(module => {
      const { name, digest } = module ?? {};
      requireThat(validLeanModuleName(name) && !names.has(name.toLowerCase()) &&
        typeof digest === 'string' && /^[a-f0-9]{64}$/.test(digest), 'Invalid approved Lean module digest');
      names.add(name.toLowerCase());
      return { name, digest };
    }).sort(orderLeanModules);
  }
  if (Object.hasOwn(obligation, 'inputPaths')) {
    const { inputPaths } = obligation;
    requireThat(!['lean-comparator', 'kani'].includes(method) && Array.isArray(inputPaths) && inputPaths.length > 0 &&
      inputPaths.every(safePath) && new Set(inputPaths).size === inputPaths.length,
    'Input projection requires unique file paths and a Node verification method');
    normalized.inputPaths = [...inputPaths].sort();
  }
  requireThat(method !== 'node-differential' || !Object.hasOwn(obligation, 'inputPaths'),
    'Node differential obligations require the full snapshot');
  if (Object.hasOwn(obligation, 'proofDependencies')) {
    requireThat(method === 'lean-comparator' && subject === 'candidate' && Array.isArray(obligation.proofDependencies) &&
      obligation.proofDependencies.length > 0, 'Proof dependencies require a candidate Lean obligation');
    const names = new Set(cases);
    normalized.proofDependencies = obligation.proofDependencies.map(link => {
      requireThat(text(link?.task) && text(link.obligation) && leanName(link.theorem) && !names.has(link.theorem),
        'Invalid or duplicate prerequisite theorem');
      names.add(link.theorem);
      return { task: link.task, obligation: link.obligation, theorem: link.theorem };
    });
  }
  return normalized;
}

export function planVerification(intent) {
  const claims = [...index(intent.claims, 'claim').values()].map(claim => {
    requireThat(text(claim.statement) && levels.has(claim.required), 'Invalid claim ' + claim.id);
    const dependencies = claim.dependencies ?? [];
    requireThat(Array.isArray(dependencies) && dependencies.every(link => text(link?.claim) && text(link.statement)), 'Invalid claim dependencies');
    return { id: claim.id, statement: claim.statement, required: claim.required, domain: normalizeDomain(claim.domain), dependencies,
      ...(Object.hasOwn(claim, 'lean') ? { lean: leanClaim(claim.lean) } : {}) };
  });
  const indexedClaims = index(claims, 'claim');
  const obligations = [...index(intent.obligations, 'obligation').values()].map(o => normalizeObligation(o, indexedClaims));
  for (const claim of claims.filter(item => item.lean)) {
    requireThat(claim.required === 'formal' && obligations.some(o => o.id === claim.lean.obligation && o.claim === claim.id &&
      o.method === 'lean-comparator' && o.subject === 'candidate' && !o.proofDependencies),
    'Refinable Lean claim requires its named candidate proof obligation');
  }
  const criteria = [...index(intent.criteria, 'criterion').values()].map(criterion => {
    const hasClaims = Object.hasOwn(criterion, 'claims');
    const hasException = Object.hasOwn(criterion, 'exception');
    requireThat(text(criterion.description) && hasClaims !== hasException,
      'Invalid coverage shape for criterion ' + criterion.id);
    if (hasException) {
      const exception = criterion.exception;
      requireThat(exception && typeof exception === 'object' && !Array.isArray(exception) &&
        Object.keys(exception).length === 1 && Object.hasOwn(exception, 'risk') && text(exception.risk),
      'Invalid coverage exception for criterion ' + criterion.id);
      return { id: criterion.id, description: criterion.description, exception: { risk: exception.risk } };
    }
    requireThat(Array.isArray(criterion.claims) && criterion.claims.length > 0 &&
      criterion.claims.every(id => indexedClaims.has(id)), 'Invalid coverage for criterion ' + criterion.id);
    return { id: criterion.id, description: criterion.description, claims: criterion.claims };
  });
  const plan = { version: 1, criteria, claims, obligations };
  assurance(plan, claim => {
    const direct = obligations.filter(o => o.claim === claim.id && o.subject === 'candidate' && o.expect === 'PASS');
    requireThat(direct.length > 0, 'Claim lacks a positive candidate obligation: ' + claim.id);
    return weakest(direct.map(o => methods.get(o.method)));
  });
  const covered = new Set();
  const pending = criteria.flatMap(criterion => criterion.claims ?? []);
  while (pending.length) {
    const id = pending.pop();
    if (covered.has(id)) continue;
    covered.add(id);
    pending.push(...indexedClaims.get(id).dependencies.map(link => link.claim));
  }
  requireThat(covered.size === claims.length, 'Every claim must support an acceptance criterion');
  return plan;
}

export function makeContract(input, plan) {
  const { id, goal, scope, policy, dependencies = [], base = 'head-at-dispatch' } = input;
  requireThat(text(id) && text(goal) && Number.isSafeInteger(input.revision) && input.revision >= 1, 'Invalid contract identity');
  requireThat(policy && typeof policy === 'object' && !Array.isArray(policy), 'Invalid contract policy');
  const modelRoute = normalizeModelRoute(policy.modelRoute);
  requireThat(!Object.hasOwn(policy, 'delegation') || policy.delegation === 'monotonic', 'Unsupported delegation policy');
  requireThat(!Object.hasOwn(policy, 'reuseEvidence') || typeof policy.reuseEvidence === 'boolean', 'Invalid evidence reuse policy');
  if (Object.hasOwn(policy, 'feedbackChecks')) {
    const { feedbackChecks } = policy;
    const obligationIds = new Set(plan.obligations.map(({ id }) => id));
    requireThat(Array.isArray(feedbackChecks) && new Set(feedbackChecks).size === feedbackChecks.length &&
      feedbackChecks.every(id => obligationIds.has(id)), 'Feedback checks must be unique approved obligation IDs');
  }
  if (Object.hasOwn(policy, 'lessons')) {
    requireThat(Array.isArray(policy.lessons) && policy.lessons.length <= 16, 'Invalid approved lessons');
    const ids = new Set();
    for (const lesson of policy.lessons) {
      requireThat(lesson && typeof lesson.attempt === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(lesson.attempt) &&
        typeof lesson.evidence === 'string' && /^[0-9a-f]{64}$/.test(lesson.evidence) &&
        text(lesson.diagnosis) && lesson.diagnosis.length <= 2000 && text(lesson.regression) &&
        plan.obligations.some(item => item.id === lesson.regression && item.subject === 'candidate' && item.expect === 'PASS') &&
        !ids.has(lesson.regression), 'Invalid or duplicate approved lesson regression');
      ids.add(lesson.regression);
    }
  }
  requireThat(Array.isArray(dependencies) && dependencies.every(text) && !dependencies.includes(id) &&
    new Set(dependencies).size === dependencies.length, 'Invalid task dependencies');
  requireThat(plan.obligations.every(obligation => (obligation.proofDependencies ?? []).every(link => dependencies.includes(link.task))),
    'Proof dependency must name a direct prerequisite task');
  requireThat(base === 'head-at-dispatch' || /^[a-f0-9]{40}([a-f0-9]{24})?$/.test(base), 'Invalid task base');
  requireThat(typeof policy?.ref === 'string' && policy.ref.startsWith('refs/heads/'), 'Invalid protected branch');
  requireThat(Number.isSafeInteger(policy.budgetMs) && policy.budgetMs > 0 && policy.budgetMs <= 2_147_483_647, 'Invalid task budget');
  requireThat(!Object.hasOwn(policy, 'validUntilMs') || Number.isSafeInteger(policy.validUntilMs) && policy.validUntilMs > 0,
    'Invalid approval expiration time');
  const maxRepairs = policy.maxRepairs ?? 0;
  requireThat(Number.isSafeInteger(maxRepairs) && maxRepairs >= 0 && maxRepairs < Number.MAX_SAFE_INTEGER, 'Invalid repair limit');
  for (const limit of ['maxToolCalls', 'maxVerificationMs']) {
    requireThat(!Object.hasOwn(policy, limit) || Number.isSafeInteger(policy[limit]) && policy[limit] >= 0, 'Invalid ' + limit);
  }
  requireThat(plan.obligations.reduce((sum, o) => sum + o.timeoutMs, 0) < policy.budgetMs, 'Verification exceeds task budget');
  requireThat(scope && ['read', 'write', 'forbidden'].every(key => Array.isArray(scope[key]) && scope[key].every(safePath)),
    'Invalid contract path scope');
  requireThat(scope.write.length > 0, 'Empty write scope');
  requireThat(!scope.write.some(path => within(path, scope.forbidden)), 'Write scope is forbidden');
  if (Object.hasOwn(input, 'revertOperation')) {
    requireThat(typeof input.revertOperation === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(input.revertOperation) &&
      base === 'head-at-dispatch' && !modelRoute, 'Rollback requires a promoted operation ID, current target base and no model route');
  }
  return { version: 1, id, revision: input.revision, goal, base, dependencies, scope,
    policy: modelRoute ? { ...policy, modelRoute } : policy, plan: digest(plan),
    ...(input.revertOperation ? { revertOperation: input.revertOperation } : {}) };
}

export function approvedTask(input) {
  const plan = planVerification(input);
  const contract = makeContract(input, plan);
  const approval = digest(contract);
  requireThat(input.approval === approval, 'Missing or mismatched principal approval for ' + contract.id);
  return { contract, plan, approval };
}

export function evidenceKeys(obligation, claim, subject, manifest, environment, proofDependencies, baseline) {
  const run = digest({
    version: 1, method: obligation.method, oracle: obligation.oracle, cases: obligation.cases,
    timeoutMs: obligation.timeoutMs, ...evidenceSubject(obligation, subject, manifest), environment,
    ...(obligation.proofDependencies ? { proofDependencies } : {}),
    ...(baseline ? { baseline } : {}),
  });
  return { run, authorization: digest({
    version: 1, run, obligation: obligation.id, claim, expect: obligation.expect,
    witness: obligation.witness, outputs: obligation.outputs,
  }) };
}

export function evidenceSubject(obligation, subject, manifest) {
  return obligation.inputPaths ? { inputPaths: obligation.inputPaths, files: manifest.files }
    : { subject, manifest };
}

export function compose(plan, results) {
  const byId = index(results, 'obligation result');
  requireThat(byId.size === plan.obligations.length, 'Incomplete or extraneous evidence');
  for (const obligation of plan.obligations) {
    const result = byId.get(obligation.id);
    requireThat(result?.status === obligation.expect, 'Unexpected verdict for ' + obligation.id);
    requireThat(obligation.expect !== 'FAIL' || result.witness === obligation.witness, 'Wrong failure witness for ' + obligation.id);
    requireThat(result.level === methods.get(obligation.method), 'Unsupported assurance for ' + obligation.id);
    requireThat(Object.keys(result.outputs).length === obligation.outputs.length && obligation.outputs.every(path =>
      Object.hasOwn(result.outputs, path) && /^[a-f0-9]{64}$/.test(result.outputs[path])), 'Missing outputs for ' + obligation.id);
  }
  return assurance(plan, claim => weakest(plan.obligations.filter(o =>
    o.claim === claim.id && o.subject === 'candidate' && o.expect === 'PASS').map(o => byId.get(o.id).level)));
}
