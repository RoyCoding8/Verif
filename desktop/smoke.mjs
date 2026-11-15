// Verity Desktop — smoke runner.
//
// Phase 1 runs `electron desktop/main.mjs --smoke`: window startup, DOM
// anchors, SMOKE OK. Phase 2 drives one genuine fixture task through the
// actual Electron-launched backend — spawned exactly as desktop/main.mjs
// does (electron.exe with ELECTRON_RUN_AS_NODE=1) — and requires the task
// to reach promoted with the expected verifier evidence.

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));

// Under plain Node the electron package exports the path to the binary.
const electronPath = require('electron');
if (typeof electronPath !== 'string') {
  console.error('smoke must run under node, not electron');
  process.exit(1);
}

// Never inherit ELECTRON_RUN_AS_NODE: the checks need the real Electron
// runtime, not the binary re-executed as plain Node.
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

function exit(code, signal) {
  process.exit(signal ? 1 : (code ?? 1));
}

function runElectron(args, options) {
  return new Promise((resolve) => {
    const child = spawn(electronPath, args, { stdio: 'inherit', ...options });
    child.on('error', (error) => {
      console.error('failed to launch electron: ' + error.message);
      resolve(1);
    });
    child.on('exit', (code, signal) => resolve(signal ? 1 : (code ?? 1)));
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// Phase 1: window startup and DOM anchors.
const startupCode = await runElectron([join(here, 'main.mjs'), '--smoke'], { env });
if (startupCode !== 0) process.exit(startupCode);

// Phase 2: a fixture task promoted through the Electron-launched backend.
const port = await freePort();
const data = await mkdtemp(join(tmpdir(), 'verity-smoke-'));
const backend = spawn(electronPath, [join(here, 'server.mjs')], {
  stdio: 'inherit',
  windowsHide: true,
  env: { ...env, ELECTRON_RUN_AS_NODE: '1', VERITY_DESKTOP_PORT: String(port), VERITY_DESKTOP_DATA: join(data, 'threads-data') },
});
const base = `http://127.0.0.1:${port}`;
try {
  let ready = false;
  for (let waited = 0; waited < 30000 && backend.exitCode === null; waited += 150) {
    try {
      const response = await fetch(`${base}/api/state`, { signal: AbortSignal.timeout(2000) });
      ready = response.ok;
      if (ready) break;
    } catch { /* not up yet */ }
    await sleep(150);
  }
  if (!ready) throw new Error('backend did not answer GET /api/state');
  const created = await (await fetch(`${base}/api/threads`, { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ goal: 'smoke fixture run', taskId: 'reserve', mode: 'fixture' }) })).json();
  let thread;
  for (let waited = 0; waited < 60000; waited += 250) {
    await sleep(250);
    thread = await (await fetch(`${base}/api/threads/${created.id}`)).json();
    if (thread.status === 'done' || thread.status === 'attention') break;
  }
  const result = thread?.results?.[0];
  if (thread?.status !== 'done' || result?.status !== 'promoted' ||
      !/^Promoted as [0-9a-f]{8} · assurance \{"stock":"bounded"\}$/.test(result.detail ?? '')) {
    throw new Error(`fixture run did not reach promoted with bounded assurance: ` +
      JSON.stringify({ status: thread?.status, result: result ?? null }));
  }
  console.log('SMOKE OK');
} catch (error) {
  console.error(`SMOKE FAIL ${error.message}`);
  process.exitCode = 1;
} finally {
  backend.kill();
  await sleep(300);
  if (backend.exitCode === null) backend.kill('SIGKILL');
  await rm(data, { recursive: true, force: true, maxRetries: 5 });
}
