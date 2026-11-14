// Verity Desktop — local backend.
//
// Serves the harness UI and drives the real controller: each thread is an
// isolated demo workspace (its own repository and journal), runs go through
// runTasks, and every message the chat shows is produced by the run itself.
// Fixture mode runs offline; Pi mode runs the real Pi agent loop and is
// refused without an approved dollar ceiling.

import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createDemo, fixtureWorker } from '../examples/setup.mjs';
import { costCeilingMicros } from '../src/cost-ceiling.mjs';
import { GitRepo } from '../src/git.mjs';
import { runTasks } from '../src/verity.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = join(here, 'public');
const dataDir = process.env.VERITY_DESKTOP_DATA ?? join(here, '.data');
const threadsFile = join(dataDir, 'threads.json');
const protectedRef = 'refs/heads/protected';

// ---------- durable thread store ----------

const threads = new Map();
const listeners = new Set();

function persist() {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(threadsFile, JSON.stringify([...threads.values()], null, 2));
}

function loadThreads() {
  if (!existsSync(threadsFile)) return;
  for (const thread of JSON.parse(readFileSync(threadsFile, 'utf8'))) threads.set(thread.id, thread);
}

function emit(event, data) {
  for (const send of listeners) send(event, data);
}

function threadSummary(thread) {
  const { id, title, taskId, mode, status, createdAt, messages } = thread;
  return { id, title, taskId, mode, status, createdAt, messages: messages.length };
}

function fullThread(thread) {
  return { ...thread, ...workspaceState(thread) };
}

// ---------- per-thread workspace ----------

async function ensureWorkspace(thread) {
  const workspace = join(dataDir, 'threads', thread.id, 'workspace');
  await mkdir(workspace, { recursive: true });
  thread.settings = await createDemo(workspace);
  thread.workspace = workspace;
  persist();
  return thread.settings;
}

async function taskCatalog() {
  const root = join(dataDir, 'task-catalog', 'workspace');
  await mkdir(root, { recursive: true });
  return createDemo(root);
}

function workspaceState(thread) {
  if (!thread.settings) return {};
  const repo = new GitRepo(thread.settings.repository);
  const head = repo.readRef(protectedRef);
  const run = thread.results ?? [];
  const changed = new Set();
  for (const result of run) {
    if (result.commit && result.base) for (const file of repo.changedPaths(result.base, result.commit)) changed.add(file);
    else if (result.commit) for (const file of repo.changedPaths(thread.seed, result.commit)) changed.add(file);
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

async function piRoute() {
  const provider = process.env.VERITY_APP_PROVIDER ?? process.env.VERITY_EVAL_PROVIDER;
  const model = process.env.VERITY_APP_MODEL ?? process.env.VERITY_EVAL_MODEL;
  const ceilingUsd = Number(process.env.VERITY_COST_CEILING_USD);
  if (!provider || !model) return { ready: false, reason: 'Set VERITY_APP_PROVIDER and VERITY_APP_MODEL to the exact Pi model ID' };
  if (!Number.isFinite(ceilingUsd) || ceilingUsd <= 0) {
    return { ready: false, reason: 'Pi runs are refused without an approved dollar ceiling in VERITY_COST_CEILING_USD' };
  }
  try {
    const { ModelRuntime } = await import('@earendil-works/pi-coding-agent');
    const runtime = await ModelRuntime.create({ allowModelNetwork: true, modelRefreshTimeoutMs: 20_000 });
    const entry = runtime.getModel(provider, model);
    if (!entry) return { ready: false, reason: `Model ${provider}/${model} is absent from the Pi catalog` };
    if (!runtime.hasConfiguredAuth(provider)) return { ready: false, reason: `Provider ${provider} has no configured credentials` };
    return { ready: true, provider, model, ceilingUsd };
  } catch (error) {
    return { ready: false, reason: error.message };
  }
}

// ---------- runs ----------

const terminal = new Set(['promoted', 'refused', 'blocked']);

async function startRun(thread) {
  const mode = thread.mode;
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
      const { ModelRuntime } = await import('@earendil-works/pi-coding-agent');
      const runtime = await ModelRuntime.create({ allowModelNetwork: true, modelRefreshTimeoutMs: 20_000 });
      const model = runtime.getModel(route.provider, route.model);
      worker = job => runPiWorker({ ...job, model, modelRuntime: runtime });
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
      const detail = result.status === 'promoted'
        ? `Promoted as ${result.commit?.slice(0, 8)} · assurance ${JSON.stringify(result.assurance)}`
        : result.reason ?? result.status;
      thread.messages.push({
        role: 'result',
        ts: Date.now(),
        data: { task: result.id, status: result.status, detail, operation: result.operation ?? null },
      });
    }
    thread.status = results.every(result => result.status === 'promoted') ? 'done' : 'attention';
  } catch (error) {
    thread.status = 'attention';
    thread.messages.push({ role: 'error', text: error.message, ts: Date.now() });
  }
  persist();
  emit('thread:update', fullThread(thread));
}

// ---------- http api ----------

function json(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

function readBody(request) {
  return new Promise((resolveBody, reject) => {
    let data = '';
    request.on('data', chunk => { data += chunk; });
    request.on('end', () => resolveBody(data ? JSON.parse(data) : {}));
    request.on('error', reject);
  });
}

const mime = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml' };

let catalogPromise;

async function handle(request, response) {
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
      pi: await piRoute(),
    });
  }

  if (path === '/api/tasks' && request.method === 'GET') {
    // The demo project template: one workspace is materialized per thread,
    // so task definitions come from a single scratch materialization.
    catalogPromise ??= taskCatalog();
    const settings = await catalogPromise;
    return json(response, 200, {
      tasks: settings.tasks.map(task => ({ id: task.id, goal: task.goal, dependencies: task.dependencies })),
    });
  }

  if (path === '/api/threads' && request.method === 'POST') {
    const { goal, taskId, mode } = await readBody(request);
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
    emit('thread:created', threadSummary(thread));
    persist();
    const settings = await ensureWorkspace(thread);
    thread.seed = new GitRepo(settings.repository).readRef(protectedRef);
    void startRun(thread);
    return json(response, 201, threadSummary(thread));
  }

  const threadMatch = path.match(/^\/api\/threads\/([^/]+)$/);
  if (threadMatch && request.method === 'GET') {
    const thread = threads.get(threadMatch[1]);
    return thread ? json(response, 200, fullThread(thread)) : json(response, 404, { error: 'unknown thread' });
  }

  const fileMatch = path.match(/^\/api\/threads\/([^/]+)\/file$/);
  if (fileMatch && request.method === 'GET') {
    const thread = threads.get(fileMatch[1]);
    const file = url.searchParams.get('path');
    if (!thread?.settings || !file) return json(response, 400, { error: 'path required' });
    const repo = new GitRepo(thread.settings.repository);
    const head = repo.readRef(protectedRef);
    const text = execFileSync('git', ['-C', thread.settings.repository, 'show', `${head}:${file}`],
      { encoding: 'utf8', windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
    return json(response, 200, { path: file, content: text });
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

export function startServer(port = Number(process.env.VERITY_DESKTOP_PORT ?? 47812)) {
  loadThreads();
  mkdirSync(dataDir, { recursive: true });
  const server = createServer((request, response) => {
    handle(request, response).catch(error => json(response, 500, { error: error.message }));
  });
  server.listen(port, '127.0.0.1');
  return { server, port, url: `http://127.0.0.1:${port}` };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { url } = startServer();
  console.log('Verity Desktop backend at ' + url);
}
