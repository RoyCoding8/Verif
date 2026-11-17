// End-to-end checks for the settings API and startup recovery. The backend
// runs as a real child process (`node desktop/server.mjs`), headless, so
// credential storage is genuinely unavailable here and secret persistence
// must fail clearly while preserving prior settings. Named scenarios carry
// expected verdicts: fail-before/pass-after for catalog recovery, and
// contract shapes for the shared Data/API contract with the UI.

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const serverEntry = join(here, 'server.mjs');

function freshDataDir() {
  const dir = join(mkdtempSync(join(tmpdir(), 'verity-settings-')), 'data');
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function startBackend(dataDir, envOverrides = {}) {
  const env = { ...process.env, VERITY_DESKTOP_DATA: dataDir, VERITY_DESKTOP_PORT: '0', ...envOverrides };
  for (const name of ['VERITY_COST_CEILING_USD', 'VERITY_APP_PROVIDER', 'VERITY_APP_MODEL',
    'VERITY_EVAL_PROVIDER', 'VERITY_EVAL_MODEL', 'VERITY_DESKTOP_KEY_HANDOFF_FD',
    'VERITY_DESKTOP_LEGACY_DATA']) {
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

async function sendJson(base, method, path, body, headers = {}) {
  const response = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let parsed;
  try { parsed = await response.json(); } catch { parsed = null; }
  return { status: response.status, body: parsed };
}

const putJson = (base, body, headers) => sendJson(base, 'PUT', '/api/settings', body, headers);

describe('GET /api/settings contract shape', () => {
  const dataDir = freshDataDir();
  let backend;
  before(async () => { backend = await startBackend(dataDir); });
  after(async () => { await backend.stop(); });

  test('the response carries exactly the shared contract fields', async () => {
    const { status, body } = await getJson(backend.base, '/api/settings');
    assert.equal(status, 200);
    assert.deepEqual(Object.keys(body).sort(),
      ['costCeilingUsd', 'credentialStorage', 'defaultProviderId', 'providers']);
    assert.deepEqual(body.providers, []);
    assert.equal(body.defaultProviderId, null);
    assert.equal(body.costCeilingUsd, null);
    // Headless: no desktop shell delivered credential protection, and the
    // backend says so instead of pretending.
    assert.deepEqual(Object.keys(body.credentialStorage).sort(), ['available', 'reason']);
    assert.equal(body.credentialStorage.available, false);
    assert.equal(typeof body.credentialStorage.reason, 'string');
  });
});

describe('PUT /api/settings validation and redaction', () => {
  const dataDir = freshDataDir();
  let backend;
  let initial;
  before(async () => {
    backend = await startBackend(dataDir);
    initial = (await getJson(backend.base, '/api/settings')).body;
  });
  after(async () => { await backend.stop(); });

  const invalidCases = [
    ['missing providers array', { defaultProviderId: null, costCeilingUsd: null }],
    ['providers not an array', { providers: 'nope', defaultProviderId: null, costCeilingUsd: null }],
    ['invalid protocol', { providers: [{ id: 'p1', label: 'P1', protocol: 'chat', baseUrl: 'https://api.example.com/v1', modelId: 'm1' }], defaultProviderId: null, costCeilingUsd: null }],
    ['dangling default reference', { providers: [{ id: 'p1', label: 'P1', protocol: 'openai-completions', baseUrl: 'https://api.example.com/v1', modelId: 'm1' }], defaultProviderId: 'ghost', costCeilingUsd: null }],
    ['non-URL baseUrl', { providers: [{ id: 'p1', label: 'P1', protocol: 'openai-completions', baseUrl: 'not-a-url', modelId: 'm1' }], defaultProviderId: null, costCeilingUsd: null }],
    ['non-http scheme', { providers: [{ id: 'p1', label: 'P1', protocol: 'openai-completions', baseUrl: 'ftp://api.example.com', modelId: 'm1' }], defaultProviderId: null, costCeilingUsd: null }],
    ['zero ceiling', { providers: [], defaultProviderId: null, costCeilingUsd: 0 }],
    ['negative ceiling', { providers: [], defaultProviderId: null, costCeilingUsd: -5 }],
    ['non-numeric ceiling', { providers: [], defaultProviderId: null, costCeilingUsd: 'ten' }],
    ['duplicate provider ids', { providers: [{ id: 'dup', label: 'A', protocol: 'openai-completions', baseUrl: 'https://a.example.com', modelId: 'm' }, { id: 'dup', label: 'B', protocol: 'openai-completions', baseUrl: 'https://b.example.com', modelId: 'm' }], defaultProviderId: null, costCeilingUsd: null }],
    ['bad provider id', { providers: [{ id: '../escape', label: 'P', protocol: 'openai-completions', baseUrl: 'https://a.example.com', modelId: 'm' }], defaultProviderId: null, costCeilingUsd: null }],
    ['empty modelId', { providers: [{ id: 'p1', label: 'P1', protocol: 'openai-completions', baseUrl: 'https://a.example.com', modelId: '' }], defaultProviderId: null, costCeilingUsd: null }],
    ['apiKey of the wrong type', { providers: [{ id: 'p1', label: 'P1', protocol: 'openai-completions', baseUrl: 'https://a.example.com', modelId: 'm', apiKey: 42 }], defaultProviderId: null, costCeilingUsd: null }],
  ];

  test('each invalid input returns 400 {error} and preserves prior settings', async () => {
    for (const [name, payload] of invalidCases) {
      const rejected = await putJson(backend.base, payload);
      assert.equal(rejected.status, 400, `${name}: expected 400`);
      assert.equal(typeof rejected.body.error, 'string', `${name}: expected an error message`);
      assert.ok(!JSON.stringify(rejected.body).includes(JSON.stringify(payload?.providers?.[0]?.apiKey ?? '')),
        `${name}: error must not echo submitted key material`);
      const after = (await getJson(backend.base, '/api/settings')).body;
      assert.deepEqual(after, initial, `${name}: settings must be unchanged`);
    }
  });

  test('malformed JSON returns 400 and the backend stays alive', async () => {
    const response = await fetch(backend.base + '/api/settings', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{',
    });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(typeof body.error, 'string');
    const alive = await getJson(backend.base, '/api/state');
    assert.equal(alive.status, 200);
  });

  test('a valid provider without a key is accepted and no key field is stored', async () => {
    const accepted = await putJson(backend.base, {
      providers: [{ id: 'p1', label: 'Provider One', protocol: 'openai-completions', baseUrl: 'https://api.example.com/v1', modelId: 'model-1' }],
      defaultProviderId: 'p1',
      costCeilingUsd: 1.5,
    });
    assert.equal(accepted.status, 200);
    assert.deepEqual(Object.keys(accepted.body.providers[0]).sort(),
      ['baseUrl', 'hasApiKey', 'id', 'label', 'modelId', 'protocol']);
    assert.equal(accepted.body.providers[0].hasApiKey, false);
    assert.equal(accepted.body.defaultProviderId, 'p1');
    assert.equal(accepted.body.costCeilingUsd, 1.5);
    assert.ok(accepted.body.credentialStorage.available === false);
    const onDisk = readFileSync(join(dataDir, 'settings.json'), 'utf8');
    assert.ok(!onDisk.includes('apiKey'), 'settings.json must never contain key material');
  });

  test('secret persistence fails clearly when protection is unavailable, preserving prior settings', async () => {
    const before = (await getJson(backend.base, '/api/settings')).body;
    const settingsBefore = readFileSync(join(dataDir, 'settings.json'), 'utf8');
    const rejected = await putJson(backend.base, {
      providers: [{ id: 'p1', label: 'Provider One', protocol: 'openai-completions', baseUrl: 'https://api.example.com/v1', modelId: 'model-1', apiKey: 'sk-secret-value-1' }],
      defaultProviderId: 'p1',
      costCeilingUsd: 1.5,
    });
    assert.equal(rejected.status, 503);
    assert.match(rejected.body.error, /credential storage is unavailable/);
    const after = (await getJson(backend.base, '/api/settings')).body;
    assert.deepEqual(after, before, 'a failed secret save must preserve previous settings');
    assert.equal(readFileSync(join(dataDir, 'settings.json'), 'utf8'), settingsBefore);
    assert.ok(!existsSync(join(dataDir, 'credentials.vault.json')), 'no vault file is created by a refused write');
  });

  test('an oversized settings body is refused with 413', async () => {
    const response = await fetch(backend.base + '/api/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ providers: [{ id: 'p1', label: 'x'.repeat(2 * 1024 * 1024), protocol: 'openai-completions', baseUrl: 'https://a.example.com', modelId: 'm' }], defaultProviderId: null, costCeilingUsd: null }),
    });
    assert.equal(response.status, 413);
  });

  test('cross-origin writes are refused and create nothing', async () => {
    const rejectedOrigin = await putJson(backend.base,
      { providers: [], defaultProviderId: null, costCeilingUsd: null },
      { origin: 'http://evil.example' });
    assert.equal(rejectedOrigin.status, 403);
    const spoofedHost = await new Promise((resolveSpoof, rejectSpoof) => {
      const url = new URL(backend.base);
      const request = http.request({
        hostname: url.hostname, port: url.port, path: '/api/settings', method: 'PUT',
        headers: { 'content-type': 'application/json', host: 'evil.example' },
      }, response => {
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('end', () => resolveSpoof({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') }));
      });
      request.on('error', rejectSpoof);
      request.end('{}');
    });
    assert.equal(spoofedHost.status, 403);
    const thread = await sendJson(backend.base, 'POST', '/api/threads',
      { goal: 'x', mode: 'fixture' }, { origin: 'http://evil.example' });
    assert.equal(thread.status, 403);
    const state = await getJson(backend.base, '/api/state');
    assert.deepEqual(state.body.threads, []);
  });
});

describe('catalog recovery and retry (fail-before/pass-after)', () => {
  const dataDir = freshDataDir();
  let backend;
  before(async () => { backend = await startBackend(dataDir); });
  after(async () => { backend && await backend.stop(); });

  test('fail-before: an unusable cache file fails the first catalog request', async () => {
    // A partially created catalog: the cache path exists but is unusable
    // (a directory). The build itself cannot complete either.
    mkdirSync(join(dataDir, 'task-catalog', 'settings.json'), { recursive: true });
    const first = await getJson(backend.base, '/api/tasks');
    assert.equal(first.status, 500, 'the poisoned first attempt must fail, not silently pass');
  });

  test('pass-after: repairing the transient failure is retried in the same process', async () => {
    rmSync(join(dataDir, 'task-catalog', 'settings.json'), { recursive: true, force: true });
    const second = await getJson(backend.base, '/api/tasks');
    assert.equal(second.status, 200, 'a repaired condition must be retried, not remembered as failed');
    assert.deepEqual(second.body.tasks.map(task => task.id), ['reserve', 'messages', 'api']);
  });

  test('existing catalog files are preserved, not destroyed, by recovery', async () => {
    writeFileSync(join(dataDir, 'task-catalog', 'keepme.txt'), 'user data');
    rmSync(join(dataDir, 'task-catalog', 'settings.json'), { force: true });
    const { status } = await getJson(backend.base, '/api/tasks');
    assert.equal(status, 200);
    assert.equal(readFileSync(join(dataDir, 'task-catalog', 'keepme.txt'), 'utf8'), 'user data',
      'recovery must not delete pre-existing catalog content');
  });

  test('a partial workspace without a cache builds fresh and preserves the workspace', async () => {
    const partial = freshDataDir();
    const other = await startBackend(partial);
    try {
      mkdirSync(join(partial, 'task-catalog', 'workspace'), { recursive: true });
      writeFileSync(join(partial, 'task-catalog', 'workspace', 'keepme.txt'), 'kept');
      const { status, body } = await getJson(other.base, '/api/tasks');
      assert.equal(status, 200);
      assert.ok(body.tasks.length >= 3);
      assert.equal(readFileSync(join(partial, 'task-catalog', 'workspace', 'keepme.txt'), 'utf8'), 'kept');
      assert.ok(existsSync(join(partial, 'task-catalog', 'settings.json')), 'the cache is written atomically on success');
    } finally {
      await other.stop();
    }
  });
});

describe('user data migration and damaged stores', () => {
  test('saved settings round trip across a backend restart', async () => {
    const dataDir = freshDataDir();
    const first = await startBackend(dataDir);
    const saved = await putJson(first.base, {
      providers: [{ id: 'p1', label: 'Provider One', protocol: 'openai-responses', baseUrl: 'https://api.example.com/v1', modelId: 'model-1' }],
      defaultProviderId: 'p1',
      costCeilingUsd: 3,
    });
    assert.equal(saved.status, 200);
    await first.stop();

    const second = await startBackend(dataDir);
    try {
      const view = (await getJson(second.base, '/api/settings')).body;
      assert.deepEqual(view.providers.map(({ hasApiKey, ...rest }) => rest),
        [{ id: 'p1', label: 'Provider One', protocol: 'openai-responses', baseUrl: 'https://api.example.com/v1', modelId: 'model-1' }]);
      assert.equal(view.defaultProviderId, 'p1');
      assert.equal(view.costCeilingUsd, 3);
    } finally {
      await second.stop();
    }
  });

  test('legacy data is copied conservatively and the source is never touched', async () => {
    const dataDir = freshDataDir();
    const legacyDir = freshDataDir();
    const legacyThread = {
      id: 'legacy1', title: 'Legacy task', taskId: 'reserve', mode: 'fixture',
      status: 'done', createdAt: 1, messages: [],
    };
    writeFileSync(join(legacyDir, 'threads.json'), JSON.stringify([legacyThread]));
    mkdirSync(join(legacyDir, 'threads'), { recursive: true });
    mkdirSync(join(legacyDir, 'task-catalog'), { recursive: true });
    writeFileSync(join(legacyDir, 'task-catalog', 'settings.json'),
      JSON.stringify({ tasks: [{ id: 'reserve', goal: 'g', dependencies: [] }] }));
    const legacyBefore = readdirSync(legacyDir).sort().join(',');

    const backend = await startBackend(dataDir, { VERITY_DESKTOP_LEGACY_DATA: legacyDir });
    try {
      const state = await getJson(backend.base, '/api/state');
      assert.equal(state.status, 200);
      const summary = state.body.threads.find(thread => thread.id === 'legacy1');
      assert.ok(summary, 'the migrated thread must be served from the new data dir');
      const tasks = await getJson(backend.base, '/api/tasks');
      assert.equal(tasks.status, 200);
      assert.deepEqual(tasks.body.tasks.map(task => task.id), ['reserve'],
        'a migrated catalog cache is honored');
      assert.equal(readdirSync(legacyDir).sort().join(','), legacyBefore,
        'the legacy directory must be left exactly as it was');
      assert.equal(readFileSync(join(legacyDir, 'threads.json'), 'utf8'),
        JSON.stringify([legacyThread]));
    } finally {
      await backend.stop();
    }
  });

  test('a corrupt thread store parks the bytes and boots empty', async () => {
    const dataDir = freshDataDir();
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'threads.json'), '{corrupt');
    const backend = await startBackend(dataDir);
    try {
      const state = await getJson(backend.base, '/api/state');
      assert.equal(state.status, 200);
      assert.deepEqual(state.body.threads, []);
      const parked = readdirSync(dataDir).filter(name => name.startsWith('threads.json.corrupt-'));
      assert.equal(parked.length, 1, 'the corrupt bytes are kept beside the store');
      assert.equal(readFileSync(join(dataDir, parked[0]), 'utf8'), '{corrupt');
    } finally {
      await backend.stop();
    }
  });
});
