# Journal promotion correspondence

Run the bounded conformance exploration with:

```sh
node --test test/journal-correspondence.test.mjs
```

The independent abstract state is `(head, status, attemptActive, policyEpoch, operationEpoch)`. Each component is finite: head is old/next/other, status is none/prepared/promoted, authority is active/inactive, and epochs are 0/1 (or absent before preparation). The transition relation and BFS live in `JournalCorrespondence.mjs`; it does not import or inspect Journal code. Tests execute each reachable abstract edge against a fresh SQLite Journal and compare the public observation `(readRef(ref), getOperation(id)?.status ?? none, authority(id)?.active ?? true, policyLabel, operationPolicyLabel)` through the declared string-to-epoch mapping.

The BFS reaches 28 states and 58 distinct reachable transitions. The test replays a shortest abstract prefix for each transition, then compares the public SQLite/adapter observation after every prefix action and after the transition under test.

Preparation snapshots the policy label. A policy change makes an operation stale; invalidation revokes the attempt. A compare-and-swap from old to next is permitted only while the attempt remains active, its current policy label matches the prepared label, and the synchronous recheck accepts. The model explores the accepted recheck case; a false recheck is a refusal with no state change and is not a separate state variable. A divergent ref is refused without changing the journal. If updateRef writes next and then throws, SQLite rolls back to prepared while the external ref remains next; the next promotion call reconciles that state to promoted without another authorization or recheck. Replaying a promoted operation returns the same terminal status without consulting callbacks.

The negative control changes only the abstract transition guard: it permits old-to-next promotion with stale authority. The invariant rejects that edge, and the same public-state equality used for concrete observations rejects the resulting state. Its witness is prepare, change policy, then unsafe promotion. This demonstrates sensitivity to an unauthorized update; it does not inject a source mutation into the production module.

## Relation to Promotion.tla

The tested successful fenced transition is `RetryAtOld` with `FenceAuthorization = TRUE`; recovery after the ref write is `CrashAfterRefWriteBeforeJournalCommit` followed by `RecoverAfterWrite`; a head-drift refusal corresponds to `RefuseStaleHead`. Policy change maps to `ChangePolicy`. The implementation stores opaque policy strings, mapped here to two abstract generations, and captures the prepared string in the operation row. `Promotion.tla` also advances its policy epoch during `RevokeAttempt`; Journal invalidation instead clears `attempt.active` without changing the policy label. These have the same effective authorization result, but are not a raw-variable bisimulation. The implementation's crash is observed as prepared plus ref=next; the TLA `crashed` flag is ghost state that distinguishes the pre-recovery phase.

This is a finite single-operation model. It abstracts away SQL statement ordering and durability, multiple operations and refs, task-bound claims, process scheduling, multiple Journal connections, filesystem or Git ref failure modes, and actual power loss. The executed callback is synchronous, SQLite operations are serialized by `BEGIN IMMEDIATE`, and the ref callback is treated as an atomic compare-and-swap except in the explicit write-then-throw recovery trace. A callback returning false, rather than throwing or succeeding, is also outside this model. SQLite WAL/FULL and Git's ref transaction implementation are assumptions here, not established by this model. The tests establish bounded trace correspondence for the explored state space and selected real SQLite traces; they are not a proof of the JavaScript runtime, SQLite, Git, or concurrent executions.
