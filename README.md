# Verity

Verity turns approved software tasks into checked Git changes. A Pi worker proposes changes in its own checkout. Verity runs the approved verification plan against the integration snapshot and records the results before updating the protected branch.

## Run the reservation example

Use Node.js 24 and Git 2.38 or later.

```sh
npm ci
npm run demo
```

The example starts two independent reservation tasks and schedules the API task after both land. It checks all 15 cases in a declared arithmetic domain, observes the expected failure on the original code, and checks one API interaction. The fixture supplies reproducible candidate edits. To let Pi propose the edits, configure a Pi model and run `npm run demo -- --pi`.

The `Evaluate Pi reservation changes` workflow runs paired normal and adversarial prompts under the same selected Pi model and wall-time budget. Its shadow suite measures whether candidates preserve other reservation statuses. The live workflow requires the selected provider's GitHub Actions secret.

## Run an approved plan

The manifest contains `repository`, `oracles`, `journal`, `scratch`, `maxWorkers`, and `tasks`. Paths are relative to the manifest. The example builds the task records in `examples/setup.mjs`. Store the manifest, oracle files, journal, and protected repository under controller control.

1. Run `node src/cli.mjs plan manifest.json` to inspect the proposed contract, coverage, and obligations.
2. Review the plan and set each task's `approval` to the displayed digest when you approve it.
3. Run `node src/cli.mjs run manifest.json`.
4. Use `node src/cli.mjs receipt manifest.json <operation>` to inspect the recorded evidence.

To ask Pi for a plan, list the available oracle files in each task's `oracleFiles` and run `node src/cli.mjs propose manifest.json`. Review the returned intent before approving it.

For a task whose approved policy includes `"delegation": "monotonic"`, run `node src/cli.mjs delegate manifest.json proposed-task.json` to check the next full task revision. A plain task proposal can add coverage and tighten budgets and path permissions while preserving existing claims and obligations. The controller can install the returned revision in its manifest after the check.

On Linux, a bound Lean claim can advance by a checked semantic refinement. Its `lean` record names the frozen `source`, `definitionDigest`, `domain` and `implementation`, and the current `precondition`, `guarantee`, `assumptions` and candidate proof `obligation`. Seal the candidate oracle against the frozen declarations and the statement `∀ x, precondition x → implementation x → guarantee x`. Supply a delegation request shaped as `{ "task": proposedTask, "witness": { "claim": "claim-id" } }` to obtain the exact witness challenge. Add the Lean source text as `witness.solution` and rerun `delegate` to obtain the checked revision. The witness is bound to the exact predecessor, successor and claim. Retain prior obligations and add a new proof obligation for the successor predicate.

Set `policy.feedbackChecks` to the obligation IDs the worker may run while constructing a candidate. The default is an empty list. Keep held-out acceptance obligations outside this list. Workers receive a generic refusal on retry and operators can inspect the specific final refusal with `status`.

Use `node src/cli.mjs refinement manifest.json witness-request.json` on Linux to check a Lean witness for a principal-approved refinement contract. The manifest's `refinements` list supplies `id`, `source` relative to `oracles`, `contract`, `approvedDigest`, and `timeoutMs`. The witness request supplies the matching `id` and the candidate Lean module as `solution`. The command returns a checked witness and its binding digests. Approval of a task revision still goes through `delegate` or the principal.

Use `status` to see persisted task outcomes. `run` prints an attempt ID when a worker starts. Use `cancel` with that ID to revoke its authority. Use `recover` with a prepared operation ID to reconcile an interrupted promotion. Add `--abandon` to abandon an operation that has not written its target ref. Recovery records a completed update if the ref already points to the prepared commit. If a controller stops while a task is running, resolve any prepared promotion and use `requeue` with the task ID to retry it. The initial attempt plus `policy.maxRepairs` is the total attempt allowance. Requeue keeps the original deadline and charges any attempt already reserved.

`status` includes verifier verdict mismatches with the attempt, obligation, candidate snapshot and evidence identity. Held-out failures stay in the controller journal. Retry prompts receive the generic refusal and any explicitly approved feedback.

A principal can turn a confirmed refusal into worker guidance with `policy.lessons`. Each entry names the recorded `attempt` and `evidence`, approved `diagnosis` text, and a current positive candidate obligation as `regression`. Verity checks the historical record before dispatch and includes the approved diagnosis in the worker prompt.

`status` also totals model tokens and estimated cost for attempts that returned usage. The report includes the number of such attempts. Interrupted sessions can incur charges before they report usage.

To choose the Pi model, set `policy.modelRoute` to an ordered list of exact `{provider, model}` pairs. Each reserved attempt advances through that list and reuses its final entry when the list is exhausted. The provider needs credentials on the controller host. Route changes require a new principal approval.

Set `policy.maxToolCalls` to cap Pi tool calls and `policy.maxVerificationMs` to cap the sum of timeouts reserved for new verifier executions. Both allowances are shared by a task's attempts and survive restart. Feedback checks and final verification draw from the same verifier allowance. A cache hit uses no new verifier reservation.

To revert a landed change, create and approve a new task with `revertOperation` set to the earlier promotion operation ID. Give it the scope and checks for the restored behavior. Verity applies the inverse patch to the current target in a disposable checkout and sends that candidate through the normal verification and promotion gates.

## Evidence and operating scope

The `node-test` and `finite-domain` JSON oracles list case IDs, module paths, exported functions, inputs, and expected values. The evaluator receives inputs in a separate process. The verifier compares its output with the approved values and binds the result to the oracle digest, adapter, and checked tree.

The tested route reports observed cases. The bounded route requires exactly one case for every input tuple in the approved finite domain. A human reviews whether the domain and expected values capture the intended claim. The TLA+ model checks a finite promotion protocol and includes an unfenced configuration that must produce an unauthorized-update counterexample.

Use `node-property` to sample an approved set of inputs. Its JSON oracle specifies `module`, `name`, argument `axes`, a constant `expected` result, a uint32 `seed`, and `samples` from 1 to 1000. Use consecutive string case IDs starting at `"0"`. The receipt records the generator, seed and count. Each draw contributes tested assurance.

Set `policy.reuseEvidence` to `true` only for deterministic Node and finite-domain checks. Verity can reuse raw observations for the same commit, tree, approved oracle, and execution environment. It rebuilds verdicts and artifacts for the current plan and checks current authorization before promotion. See [the reuse contract](verification/EvidenceReuse.md) for the full key and reproduction steps.

For a Node obligation whose inputs are known, set `inputPaths` to the exact files it needs, including imports, package metadata and fixtures. Verity materializes those files for the check. With reuse enabled, an unrelated commit can reuse observations if the approved inputs, tool and oracle match. The promotion receipt still names the current candidate.

### Check a Lean proof

Use `lean-comparator` on Linux with the Lean 4.35.0 toolchain and a working `bubblewrap` sandbox. The approved oracle JSON contains a qualified `theorem` name, a `solution` path relative to the subject tree, and `challenge` Lean source. Set the obligation's `cases` to an array containing the theorem name and set `expect` to `PASS`. The solution file must define a theorem with the same name and statement. The worker needs the statement to construct a proof, so include it in the task goal.

The verifier copies the solution from the exact Git snapshot and checks it against the approved challenge. Comparator matches the theorem statement, restricts axioms, and replays the proof through Lean's kernel. This verifies the stated Lean theorem. A claim about code in another language needs a separate, reviewed connection between that code and the Lean statement.

For a theorem that uses a promoted prerequisite, add `proofDependencies` to its obligation. Each entry names the direct prerequisite `task`, its verified `obligation` and its `theorem`. The downstream challenge must state all linked theorems. The solution files are ordered Lean declaration fragments that share one module, with any imports at the start of the first fragment. Verity checks the prerequisite source against the promoted evidence, then checks all named theorems together.

Run Verity on a trusted host with cooperative workers and controller-owned Git refs. Independent checkouts and process permissions constrain the supplied worker and Node verification routes. A hostile-code isolation boundary requires stronger deployment controls.
