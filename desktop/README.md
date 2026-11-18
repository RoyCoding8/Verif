# Verity Desktop

A native desktop harness app for Verity, laid out like DeepAI Code, ChatGPT
desktop, and Cursor: projects and threads on the left rail, the agent chat in
the center, files and context on the right, a tab bar on top. The app talks to
the real controller in this repository and never routes through an external or
hosted service.

## Prerequisites

- **Node.js 24+** and **npm** (for development and source builds).
- **Git 2.38 or newer** on `PATH`. The packaged/installed app does **not**
  bundle Git; it uses the host's Git installation for repository/worktree
  operations (external Git is a required runtime prerequisite).
- **Windows x64** host for the Windows installer produced by this packaging
  flow.
- Writable per-user application data via Electron `app.getPath('userData')`
  (Windows default: `%APPDATA%\Verity\`).
- Packaged credential storage uses Windows OS credential protection via
  Electron `safeStorage` as designed by the app. In headless/non-interactive
  environments without a usable credential store, the app reports credential
  storage as unavailable.

## Development run (from source)

```sh
npm install
npm run app
```

`npm run app` launches the native Electron shell (`electron desktop/main.mjs`).
It spawns the local backend (`desktop/server.mjs`) as a child process on
`VERITY_DESKTOP_PORT` (default `47812`) with `ELECTRON_RUN_AS_NODE=1` and opens
the harness UI in a `BrowserWindow` once the backend answers `GET /api/state`.
The backend binds `127.0.0.1` only. The window keeps its last position/size;
content security is locked down (context isolation on, node integration off,
restrictive CSP, no remote module).

Development smoke (spawns Electron from source, validates backend/UI wiring):

```sh
npm run smoke
```

## Packaging (Windows x64 setup executable)

**Toolchain (pinned):**

- Electron **45.3.2** (runtime, pinned devDependency)
- electron-builder **26.18.0** (pinned devDependency), **NSIS** target
- Configuration: `package.json` (`"build"` field)

This is a maintained, standard npm-based Windows packaging path (no global
packaging tool install required beyond documented prerequisites).

### Build prerequisites

- Node.js 24+ and npm
- Git 2.38+ on `PATH` (runtime prerequisite; not bundled)
- Network access for `npm install` and first-time Electron binary download if
  the pinned Electron runtime is not already cached by electron-builder
- Windows x64 environment to produce the Windows x64 NSIS installer

### Exact build steps

From the repository/worktree root:

```sh
npm install
npm run dist:win
```

`npm run dist:win` runs `electron-builder --win nsis --x64` and produces:

- **Installer (deliverable):** `dist/Verity-Setup-0.1.0-win-x64.exe`
  (Windows x64 NSIS setup executable)
- **Unpacked app:** `dist/win-unpacked/` (useful for local launch/debug)

Build outputs in `dist/` (and `out/`) are ignored by Git and must not be
committed.

### Install

Run `dist/Verity-Setup-0.1.0-win-x64.exe` interactively to choose an install
location, or install silently with NSIS for automation:

```powershell
.\dist\Verity-Setup-0.1.0-win-x64.exe /S /D=C:\Path\To\VerityInstall
```

For NSIS, `/D=` must be the last argument and specifies the installation
directory. Launch **Verity** from the installed shortcut or `Verity.exe`.

### Packaged launch/smoke verification

- **Automated packaged smoke (no live provider required):** Chromium rejects
  unknown CLI switches in packaged apps, so packaged smoke mode is enabled via
  `VERITY_SMOKE=1` (dev/source launches may also use `--smoke`):

  ```sh
  VERITY_SMOKE=1 ./dist/win-unpacked/Verity.exe
  ```

  Exit code `0` indicates the packaged main process started, spawned the bundled
  backend (`desktop/server.mjs`) in `ELECTRON_RUN_AS_NODE` mode, reached
  `GET /api/state`, loaded the UI, and passed built-in harness checks.

- **Backend/state probe (headless-friendly observable behavior):** run the
  bundled backend directly with the packaged Electron runtime in Node mode:

  ```sh
  ELECTRON_RUN_AS_NODE=1 ./dist/win-unpacked/Verity.exe \
    ./dist/win-unpacked/resources/app.asar/desktop/server.mjs
  ```

  with `VERITY_DESKTOP_DATA` set to a writable temp directory and
  `VERITY_DESKTOP_PORT` set as needed. `GET http://127.0.0.1:<port>/api/state`
  should return harness state (for example `threads` and `pi`), confirming
  bundled code/assets/imports resolve in the packaged app.

If Windows UI automation is unavailable, the exit-code and `/api/state` probes
above provide documented observable packaged harness behavior without live-
provider dependency.

## Worker modes

Each chat turn runs the Verity controller against the demo catalog through
`runTasks`, in one of two modes:

- **fixture** — deterministic offline fixture worker from `examples/setup.mjs`.
  It writes the known-good patch and the verification pipeline judges it;
  useful for driving the app with zero credentials.
- **pi** — real Pi agent loop via `src/pi-worker.mjs`: the model proposes work
  and the controller verifies, refuses, or promotes it.

## Pi runs require an approved dollar ceiling

Pi mode enforces a controller-owned spending ceiling per run (configured in the
app). Runs without an approved ceiling are not executed; this preserves the
existing approval/cost/security rules.

## Runtime data and behavior

State lives under `<userData>/.verity/` by default (Windows:
`%APPDATA%\Verity\.verity\`, from Electron `app.getPath('userData')`), a
writable per-user location. Override with `VERITY_DESKTOP_DATA` for an isolated
run.

```text
<userData>/.verity/
  desktop-settings.json   provider credentials and selected model
  desktop-state.json      thread index (root, project, protected head, messages)
  repos/<name>.git        bare, thread-local integration repositories
  task-catalog/           materialization of the demo project template plus
                          cached settings (not re-created in a non-empty dir)
```

Threads survive backend restarts: a fresh boot reloads the store and serves
workspace files from each thread's `refs/heads/protected` head.
