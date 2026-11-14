# Verity

Verifiable software construction around the Pi agent loop. The architecture
specification lives in `tmp/verity-architecture.tex` (gitignored, local only)
and is the source of truth for design questions. The implementation target is
`https://github.com/RoyCoding8/Verif`.

## Working conventions

- `tmp/` is gitignored. The architecture paper, `tmp/tasks.md` (working task
  list), `tmp/decisions.tsv` (decision and assumption trail), and scratch
  artifacts stay local and untracked. Update `tasks.md` and `decisions.tsv`
  as work lands; record rejected alternatives and assumptions there.
- Method: capture the behavior at the current revision, write a positive case
  and a falsifying mutation, run the small check locally (`node --test
  test/*.test.mjs`), then use Ubuntu/macOS/Windows CI for the integrated
  revision. A mutation that survives means the check is weak; strengthen it.
- Strict verification applies at approval, proof composition, and promotion.
  Agents propose; they never approve their own acceptance conditions, and
  worker reports are never evidence. The gate is a pure decision over
  independently executed, key-fresh evidence bound to the exact merged bytes.
- Expectations in tests and plans use expected verdicts over named subjects
  (fail-before/pass-after, mutation kill, differential, vacuity), not bare
  pass counts.

## CI and branches

- `main` is untouched by implementation work. Work lands on
  `ci/verity-implementation`; the opt-in live evaluation runs on
  `ci/verity-live-evaluation`.
- Heavy checks run on temporary GitHub Actions branches (`ci/**`, `wt/**`
  trigger the workflows). Integrate only after the checks pass on the exact
  revision, confirm the workflows on the integrated commit, then remove
  finished worktrees and obsolete branches (local and remote).
- Paid or live runs require a recheck of the hosted configuration first:
  Actions secrets and variables, provider credentials with a spending cap,
  and an approved dollar ceiling. Live evaluation refuses to start without
  `VERITY_EVAL_COST_CEILING_USD`.

## Layout

- `src/` — controller, contracts, journal, verification service, workers.
- `verification/` — finite models, Lean/Kani/TLA+ artifacts and their laws.
- `test/` — the machine checks; `examples/` — demo fixture and oracles;
  `evaluation/` — shadow evaluation and matched-trial harness.
- `test/*.test.mjs` is the suite CI runs (`npm test` also scans local
  gitignored archives, so prefer the glob locally).
