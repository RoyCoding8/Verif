// Verity Desktop — local backend.
//
// Serves the harness UI and drives the real controller: each thread is an
// isolated demo workspace (its own repository and journal), runs go through
// runTasks, and every message the chat shows is produced by the run itself.
// Fixture mode runs offline; Pi mode runs the real Pi agent loop and is
// refused without an approved dollar ceiling.

import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createDemo, fixtureWorker } from '../examples/setup.mjs';
import { GitRepo } from '../src/git.mjs';
import { runTasks } from '../src/verity.mjs';
import { OperationalError, ValidationError } from './errors.mjs';
import { createAesGcmCipher, absentCipher, readKeyHandoffFile } from './keyhandoff.mjs';
import { createSavedRouteRuntime } from './route.mjs';
import { createSettingsStore } from './settings.mjs';
import { createVault } from './vault.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = join(here, 'public');
const dataDir = process.env.VERITY_DESKTOP_DATA ?? join(here, '.data');
const threadsFile = join(dataDir, 'threads.json');
const protectedRef = 'refs/heads/protected';

let vault;
let providerSettings;

// ---------- durable thread store ----------

const threads = new Map();
const listeners = new Set();

// Durable writes are atomic: a crash mid-write leaves the previous file.
function writeJsonAtomic(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.tmp`;
  writeFileSync(temp, JSON.stringify(value, null, 2));
  renameSync(temp, file);
}

function persist() {
  writeJsonAtomic(threadsFile, [...threads.values()]);
}

function loadThreads() {
  if (!existsSync(threadsFile)) return;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(threadsFile, 'utf8'));
  } catch {
    // An unreadable thread store must not block boot: park it and start
    // empty. The bytes are kept next to the file for manual recovery.
    renameSync(threadsFile, `${threadsFile}.corrupt-${Date.now().toString(36)}`);
    return;
  }
  for (const thread of Array.isArray(parsed) ? parsed : []) threads.set(thread.id, thread);
}

// Conservative preserve/copy migration: the desktop shell asks for it only
// when the destination is fresh, and neither directory is ever deleted or
// overwritten here.
function migrateLegacyData() {
  const legacyDir = process.env.VERITY_DESKTOP_LEGACY_DATA;
  if (!legacyDir || !existsSync(join(legacyDir, 'threads.json')) || existsSync(threadsFile)) return;
  mkdirSync(dataDir, { recursive: true });
  for (const name of ['threads', 'task-catalog']) {
    const source = join(legacyDir, name);
    const target = join(dataDir, name);
    if (existsSync(source) && !existsSync(target)) cpSync(source, target, { recursive: true });
  }
  copyFileSync(join(legacyDir, 'threads.json'), threadsFile);
  writeJsonAtomic(join(dataDir, '.migrated'), { from: legacyDir, at: Date.now() });
}

function emit(event, data) {
  for (const send of listeners) send(event, data);
}

function threadSummary(thread) {
  const { id, title, taskId, mode, status, createdAt, messages } = thread;
  return { id, title, taskId, mode, status, createdAt, messages: messages.length };
}

// Result is { task, status, detail, operation?, commit?, assurance? }:
// the run's raw promotion record projected onto the wire contract in
// exactly one place.
function resultView(result) {
  const detail = result.status === 'promoted'
    ? (result.commit ? `Promoted as ${result.commit.slice(0, 8)}` : 'Promoted')
    : result.reason ?? result.status;
  return {
    task: result.id,
    status: result.status,
    detail,
    operation: result.operation ?? null,
    commit: result.commit ?? null,
    assurance: result.assurance ?? null,
  };
}
// The wire contract: exactly the Thread shape, never the internal record
// (settings and the seed commit stay private to the store).
function fullThread(thread) {
  const { id, title, taskId, mode, status, createdAt, messages } = thread;
  return {
    id, title, taskId, mode, status, createdAt, messages,
    ...workspaceState(thread),
    ...(thread.results ? { results: thread.results.map(resultView) } : {}),
  };
}

// ---------- per-thread workspace ----------

async function ensureWorkspace(thread) {
  const workspace = join(dataDir, 'threads', thread.id, 'workspace');
  await mkdir(workspace, { recursive: true });
  thread.settings = await createDemo(workspace);
  persist();
  return thread.settings;
}

// createDemo refuses to run twice in one directory, so the demo template is
// materialized once per data dir and its settings cached durably for later
// boots of the same data dir.
//
// Recovery is idempotent and non-destructive: an interrupted or failed setup
// is retried by building a fresh staging workspace, then caching. The live
// catalog directory is never deleted or rebuilt, so partial state and any
// files another process holds open (Windows EPERM/EBUSY on a held CWD)
// cannot destroy or block user data.
async function taskCatalog() {
  const catalogDir = join(dataDir, 'task-catalog');
  const cacheFile = join(catalogDir, 'settings.json');
  if (existsSync(cacheFile)) {
    try {
      return JSON.parse(readFileSync(cacheFile, 'utf8'));
    } catch {
      // A corrupt or partial cache is rebuilt; existing files stay untouched.
    }
  }
  const staging = join(catalogDir, `staging-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
  const root = join(staging, 'workspace');
  await mkdir(root, { recursive: true });
  const settings = await createDemo(root);
  writeJsonAtomic(cacheFile, settings);
  cleanStaleStaging(catalogDir, staging);
  return settings;
}

// Only our own abandoned staging dirs are cleaned up, best-effort, and only
// after a successful catalog build; the live catalog content is never a
// cleanup target.
function cleanStaleStaging(catalogDir, keep) {
  for (const name of readdirSync(catalogDir)) {
    if (!name.startsWith('staging-') || join(catalogDir, name) === keep) continue;
    try {
      rmSync(join(catalogDir, name), { recursive: true, force: true });
    } catch {
      // A dir we cannot delete today is left for a later successful build.
    }
  }
}

// A rejected initialization must be retryable within the same backend
// process: the promise is dropped on failure so the next request rebuilds.
function ensureCatalog() {
  if (!catalogPromise) {
    catalogPromise = taskCatalog().catch(error => {
      catalogPromise = null;
      throw error;
    });
  }
  return catalogPromise;
}

function workspaceState(thread) {
  if (!thread.settings) return {};
  const repo = new GitRepo(thread.settings.repository);
  const head = repo.readRef(protectedRef);
  const changed = new Set();
  if (thread.seed) {
    for (const result of thread.results ?? []) {
      if (result.status !== 'promoted' || !result.commit) continue;
      for (const file of repo.changedPaths(thread.seed, result.commit)) changed.add(file);
    }
  }
  return {
    workspace: {
      host: hostname(),
      ref: protectedRef,
      head: head ? head.slice(0, 8) : null,
      files: head ? repo.manifest(head).files.length : 0,
      changed: [...changed],
    },
  };
}

function closure(tasks, taskId) {
  const byId = new Map(tasks.map(task => [task.id, task]));
  const needed = new Set();
  const visit = id => {
    if (needed.has(id)) return;
    needed.add(id);
    for (const dependency of byId.get(id)?.dependencies ?? []) visit(dependency);
  };
  visit(taskId);
  return tasks.filter(task => needed.has(task.id));
}

// ---------- workers ----------

// The saved provider route drives both readiness and runs; environment
// variables remain an explicit dev/legacy fallback only when nothing is
// saved. Readiness never performs network discovery.
async function piRoute() {
  const saved = await providerSettings.routeConfig();
  if (saved) return savedRoute(saved);
  const provider = process.env.VERITY_APP_PROVIDER ?? process.env.VERITY_EVAL_PROVIDER;
  const model = process.env.VERITY_APP_MODEL ?? process.env.VERITY_EVAL_MODEL;
  const ceilingUsd = Number(process.env.VERITY_COST_CEILING_USD);
  if (!provider || !model) return { kind: 'env', ready: false, reason: 'Set VERITY_APP_PROVIDER and VERITY_APP_MODEL to the exact Pi model ID' };
  if (!Number.isFinite(ceilingUsd) || ceilingUsd <= 0) {
    return { kind: 'env', ready: false, reason: 'Pi runs are refused without an approved dollar ceiling in VERITY_COST_CEILING_USD' };
  }
  try {
    const { ModelRuntime } = await import('@earendil-works/pi-coding-agent');
    const runtime = await ModelRuntime.create({ allowModelNetwork: true, modelRefreshTimeoutMs: 20_000 });
    const entry = runtime.getModel(provider, model);
    if (!entry) return { kind: 'env', ready: false, reason: `Model ${provider}/${model} is absent from the Pi catalog` };
    if (!runtime.hasConfiguredAuth(provider)) return { kind: 'env', ready: false, reason: `Provider ${provider} has no configured credentials` };
    return { kind: 'env', ready: true, provider, model, ceilingUsd };
  } catch (error) {
    return { kind: 'env', ready: false, reason: error.message };
  }
}

async function savedRoute(saved) {
  const route = { kind: 'saved', provider: saved.id, model: saved.modelId, ceilingUsd: saved.ceilingUsd, protocol: saved.protocol, baseUrl: saved.baseUrl };
  if (saved.ceilingUsd === null) {
    return { ...route, ready: false, reason: 'Pi runs are refused without an approved dollar ceiling; set one in Settings' };
  }
  if (!saved.keyStored) {
    return { ...route, ready: false, reason: `Add an API key for ${saved.id} in Settings` };
  }
  if (typeof saved.apiKey !== 'string') {
    return { ...route, ready: false, reason: `The stored key for ${saved.id} could not be read; re-enter it in Settings` };
  }
  try {
    const { runtime, model } = await createSavedRouteRuntime(saved);
    return { ...route, ready: true, runtime, sdkModel: model, secretKey: saved.apiKey };
  } catch (error) {
    return { ...route, ready: false, reason: withoutSecrets(`Provider ${saved.id} is not runnable: ${error.message}`, [saved.apiKey]) };
  }
}

// Wire shape for /api/state: never the runtime, never key material.
function routeView(route) {
  const { kind, ready, reason, provider, model, ceilingUsd } = route;
  return {
    ready,
    ...(reason === undefined ? {} : { reason }),
    ...(ready ? { provider, model, ceilingUsd } : {}),
  };
}

function withoutSecrets(text, secrets) {
  let clean = String(text);
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length > 0) clean = clean.split(secret).join('[redacted]');
  }
  return clean;
}

// ---------- runs ----------

async function startRun(thread) {
  const mode = thread.mode;
  const secretsInFlight = [];
  thread.status = 'running';
  thread.messages.push({ role: 'system', text: `Dispatching \`${thread.taskId}\` through the controller (${mode} worker).`, ts: Date.now() });
  emit('thread:update', fullThread(thread));
  try {
    const settings = thread.settings;
    let worker = job => fixtureWorker(job);
    let costCeilingUsd;
    if (mode === 'pi') {
      const route = await piRoute();
      if (!route.ready) throw new Error(route.reason);
      const { runPiWorker } = await import('../src/pi-worker.mjs');
      if (route.kind === 'saved') {
        if (typeof route.secretKey === 'string') secretsInFlight.push(route.secretKey);
        worker = async job => {
          try {
            return await runPiWorker({ ...job, model: route.sdkModel, modelRuntime: route.runtime });
          } catch (error) {
            const message = /did not complete the model request/.test(error.message)
              ? `Model request failed for ${route.provider}/${route.model} (${route.protocol} at ${route.baseUrl}). Check the model ID, endpoint and API key in Settings.`
              : error.message;
            throw new Error(withoutSecrets(message, secretsInFlight));
          }
        };
      } else {
        const { ModelRuntime } = await import('@earendil-works/pi-coding-agent');
        const runtime = await ModelRuntime.create({ allowModelNetwork: true, modelRefreshTimeoutMs: 20_000 });
        const model = runtime.getModel(route.provider, route.model);
        worker = job => runPiWorker({ ...job, model, modelRuntime: runtime });
      }
      costCeilingUsd = route.ceilingUsd;
    }
    const results = await runTasks({
      repository: settings.repository,
      journalPath: settings.journalPath,
      oracleRoot: settings.oracleRoot,
      scratch: settings.scratch,
      maxWorkers: settings.maxWorkers,
      tasks: closure(settings.tasks, thread.taskId),
      worker,
      onEvent: event => {
        if (event.type === 'attempt_started') {
          thread.messages.push({ role: 'system', text: 'Attempt started in an isolated clone.', ts: Date.now() });
          emit('thread:update', fullThread(thread));
        }
      },
      ...(costCeilingUsd === undefined ? {} : { costCeilingUsd }),
    });
    thread.results = results;
    for (const result of results) {
      thread.messages.push({ role: 'result', ts: Date.now(), data: resultView(result) });
    }
    thread.status = results.every(result => result.status === 'promoted') ? 'done' : 'attention';
  } catch (error) {
    thread.status = 'attention';
    thread.messages.push({ role: 'error', text: withoutSecrets(error.message, secretsInFlight), ts: Date.now() });
  }
  persist();
  emit('thread:update', fullThread(thread));
}

// Repository paths served from the protected head: plain relative tree paths
// only — no traversal, no absolute roots, no git metadata.
function safeRepoPath(file) {
  if (typeof file !== 'string' || file.length === 0) return false;
  if (file.startsWith('/') || /^[a-zA-Z]:/.test(file) || file.includes('\\')) return false;
  if (/[\u0000-\u001f]/.test(file)) return false;
  const segments = file.split('/');
  return segments[0] !== '.git'
    && segments.every(segment => segment !== '' && segment !== '.' && segment !== '..');
}
// ---------- http api ----------

function json(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

async function readBody(request, limit = 1024 * 1024) {
  request.setEncoding('utf8');
  let data = '';
  let bytes = 0;
  let tooLarge = false;
  for await (const chunk of request) {
    bytes += Buffer.byteLength(chunk, 'utf8');
    if (bytes > limit) {
      tooLarge = true;
      // Drain the remainder so the refusal is delivered on a clean socket;
      // give up (and reset) only on a grossly oversized stream.
      if (bytes > limit + 64 * 1024 * 1024) {
        request.destroy();
        break;
      }
    } else {
      data += chunk;
    }
  }
  if (tooLarge) {
    const error = new Error('request body too large');
    error.tooLarge = true;
    throw error;
  }
  return data ? JSON.parse(data) : {};
}

function rejectTooLarge(request, response) {
  response.writeHead(413, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ error: 'request body too large' }));
}

// Early rejects drain an unconsumed request body first, so the client sees
// the refusal instead of a connection reset. The connection is marked
// close-once: the client must not reuse a socket whose body was discarded.
function refuseJson(request, response, status, error) {
  request.resume();
  response.setHeader('connection', 'close');
  json(response, status, { error });
}

// The backend is loopback-only. Hosts other than loopback are refused (DNS
// rebinding guard), and browser-initiated cross-origin writes are refused.
const LOOPBACK_NAMES = new Set(['127.0.0.1', 'localhost', '::1']);
const MUTATING_METHODS = new Set(['POST', 'PUT', 'DELETE', 'PATCH']);

function foreignRequest(request) {
  const host = request.headers.host;
  if (typeof host !== 'string' || host.length === 0) return 'requests must target the loopback interface';
  let hostName;
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    hostName = end === -1 ? host : host.slice(1, end);
  } else {
    const colon = host.lastIndexOf(':');
    hostName = colon === -1 ? host : host.slice(0, colon);
  }
  if (!LOOPBACK_NAMES.has(hostName.toLowerCase())) {
    return `only loopback hosts may reach the Verity backend, not ${hostName}`;
  }
  if (MUTATING_METHODS.has(request.method)) {
    const origin = request.headers.origin;
    if (origin === undefined) return null; // non-browser clients send no Origin
    try {
      if (!LOOPBACK_NAMES.has(new URL(origin).hostname.toLowerCase())) return 'cross-origin writes are refused';
    } catch {
      return 'invalid Origin header';
    }
  }
  return null;
}

// Validated once at the HTTP boundary: after this the parsed request is
// trusted, so run dispatch needs no re-checks.
function invalidThreadRequest(payload) {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return 'request body must be a JSON object';
  }
  const { goal, taskId, mode } = payload;
  if (goal !== undefined && typeof goal !== 'string') return 'goal must be a string';
  if (taskId !== undefined && typeof taskId !== 'string') return 'taskId must be a string';
  if (mode !== undefined && mode !== 'fixture' && mode !== 'pi') return 'mode must be fixture or pi';
  return null;
}

const mime = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };

let catalogPromise;

async function handle(request, response) {
  const foreign = foreignRequest(request);
  if (foreign) return refuseJson(request, response, 403, foreign);
  const url = new URL(request.url, 'http://127.0.0.1');
  const path = url.pathname;

  if (path === '/api/events') {
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    const send = (event, data) => response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    listeners.add(send);
    send('hello', { hostname: hostname() });
    request.on('close', () => listeners.delete(send));
    return;
  }

  if (path === '/api/state' && request.method === 'GET') {
    return json(response, 200, {
      hostname: hostname(),
      threads: [...threads.values()].map(threadSummary),
      pi: routeView(await piRoute()),
    });
  }

  if (path === '/api/settings' && request.method === 'GET') {
    return json(response, 200, providerSettings.view());
  }

  if (path === '/api/settings' && request.method === 'PUT') {
    let payload;
    try {
      payload = await readBody(request);
    } catch (error) {
      if (error.tooLarge) return rejectTooLarge(request, response);
      return json(response, 400, { error: 'invalid JSON' });
    }
    try {
      return json(response, 200, await providerSettings.update(payload));
    } catch (error) {
      if (error instanceof ValidationError) return json(response, 400, { error: error.message });
      return json(response, 503, { error: error.message });
    }
  }

  if (path === '/api/tasks' && request.method === 'GET') {
    // The demo project template: one workspace is materialized per thread,
    // so task definitions come from a single scratch materialization.
    const settings = await ensureCatalog();
    return json(response, 200, {
      tasks: settings.tasks.map(task => ({ id: task.id, goal: task.goal, dependencies: task.dependencies })),
    });
  }

  if (path === '/api/threads' && request.method === 'POST') {
    let payload;
    try {
      payload = await readBody(request);
    } catch {
      return json(response, 400, { error: 'invalid JSON' });
    }
    const shapeError = invalidThreadRequest(payload);
    if (shapeError) return json(response, 400, { error: shapeError });
    if (payload.taskId !== undefined) {
      const settings = await ensureCatalog();
      if (!settings.tasks.some(task => task.id === payload.taskId)) {
        return json(response, 400, { error: 'unknown taskId' });
      }
    }
    const { goal, taskId, mode } = payload;
    const id = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    const thread = {
      id,
      title: (goal ?? 'New task').slice(0, 72),
      taskId: taskId ?? 'messages',
      mode: mode === 'pi' ? 'pi' : 'fixture',
      status: 'queued',
      createdAt: Date.now(),
      messages: [{ role: 'user', text: goal ?? '', ts: Date.now() }],
    };
    threads.set(id, thread);
    // Snapshot the summary at creation time: the run dispatch mutates status.
    const summary = threadSummary(thread);
    emit('thread:created', summary);
    persist();
    const settings = await ensureWorkspace(thread);
    thread.seed = new GitRepo(settings.repository).readRef(protectedRef);
    void startRun(thread);
    return json(response, 201, summary);
  }

  const threadMatch = path.match(/^\/api\/threads\/([^/]+)$/);
  if (threadMatch && request.method === 'GET') {
    const thread = threads.get(threadMatch[1]);
    return thread ? json(response, 200, fullThread(thread)) : json(response, 404, { error: 'unknown thread' });
  }

  const fileMatch = path.match(/^\/api\/threads\/([^/]+)\/file$/);
  if (fileMatch && request.method === 'GET') {
    const thread = threads.get(fileMatch[1]);
    if (!thread) return json(response, 404, { error: 'unknown thread' });
    const file = url.searchParams.get('path');
    if (!file || !safeRepoPath(file)) return json(response, 400, { error: 'invalid path' });
    // Files are served only from the protected head of the thread's repo.
    const head = thread.settings ? new GitRepo(thread.settings.repository).readRef(protectedRef) : null;
    if (!head) return json(response, 404, { error: 'no protected head' });
    try {
      const text = execFileSync('git', ['-C', thread.settings.repository, 'show', `${head}:${file}`],
        { encoding: 'utf8', windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
      return json(response, 200, { path: file, content: text });
    } catch {
      return json(response, 404, { error: 'not found' });
    }
  }

  // static renderer
  const requested = path === '/' ? '/index.html' : path;
  const target = resolve(join(publicDir, requested));
  if (!target.startsWith(publicDir) || !existsSync(target) || extname(target) === '') {
    return json(response, 404, { error: 'not found' });
  }
  response.writeHead(200, { 'content-type': mime[extname(target)] ?? 'application/octet-stream' });
  response.end(await readFile(target));
}

export function startServer(port = Number(process.env.VERITY_DESKTOP_PORT ?? 47812), options = {}) {
  // The cipher is injected by the host process (Electron main via a one-shot
  // wrapped-DEK handoff) or by tests; headless runs report credential
  // storage unavailable instead of falling back to plaintext.
  vault = createVault({ dataDir, cipher: options.cipher ?? bootVaultCipher() });
  providerSettings = createSettingsStore({ dataDir, vault });
  migrateLegacyData();
  mkdirSync(dataDir, { recursive: true });
  loadThreads();
  const server = createServer((request, response) => {
    handle(request, response).catch(error => {
      if (!response.headersSent) json(response, 500, { error: error.message });
    });
  });
  server.listen(port, '127.0.0.1');
  return { server, port, url: `http://127.0.0.1:${port}` };
}

// The desktop shell delivers a one-shot, OS-protected data-encryption key
// over a private inherited pipe (see keyhandoff.mjs). A bare
// `node desktop/server.mjs` process receives none and reports credential
// storage unavailable; there is deliberately no plaintext fallback.
function bootVaultCipher() {
  const file = process.env.VERITY_DESKTOP_KEY_HANDOFF_FILE;
  if (!file) {
    return absentCipher(
      'API keys are protected by the Verity desktop shell (OS keychain via safeStorage); '
      + 'this backend was started without the shell, so keys cannot be stored.',
    );
  }
  try {
    const handoff = readKeyHandoffFile(file);
    if (typeof handoff.dek === 'string') return createAesGcmCipher(handoff.dek);
    return absentCipher(handoff.reason ?? 'The desktop shell did not deliver credential protection.');
  } catch (error) {
    return absentCipher(`The desktop shell did not deliver credential protection (${error.message}); keys cannot be stored.`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { server } = startServer();
  server.on('listening', () => {
    console.log('Verity Desktop backend at http://127.0.0.1:' + server.address().port);
  });
}
