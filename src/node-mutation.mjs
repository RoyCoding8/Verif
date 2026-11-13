import { digest, requireThat, safePath, text } from './contracts.mjs';

export function parseMutationOracle(oracle) {
  const { kind, cases, mutants, minimumKills } = oracle ?? {};
  requireThat(kind === 'node-mutation-v1' && Array.isArray(cases) && cases.length > 0 &&
    cases.every(item => text(item?.id)) && new Set(cases.map(item => item.id)).size === cases.length &&
    Array.isArray(mutants) && mutants.length > 0 && mutants.length <= 32 &&
    Number.isSafeInteger(minimumKills) && minimumKills > 0 && minimumKills <= mutants.length, 'Invalid mutation oracle');
  requireThat(mutants.every(m => text(m?.id) && safePath(m.path) && /\.(?:mjs|js|cjs)$/.test(m.path) &&
    typeof m.before === 'string' && m.before.length > 0 && typeof m.after === 'string' && m.before !== m.after &&
    cases.some(item => item.id === m.witness)) && new Set(mutants.map(m => m.id)).size === mutants.length &&
    new Set(mutants.map(({ path, before, after }) => digest({ path, before, after }))).size === mutants.length,
  'Invalid or duplicate source mutations');
  return { cases, mutants, minimumKills };
}

export function checkMutationRun(recipe, observations, changedPaths) {
  const { cases, mutants, minimumKills } = recipe;
  const checkCases = outcomes => {
    requireThat(Array.isArray(outcomes) && outcomes.length === cases.length && outcomes.every((item, index) =>
      item?.id === cases[index].id && Object.hasOwn(item, 'actual') && item.actual !== undefined), 'Incomplete mutation cases');
    return outcomes.filter((item, index) => digest(item.actual) !== digest(cases[index].expected)).map(item => item.id);
  };
  requireThat(checkCases(observations.pristine).length === 0, 'Mutation pristine control failed');
  requireThat(Array.isArray(observations.mutants) &&
    digest(observations.mutants.map(m => m.id)) === digest(mutants.map(m => m.id)), 'Incomplete mutation inventory');
  const results = mutants.map((mutant, index) => {
    const observed = observations.mutants[index];
    requireThat(changedPaths.includes(mutant.path) && /^[a-f0-9]{64}$/.test(observed.digest), 'Invalid mutation subject');
    const failures = checkCases(observed.cases);
    requireThat(failures.length === 0 || (failures.length === 1 && failures[0] === mutant.witness),
      'Unrelated failure for mutant ' + mutant.id);
    return { id: mutant.id, digest: observed.digest, status: failures.length ? 'killed' : 'survived' };
  });
  requireThat(results.filter(result => result.status === 'killed').length >= minimumKills, 'Mutation kill threshold unmet');
  return results;
}
