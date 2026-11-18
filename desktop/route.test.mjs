// In-process checks for the saved provider route: credential blob semantics
// at the vault boundary, readiness and run routing through the selected
// Settings configuration on the pinned Pi SDK, and no key material anywhere
// on the wire, on disk, or in error messages. All providers here are fake
// and all endpoints are loopback; no live provider or network discovery is
// involved.

const { mkdtempSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join, dirname } = await import('node:path');
const { fileURLToPath } = await import('node:url');

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(mkdtempSync(join(tmpdir(), 'verity-route-')), 'data');
process.env.VERITY_DESKTOP_DATA = dataDir;
// Isolate from the host environment: the saved route must win over env vars.
for (const name of ['VERITY_APP_PROVIDER', 'VERITY_APP_MODEL', 'VERITY_EVAL_PROVIDER',
  'VERITY_EVAL_MODEL', 'VERITY_COST_CEILING_USD', 'VERITY_DESKTOP_PORT',
  'VERITY_DESKTOP_KEY_HANDOFF_FD', 'VERITY_DESKTOP_LEGACY_DATA']) {
  delete process.env[name];
}
process.env.VERITY_APP_PROVIDER = 'env-provider';
process.env.VERITY_APP_MODEL = 'env-model';

const { test, before, after } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const { existsSync, readFileSync } = await import('node:fs');
const { createAesGcmCipher } = await import('./keyhandoff.mjs');
const { createSavedRouteRuntime } = await import('./route.mjs');
const { startServer } = await import('./server.mjs');

const KEY = 'sk-test-key-abcdef0123456789';
const KEY2 = 'sk-test-key-updated-99887766';

// Test-owned cipher so single failure modes can be triggered per request.
const aes = createAesGcmCipher('77'.repeat(32));
const cipher = {
  available: true,
  failNext: false,
  corruptRead: false,
  async encrypt(plain) {
    if (this.failNext) throw new Error('simulated secret-save failure');
    return aes.encrypt(plain);
  },
  async decrypt(blob) {
    if (this.corruptRead) throw new Error('simulated unreadable key');
    return aes.decrypt(blob);
  },
};

const { server } = startServer(0, { cipher });
await new Promise(done => server.on('listening', done));
const base = `http://127.0.0.1:${server.address().port}`;

async function getJson(path) {
  const response = await fetch(base + path);
  return { status: response.status, body: await response.json() };
}

async function putSettings(body) {
  const response = await fetch(base + '/api/settings', {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

const provider = (id, protocol, overrides = {}) => ({
  id, label: `Label ${id}`, protocol, baseUrl: 'http://127.0.0.1:9/v1', modelId: `m-${id}`, ...overrides,
});
const settingsBody = (providers, defaultProviderId, costCeilingUsd = 2) =>
  ({ providers, defaultProviderId, costCeilingUsd });
const storeFile = join(dataDir, 'settings.json');
const blob = () => JSON.parse(readFileSync(storeFile, 'utf8')).credentials;

after(() => new Promise(done => server.close(() => done())));

test('three SDK protocols register from saved settings, and no key material leaks', async () => {
  const protocols = ['openai-completions', 'openai-responses', 'anthropic-messages'];
  const providers = protocols.map((protocol, index) => provider(`fake-${index}`, protocol, { apiKey: KEY }));
  const accepted = await putSettings(settingsBody(providers, 'fake-0'));
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.providers[0].hasApiKey, true);
  assert.ok(!JSON.stringify(accepted.body).includes(KEY), 'the settings view must not echo the key');
  for (const file of ['settings.json']) {
    assert.ok(!readFileSync(join(dataDir, file), 'utf8').includes(KEY), `${file} must not contain plaintext key material`);
  }

  const state = await getJson('/api/state');
  assert.equal(state.status, 200);
  assert.equal(state.body.pi.ready, true, 'the saved route is ready with no env setup');
  assert.equal(state.body.pi.provider, 'fake-0');
  assert.equal(state.body.pi.model, 'm-fake-0');
  assert.equal(state.body.pi.ceilingUsd, 2);
  assert.ok(!JSON.stringify(state.body.pi).includes(KEY));

  // Every registered protocol resolves through the saved configuration.
  for (const [index, protocol] of protocols.entries()) {
    const saved = {
      id: `fake-${index}`, label: `Label fake-${index}`, protocol,
      baseUrl: 'http://127.0.0.1:9/v1', modelId: `m-fake-${index}`, apiKey: KEY,
    };
    const { model } = await createSavedRouteRuntime(saved);
    assert.equal(model.api, protocol, `${protocol} must register as its exact SDK protocol`);
    assert.equal(model.baseUrl, 'http://127.0.0.1:9/v1');
    assert.equal(model.id, `m-fake-${index}`);
  }
});

test('a run uses the selected configuration and fails actionably without leaking the key', async () => {
  const created = await fetch(base + '/api/threads', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ goal: 'Try the fake provider.', taskId: 'reserve', mode: 'pi' }),
  });
  assert.equal(created.status, 201);
  const id = (await created.json()).id;
  const deadline = Date.now() + 120_000;
  let thread;
  for (;;) {
    thread = (await getJson(`/api/threads/${id}`)).body;
    if (thread.status === 'done' || thread.status === 'attention') break;
    assert.ok(Date.now() < deadline, 'the run must terminate');
    await new Promise(done => setTimeout(done, 200));
  }
  assert.equal(thread.status, 'attention');
  const text = JSON.stringify(thread.messages);
  assert.match(text, /Model request failed for fake-0\/m-fake-0/,
    'the failure names the saved provider and model');
  assert.match(text, /127\.0\.0\.1:9/, 'the failure names the configured endpoint');
  assert.ok(!text.includes(KEY), 'run errors must never contain the key');
  assert.equal(thread.results.length, 1);
  assert.equal(thread.results[0].status, 'refused');
  assert.ok(!JSON.stringify(thread.results).includes(KEY));
});

test('an omitted or empty apiKey preserves the stored blob, a new key replaces it', async () => {
  const before = blob()['fake-0'];
  await putSettings(settingsBody([provider('fake-0', 'openai-completions')], 'fake-0'));
  assert.equal(blob()['fake-0'], before, 'omitting apiKey preserves the stored credential');
  await putSettings(settingsBody([provider('fake-0', 'openai-completions', { apiKey: '' })], 'fake-0'));
  assert.equal(blob()['fake-0'], before, 'an empty apiKey preserves the stored credential');
  await putSettings(settingsBody([provider('fake-0', 'openai-completions', { apiKey: KEY2 })], 'fake-0'));
  assert.notEqual(blob()['fake-0'], before, 'a new key replaces the stored credential');
  assert.ok(!readFileSync(storeFile, 'utf8').includes(KEY2));
});

test('deleting an entry removes its stored credential', async () => {
  await putSettings(settingsBody([provider('fake-1', 'openai-responses', { apiKey: KEY })], null));
  assert.ok(blob()['fake-1']);
  await putSettings(settingsBody([provider('fake-0', 'openai-completions', { apiKey: KEY })], null));
  assert.equal(blob()['fake-1'], undefined, 'removed provider keys are deleted');
});

test('a failed secret save preserves previous settings and keys', async () => {
  const viewBefore = (await getJson('/api/settings')).body;
  const storeBefore = readFileSync(storeFile, 'utf8');
  cipher.failNext = true;
  const rejected = await putSettings(settingsBody(
    [provider('fake-0', 'openai-completions', { apiKey: KEY }), provider('new-prov', 'anthropic-messages', { apiKey: KEY })],
    'fake-0',
  ));
  assert.equal(rejected.status, 503);
  assert.match(rejected.body.error, /simulated secret-save failure/);
  cipher.failNext = false;
  assert.deepEqual((await getJson('/api/settings')).body, viewBefore, 'settings are preserved');
  assert.equal(readFileSync(storeFile, 'utf8'), storeBefore,
    'the durable record is untouched by a failed secret save');
});

test('invalid input returns 400 and preserves prior settings', async () => {
  const viewBefore = (await getJson('/api/settings')).body;
  const cases = [
    settingsBody([provider('bad', 'chat')], null),
    settingsBody([provider('bad', 'openai-completions')], 'ghost'),
    settingsBody([provider('bad', 'openai-completions', { baseUrl: 'nope' })], null),
    settingsBody([], null, 0),
    settingsBody([], null, -1),
  ];
  for (const payload of cases) {
    const rejected = await putSettings(payload);
    assert.equal(rejected.status, 400);
    assert.equal(typeof rejected.body.error, 'string');
  }
  assert.deepEqual((await getJson('/api/settings')).body, viewBefore);
});

test('readiness follows the saved provider, ceiling, and key state', async () => {
  // No ceiling: not ready, naming the ceiling.
  const noCeiling = await putSettings(settingsBody([provider('fake-0', 'openai-completions', { apiKey: KEY })], 'fake-0', null));
  assert.equal(noCeiling.status, 200);
  assert.equal((await getJson('/api/state')).body.pi.ready, false);
  assert.match((await getJson('/api/state')).body.pi.reason, /ceiling/i);
  // Keyless provider: not ready, naming the key.
  await putSettings(settingsBody([provider('keyless', 'openai-completions')], 'keyless'));
  const keyless = (await getJson('/api/state')).body.pi;
  assert.equal(keyless.ready, false);
  assert.match(keyless.reason, /Add an API key for keyless/);
  // Unreadable stored key: not ready, asking to re-enter.
  cipher.corruptRead = true;
  await putSettings(settingsBody([provider('fake-0', 'openai-completions', { apiKey: KEY })], 'fake-0'));
  const unreadable = (await getJson('/api/state')).body.pi;
  assert.equal(unreadable.ready, false);
  assert.match(unreadable.reason, /could not be read; re-enter it in Settings/);
  assert.ok(!unreadable.reason.includes(KEY));
  cipher.corruptRead = false;
  // Restored: ready, and the saved route beat the env fallback.
  const ready = (await getJson('/api/state')).body.pi;
  assert.equal(ready.ready, true);
  assert.equal(ready.provider, 'fake-0');
});

test('with nothing saved, the env fallback still drives readiness', async () => {
  await putSettings({ providers: [], defaultProviderId: null, costCeilingUsd: null });
  // Env provider/model without a ceiling: the ceiling refusal comes first.
  assert.match((await getJson('/api/state')).body.pi.reason, /VERITY_COST_CEILING_USD/);
  // Without any env selection: naming the missing env route.
  const providerEnv = process.env.VERITY_APP_PROVIDER;
  const modelEnv = process.env.VERITY_APP_MODEL;
  delete process.env.VERITY_APP_PROVIDER;
  delete process.env.VERITY_APP_MODEL;
  try {
    const pi = (await getJson('/api/state')).body.pi;
    assert.equal(pi.ready, false);
    assert.match(pi.reason, /VERITY_APP_PROVIDER/);
    assert.equal(pi.provider, undefined);
  } finally {
    process.env.VERITY_APP_PROVIDER = providerEnv;
    process.env.VERITY_APP_MODEL = modelEnv;
  }
});
