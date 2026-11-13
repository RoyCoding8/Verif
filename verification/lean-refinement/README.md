# Refinement theorem

`RefinementContract.lean` defines the shared proposition used by each generated witness. For a domain `D`, old and new preconditions `Pold` and `Pnew`, and guarantees `Qold` and `Qnew`, a witness proves:

```lean
(∀ x : D, Pold x → Pnew x) ∧
  ((∀ x : D, Pold x → Qnew x → Qold x) ∧ (∃ x : D, Pold x))
```

The existential is a concrete old-domain witness. The guarantee implication has the direction required to show that every new result accepted under the old precondition also satisfies the old guarantee. `FiniteModel.lean` supplies a small model where reversing either implication fails, and `FiniteWitness.lean` proves the valid contract. The model also allows the new guarantee to improve at `.newOnly`, outside the old precondition; its axiom-free lemma shows unconditional `Qnew → Qold` would reject that valid refinement.

The JavaScript verifier accepts a contract containing the SHA-256 of controller-loaded trusted definitions, a qualified domain type, precondition and guarantee identifiers, and old/new assumption-label arrays. It normalizes labels to NFC, trims and sorts them, rejects duplicates, and requires the new labels to be a subset of the old labels. Labels are recorded metadata for caller-side enforcement; they are not inserted into the theorem as assumptions.

`refinesTrans` proves that two refinements compose over an arbitrary common domain. CI runs `lake env lean -DwarningAsError=true AxiomAudit.lean` and requires all three reported theorems to be axiom-free.

The controller supplies the frozen definitions source separately. The verifier checks its exact UTF-8 SHA-256 against the contract before generating a fresh theorem name from the full contract digest. It builds the challenge itself and passes that challenge and the worker solution to the existing Linux Lake Comparator judge. A worker cannot supply or replace the challenge. Comparator checks the candidate against the trusted exported statement and rejects proofs that depend on axioms outside the existing allowlist.

This verifies the named Lean proposition. It does not establish that the trusted definitions or predicate names accurately describe software behavior; the controller must approve those definitions and the caller must enforce any recorded assumptions.

The checked-in Lake manifest has no dependencies. It keeps `lake check` from trying to create package state inside its kernel-replay sandbox.
