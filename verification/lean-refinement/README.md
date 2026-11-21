# Refinement theorem

`RefinementContract.lean` defines the shared proposition used by each generated witness. For a domain `D`, old and new preconditions `Pold` and `Pnew`, and guarantees `Qold` and `Qnew`, a witness proves:

```lean
(∀ x : D, Pold x → Pnew x) ∧
  ((∀ x : D, Pold x → Qnew x → Qold x) ∧ (∃ x : D, Pold x))
```

The existential is a concrete old-domain witness. The guarantee implication has the direction required to show that every new result accepted under the old precondition also satisfies the old guarantee. `FiniteModel.lean` supplies a small model where reversing either implication fails, and `FiniteWitness.lean` proves the valid contract. The model also allows the new guarantee to improve at `.newOnly`, outside the old precondition; its axiom-free lemma shows unconditional `Qnew → Qold` would reject that valid refinement.

The JavaScript verifier accepts a contract containing the SHA-256 of controller-loaded trusted definitions, a qualified domain type, precondition and guarantee identifiers, and old/new assumption-label arrays. It normalizes labels to NFC, trims and sorts them, rejects duplicates, and requires the new labels to be a subset of the old labels. Labels are recorded metadata for caller-side enforcement; they are not inserted into the theorem as assumptions.

`refinesTrans` proves that two refinements compose over an arbitrary common domain. CI runs `lake env lean -DwarningAsError=true AxiomAudit.lean` and requires all three reported theorems to be axiom-free.

`node ../axiom-audit.mjs .` runs every file in this package that contains `#print axioms`. Each of those lines is one required report. A declaration must be axiom-free unless its line ends with `-- allow:` and the axioms it may use. A missing, reordered, or extra report, or any axiom outside the line's allowlist, fails the audit. Adding a `#print axioms` line is enough to put a new theorem under the check.

`DelegationLaw.lean` checks the issuance relation over frozen predecessor and successor predicates. CI audits `issueSound` and three replay rejections for successor digest, successor approval, and claim identity with `lake env lean -DwarningAsError=true DelegationLawAudit.lean`. The controller test runs the real comparator on a witness for an exact successor and rejects the same witness for a changed approval.

`AttemptBudgetLaw.lean` proves cap preservation, monotonic spending, and current-claim authority for every finite action sequence and natural-number cap. It also proves grant progress when the model permits a grant and refusal when the claim is stale, the task is queued, or capacity is exhausted. Its 17 audited declarations must be axiom-free. The state models claim generations with a per-claim grant identity; it has no attempt-slot identity, so `clear` then `grant` re-spends a token that the journal refuses as idempotent. The Lean model therefore allows more behaviors than the implementation, and its safety results still bound the implementation's. No test ties the model to the journal yet. The journal tests exercise SQLite transactions, duplicate attempt IDs, and durability across connections and reopen.

`PromotionLaw.lean` models one prepared operation against an exact old head, candidate, and current authority. For every finite trace it checks that the operation writes at most once, any recorded write matched the three fences, and recovery of a completed write preserves the ref and write log. It also checks a successful write and recovery and four rejected write attempts. Replay it with `lake env lean -DwarningAsError=true PromotionLawAudit.lean` after `lake build --wfail`. The audit permits only Lean's standard `propext` and `Quot.sound` when a theorem uses axioms. The model treats each action as atomic. Controller and journal fixtures exercise the Git and SQLite path.

`HistoryLaw.lean` proves that its Boolean search accepts exactly the complete histories with a constructive order respecting real-time predecessors and matching every machine transition. The model starts with the complete list of distinct call IDs and a search depth equal to its length. The audit checks a valid order and an impossible real-time order. Replay it with `lake env lean -DwarningAsError=true HistoryLawAudit.lean` after `lake build --wfail`. The JavaScript implementation uses a memoized bitset search, and its tests compare verdicts with an independent permutation reference. The Lean model abstracts those implementation details and the capture of concrete events.

`NodeDifferential.lean` is the Lean differential for the Node acceptance relation. Its Boolean `acceptedCheck` is proved equivalent to the propositional `accepted` over frozen bindings, observation lists, and receipts, and the stale baseline, stale candidate manifest, stale oracle, incomplete inventory, and explicit false-positive receipts are rejected. Its `#print axioms` lines require eight of the ten declarations to be axiom-free, and allow `acceptedCheck_correct` and `refactorAcceptedAsProp` to depend only on Lean's standard `propext` and `Quot.sound`, the same allowlist as the promotion audit. This is evidence about the Lean model's own decision function; it does not establish that the Node implementation computes the same relation.

The controller supplies the frozen definitions source separately. The verifier checks its exact UTF-8 SHA-256 against the contract before generating a fresh theorem name from the full contract digest. It builds the challenge itself and passes that challenge and the worker solution to the existing Linux Lake Comparator judge. A worker cannot supply or replace the challenge. Comparator checks the candidate against the trusted exported statement and rejects proofs that depend on axioms outside the existing allowlist.

This verifies the named Lean proposition. It does not establish that the trusted definitions or predicate names accurately describe software behavior; the controller must approve those definitions and the caller must enforce any recorded assumptions.

The checked-in Lake manifest has no dependencies. It keeps `lake check` from trying to create package state inside its kernel-replay sandbox.
