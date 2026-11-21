# Per-delegation evidence reuse contract

Run the finite contract and its implementation checks with:

```sh
node --test test/evidence-reuse.test.mjs
```

## State model

`EvidenceReuse.mjs` explores a finite state with a stored cache entry, the current and stored execution identities, the source of the current observation, and current authority. The reachable graph has 60 states and 174 transitions. Its edge invariants require a completed execution before insertion, a matching identity and fresh authority on a cache hit, and matching evidence identity plus fresh authority before promotion. Negative controls show both stale-authority promotion after a hit and promotion after the execution key changes; the invariants reject both edges.

The model treats one stored row at a time. The concrete journal supports any number of keys. It abstracts away SQL durability, concurrency, and crashes; the paired tests exercise SQLite row insertion, immutability, checksum validation, corruption repair, and the public promotion decision separately.

## Concrete correspondence checks

The tests compare `evidenceReuseKey()` with its inputs and verify that changes to approved oracle bytes, method, subject commit, tree, or environment produce a different key. Changes to obligation identity, claim text, expected verdict, witness, and output paths preserve the raw key but change `evidenceKeys().authorization`.

The integration case stores raw Node observations, closes and reopens the same controller journal, then waits until a clock-based probe would return a different value. The next approved task reuses the observation under a new claim and obligation identity. It confirms that artifacts are rebuilt for the second task's output paths and have stable bytes even when observations contain nested objects. A malformed cache row forces a fresh execution and is repaired; the following run reuses the repaired row. A separate finite-domain case verifies that changed domain inputs are rejected before the journal is queried. An evaluator failure leaves the cache empty. A receipt from a cache hit passes with active authority and is refused after that attempt is invalidated.

## Key and trust boundary

Reuse is opt-in through the approved `policy.reuseEvidence` field. The raw key includes method, the oracle declaration and actual oracle-byte hash, case IDs, timeout, exact subject commit and tree, materialized manifest, runtime, platform, architecture, Windows system root when applicable, adapter hashes, fixed evaluator locale, and the finite domain for `finite-domain` checks. It omits claim identity, obligation identity, expected verdict, witness, and artifact paths. Each current task recomputes case statuses, artifacts, assurance, and authorization evidence from the stored raw observations before the existing authority and promotion checks run.

An approved `inputPaths` on a Node obligation changes its execution identity to the exact path set and its materialized file modes and digests. The evaluator runs in that projected tree, so the key can survive edits to other files. The gate independently restricts the current integration manifest to the approved path set. The evidence envelope still binds the full current commit and tree. The concrete projection test exercises a hit after an unrelated edit, misses after dependency and oracle changes, an import failure when an input is omitted, and refusal of a stale receipt.

Only completed `node-test` and `finite-domain` executions are stored. Infrastructure failures, malformed output, cancellation, and materialization changes cannot create an entry. Worker feedback checks and standalone verification calls have no journal and bypass reuse. Lean comparator results are not reused because its current live setup can report infrastructure failure through the same exit channel as a rejected proof.

The SQLite journal is trusted local state. The row checksum binds both key and payload and detects malformed or swapped rows; it is not a MAC against a malicious database editor. Opting in also asserts that checked Node code is deterministic for the keyed inputs. The environment fingerprint does not include wall-clock state, random state, or the per-run temporary path, so code that depends on those values must not use reuse.

The finite exploration establishes these invariants over its declared abstract states. The concrete tests establish the listed SQLite and Verity behaviors on the tested runtime and fixtures; they do not prove SQLite durability, arbitrary concurrent processes, Node programs' determinism, Lean execution, or correctness for untested repository inputs.
