# Verity Desktop

A native desktop harness app for Verity, laid out like DeepAI Code, ChatGPT
desktop, and Cursor: projects and threads on the left rail, the agent chat in
the center, files and context on the right, a tab bar on top. The app talks to
a local backend — `server.mjs` in this directory — which serves the renderer
(`public/`) and drives the real controller in `src/verity.mjs`. Every message
the chat shows is produced by an actual run: nothing is synthesized by the UI.

## Running the app

```sh
npm run app
```

(equivalent to `node desktop/server.mjs`). The backend binds `127.0.0.1` and
prints its URL; override the port with `VERITY_DESKTOP_PORT`.

## Worker modes

Each thread runs one task from the demo catalog through `runTasks`, in one of
two modes:

- **fixture** — the deterministic offline fixture worker from
  `examples/setup.mjs`. It writes the known-good patch and the verification
  pipeline judges it; useful for driving the app with zero credentials.
- **pi** — the real Pi agent loop via `src/pi-worker.mjs`: the model proposes
  work and the controller verifies, refuses, or promotes it.

## Pi runs require an approved dollar ceiling

A Pi run is **refused to start** unless `VERITY_COST_CEILING_USD` holds an
approved dollar ceiling. Without it the thread does no paid work: it ends in
`attention` with an error message naming the variable. Pi mode also needs
`VERITY_APP_PROVIDER` and `VERITY_APP_MODEL` (the exact Pi model ID);
`GET /api/state` reports readiness and the refusal reason under `pi`.

## Where thread data lives

Thread state is durable and per checkout, under `desktop/.data` (override with
`VERITY_DESKTOP_DATA`):

- `.data/threads.json` — the thread store (titles, status, messages, results).
- `.data/threads/<id>/workspace/` — each thread's isolated demo workspace: its
  own git repository and journal, so runs never touch each other.
- `.data/task-catalog/` — one materialization of the demo project template plus
  its cached settings (the template cannot be re-created in a directory that
  already holds one).

Threads survive backend restarts: a fresh boot reloads the store and serves
workspace files from each thread's `refs/heads/protected` head.
