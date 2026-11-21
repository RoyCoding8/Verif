# Delegation policy check

Run the check from the worktree root with Node.js 24 or later:

```powershell
node --test test/delegation-policy.test.mjs
node verification/DelegationPolicy.mjs
```

The test suite checks positive revisions, additive claims and obligations, parent opt-in, frozen fields, portable path aliases, policy changes, and invalid parent approvals. The model command prints the number of production decisions checked.

## Finite domain

The model fixes one approved parent at revision 1. It has task ID `task-a`, goal `Preserve the required output.`, base `head-at-dispatch`, no dependencies, read scope `src`, write scope `src/output.mjs`, forbidden scope `src/private`, protected ref `refs/heads/protected`, a 1000 ms budget, two repairs, and explicit `delegation: monotonic` opt-in. Its verification plan has one tested claim, one positive candidate obligation, and one criterion.

Each candidate starts as an exact copy of that parent with revision 2. The finite domain has thirteen independent Boolean dimensions. A zero bit preserves the field. A one bit selects the corresponding counterexample:

1. Replace the task ID.
2. Change the goal.
3. Skip to revision 3.
4. Change the base.
5. Add a dependency.
6. Change the protected ref.
7. Increase the budget.
8. Increase the repair limit.
9. Expand read scope.
10. Expand write scope.
11. Remove a forbidden path.
12. Substitute the existing claim.
13. Add an unknown policy field.

The state space is the full Cartesian product, so `2^13 = 8,192` proposals are compared. The model accepts exactly the all-zero vector. The other 8,191 states must be rejected by `reviseApprovedTask`. This exercises every single-field counterexample as well as all combinations. The test suite separately covers frozen obligations and criteria, additions to the plan, evidence-reuse policy preservation, and case or Unicode spelling changes that differ on case-sensitive filesystems.

This is bounded evidence over the stated finite domain, not a proof for every possible manifest. It checks the exported production decision function against the finite acceptance relation. The approval and revision-binding values are deterministic SHA-256 digests; those digests identify data and lineage but do not create principal authorization or execution authority.
