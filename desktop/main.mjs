// Verity Desktop — native shell.
//
// Spawns the local backend (desktop/server.mjs) as a child process on
// VERITY_DESKTOP_PORT (default 47812), waits until GET /api/state answers,
// then opens the harness UI in a BrowserWindow. The child is killed on quit
// and on crash so no backend outlives the shell.
//
// `electron desktop/main.mjs --smoke` runs the headless acceptance check:
// load the page, wait for #app, assert the DOM anchors, assert the real
// Material components are registered and upgraded and the generated MD3
// color roles resolve in both themes, print SMOKE OK.

import { app, BrowserWindow, safeStorage } from 'electron';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deliverKeyHandoff, ensureVaultKey } from './keyhandoff.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const serverScript = join(here, 'server.mjs');
const port = Number(process.env.VERITY_DESKTOP_PORT ?? 47812);
const url = `http://127.0.0.1:${port}`;
const smoke = process.argv.includes('--smoke') || process.env.VERITY_SMOKE === '1';

const ANCHORS = ['#app', '.sidebar', '.transcript', '.composer', '.context', '#thread-list'];

// Checks run inside the real Chromium page. Every md-* element found in the
// DOM must come from the locally registered Material bundle, and every
// interactive Material control must actually upgrade (registered class with a
// rendered shadow root) — including the Providers controls. The generated MD3
// theme must be adopted from the served bundle and resolve
// --md-sys-color-primary in both themes.
const MATERIAL_CHECK = `(async () => {
  const materialElements = [...document.querySelectorAll('*')]
    .filter((element) => element.tagName.toLowerCase().startsWith('md-'));
  await Promise.all(materialElements.map((element) => element.updateComplete ?? Promise.resolve()).map((pending) => pending.catch(() => {})));
  const tags = [...new Set(materialElements.map((element) => element.tagName.toLowerCase()))];
  const result = { tags, unregistered: tags.filter((tag) => !customElements.get(tag)) };
  result.notUpgraded = [...document.querySelectorAll('md-outlined-text-field, md-outlined-select, md-text-button, md-filled-button')]
    .filter((element) => {
      const definition = customElements.get(element.tagName.toLowerCase());
      return definition !== undefined && (!(element instanceof definition) || !element.shadowRoot);
    })
    .map((element) => element.id || element.tagName.toLowerCase());
  // The generated theme must be adopted from the served bundle itself, not
  // provided by any other stylesheet.
  result.themeAdopted = document.adoptedStyleSheets.some((sheet) => {
    try {
      return [...sheet.cssRules].some((rule) => rule.cssText.includes('--md-sys-color-primary:'))
        && [...sheet.cssRules].some((rule) => rule.selectorText === ':root[data-theme="dark"]');
    } catch { return false; }
  });
  const primary = () => getComputedStyle(document.documentElement)
    .getPropertyValue('--md-sys-color-primary').trim();
  const previousTheme = document.documentElement.dataset.theme ?? '';
  document.documentElement.dataset.theme = 'light';
  const light = primary();
  document.documentElement.dataset.theme = 'dark';
  const dark = primary();
  document.documentElement.dataset.theme = previousTheme;
  result.lightPrimary = light;
  result.darkPrimary = dark;
  return JSON.stringify(result);
})()`;

let backend = null;
let backendExit = null;
let quitting = false;

function startBackend(boot) {
  // Run the backend under plain Node even though the parent is Electron.
  // Credential protection is delivered as exactly one JSON line over the
  // child's stdin (see keyhandoff.mjs); no file, argument, or environment
  // variable carries key material, and nothing else traverses the channel.
  backend = spawn(process.execPath, [serverScript], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      VERITY_DESKTOP_PORT: String(port),
      ...boot.env,
    },
    stdio: ['pipe', 'inherit', 'inherit'],
    windowsHide: true,
  });
  deliverKeyHandoff(backend, boot.vaultKey);
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
    const material = JSON.parse(await window.webContents.executeJavaScript(MATERIAL_CHECK));
    if (material.unregistered.length > 0 || material.notUpgraded.length > 0) {
      console.error(`SMOKE FAIL material: unregistered=${material.unregistered} notUpgraded=${material.notUpgraded}`);
      app.exit(1);
      return;
    }
    if (!material.themeAdopted) {
      console.error('SMOKE FAIL material theme: generated color roles not adopted from /material.js');
      app.exit(1);
      return;
    }
    if (!material.lightPrimary || !material.darkPrimary || material.lightPrimary === material.darkPrimary) {
      console.error(`SMOKE FAIL material theme: light=${material.lightPrimary} dark=${material.darkPrimary}`);
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
  return { env, vaultKey: await ensureBootVaultKey(dataDir) };
}

// Main owns OS-protected key material: a random data-encryption key wrapped
// with safeStorage's supported async API at rest, unwrapped only here and
// handed to the child once over the stdin channel. An unwrappable key that
// fails is rewrapped; prior settings survive and stored keys are re-entered
// in Settings.
function ensureBootVaultKey(dataDir) {
  return ensureVaultKey({ safeStorage, dataDir });
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
