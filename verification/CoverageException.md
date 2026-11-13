# Coverage exception check

Replay from the worktree root with Node.js 24 or later:

```powershell
node --test test/coverage-exception.test.mjs test/delegation-policy.test.mjs
node verification/CoverageException.mjs
```

The finite model defines the delegation relation independently of production. For each old criterion, the successor must retain its ID and description and keep its form. Covered criteria may add claim coverage, while exception criteria must preserve their recorded risk exactly. New criteria may be covered criteria only. Claims `a` and `b` must remain covered. The finite states use valid criterion shapes; malformed-shape controls are checked separately against the production validator.

The finite state space is the Cartesian product of five variants for the existing covered criterion, five for the existing exception, and three for an added criterion: 75 successor plans. It includes unchanged and expanded coverage, changed or removed coverage, exception risk and description changes, exception removal and type changes, and a new exception. Expected result: 4 accepted and 71 rejected. The replay command compares every modeled decision with `reviseApprovedTask` and fails on any mismatch.

The independent relation is deliberately weakened once by omitting exact exception-risk equality; this is its only changed rule. It then accepts state 3: the parent risk is `Manual review is incomplete.` and the proposed risk is `changed risk`. The test asserts all replay counts and this exact counterexample, so a relation that accidentally stops exercising the weakened rule fails the replay.

Positive controls also cover unchanged exception carry-forward, adding ordinary covered criteria, and expanding existing covered criteria. Ordinary covered criteria continue to accept unrelated metadata and normalize it away as before. Separate input-validation tests reject malformed criterion shapes, claims combined with an exception, missing forms, and missing or empty risk values. Other negative controls check failure of claim coverage when an exception is the only criterion, failure to provide a positive candidate obligation, delegation mutations, and copying a stale approval onto a directly revised exception. A direct revision is accepted only when its approval digest is recomputed over the exact revised contract.

Assumptions and limits: this is finite evidence for the fixed approved parent and the 125 criterion variants above, not a proof over arbitrary manifests, JavaScript object prototypes, every possible string, or every unrelated contract field. Existing contract validation and all other delegation constraints remain in force. The exception is approval metadata only; it contributes neither claim coverage nor verification evidence.

Outcome: all 75 production decisions matched the independent relation; 4 accepted and 71 rejected. The risk-change counterexample was found at state 3.
