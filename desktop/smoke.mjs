// Verity Desktop — smoke runner. Boots the shell window headlessly
// (`electron desktop/main.mjs --smoke`), then drives one genuine fixture
// task through the backend spawned exactly as main.mjs spawns it
// (electron.exe with ELECTRON_RUN_AS_NODE=1) and requires it to reach
// promoted with bounded assurance. Every phase is bounded in wall time and
// cleans up only its own backend process and temp directory.

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

const READY_DEADLINE_MS = 30_000;
const RUN_DEADLINE_MS = 120_000;
const TEMP_PREFIX = 'verity-smoke-';

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

const sleep = (ms) => new Promise((done) => setTimeout(done, Math.max(0, ms)));

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

// One HTTP request sliced off a shared wall-clock deadline, requiring HTTP
// success before the body is read: transport errors, timeouts, non-2xx
// responses and malformed JSON each surface as their own failure instead of
// falling through as empty data.
async function api(base, path, deadline, init = {}) {
  let response;
  try {
    response = await fetch(base + path, {
      ...init,
      signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
    });
  } catch (error) {
    throw new Error(`transport ${init.method ?? 'GET'} ${path}: ${error.message}`);
  }
  if (!response.ok) throw new Error(`HTTP ${response.status} ${init.method ?? 'GET'} ${path}`);
  return response.json();
}

// Bounded stop: graceful kill, await the real exit, escalate only if the
// grace deadline passes, then await that exit too.
async function stopChild(child, gracefulMs = 3000) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const deadline = Date.now() + gracefulMs;
  child.kill();
  await Promise.race([once(child, 'exit'), sleep(deadline - Date.now())]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await Promise.race([once(child, 'exit'), sleep(1000)]);
  }
}

const startupCode = await runElectron([join(here, 'main.mjs'), '--smoke'], { env });
if (startupCode !== 0) process.exit(startupCode);

const port = await freePort();
const data = await mkdtemp(join(tmpdir(), TEMP_PREFIX));
const backend = spawn(electronPath, [join(here, 'server.mjs')], {
  stdio: 'inherit',
  windowsHide: true,
  env: { ...env, ELECTRON_RUN_AS_NODE: '1', VERITY_DESKTOP_PORT: String(port), VERITY_DESKTOP_DATA: join(data, 'threads-data') },
});
let spawnError = null;
backend.on('error', (error) => { spawnError = error; });

const base = `http://127.0.0.1:${port}`;
try {
  const readyDeadline = Date.now() + READY_DEADLINE_MS;
  for (;;) {
    if (spawnError) throw new Error(`backend failed to start: ${spawnError.message}`);
    if (backend.exitCode !== null) throw new Error(`backend exited with code ${backend.exitCode} before serving /api/state`);
    try {
      const response = await fetch(`${base}/api/state`, { signal: AbortSignal.timeout(Math.max(1, readyDeadline - Date.now())) });
      if (response.ok) break;
    } catch (error) {
      if (Date.now() >= readyDeadline) throw new Error(`backend not ready within ${READY_DEADLINE_MS}ms: ${error.message}`);
    }
    if (Date.now() >= readyDeadline) throw new Error(`backend did not answer GET /api/state within ${READY_DEADLINE_MS}ms`);
    await sleep(150);
  }

  const runDeadline = Date.now() + RUN_DEADLINE_MS;
  const created = await api(base, '/api/threads', runDeadline, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ goal: 'smoke fixture run', taskId: 'reserve', mode: 'fixture' }),
  });
  let thread;
  for (;;) {
    thread = await api(base, `/api/threads/${created.id}`, runDeadline);
    if (thread.status === 'done' || thread.status === 'attention') break;
    if (Date.now() >= runDeadline) throw new Error(`fixture run still ${thread.status} after ${RUN_DEADLINE_MS}ms`);
    await sleep(250);
  }
  const result = thread.results?.[0];
  // Pending structured replacement: coordinator will swap this strict detail
  // predicate for status + result.commit + assurance.stock after the Muse
  // structured-fields merge.
  if (thread.status !== 'done' || result?.status !== 'promoted' ||
      !/^Promoted as [0-9a-f]{8} · assurance \{"stock":"bounded"\}$/.test(result.detail ?? '')) {
    throw new Error(`fixture run did not reach promoted with bounded assurance: ` +
      JSON.stringify({ status: thread.status, result: result ?? null }));
  }
  console.log('SMOKE OK');
} catch (error) {
  console.error(`SMOKE FAIL ${error.message}`);
  process.exitCode = 1;
} finally {
  if (!spawnError) await stopChild(backend);
  // Recursive delete only for the directory this run created via mkdtemp:
  // it must resolve under the OS temp root and carry the run's prefix.
  const resolved = resolve(data);
  if (resolved.startsWith(resolve(tmpdir()) + sep) && basename(resolved).startsWith(TEMP_PREFIX)) {
    await rm(resolved, { recursive: true, force: true, maxRetries: 5 });
  } else {
    console.error(`SMOKE FAIL refusing to remove unexpected temp path ${resolved}`);
    process.exitCode = 1;
  }
}
