import { lstat, readFile, realpath } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { hash, parseLeanOracle, requireThat } from './contracts.mjs';

async function readApproved(root, source, expected) {
  const path = join(root, source);
  requireThat(relative(await realpath(root), await realpath(path)) === source.split('/').join(sep),
    'Lean input must resolve to its approved path');
  const info = await lstat(path);
  requireThat(info.isFile() && info.size <= 2 * 1024 * 1024, 'Invalid or oversized Lean input');
  const bytes = await readFile(path);
  requireThat(hash(bytes) === expected, 'Lean input digest changed: ' + source);
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
  const { theorem, challenge } = parseLeanOracle(JSON.parse(await readApproved(root, obligation.oracle.file, obligation.oracle.digest)));
  requireThat(theorem === obligation.cases[0] && challenge === leanClaimChallenge(binding, theorem, definitions),
    'Lean oracle does not prove the bound claim ' + obligation.claim);
}
