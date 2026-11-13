import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import {
  buildRefinementChallenge,
  digestLeanDefinitions,
  refinementContractDigest,
  verifyRefinement,
} from '../src/refinement-proof.mjs';

const trustedDefinitions = await readFile(
  new URL('../verification/lean-refinement/FiniteModel.lean', import.meta.url),
  'utf8',
);

function contractWith(overrides = {}) {
  const base = {
    definitionDigest: digestLeanDefinitions(trustedDefinitions),
    domain: 'RefinementFixture.State',
    old: {
      precondition: 'RefinementFixture.OldPrecondition',
      guarantee: 'RefinementFixture.OldGuarantee',
      assumptions: ['caller-valid-input', 'reviewed-old-model'],
    },
    new: {
      precondition: 'RefinementFixture.NewPrecondition',
      guarantee: 'RefinementFixture.NewGuarantee',
      assumptions: ['caller-valid-input'],
    },
  };
  return {
    ...base,
    ...overrides,
    old: { ...base.old, ...overrides.old },
    new: { ...base.new, ...overrides.new },
  };
}

function proofSolution(built, contract, { old = contract.old, next = contract.new } = {}) {
  const theoremType = [
    'theorem target :',
    '    VerityRefinement.Refines (Domain := ' + contract.domain + ')',
    '      ' + old.precondition,
    '      ' + next.precondition,
    '      ' + old.guarantee,
    '      ' + next.guarantee + ' := by',
  ].join('\n');
  const placeholder = [
    'theorem target :',
    '    VerityRefinement.Refines (Domain := ' + contract.domain + ')',
    '      ' + contract.old.precondition,
    '      ' + contract.new.precondition,
    '      ' + contract.old.guarantee,
    '      ' + contract.new.guarantee + ' := by',
    '  sorry',
  ].join('\n');
  const proof = [
    '  constructor',
    '  · intro state oldPre',
    '    cases state with',
    '    | oldSupported => exact True.intro',
    '    | oldNoGuarantee => exact True.intro',
    '    | newOnly => cases oldPre',
    '    | outside => cases oldPre',
    '  constructor',
    '  · intro state oldPre newGuarantee',
    '    cases state with',
    '    | oldSupported => exact True.intro',
    '    | oldNoGuarantee => cases newGuarantee',
    '    | newOnly => cases oldPre',
    '    | outside => cases oldPre',
    '  · exact ⟨.oldSupported, True.intro⟩',
  ].join('\n');
  assert.ok(built.challenge.includes(placeholder));
  return built.challenge.replace(placeholder, theoremType + '\n' + proof);
}

async function scratchFor(t) {
  const parent = resolve('tmp');
  await mkdir(parent, { recursive: true });
  const scratch = await mkdtemp(join(parent, 'refinement-proof-test-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  return scratch;
}

test('builds a pinned challenge from trusted definitions and qualified names', () => {
  const contract = contractWith();
  const built = buildRefinementChallenge({ contract, trustedDefinitions });

  assert.equal(built.definitionDigest, contract.definitionDigest);
  assert.equal(built.contractDigest, refinementContractDigest(contract));
  assert.match(built.theorem, /^VerityRefinementWitness_c[a-f0-9]{64}\.target$/);
  assert.ok(built.challenge.includes(trustedDefinitions));
  assert.match(built.challenge, /VerityRefinement\.Refines \(Domain := RefinementFixture\.State\)/);
  assert.match(built.challenge,
    /RefinementFixture\.OldPrecondition\s+RefinementFixture\.NewPrecondition\s+RefinementFixture\.OldGuarantee\s+RefinementFixture\.NewGuarantee/);
  assert.equal(built.contract.new.assumptions.join(','), 'caller-valid-input');
});

test('canonicalizes assumption labels for stable approval digests', () => {
  const contract = contractWith({
    old: { assumptions: [' reviewed-old-model ', 'caller-valid-input'] },
    new: { assumptions: ['caller-valid-input'] },
  });
  const reordered = contractWith({
    old: { assumptions: ['caller-valid-input', 'reviewed-old-model'] },
    new: { assumptions: ['caller-valid-input'] },
  });

  assert.equal(refinementContractDigest(contract), refinementContractDigest(reordered));
  assert.equal(buildRefinementChallenge({ contract, trustedDefinitions }).contractDigest,
    buildRefinementChallenge({ contract: reordered, trustedDefinitions }).contractDigest);
});

test('rejects malformed identifiers, duplicate labels, and assumption growth', () => {
  const base = contractWith();
  assert.throws(() => refinementContractDigest({ ...base, domain: 'State; axiom bad' }), /qualified Lean identifier/);
  assert.throws(() => refinementContractDigest(contractWith({
    old: { assumptions: ['same', ' same '] },
  })), /duplicate labels/);
  assert.throws(() => refinementContractDigest(contractWith({
    new: { assumptions: ['caller-valid-input', 'unapproved-assumption'] },
  })), /must be a subset/);
  assert.throws(() => refinementContractDigest({ ...base, challenge: 'worker source' }), /no fields outside/);
  assert.throws(() => buildRefinementChallenge({
    contract: base,
    trustedDefinitions,
    challenge: 'worker source',
  }), /no fields outside/);
});

test('rejects source and approval digests that do not match before judging', async () => {
  const contract = contractWith();
  const badSource = trustedDefinitions + '\n-- changed after approval\n';
  assert.throws(() => buildRefinementChallenge({ contract, trustedDefinitions: badSource }), /SHA-256/);
  await assert.rejects(verifyRefinement({
    contract,
    approvedDigest: '0'.repeat(64),
    trustedDefinitions,
    solution: 'not Lean',
    timeoutMs: 1,
    scratch: 'relative-path',
  }), /approvedDigest does not match/);
  await assert.rejects(verifyRefinement({
    contract,
    approvedDigest: refinementContractDigest(contract),
    trustedDefinitions,
    solution: 'not Lean',
    timeoutMs: 1,
    scratch: 'relative-path',
    challenge: 'worker source',
  }), /no fields outside/);
});

test('Lake Comparator accepts the witness and rejects refinement near misses', {
  skip: process.env.VERITY_LEAN_SMOKE !== '1',
}, async t => {
  const scratch = await scratchFor(t);
  const contract = contractWith();
  const built = buildRefinementChallenge({ contract, trustedDefinitions });
  const options = {
    approvedDigest: built.contractDigest,
    trustedDefinitions,
    timeoutMs: 180000,
    scratch,
  };

  const accepted = await verifyRefinement({
    ...options,
    contract,
    solution: proofSolution(built, contract),
  });
  assert.equal(accepted.accepted, true, accepted.stderr + accepted.stdout);

  const wrongPre = await verifyRefinement({
    ...options,
    contract,
    solution: proofSolution(built, contract, {
      old: { ...contract.old, precondition: contract.new.precondition },
      next: { ...contract.new, precondition: contract.old.precondition },
    }),
  });
  assert.equal(wrongPre.accepted, false);

  const wrongGuarantee = await verifyRefinement({
    ...options,
    contract,
    solution: proofSolution(built, contract, {
      old: { ...contract.old, guarantee: contract.new.guarantee },
      next: { ...contract.new, guarantee: contract.old.guarantee },
    }),
  });
  assert.equal(wrongGuarantee.accepted, false);

  const badPreContract = contractWith({
    new: { precondition: 'RefinementFixture.BadNewPrecondition' },
  });
  const badPreBuilt = buildRefinementChallenge({ contract: badPreContract, trustedDefinitions });
  const badPre = await verifyRefinement({
    ...options,
    contract: badPreContract,
    approvedDigest: badPreBuilt.contractDigest,
    solution: proofSolution(badPreBuilt, badPreContract),
  });
  assert.equal(badPre.accepted, false);

  const emptyOldContract = contractWith({
    old: { precondition: 'RefinementFixture.EmptyOldPrecondition' },
  });
  const emptyOldBuilt = buildRefinementChallenge({ contract: emptyOldContract, trustedDefinitions });
  const emptyOld = await verifyRefinement({
    ...options,
    contract: emptyOldContract,
    approvedDigest: emptyOldBuilt.contractDigest,
    solution: proofSolution(emptyOldBuilt, emptyOldContract),
  });
  assert.equal(emptyOld.accepted, false);

  const staleProof = await verifyRefinement({
    ...options,
    contract: badPreContract,
    approvedDigest: badPreBuilt.contractDigest,
    solution: proofSolution(built, contract),
  });
  assert.equal(staleProof.accepted, false);

  const inconsistentDefinitions = trustedDefinitions.replace(
    'end RefinementFixture',
    'axiom contradiction : False\n\nend RefinementFixture',
  );
  const inconsistentContract = contractWith({
    definitionDigest: digestLeanDefinitions(inconsistentDefinitions),
  });
  const inconsistentBuilt = buildRefinementChallenge({
    contract: inconsistentContract,
    trustedDefinitions: inconsistentDefinitions,
  });
  const inconsistentSolution = inconsistentBuilt.challenge.replace(
    '  sorry\n',
    '  exact False.elim RefinementFixture.contradiction\n',
  );
  const inconsistent = await verifyRefinement({
    ...options,
    contract: inconsistentContract,
    approvedDigest: inconsistentBuilt.contractDigest,
    trustedDefinitions: inconsistentDefinitions,
    solution: inconsistentSolution,
  });
  assert.equal(inconsistent.accepted, false);
});
