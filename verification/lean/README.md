# Lean reference for assurance composition

This module isolates the assurance rule used by src/contracts.mjs. It models the ordered levels tested < bounded < formal. The effective level for a claim is the weakest of its positive candidate evidence and the effective levels of its dependencies. A claim meets its requirement only when every component meets that threshold. If a dependency is bounded, the dependent claim must use the same normalized finite-domain identity.

The exported theorem supportsWeakestWithExact proves the threshold rule for any finite list of dependency levels. It states that a composed result meets a requirement exactly when the direct result and every dependency meet it. The formal examples prove that a formal result drops to bounded when it depends on bounded evidence, and that a bounded result cannot meet a formal threshold.

## Correspondence boundary

The JSON fixtures are a finite executable comparison with the current JavaScript implementation, not a proof of equivalence for all JavaScript inputs.

The Lean fixture interpreter assumes claims are listed in topological order and dependency numbers refer to earlier rows. Each claim has at least one positive candidate result. Every claim must be transitively reachable from at least one declared root; the fixture interpreter checks that roots exist, while this coverage condition is maintained by the fixture author and enforced by the JavaScript plan validator. Evidence values 0 and 1 correspond to node-test and finite-domain in src/contracts.mjs. The model includes formal as a guarantee level, but the current JavaScript method registry has no direct formal method, so a formal evidence value is rejected by the fixture boundary.

A finite-domain number represents the identity of a normalized finite domain. The fixture bridge maps it to a singleton JSON domain. This models the domain equality decision, not digest canonicalization or finite enumeration. The JavaScript implementation remains responsible for IDs, claim statements, dependency binding, cycles, authorization, oracle digests, subjects, cases, outputs, timeouts, exhaustive-domain checks, and exact evidence completeness. The comparison covers only the listed examples and does not prove those JavaScript paths correct.

## Proof and CI checks

The pinned toolchain is Lean 4.35.0. CI builds with warnings as errors, runs lake check to replay the exported project through Lean's kernel, prints the axioms of each exported theorem, rejects any axiom dependency for those theorems, executes the JSON fixtures, and compares their outcomes with planVerification and compose.

Run from this directory:

~~~powershell
lake build --wfail
lake check
lake env lean -DwarningAsError=true AxiomAudit.lean > axioms.txt
node check-axioms.mjs axioms.txt
lake exe contractFixtures > lean-results.json
node compare.mjs lean-results.json
~~~

The finite fixture includes positive tested and bounded paths, a bounded chain, weakest-evidence selection, bounded-domain mismatch, a missing finite domain, and two insufficient-threshold rejections. The expected values live beside each input in fixtures.json; the Lean executable checks them before printing results.