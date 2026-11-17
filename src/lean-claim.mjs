import { digest, hash, leanModuleDigests, maxApprovedInput, parseLeanOracle, readApprovedFile, requireThat } from './contracts.mjs';

async function readApproved(root, source, expected) {
  const bytes = await readApprovedFile(root, source, maxApprovedInput, { escapeLabel: 'Lean input must resolve to its approved path',
    sizeLabel: 'Invalid or oversized Lean input', digest: expected, digestLabel: 'Lean input digest changed: ' + source });
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
}

export function readLeanDefinitions(root, binding) {
  return readApproved(root, binding.source, binding.definitionDigest);
}

export function leanClaimChallenge(binding, theorem, definitions) {
  const { domain, precondition, guarantee, implementation } = binding;
  requireThat(!/^\s*import(?:\s|$)/m.test(definitions), 'Lean claim definitions must contain declarations only');
  return 'import Init\n\n' + definitions + '\n\ntheorem ' + theorem +
    ` : ∀ x : ${domain}, ${precondition} x → ${implementation} x → ${guarantee} x := by\n  sorry\n`;
}

export async function checkLeanClaimOracle(root, binding, obligation, definitions) {
  const { theorem, challenge, modules } = parseLeanOracle(JSON.parse(await readApproved(root, obligation.oracle.file, obligation.oracle.digest)));
  requireThat(theorem === obligation.cases[0] && challenge === leanClaimChallenge(binding, theorem, definitions),
    'Lean oracle does not prove the bound claim ' + obligation.claim);
  requireThat(digest(leanModuleDigests(modules)) === digest(obligation.leanModules ?? []), 'Approved Lean module list does not match oracle');
}
