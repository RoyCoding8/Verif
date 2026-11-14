// End-to-end checks for the desktop backend contract. The backend runs as a
// real child process (`node desktop/server.mjs`), so restart tests observe a
// genuine cold boot of the durable store rather than surviving module state.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const serverEntry = join(here, 'server.mjs');
const goal = 'Repair reserve.mjs so zero stock cannot underflow.';
const promotedReserve =
  'export function reserve(stock, quantity) { return quantity >= 1 && quantity <= stock ? stock - quantity : stock; }\n';
const taskIds = ['reserve', 'messages', 'api'];

function freshDataDir() {
  return join(mkdtempSync(join(tmpdir(), 'verity-desktop-')), 'data');
}

async function startBackend(dataDir, envOverrides = {}) {
  const env = { ...process.env, VERITY_DESKTOP_DATA: dataDir, VERITY_DESKTOP_PORT: '0', ...envOverrides };
  for (const name of ['VERITY_COST_CEILING_USD', 'VERITY_APP_PROVIDER', 'VERITY_APP_MODEL',
    'VERITY_EVAL_PROVIDER', 'VERITY_EVAL_MODEL']) {
    if (!(name in envOverrides)) delete env[name];
  }
  const child = spawn(process.execPath, [serverEntry], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const port = await new Promise((resolvePort, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`backend did not start in 30s; stdout=${out} stderr=${stderr}`)), 30_000);
    child.stdout.on('data', chunk => {
      out += chunk;
      const match = out.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) { clearTimeout(timer); resolvePort(Number(match[1])); }
    });
    child.on('exit', code => {
      clearTimeout(timer);
      reject(new Error(`backend exited with code ${code} before listening; stdout=${out} stderr=${stderr}`));
    });
  });
  return {
    base: `http://127.0.0.1:${port}`,
    dataDir,
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise(resolveExit => child.once('exit', resolveExit));
      child.kill();
      await exited;
    },
  };
}

async function getJson(base, path) {
  const response = await fetch(base + path);
  return { status: response.status, body: await response.json() };
}

async function postJson(base, path, body) {
  const response = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function waitForThread(base, id, predicate, what = 'condition', timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    const { status, body } = await getJson(base, `/api/threads/${id}`);
    last = body;
    if (status === 200 && predicate(body)) return body;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}: ` + JSON.stringify(last));
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  }
}

async function openSse(base) {
  const controller = new AbortController();
  const response = await fetch(base + '/api/events', { signal: controller.signal });
  const events = [];
  (async () => {
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let index;
      while ((index = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const event = /(?:^|\n)event: ([^\n]+)/.exec(block)?.[1];
        const data = /(?:^|\n)data: ([^\n]+)/.exec(block)?.[1];
        if (event && data) events.push({ event, data: JSON.parse(data) });
      }
    }
  })().catch(() => {});
  return {
    events,
    async waitFor(predicate, what = 'event', timeoutMs = 30_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const found = events.find(predicate);
        if (found) return found;
        if (Date.now() > deadline) {
          throw new Error(`timed out waiting for ${what}; saw: ` +
            JSON.stringify(events.map(entry => [entry.event, entry.data?.id ?? null])));
        }
        await new Promise(resolveWait => setTimeout(resolveWait, 50));
      }
    },
    close() { controller.abort(); },
  };
}

const terminal = thread => thread.status === 'done' || thread.status === 'attention';
const messageRoles = new Set(['user', 'system', 'agent', 'result', 'error']);

describe('boot and task catalog', () => {
  const dataDir = freshDataDir();
  let backend;
  before(async () => { backend = await startBackend(dataDir); });
  after(async () => { await backend.stop(); });

  test('boot creates the data directory', () => {
    assert.ok(existsSync(dataDir), `expected ${dataDir} to be created on boot`);
  });

  test('GET /api/tasks lists reserve, messages, api and stays memoized', async () => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const { status, body } = await getJson(backend.base, '/api/tasks');
      assert.equal(status, 200);
      assert.deepEqual(body.tasks.map(task => task.id), taskIds);
      assert.deepEqual(body.tasks.find(task => task.id === 'reserve').dependencies, []);
      assert.deepEqual(body.tasks.find(task => task.id === 'api').dependencies, ['reserve', 'messages']);
    }
  });
});

describe('fixture run for the reserve task', () => {
  const dataDir = freshDataDir();
  let backend;
  let sse;
  before(async () => {
    backend = await startBackend(dataDir);
    sse = await openSse(backend.base);
  });
  after(async () => {
    sse.close();
    await backend.stop();
  });

  let created;
  test('POST /api/threads returns a queued ThreadSummary', async () => {
    await sse.waitFor(entry => entry.event === 'hello', 'hello');
    created = await postJson(backend.base, '/api/threads', { goal, taskId: 'reserve', mode: 'fixture' });
    assert.equal(created.status, 201);
    assert.equal(typeof created.body.id, 'string');
    assert.equal(created.body.title, goal);
    assert.equal(created.body.taskId, 'reserve');
    assert.equal(created.body.mode, 'fixture');
    assert.equal(created.body.status, 'queued');
    assert.equal(created.body.messages, 1);
  });

  test('the run completes: status done with a promoted result message and an advanced workspace head', async () => {
    const id = created.body.id;
    const running = await sse.waitFor(
      entry => entry.event === 'thread:update' && entry.data.id === id && entry.data.status === 'running',
      'running thread:update');
    const seedHead = running.data.workspace.head;
    assert.match(seedHead, /^[0-9a-f]{8}$/, 'seed head is 8-hex');
    await sse.waitFor(
      entry => entry.event === 'thread:created' && entry.data.id === id,
      'thread:created');

    const thread = await waitForThread(backend.base, id, terminal, 'run to finish');
    assert.equal(thread.status, 'done');
    assert.deepEqual(Object.keys(thread).sort(),
      ['createdAt', 'id', 'messages', 'mode', 'results', 'status', 'taskId', 'title', 'workspace']);
    assert.equal(thread.taskId, 'reserve');
    for (const message of thread.messages) {
      assert.ok(messageRoles.has(message.role), `unexpected message role ${message.role}`);
      assert.equal(typeof message.ts, 'number');
    }
    assert.equal(thread.messages[0].role, 'user');
    assert.equal(thread.messages[0].text, goal);

    const promoted = thread.messages.filter(message => message.role === 'result');
    assert.equal(promoted.length, 1);
    assert.deepEqual(Object.keys(promoted[0].data).sort(), ['detail', 'operation', 'status', 'task']);
    assert.equal(promoted[0].data.task, 'reserve');
    assert.equal(promoted[0].data.status, 'promoted');
    assert.equal(typeof promoted[0].data.operation, 'string');
    assert.ok(promoted[0].data.operation.length > 0);

    assert.deepEqual(Object.keys(thread.workspace).sort(), ['changed', 'files', 'head', 'host', 'ref']);
    assert.equal(thread.workspace.ref, 'refs/heads/protected');
    assert.equal(typeof thread.workspace.host, 'string');
    assert.match(thread.workspace.head, /^[0-9a-f]{8}$/);
    assert.notEqual(thread.workspace.head, seedHead, 'workspace head must advance past the seed');
    assert.ok(promoted[0].data.detail.startsWith(`Promoted as ${thread.workspace.head} ·`),
      'result detail names the promoted head');
    assert.ok(thread.workspace.files >= 3);
    assert.deepEqual(thread.workspace.changed, ['reserve.mjs']);

    assert.equal(thread.results.length, 1);
    assert.deepEqual(Object.keys(thread.results[0]).sort(), ['detail', 'operation', 'status', 'task']);
    assert.equal(thread.results[0].status, 'promoted');
    assert.equal(thread.results[0].operation, promoted[0].data.operation);

    await sse.waitFor(
      entry => entry.event === 'thread:update' && entry.data.id === id && entry.data.status === 'done',
      'done thread:update');
  });

  test('GET /api/threads/:id/file returns the promoted file from the protected head', async () => {
    const { status, body } = await getJson(backend.base, `/api/threads/${created.body.id}/file?path=reserve.mjs`);
    assert.equal(status, 200);
    assert.equal(body.path, 'reserve.mjs');
    assert.equal(body.content, promotedReserve);
  });

  test('the file endpoint rejects path traversal, git metadata, and unknown lookups', async () => {
    const id = created.body.id;
    const traversal = [
      '../../.git/config',
      '..%2F..%2F.git%2Fconfig',
      encodeURIComponent('../../.git/config'),
      '.git/config',
      '/etc/passwd',
      'reserve.mjs/../../.git/config',
      '..',
    ];
    for (const path of traversal) {
      const { status, body } = await getJson(backend.base, `/api/threads/${id}/file?path=${path}`);
      assert.equal(status, 400, `expected rejection for ${path}`);
      assert.equal(body.error, 'invalid path');
    }
    const missingFile = await getJson(backend.base, `/api/threads/${id}/file?path=ghost.mjs`);
    assert.equal(missingFile.status, 404);
    const unknownThread = await getJson(backend.base, '/api/threads/no-such-thread/file?path=reserve.mjs');
    assert.equal(unknownThread.status, 404);
  });
});

describe('pi mode without an approved cost ceiling', () => {
  const dataDir = freshDataDir();
  let backend;
  before(async () => {
    backend = await startBackend(dataDir, { VERITY_APP_PROVIDER: 'test-provider', VERITY_APP_MODEL: 'test-model' });
  });
  after(async () => { await backend.stop(); });

  test('GET /api/state reports Pi as not ready without VERITY_COST_CEILING_USD', async () => {
    const { status, body } = await getJson(backend.base, '/api/state');
    assert.equal(status, 200);
    assert.deepEqual(Object.keys(body).sort(), ['hostname', 'pi', 'threads']);
    assert.equal(typeof body.hostname, 'string');
    assert.deepEqual(body.threads, []);
    assert.equal(body.pi.ready, false);
    assert.match(body.pi.reason, /VERITY_COST_CEILING_USD/);
  });

  test('a pi run is refused and the thread ends with an error message', async () => {
    const created = await postJson(backend.base, '/api/threads', { goal, taskId: 'reserve', mode: 'pi' });
    assert.equal(created.status, 201);
    assert.equal(created.body.mode, 'pi');
    const thread = await waitForThread(backend.base, created.body.id, terminal, 'pi refusal');
    assert.equal(thread.status, 'attention');
    assert.equal(thread.results, undefined);
    const errors = thread.messages.filter(message => message.role === 'error');
    assert.ok(errors.length >= 1, 'expected an error message');
    assert.ok(errors.some(message => /VERITY_COST_CEILING_USD/.test(message.text ?? '')),
      'error message must name VERITY_COST_CEILING_USD');
    assert.ok(!thread.messages.some(message => message.role === 'result'));
  });
});

describe('backend restart', () => {
  const dataDir = freshDataDir();
  let first;
  let second;
  let beforeRestart;
  before(async () => {
    first = await startBackend(dataDir);
    const created = await postJson(first.base, '/api/threads', { goal, taskId: 'reserve', mode: 'fixture' });
    assert.equal(created.status, 201);
    beforeRestart = await waitForThread(first.base, created.body.id, terminal, 'run to finish');
    assert.equal(beforeRestart.status, 'done');
  });
  after(async () => {
    await second?.stop();
    await first.stop();
  });

  test('threads and their workspace state survive a restart on a new port', async () => {
    await first.stop();
    second = await startBackend(dataDir);

    const state = await getJson(second.base, '/api/state');
    assert.equal(state.status, 200);
    const summary = state.body.threads.find(thread => thread.id === beforeRestart.id);
    assert.ok(summary, 'thread summary must survive the restart');
    assert.equal(summary.title, goal);
    assert.equal(summary.taskId, 'reserve');
    assert.equal(summary.mode, 'fixture');
    assert.equal(summary.status, 'done');

    const { status, body } = await getJson(second.base, `/api/threads/${beforeRestart.id}`);
    assert.equal(status, 200);
    assert.equal(body.status, 'done');
    assert.deepEqual(body.workspace, beforeRestart.workspace, 'settings must round-trip across restarts');
    assert.deepEqual(body.workspace.changed, ['reserve.mjs']);
    assert.equal(body.results.length, 1);
    assert.equal(body.results[0].status, 'promoted');

    const file = await getJson(second.base, `/api/threads/${beforeRestart.id}/file?path=reserve.mjs`);
    assert.equal(file.status, 200);
    assert.equal(file.body.content, promotedReserve);
  });

  test('the task catalog survives a restart', async () => {
    const { status, body } = await getJson(second.base, '/api/tasks');
    assert.equal(status, 200);
    assert.deepEqual(body.tasks.map(task => task.id), taskIds);
  });
});
