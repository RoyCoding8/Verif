import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const laws = [
  {
    law: 'Promotion fencing and crash recovery, one operation',
    proof: ['verification/lean-refinement/PromotionLaw.lean', 'verification/lean-refinement/PromotionLawAudit.lean'],
    model: ['verification/JournalCorrespondence.mjs', 'verification/JournalCorrespondence.md'],
    link: ['test/journal-correspondence.test.mjs'],
    gap: 'The Lean proof and the replayed JS model are related by the action mapping in JournalCorrespondence.md, not by a mechanical check.',
  },
  {
    law: 'Promotion slot exclusivity and fresh evidence across two tasks',
    proof: ['verification/PromotionInductive.tla'],
    gap: 'No test replays the two-task model against the journal. Crash recovery while two tasks compete is not modeled; PromotionLaw.lean covers recovery for one operation.',
  },
  {
    law: 'Approval revocation blocks promotion',
    model: ['verification/ApprovalRevocationLaw.mjs'],
    link: ['test/approval-revocation.test.mjs'],
  },
  {
    law: 'Attempt budget',
    proof: ['verification/lean-refinement/AttemptBudgetLaw.lean', 'verification/lean-refinement/AttemptBudgetLawAudit.lean'],
    gap: 'No test ties the model to the journal. The model allows a re-spend after clear that the journal refuses.',
  },
  {
    law: 'Cost ceiling',
    model: ['verification/CostCeiling.mjs'],
    link: ['test/cost-ceiling-law.test.mjs'],
  },
  {
    law: 'Coverage exceptions',
    model: ['verification/CoverageException.mjs', 'verification/CoverageException.md'],
    link: ['test/coverage-exception.test.mjs'],
  },
  {
    law: 'Delegated revision',
    proof: ['verification/lean-refinement/DelegationLaw.lean', 'verification/lean-refinement/DelegationLawAudit.lean'],
    model: ['verification/DelegationPolicy.mjs', 'verification/DelegationPolicy.md'],
    link: ['test/delegation-policy.test.mjs'],
    gap: 'The Lean issuance relation is not compared with the JS model.',
  },
  {
    law: 'Evidence reuse',
    model: ['verification/EvidenceReuse.mjs', 'verification/EvidenceReuse.md'],
    link: ['test/evidence-reuse.test.mjs'],
  },
  {
    law: 'History linearizability search',
    proof: ['verification/lean-refinement/HistoryLaw.lean', 'verification/lean-refinement/HistoryLawAudit.lean'],
    gap: 'src/history-check.mjs is compared with a permutation reference in its tests, not with the Lean search.',
  },
  {
    law: 'Node differential acceptance',
    proof: ['verification/lean-refinement/NodeDifferential.lean'],
    gap: 'Not compared with the acceptance decision in src/verify.mjs.',
  },
  {
    law: 'Refinement witnesses (product judge)',
    proof: ['verification/lean-refinement/RefinementContract.lean', 'verification/lean-refinement/FiniteModel.lean',
      'verification/lean-refinement/FiniteWitness.lean', 'verification/lean-refinement/AxiomAudit.lean'],
    link: ['src/refinement-proof.mjs', 'test/refinement-proof.test.mjs'],
  },
  {
    law: 'Assurance lattice and promotion gate',
    proof: ['verification/lean/VerityContract.lean', 'verification/lean/ContractFixtures.lean', 'verification/lean/AxiomAudit.lean'],
    link: ['verification/lean/compare.mjs', 'verification/lean/compare-gate.mjs', 'verification/lean/fixtures.json'],
  },
  {
    law: 'Kani report classification (product judge)',
    proof: ['verification/kani/Verdict.lean', 'verification/kani/smoke.rs', 'verification/kani/subject.rs'],
    link: ['test/kani-judge.test.mjs'],
  },
];

const support = [
  'verification/DELEGATION.md', 'verification/LAWS.md', 'verification/axiom-audit.mjs', 'verification/explore.mjs',
  'verification/laws.mjs', 'verification/lean-judge/README.md',
  ...['lean', 'lean-refinement'].flatMap((dir) => ['.gitignore', 'README.md', 'lake-manifest.json', 'lakefile.lean', 'lean-toolchain']
    .map((name) => `verification/${dir}/${name}`)),
];

const walk = (dir) => readdirSync(join(root, dir), { withFileTypes: true }).flatMap((entry) => {
  const path = `${dir}/${entry.name}`;
  if (!entry.isDirectory()) return [path];
  return ['.lake', 'build'].includes(entry.name) ? [] : walk(path);
});
const read = (path) => readFileSync(join(root, path), 'utf8');

function problems() {
  const claimed = [...laws.flatMap(({ proof = [], model = [], link = [] }) => [...proof, ...model, ...link]), ...support];
  const counts = claimed.reduce((map, path) => map.set(path, (map.get(path) ?? 0) + 1), new Map());
  const modelTests = walk('test').filter((path) => /from '\.\.\/verification\//.test(read(path)));
  return [
    ...[...counts].filter(([, count]) => count > 1).map(([path]) => `${path} is registered twice`),
    ...claimed.filter((path) => { try { read(path); return false; } catch { return true; } }).map((path) => `${path} does not exist`),
    ...walk('verification').filter((path) => !counts.has(path)).map((path) => `${path} belongs to no law in verification/laws.mjs`),
    ...modelTests.filter((path) => !counts.has(path)).map((path) => `${path} imports a model but belongs to no law`),
    ...laws.flatMap(({ law, link = [] }) => link.filter((path) => path.startsWith('test/') && !/\.\.\/src\//.test(read(path)))
      .map((path) => `${law}: ${path} is listed as a code link but reads nothing from src/`)),
  ];
}

const cell = (paths = []) => paths.map((path) => `\`${relative('verification', path).replaceAll('\\', '/')}\``).join('<br>') || 'none';

function render() {
  return [
    '# Laws',
    '',
    'Generated by `node verification/laws.mjs --write`. Edit the registry in `laws.mjs`, not this file.',
    '',
    'Each law keeps at most one proof per scope and any number of code links. A proof is a Lean theorem or an Apalache inductive check. A model is an executable finite exploration. A code link runs production code against the model or proof. A model that is neither the law\'s proof nor tied to code by a link is deleted instead of kept. Paths are relative to `verification/`.',
    '',
    '| Law | Proof | Model | Code link | Known gap |',
    '| --- | --- | --- | --- | --- |',
    ...laws.map(({ law, proof, model, link, gap = '' }) => `| ${law} | ${cell(proof)} | ${cell(model)} | ${cell(link)} | ${gap} |`),
    '',
  ].join('\n');
}

if (process.argv.includes('--write')) writeFileSync(join(root, 'verification/LAWS.md'), render());
const found = problems();
if (found.length) {
  console.error(found.join('\n'));
  process.exit(1);
}
if (process.argv.includes('--check') && read('verification/LAWS.md').replace(/\r\n/g, '\n') !== render()) {
  console.error('verification/LAWS.md is stale; run node verification/laws.mjs --write');
  process.exit(1);
}
console.log(`${laws.length} laws, ${laws.filter(({ link }) => link).length} with code links`);
