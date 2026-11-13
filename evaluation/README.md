# Shadow evaluation

Run `node evaluation/reservation.mjs` from the repository root with Node.js 24 and Git. The Linux CI job runs the same command.

The experiment uses four scripted candidate changes. The Verity arm runs the normal acceptance and promotion path. The baseline records the candidate a worker produces without applying an acceptance gate. Both arms evaluate the resulting candidate with a separate shadow oracle. The shadow oracle checks how the reservation code handles two statuses absent from the acceptance oracle. Its verdict is counted after the acceptance decision.

The candidate hard-coded to the visible expected output passes the acceptance check and fails the shadow check. This makes the accepted-defective count observable. The out-of-scope candidate passes the shadow behavior checks and fails the Verity path-scope rule, so it appears under refused-correct. The counts describe these four fixtures. They do not estimate model performance or defect prevalence.

To run the same task with a configured Pi provider, run `node evaluation/reservation.mjs --live <provider> <model> <trials>`. Install dependencies with `npm ci` and configure that provider before starting. A trial consists of two independent Pi sessions, one per arm. Both use the same named model, prompt, source tree, tool permissions, and two-minute wall-clock budget. The first arm alternates between trials. The baseline records any nonempty change. Verity applies the acceptance gate before the shadow suite runs. Neither session gets access to the oracle directories.

The output includes each arm’s classification counts, per-trial elapsed time through candidate collection and admission, and Pi’s reported token counts and estimated model charges when available. `noCandidate` records a run with no changed snapshot to score. Timing excludes setup and shadow evaluation. The current task and two shadow cases provide a small comparison fixture. Its results cover the selected model, task, and trial count.

The **Evaluate Pi reservation changes** workflow runs the same command on Ubuntu. After the workflow is available on the default branch, select the revision to evaluate and supply the provider, exact model ID, and trial count. Configure `GEMINI_API_KEY` for Google or `OPENROUTER_API_KEY` for OpenRouter in the repository’s Actions secrets. Scripted CI runs without either secret.
