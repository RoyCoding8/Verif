# Lean reference for assurance composition

This module isolates the assurance rule used by src/contracts.mjs. It models the ordered levels tested < bounded < formal. The effective level for a claim is the weakest of its positive candidate evidence and the effective levels of its dependencies. A claim meets its requirement only when every component meets that threshold. If a dependency is bounded, the dependent claim must use the same normalized finite-domain identity.

The exported theorem supportsWeakestWithExact proves the threshold rule for any finite list of dependency levels. It states that a composed result meets a requirement exactly when the direct result and every dependency meet it. The formal examples prove that a formal result drops to bounded when it depends on bounded evidence, and that a bounded result cannot meet a formal threshold.

## Correspondence boundary

The JSON fixtures are a finite executable comparison with the current JavaScript implementation, not a proof of equivalence for all JavaScript inputs.

The Lean fixture interpreter assumes claims are listed in topological order and dependency numbers refer to earlier rows. Each claim has at least one positive candidate result. The fixture author ensures every claim is reachable from an acceptance root, and the JavaScript planner checks that coverage. Evidence values 0, 1, and 2 represent accepted results from `node-test`, `finite-domain`, and `lean-comparator`. The comparison supplies results directly to the composer. The Linux proof workflow exercises actual Comparator execution separately.

A finite-domain number represents the identity of a normalized finite domain. The fixture bridge maps it to a singleton JSON domain. This models the domain equality decision, not digest canonicalization or finite enumeration. The JavaScript implementation remains responsible for IDs, claim statements, dependency binding, cycles, authorization, oracle digests, subjects, cases, outputs, timeouts, exhaustive-domain checks, and exact evidence completeness. The comparison covers only the listed examples and does not prove those JavaScript paths correct.

## Proof and CI checks

The pinned toolchain is Lean 4.35.0. The library is the only Lake default target, so lake check replays the assurance model and proofs without the fixture parser or executable. CI gives kernel replay four minutes within a ten-minute job timeout. CI builds with warnings as errors, runs lake check to replay the exported project through Lean's kernel, prints the axioms of each exported theorem, rejects any axiom dependency for those theorems, executes the JSON fixtures, and compares their outcomes with planVerification and compose.

Run from this directory:

~~~powershell
lake build --wfail
lake check
lake env lean -DwarningAsError=true AxiomAudit.lean > axioms.txt
node check-axioms.mjs axioms.txt
lake exe contractFixtures > lean-results.json
node compare.mjs lean-results.json
~~~

The fixtures include each assurance level, domain mismatches, and requirements that fail when a dependency has lower assurance. The Lean executable checks each outcome against the expected values in `fixtures.json` before printing results.

## Promotion decision

`gateExact` proves that the reference accepts exactly when all nine modeled predicates hold. `gateRefusesMissing` covers a missing decision input. `compare-gate.mjs` builds one genuine Git candidate and verifier receipt, then changes each predicate's inputs independently. It checks the precise refusal reason for each single fault and compares all 512 combinations plus a missing bundle against the Lean reference.

Run `lake exe contractFixtures gate > gate-results.json` and `node compare-gate.mjs gate-results.json` from this directory. The correspondence covers the nine mutations and one valid receipt. It leaves arbitrary JavaScript objects and Git, SQLite, verifier execution, and promotion atomicity outside the proof.
