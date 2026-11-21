import { digest, requireThat } from './contracts.mjs';

export function resolveProofDependencies(task, runId, prerequisites, journal) {
  const resolved = new Map();
  const commits = new Map(prerequisites.map(({ id, commit }) => [id, commit]));
  for (const obligation of task.plan.obligations) {
    if (!obligation.proofDependencies) continue;
    resolved.set(obligation.id, obligation.proofDependencies.map(link => {
      const promotion = journal.getTaskPromotion(runId, link.task);
      requireThat(promotion?.next === commits.get(link.task) && promotion?.status === 'promoted',
        'Missing promoted proof prerequisite ' + link.task);
      const { task: priorTask, evidence } = promotion.receipt;
      const prior = priorTask.plan.obligations.find(item => item.id === link.obligation);
      const result = evidence.results.find(item => item.id === link.obligation);
      requireThat(prior?.method === 'lean-comparator' && prior.subject === 'candidate' && prior.cases[0] === link.theorem &&
        evidence.contract === priorTask.approval && evidence.plan === priorTask.contract.plan &&
        result?.level === 'formal' && result.status === 'PASS' && result.observation?.exit === 0 &&
        result.commit === evidence.candidate && result.proof?.theorem === link.theorem,
      'Prerequisite lacks the approved theorem ' + link.theorem);
      return { ...link, operation: promotion.id, commit: promotion.next, receipt: digest(evidence), proof: result.proof };
    }));
  }
  return resolved;
}

export function proofSources(theorem, source, dependencies, manifest, modules = []) {
  const sources = new Map();
  const theorems = new Set();
  for (const link of dependencies) {
    for (const module of link.proof.modules ?? []) {
      requireThat(modules.some(item => item.name === module.name && item.digest === module.digest),
        'Missing or changed prerequisite Lean module: ' + module.name);
    }
    for (const name of link.proof.theorems) theorems.add(name);
    for (const input of link.proof.sources) {
      const existing = sources.get(input.path);
      requireThat(!existing || existing.digest === input.digest, 'Conflicting prerequisite proof sources: ' + input.path);
      sources.set(input.path, input);
    }
  }
  requireThat(!sources.has(source) && !theorems.has(theorem), 'Linked theorem must use a distinct name and solution file');
  theorems.add(theorem);
  const own = manifest.files.find(file => file.path === source);
  requireThat(own, 'Missing Lean solution: ' + source);
  sources.set(source, own);
  const files = [...sources].map(([path, input]) => {
    requireThat(input && manifest.files.some(file => file.path === path && file.digest === input.digest),
      'Missing or changed prerequisite proof source: ' + path);
    return { path, digest: input.digest };
  });
  return { theorem, theorems: [...theorems], sources: files, ...(modules.length > 0 ? { modules } : {}) };
}
