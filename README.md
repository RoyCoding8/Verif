# Verity

Verity turns approved software tasks into checked Git changes. A Pi worker proposes changes in its own checkout. Verity runs the approved verification plan against the integration snapshot and records the results before updating the protected branch.

## Run the reservation example

Use Node.js 24 and Git 2.38 or later.

```sh
npm ci
npm run demo
```

The example starts two independent reservation tasks and schedules the API task after both land. It checks all 15 cases in a declared arithmetic domain, observes the expected failure on the original code, and checks one API interaction. The fixture supplies reproducible candidate edits. To let Pi propose the edits, configure a Pi model and run `npm run demo -- --pi`.

## Run an approved plan

The manifest contains `repository`, `oracles`, `journal`, `scratch`, `maxWorkers`, and `tasks`. Paths are relative to the manifest. The example builds the task records in `examples/setup.mjs`. Store the manifest, oracle files, journal, and protected repository under controller control.

1. Run `node src/cli.mjs plan manifest.json` to inspect the proposed contract, coverage, and obligations.
2. Review the plan and set each task's `approval` to the displayed digest when you approve it.
3. Run `node src/cli.mjs run manifest.json`.
4. Use `node src/cli.mjs receipt manifest.json <operation>` to inspect the recorded evidence.

To ask Pi for a plan, list the available oracle files in each task's `oracleFiles` and run `node src/cli.mjs propose manifest.json`. Review the returned intent before approving it.

Use `status` to see persisted task outcomes. `run` prints an attempt ID when a worker starts. Use `cancel` with that ID to revoke its authority. Use `recover` with a prepared operation ID to reconcile an interrupted promotion. Add `--abandon` to abandon an operation that has not written its target ref. Recovery records a completed update if the ref already points to the prepared commit. If a controller stops while a task is running, resolve any prepared promotion and use `requeue` with the task ID to retry it.

## Evidence and operating scope

The `node-test` and `finite-domain` JSON oracles list case IDs, module paths, exported functions, inputs, and expected values. The evaluator receives inputs in a separate process. The verifier compares its output with the approved values and binds the result to the oracle digest, adapter, and checked tree.

The tested route reports observed cases. The bounded route requires exactly one case for every input tuple in the approved finite domain. A human reviews whether the domain and expected values capture the intended claim. The TLA+ model checks a finite promotion protocol and includes an unfenced configuration that must produce an unauthorized-update counterexample.

### Check a Lean proof

Use `lean-comparator` on Linux with the Lean 4.35.0 toolchain and a working `bubblewrap` sandbox. The approved oracle JSON contains a qualified `theorem` name, a `solution` path relative to the subject tree, and `challenge` Lean source. Set the obligation's `cases` to an array containing the theorem name and set `expect` to `PASS`. The solution file must define a theorem with the same name and statement. The worker needs the statement to construct a proof, so include it in the task goal.

The verifier copies the solution from the exact Git snapshot and checks it against the approved challenge. Comparator matches the theorem statement, restricts axioms, and replays the proof through Lean's kernel. This verifies the stated Lean theorem. A claim about code in another language needs a separate, reviewed connection between that code and the Lean statement.

Run Verity on a trusted host with cooperative workers and controller-owned Git refs. Independent checkouts and process permissions constrain the supplied worker and Node verification routes. A hostile-code isolation boundary requires stronger deployment controls.
