# Lean comparator judge

This is the first deductive judge in Verity. A caller supplies a complete, trusted Lean challenge module, a candidate solution module, and the theorem name to check.

## Contract

The public function is judgeLean({ challenge, solution, theorem, timeoutMs, signal, scratch }).

- challenge and solution are UTF-8 Lean source strings. The trusted challenge is a full Challenge.lean; the candidate is the full Solution.lean.
- theorem is a Lean identifier or qualified identifier matching the simple identifier rule in src/lean-judge.mjs.
- scratch is the verifier-owned absolute directory used for isolated temporary projects.
- The result is { accepted, stdout, stderr }. Comparator exit 0 returns accepted: true; exit 1 returns accepted: false. Comparator exit 2, an unknown exit, a version mismatch, a process-start failure, cancellation, timeout, or a trusted-challenge build/export failure throws.
- The function never parses proof output to decide acceptance. It does not use --inadvisably-no-sandbox.

leanEnvironment is deterministic JSON data recording the adapter version, Lean toolchain and commit, Linux requirement, comparator protocol, sandbox expectation, and permitted axioms. The function checks lake --version before building the trusted challenge.

## Project separation

Each call creates two distinct temporary Lake projects.

1. The challenge project contains controller-written Lake metadata and only the exact trusted Challenge.lean bytes. It builds and exports the full module before the candidate is introduced.
2. The solution project contains controller-written Lake metadata and comparator configuration plus only the exact candidate Solution.lean bytes. It does not contain Challenge.lean.
3. The solution project invokes lake comparator --challenge-from-export=<file> --paranoid. The trusted export is passed as a read-only input. Comparator builds the candidate solution inside its bubblewrap sandbox.

The child process receives only PATH, locale, timezone, and HOME and ELAN_HOME when present. It does not inherit process credentials or comparator/Lean override variables. The project manifests declare no dependencies; this first method accepts self-contained Lean core proofs.

## Judgment

Comparator is pinned to Lean 4.35.0, commit eb6cafb7290e8bd5f2937522d8d804f58f02bafc. The axiom allowlist is exactly propext, Quot.sound, and Classical.choice. --paranoid requires the Lean kernel and every external checker bundled with this release to accept the solution.

Lake documents exit 0 as accepted, exit 1 as rejected, and exit 2 as unable to run the judgment. Exit 1 also covers solution build failure, so a caller should treat it as a negative result, not as an explanation of why the candidate failed. The diagnostic text is preserved unchanged.

## Assurance boundary

The checked theorem declaration in Solution.lean must match the named theorem in the trusted challenge export. Comparator checks the statement, permitted axioms, and proof term with Lean's kernel and, under --paranoid, the release's bundled external checkers.

This result depends on the correctness and intended meaning of the approved Challenge.lean, Lean's logic, Lake Comparator's plumbing, the bubblewrap sandbox, and the platform. It does not determine whether the formal statement matches an informal requirement. Lake's reference also notes that a broken kernel shared by all enabled checkers could affect the result.

## Reproduction

On Linux with Node 24, run:

    VERITY_LEAN_SMOKE=1 node --test test/lean-judge.test.mjs

The test uses a real pinned Lake Comparator and checks one matching proof, one disallowed axiom, a weaker statement, and a missing theorem. It also checks that challenge and solution files are kept in separate projects, setup errors do not become acceptance, and credentials and tool override variables are not passed to the judge process.

The GitHub workflow installs the official Lean release asset by its SHA-256, checks that bubblewrap can start, then runs these fixtures. It also runs the root obligation end-to-end file on Node 24 whenever that file exists.

## References

- Lean 4.35.0 release notes: https://lean-lang.org/doc/reference/latest/releases/v4.35.0/
- Lake Comparator command and exit semantics: https://lean-lang.org/doc/reference/latest/Build-Tools-and-Distribution/Lake/
- Validating a Lean proof and remaining trust assumptions: https://lean-lang.org/doc/reference/latest/ValidatingProofs/
- Lean 4.35.0 Comparator help source: https://github.com/leanprover/lean4/blob/v4.35.0/src/lake/Lake/CLI/Help.lean
