import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';
import { test } from 'node:test';
import { judgeLean, leanEnvironment } from '../src/lean-judge.mjs';

const challenge = 'theorem target : ∀ n : Nat, n = n := by\n  sorry\n';
const correctSolution = 'theorem target : ∀ n : Nat, n = n := by\n  intro n\n  rfl\n';
const helperSource = 'theorem sameNat (n : Nat) : n = n := rfl\n';
const helperChallenge = 'import VerityFixture\ntheorem target : ∀ n : Nat, n = n := by\n  intro n\n  exact sameNat n\n';
const helperSolution = 'import VerityFixture\ntheorem target : ∀ n : Nat, n = n := by\n  intro n\n  exact sameNat n\n';

async function fixture(t) {
  const scratch = resolve('tmp');
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, 'lean-judge-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('rejects invalid theorem names before the platform or toolchain check', async t => {
  const scratch = await fixture(t);
  const options = { challenge, solution: correctSolution, timeoutMs: 1000, scratch };
  await assert.rejects(judgeLean({ ...options, theorem: 'target; lake comparator' }), {
    name: 'TypeError', message: /simple qualified Lean identifier/,
  });
  await assert.rejects(judgeLean({ ...options, theorems: [] }), {
    name: 'TypeError', message: /nonempty list/,
  });
  await assert.rejects(judgeLean({ ...options, theorems: ['target', 'bad; name'] }), {
    name: 'TypeError', message: /nonempty list/,
  });
  await assert.rejects(judgeLean({ ...options, theorems: ['target', 'target'] }), {
    name: 'TypeError', message: /distinct/,
  });
  await assert.rejects(judgeLean({ ...options, theorem: 'target', theorems: ['target'] }), {
    name: 'TypeError', message: /exactly one/,
  });
  await assert.rejects(judgeLean(options), {
    name: 'TypeError', message: /exactly one/,
  });
});

test('rejects malformed or colliding approved helper modules before the platform check', async t => {
  const scratch = await fixture(t);
  const options = { challenge, solution: correctSolution, theorem: 'target', timeoutMs: 1000, scratch };
  await assert.rejects(judgeLean({ ...options, modules: null }), /at most 16 approved local modules/);
  await assert.rejects(judgeLean({ ...options, modules: [{ name: 'Helper', source: helperSource }] }), /Invalid or duplicate/);
  await assert.rejects(judgeLean({ ...options, modules: [
    { name: 'VerityFixture', source: helperSource },
    { name: 'Verityfixture', source: helperSource },
  ] }), /Invalid or duplicate/);
  await assert.rejects(judgeLean({ ...options, modules: [{ name: 'VerityFixture', source: '\ud800' }] }), /Invalid or duplicate/);
  await assert.rejects(judgeLean({ ...options, modules: Array.from({ length: 17 }, (_, index) => ({
    name: 'VerityModule' + index, source: helperSource,
  })) }), /at most 16 approved local modules/);
});

test('keeps the trusted challenge and candidate in separate projects and fails closed on tool errors', {
  skip: process.platform !== 'linux',
}, async t => {
  const root = await fixture(t);
  const bin = join(root, 'bin');
  await mkdir(bin);
  const runner = String.raw`#!/bin/sh
set -eu
command="$1"
shift
bin="$(dirname "$0")"
if env | grep -E '^(GITHUB_TOKEN|OPENAI_API_KEY|MODEL_API_KEY|COMPARATOR_BWRAP|COMPARATOR_LEAN4EXPORT|LEAN|LEAN_SYSROOT|LEAN_PATH)=' >/dev/null; then exit 77; fi
if [ "$command" = "--version" ]; then
  cat "$bin/version"
  exit 0
fi
if [ "$command" = "build" ]; then
  test "$1" = "Challenge"
  test -f Challenge.lean
  test ! -f Solution.lean
  test ! -e ../solution
  if [ -e "$bin/require-helper" ]; then
    test -f VerityFixture.lean
    grep -F 'name = "VerityFixture"' lakefile.toml >/dev/null
    grep -F 'import VerityFixture' Challenge.lean >/dev/null
  else
    grep -F sorry Challenge.lean >/dev/null
  fi
  exit 0
fi
if [ "$command" = "env" ]; then
  test "$1" = "leanexport"
  test "$2" = "Challenge"
  test -f Challenge.lean
  test ! -f Solution.lean
  test ! -e ../solution
  printf "fixture export\n"
  exit 0
fi
if [ "$command" = "comparator" ]; then
  test -f Solution.lean
  test ! -f Challenge.lean
  if [ -e "$bin/require-helper" ]; then
    test -f VerityFixture.lean
    cmp -s VerityFixture.lean ../challenge/VerityFixture.lean
    grep -F 'name = "VerityFixture"' lakefile.toml >/dev/null
    grep -F 'import VerityFixture' Solution.lean >/dev/null
  fi
  grep -F '"theorem_names"' comparator.json >/dev/null
  grep -F '"Namespace.target"' comparator.json >/dev/null
  if [ -e "$bin/require-second" ]; then grep -F '"Namespace.second"' comparator.json >/dev/null; fi
  grep -F '"permitted_axioms"' comparator.json >/dev/null
  export_path=""
  for arg do
    case "$arg" in
      --paranoid) ;;
      --challenge-from-export=*) export_path="$(printf '%s' "$arg" | cut -d= -f2-)" ;;
      --inadvisably-no-sandbox|--solution-from-export=*) exit 77 ;;
    esac
  done
  test -n "$export_path"
  grep -F "fixture export" "$export_path" >/dev/null
  code="$(cat "$bin/exit")"
  if [ "$code" = "0" ]; then
    printf "accepted\n"
  else
    printf "rejected\n"
  fi
  printf "comparator diagnostics\n" >&2
  exit "$code"
fi
exit 77
`;
  const fakeLake = join(bin, 'lake');
  await writeFile(fakeLake, runner, { mode: 0o755 });
  await chmod(fakeLake, 0o755);
  await writeFile(join(bin, 'version'), 'Lake version 5.0.0-src+eb6cafb (Lean version 4.35.0)\n');
  const priorPath = process.env.PATH;
  const injected = new Map([
    ['GITHUB_TOKEN', process.env.GITHUB_TOKEN],
    ['OPENAI_API_KEY', process.env.OPENAI_API_KEY],
    ['MODEL_API_KEY', process.env.MODEL_API_KEY],
    ['COMPARATOR_BWRAP', process.env.COMPARATOR_BWRAP],
    ['COMPARATOR_LEAN4EXPORT', process.env.COMPARATOR_LEAN4EXPORT],
    ['LEAN', process.env.LEAN],
    ['LEAN_SYSROOT', process.env.LEAN_SYSROOT],
    ['LEAN_PATH', process.env.LEAN_PATH],
  ]);
  process.env.PATH = bin + delimiter + priorPath;
  for (const name of injected.keys()) process.env[name] = 'must-not-reach-judge';
  try {
    await writeFile(join(bin, 'require-helper'), '');
    await writeFile(join(bin, 'exit'), '0');
    const accepted = await judgeLean({
      challenge: helperChallenge,
      solution: helperSolution,
      modules: [{ name: 'VerityFixture', source: helperSource }],
      theorem: 'Namespace.target',
      timeoutMs: 10000,
      scratch: root,
    });
    assert.deepEqual(accepted, {
      accepted: true,
      stdout: 'accepted\n',
      stderr: 'comparator diagnostics\n',
    });
    await rm(join(bin, 'require-helper'));

    await writeFile(join(bin, 'exit'), '0');
    await writeFile(join(bin, 'require-second'), '');
    const linkedAccepted = await judgeLean({
      challenge,
      solution: correctSolution,
      theorems: ['Namespace.target', 'Namespace.second'],
      timeoutMs: 10000,
      scratch: root,
    });
    await rm(join(bin, 'require-second'));
    assert.equal(linkedAccepted.accepted, true);

    await writeFile(join(bin, 'exit'), '1');
    const rejected = await judgeLean({
      challenge,
      solution: correctSolution,
      theorem: 'Namespace.target',
      timeoutMs: 10000,
      scratch: root,
    });
    assert.equal(rejected.accepted, false);
    assert.equal(rejected.stdout, 'rejected\n');
    assert.equal(rejected.stderr, 'comparator diagnostics\n');

    await writeFile(join(bin, 'exit'), '2');
    await assert.rejects(judgeLean({
      challenge,
      solution: correctSolution,
      theorem: 'Namespace.target',
      timeoutMs: 10000,
      scratch: root,
    }), /Lean judge could not complete lake/);

    await writeFile(join(bin, 'version'), 'Lake version 5.0.0-src+different (Lean version 4.35.0)\n');
    await writeFile(join(bin, 'exit'), '0');
    await assert.rejects(judgeLean({
      challenge,
      solution: correctSolution,
      theorem: 'Namespace.target',
      timeoutMs: 10000,
      scratch: root,
    }), /toolchain mismatch/);
  } finally {
    process.env.PATH = priorPath;
    for (const [name, value] of injected) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test('pins a JSON-serializable Lean environment contract', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(leanEnvironment)), {
    adapter: 'verity-lean-judge/1',
    toolchain: 'leanprover/lean4:v4.35.0',
    toolchainCommit: 'eb6cafb7290e8bd5f2937522d8d804f58f02bafc',
    platform: 'linux',
    challengeExport: 'lake env leanexport Challenge',
    comparator: ['lake', 'comparator', '--challenge-from-export=<file>', '--paranoid'],
    sandbox: 'Lake comparator bubblewrap; sandbox enabled',
    permittedAxioms: ['propext', 'Quot.sound', 'Classical.choice'],
  });
});

test('Lake Comparator accepts a matching theorem and rejects an axiom, weaker statement, and missing theorem', {
  skip: process.env.VERITY_LEAN_SMOKE !== '1',
}, async t => {
  const scratch = await fixture(t);
  const options = { theorem: 'target', timeoutMs: 180000, scratch };
  const accepted = await judgeLean({ ...options, challenge, solution: correctSolution });
  assert.equal(accepted.accepted, true, accepted.stderr + accepted.stdout);

  const axiom = [
    'axiom injected : ∀ n : Nat, n = n',
    'theorem target : ∀ n : Nat, n = n := injected',
  ].join('\n');
  const axiomRejected = await judgeLean({ ...options, challenge, solution: axiom });
  assert.equal(axiomRejected.accepted, false, axiomRejected.stderr + axiomRejected.stdout);
  assert.match(axiomRejected.stderr + axiomRejected.stdout, /Illegal axiom detected: 'injected'/);

  const weaker = 'theorem target : True := True.intro\n';
  const weakerRejected = await judgeLean({ ...options, challenge, solution: weaker });
  assert.equal(weakerRejected.accepted, false, weakerRejected.stderr + weakerRejected.stdout);
  assert.match(weakerRejected.stderr + weakerRejected.stdout, /theorem statement do not match/);

  const missing = 'theorem other : ∀ n : Nat, n = n := by\n  intro n\n  rfl\n';
  const missingRejected = await judgeLean({ ...options, challenge, solution: missing });
  assert.equal(missingRejected.accepted, false, missingRejected.stderr + missingRejected.stdout);
  assert.match(missingRejected.stderr + missingRejected.stdout, /Const not found in solution: 'target'|Constant target not found in environment/);

  const helperAccepted = await judgeLean({
    ...options,
    challenge: helperChallenge,
    solution: helperSolution,
    modules: [{ name: 'VerityFixture', source: helperSource }],
  });
  assert.equal(helperAccepted.accepted, true, helperAccepted.stderr + helperAccepted.stdout);
  const changedHelperResult = await judgeLean({
    ...options,
    challenge: helperChallenge,
    solution: 'import VerityFixture\ntheorem target : True := True.intro\n',
    modules: [{ name: 'VerityFixture', source: helperSource }],
  });
  assert.equal(changedHelperResult.accepted, false, changedHelperResult.stderr + changedHelperResult.stdout);
  assert.match(changedHelperResult.stderr + changedHelperResult.stdout, /theorem statement do not match/);
});

test('Lake Comparator checks every requested theorem in a linked proof chain', {
  skip: process.env.VERITY_LEAN_SMOKE !== '1',
}, async t => {
  const scratch = await fixture(t);
  const options = { theorems: ['foundation', 'corollary'], timeoutMs: 180000, scratch };
  const linkedChallenge = [
    'theorem foundation : ∀ n : Nat, n = n := by sorry',
    'theorem corollary : ∀ n : Nat, n = n := by sorry',
  ].join('\n');
  const linkedSolution = [
    'theorem foundation : ∀ n : Nat, n = n := by',
    '  intro n',
    '  rfl',
    'theorem corollary : ∀ n : Nat, n = n := foundation',
  ].join('\n');
  const accepted = await judgeLean({ ...options, challenge: linkedChallenge, solution: linkedSolution });
  assert.equal(accepted.accepted, true, accepted.stderr + accepted.stdout);

  const weakenedFoundation = [
    'theorem foundation : True := True.intro',
    'theorem corollary : ∀ n : Nat, n = n := by',
    '  intro n',
    '  rfl',
  ].join('\n');
  const weakenedRejected = await judgeLean({
    ...options, challenge: linkedChallenge, solution: weakenedFoundation,
  });
  assert.equal(weakenedRejected.accepted, false);
  assert.match(weakenedRejected.stderr + weakenedRejected.stdout, /theorem statement do not match/);

  const missingFoundation = [
    'theorem corollary : ∀ n : Nat, n = n := by',
    '  intro n',
    '  rfl',
  ].join('\n');
  const missingRejected = await judgeLean({
    ...options, challenge: linkedChallenge, solution: missingFoundation,
  });
  assert.equal(missingRejected.accepted, false);
  assert.match(missingRejected.stderr + missingRejected.stdout, /Const not found in solution: 'foundation'|Constant foundation not found in environment/);

  const axiomSolution = [
    'axiom injected : ∀ n : Nat, n = n',
    'theorem bad_helper : ∀ n : Nat, n = n := injected',
    'theorem foundation : ∀ n : Nat, n = n := by',
    '  intro n',
    '  rfl',
    'theorem corollary : ∀ n : Nat, n = n := bad_helper',
  ].join('\n');
  const axiomRejected = await judgeLean({ ...options, challenge: linkedChallenge, solution: axiomSolution });
  assert.equal(axiomRejected.accepted, false);
  assert.match(axiomRejected.stderr + axiomRejected.stdout, /Illegal axiom detected: 'injected'/);
});
