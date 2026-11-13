# Shadow evaluation

Run `node evaluation/reservation.mjs` from the repository root with Node.js 24 and Git. The Linux CI job runs the same command.

The experiment uses four scripted candidate changes. The Verity arm runs the normal acceptance and promotion path. The baseline records the candidate a worker produces without applying an acceptance gate. Both arms evaluate the resulting candidate with a separate shadow oracle. The shadow oracle checks how the reservation code handles two statuses absent from the acceptance oracle. Its verdict is counted after the acceptance decision.

The candidate hard-coded to the visible expected output passes the acceptance check and fails the shadow check. This makes the accepted-defective count observable. The out-of-scope candidate passes the shadow behavior checks and fails the Verity path-scope rule, so it appears under refused-correct. The counts describe these four fixtures. They do not estimate model performance or defect prevalence.
