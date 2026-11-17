// Verity Desktop — native shell.
//
// Spawns the local backend (desktop/server.mjs) as a child process on
// VERITY_DESKTOP_PORT (default 47812), waits until GET /api/state answers,
// then opens the harness UI in a BrowserWindow. The child is killed on quit
// and on crash so no backend outlives the shell.
//
// `electron desktop/main.mjs --smoke` runs the headless acceptance check:
// load the page, wait for #app, assert the DOM anchors, print SMOKE OK.

import { app, BrowserWindow, safeStorage } from 'electron';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeKeyHandoffFile } from './keyhandoff.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const serverScript = join(here, 'server.mjs');
const port = Number(process.env.VERITY_DESKTOP_PORT ?? 47812);
const url = `http://127.0.0.1:${port}`;
const smoke = process.argv.includes('--smoke');

const ANCHORS = ['#app', '.sidebar', '.transcript', '.composer', '.context', '#thread-list'];

let backend = null;
let backendExit = null;
let quitting = false;

function startBackend(boot) {
  // Run the backend under plain Node even though the parent is Electron.
  // Credential protection is delivered as exactly one consumed-on-read
  // handoff file (see keyhandoff.mjs); nothing else traverses the channel.
  const handoffFile = join(mkdtempSync(join(tmpdir(), 'verity-key-')), 'dek.handoff');
  writeKeyHandoffFile(handoffFile, {
    dek: boot.vaultKey.dek ? boot.vaultKey.dek.toString('hex') : null,
    ...(boot.vaultKey.reason ? { reason: boot.vaultKey.reason } : {}),
  });
  backend = spawn(process.execPath, [serverScript], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      VERITY_DESKTOP_PORT: String(port),
      ...boot.env,
      VERITY_DESKTOP_KEY_HANDOFF_FILE: handoffFile,
    },
    stdio: ['ignore', 'inherit', 'inherit'],
    windowsHide: true,
  });
  backend.on('exit', (code, signal) => {
    backendExit = { code, signal };
    // A crash of the backend kills the shell too; nothing to show without it.
    if (!quitting) {
      console.error(`Verity backend exited unexpectedly (code=${code ?? 'null'} signal=${signal ?? 'null'})`);
      app.exit(1);
    }
  });
  backend.on('error', (error) => {
    console.error('Verity backend failed to start: ' + error.message);
    app.exit(1);
  });
}

function stopBackend() {
  if (backend && backend.exitCode === null && !backendExit) backend.kill();
  backend = null;
}

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

async function waitForState(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (backendExit) throw new Error('backend exited before serving /api/state');
    try {
      const response = await fetch(`${url}/api/state`, { signal: AbortSignal.timeout(2000) });
      if (response.ok) return;
    } catch {
      // Not up yet; retry until the deadline.
    }
    if (Date.now() > deadline) throw new Error(`backend did not answer GET /api/state within ${timeoutMs}ms`);
    await sleep(150);
  }
}

function createWindow() {
  return new BrowserWindow({
    title: 'Verity',
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 640,
    backgroundColor: '#f6f4ef', // dark shell chrome; no white flash while loading
    autoHideMenuBar: true,
  });
}

async function waitForApp(window, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = await window.webContents.executeJavaScript('Boolean(document.querySelector("#app"))').catch(() => false);
    if (found) return;
    if (Date.now() > deadline) throw new Error('page never rendered #app');
    await sleep(150);
  }
}

async function assertAnchors(window) {
  return window.webContents.executeJavaScript(
    `(() => ${JSON.stringify(ANCHORS)}.filter((anchor) => !document.querySelector(anchor)))()`,
  );
}

async function runSmoke(window) {
  try {
    await waitForApp(window);
    const missing = await assertAnchors(window);
    if (missing.length > 0) {
      for (const anchor of missing) console.error(`SMOKE FAIL missing anchor: ${anchor}`);
      app.exit(1);
      return;
    }
    console.log('SMOKE OK');
    app.exit(0);
  } catch (error) {
    console.error(`SMOKE FAIL ${error.message}`);
    app.exit(1);
  }
}

// Keep the backend from outliving the shell in any exit path.
app.on('before-quit', () => {
  quitting = true;
  stopBackend();
});
app.on('window-all-closed', () => app.quit());
process.on('exit', stopBackend);
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    stopBackend();
    process.exit(1);
  });
}

// Durable data lives under the OS user-data directory by default; an
// explicit VERITY_DESKTOP_DATA keeps isolated tests and dev runs apart.
// A pre-existing checkout .data is migrated conservatively: only into a
// fresh destination, and never deleted or modified here.
async function prepareBoot() {
  const explicit = Boolean(process.env.VERITY_DESKTOP_DATA);
  const dataDir = process.env.VERITY_DESKTOP_DATA ?? join(app.getPath('userData'), 'desktop-data');
  const env = { VERITY_DESKTOP_DATA: dataDir };
  if (!explicit) {
    const legacyDir = join(here, '.data');
    if (existsSync(join(legacyDir, 'threads.json')) && !existsSync(join(dataDir, 'threads.json'))) {
      env.VERITY_DESKTOP_LEGACY_DATA = legacyDir;
    }
  }
  return { env, vaultKey: await ensureVaultKey(dataDir) };
}

// Main owns OS-protected key material: a random data-encryption key wrapped
// with safeStorage's supported async API at rest, unwrapped only here and
// handed to the child once over the private pipe. An unwrappable key that
// fails is rewrapped; prior settings survive and stored keys are re-entered
// in Settings.
async function ensureVaultKey(dataDir) {
  mkdirSync(dataDir, { recursive: true });
  const keyFile = join(dataDir, 'vault-key.json');
  if (!(await safeStorage.isAsyncEncryptionAvailable())) {
    return { dek: null, reason: 'OS credential protection (safeStorage) is unavailable, so API keys cannot be stored in this installation.' };
  }
  const wrap = async dek => (await safeStorage.encryptStringAsync(dek.toString('hex'))).toString('base64');
  let wrapped;
  if (existsSync(keyFile)) {
    try {
      wrapped = JSON.parse(readFileSync(keyFile, 'utf8')).wrapped;
    } catch {
      wrapped = undefined;
    }
  }
  let dek;
  if (typeof wrapped === 'string') {
    try {
      const unwrapped = await safeStorage.decryptStringAsync(Buffer.from(wrapped, 'base64'));
      if (/^[0-9a-f]{64}$/.test(unwrapped.result)) {
        dek = Buffer.from(unwrapped.result, 'hex');
        if (unwrapped.shouldReEncrypt) {
          // The OS rotated its key; re-wrap so the next boot decrypts cleanly.
          const temp = join(dataDir, `vault-key.json.${Date.now().toString(36)}.tmp`);
          writeFileSync(temp, JSON.stringify({ wrapped: await wrap(dek) }));
          renameSync(temp, keyFile);
        }
      }
    } catch {
      dek = undefined;
    }
  }
  if (Buffer.isBuffer(dek) && dek.length === 32) return { dek };
  dek = randomBytes(32);
  const temp = join(dataDir, `vault-key.json.${Date.now().toString(36)}.tmp`);
  writeFileSync(temp, JSON.stringify({ wrapped: await wrap(dek) }));
  renameSync(temp, keyFile);
  return { dek };
}

app.whenReady().then(async () => {
  const boot = await prepareBoot();
  startBackend(boot);
  try {
    await waitForState();
  } catch (error) {
    console.error(`${smoke ? 'SMOKE FAIL' : 'Verity shell'}: ${error.message}`);
    app.exit(1);
    return;
  }
  const window = createWindow();
  window.loadURL(url);
  if (smoke) runSmoke(window);
});
