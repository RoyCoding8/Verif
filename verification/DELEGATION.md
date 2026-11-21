# Verification for delegated changes

Before handing out a task, record its base commit, owned paths, the behavior to establish, the assumptions, and how the checker observes the implementation. Identify which statement or configuration represents the contract. Keep the approved contract outside the worker's write scope. A worker can propose a correction to the contract for review before checking against the revised statement.

The worker returns its commit, the exact reproduction command with tool versions, the result, a known-bad input or mutation the checker rejects, and the limits of the evidence. Where the checked artifact is a model, describe how its inputs, outputs, and actions map to the implementation. Report the explored domain for an exhaustive check.

The integrator checks that the formal statement captures the requested behavior and that the known-bad case fails for the intended reason. Review which assumptions the checker makes and which production paths it observes. Rerun the supplied check for the worker commit in CI, inspect the owned diff, and merge only after both reviews pass. Rerun the relevant checks on the integrated commit. A changed contract or model-to-code mapping needs another review.

A Lean kernel result establishes a theorem about its formal definitions. A finite state exploration establishes its invariants over the configured reachable states. An implementation comparison establishes agreement over the inputs and observables it actually compares. Record those scopes with the result.
