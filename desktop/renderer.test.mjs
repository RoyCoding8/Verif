// Behavioral check of the shipped renderer (desktop/public/app.js).
// The real backend serves the wire contract on a random port while app.js
// runs unmodified in a Node VM behind a small DOM stub, so the fetch
// boundary, thread state, and visible error paths are exercised as the
// browser would drive them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';

process.env.VERITY_DESKTOP_DATA ??= mkdtempSync(join(tmpdir(), 'verity-renderer-test-'));

const { startServer } = await import('./server.mjs');

function listen(server) {
  return new Promise(resolve => {
    if (server.listening) resolve();
    else server.once('listening', resolve);
  });
}

const { server } = startServer(0);
await listen(server);
const base = `http://127.0.0.1:${server.address().port}`;
const realFetch = globalThis.fetch;

test.after(async () => {
  await new Promise(resolve => server.close(resolve));
});

function makeElement(tag) {
  const listeners = {};
  const children = [];
  const classSet = new Set();
  const node = {
    tag, children, title: '', type: '', value: '',
    disabled: false, hidden: false,
    scrollTop: 0, scrollHeight: 0,
    dataset: {}, style: {}, attrs: {},
    setAttribute(name, value) { node.attrs[name] = String(value); },
    contains(target) {
      if (this === target) return true;
      return children.some(child => typeof child.contains === 'function' && child.contains(target));
    },
    appendChild(child) { children.push(child); return child; },
    insertBefore(child, ref) {
      const index = children.indexOf(ref);
      if (index === -1) children.push(child);
      else children.splice(index, 0, child);
      return child;
    },
    querySelectorAll() { return []; },
    querySelector() { return makeElement(tag); },
    addEventListener(type, handler) { (listeners[type] ??= []).push(handler); },
    dispatch(type, event) {
      for (const handler of listeners[type] ?? []) handler(event ?? { preventDefault() {} });
    },
    click() { for (const handler of listeners.click ?? []) handler({ preventDefault() {} }); },
    keydown(key) { for (const handler of listeners.keydown ?? []) handler({ key, preventDefault() {} }); },
    classList: {
      toggle(name, force) {
        const on = force === undefined ? !classSet.has(name) : Boolean(force);
        if (on) classSet.add(name); else classSet.delete(name);
      },
      add(name) { classSet.add(name); },
    },
  };
  Object.defineProperty(node, 'textContent', {
    get: () => (children.length ? children.map(textOf).join('') : node.ownText ?? ''),
    set: value => { node.ownText = value; children.length = 0; },
  });
  return node;
}

function textOf(node) {
  return (node.children.length ? node.children.map(textOf).join('') : (node.ownText ?? ''));
}

function makeRenderer() {
  const registry = new Map();
  const documentHandlers = {};
  const document = {
    getElementById: id => {
      if (!registry.has(id)) registry.set(id, makeElement('div'));
      return registry.get(id);
    },
    createElement: tag => makeElement(tag),
    createDocumentFragment: () => makeElement('#fragment'),
    createTextNode: text => { const node = makeElement('#text'); node.ownText = text; return node; },
    documentElement: { dataset: {} },
    addEventListener(type, handler) { (documentHandlers[type] ??= []).push(handler); },
  };
  const storage = new Map();
  const scenario = { fetch: null };
  const fetchInContext = (url, options) => {
    if (scenario.fetch) return scenario.fetch(url, options);
    return realFetch(base + url, options);
  };
  const context = vm.createContext({
    document,
    fetch: fetchInContext,
    localStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, String(value)),
    },
    EventSource: class { constructor() {} addEventListener() {} close() {} },
    setTimeout,
    console,
  });
  return {
    scenario,
    registry,
    context,
    documentHandlers,
    // Top-level bindings of the evaluated script are visible to later
    // scripts in the same context, exactly like a browser console.
    run: expression => vm.runInContext(expression, context, { filename: 'driver.vm.js' }),
  };
}

function rendererText(renderer, id) {
  if (!renderer.registry.has(id)) renderer.registry.set(id, makeElement('div'));
  return textOf(renderer.registry.get(id));
}

async function until(predicate, timeoutMs = 60000, label = 'condition') {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error('timed out waiting for ' + label);
    await new Promise(done => setTimeout(done, 50));
  }
}

async function bootedRenderer(options = {}) {
  const renderer = makeRenderer();
  if (options.scenario) renderer.scenario.fetch = options.scenario;
  const source = await readFile(new URL('./public/app.js', import.meta.url), 'utf8');
  vm.runInContext(source, renderer.context, { filename: 'app.js' });
  await until(() => rendererText(renderer, 'host') !== '', 5000, 'boot to render the host');
  return renderer;
}

async function startDemoRun(renderer) {
  const before = renderer.run('state.summaries.length');
  renderer.registry.get('goal').value = 'Reserve the demo room for the walkthrough';
  renderer.registry.get('send').click();
  await until(() => renderer.run('state.summaries.length') === before + 1, 30000, 'thread creation');
  const id = renderer.run('state.summaries[0].id');
  await until(async () => (await (await realFetch(`${base}/api/threads/${id}`)).json()).status === 'done',
    90000, 'fixture run to finish');
  await renderer.run(`(async () => { await openThread(${JSON.stringify(id)}); })()`);
  return id;
}

test('appearance choices persist and resolve through settings controls', async () => {
  const renderer = await bootedRenderer();
  renderer.registry.get('theme-dark').click();
  assert.equal(renderer.run('document.documentElement.dataset.theme'), 'dark', 'dark choice applies the dark theme');
  assert.equal(renderer.run('localStorage.getItem("verity-theme")'), 'dark', 'dark choice is persisted');
  renderer.registry.get('theme-light').click();
  assert.equal(renderer.run('document.documentElement.dataset.theme'), 'light', 'light choice applies the light theme');
  assert.equal(renderer.run('localStorage.getItem("verity-theme")'), 'light', 'light choice is persisted');
  renderer.registry.get('theme-system').click();
  assert.equal(renderer.run('localStorage.getItem("verity-theme")'), 'system', 'system choice is persisted');
  assert.ok(['light', 'dark'].includes(renderer.run('document.documentElement.dataset.theme')), 'system resolves to a concrete theme');
});

test('Pi mode shows the unavailable reason in one line and fixture mode shows nothing', async () => {
  const renderer = await bootedRenderer();
  const mode = renderer.registry.get('mode');
  const note = renderer.registry.get('mode-note');
  mode.value = 'pi';
  await renderer.run('renderModeNote()');
  assert.equal(note.hidden, false, 'the unavailable reason is visible');
  assert.ok(note.textContent.length > 0, 'the reason names the missing route');
  mode.value = 'fixture';
  await renderer.run('renderModeNote()');
  assert.equal(note.hidden, true, 'fixture mode carries no note');
});

test('top readiness describes the selected mode: Demo ready by default, Pi verdict only when Pi is selected', async () => {
  const renderer = await bootedRenderer();
  const mode = renderer.registry.get('mode');
  mode.value = 'fixture';
  await renderer.run('renderComposer()');
  assert.equal(rendererText(renderer, 'route-label'), 'Demo ready',
    'the fixture demo reads ready, never Pi unavailable');
  mode.value = 'pi';
  await renderer.run('renderComposer()');
  assert.equal(rendererText(renderer, 'route-label'), 'Pi unavailable',
    'selecting Pi surfaces the Pi verdict');
  assert.equal(rendererText(renderer, 'mode-note').length > 0, true,
    'the concise Pi reason appears only while Pi is selected');
  mode.value = 'fixture';
  await renderer.run('renderComposer()');
  assert.equal(rendererText(renderer, 'route-label'), 'Demo ready',
    'returning to Demo clears the Pi verdict');
  assert.equal(rendererText(renderer, 'mode-note'), '', 'the Pi reason hides with Demo');
});

test('closing the file viewer clears the open path without navigating away', async () => {
  const renderer = await bootedRenderer();
  await renderer.run('openThread("missing-thread-xyz")');
  await renderer.run('state.files.path = "reserve.mjs"');
  renderer.registry.get('file-close').click();
  assert.equal(renderer.run('state.files.path'), null, 'the open path is cleared');
  assert.equal(renderer.registry.get('file-view').hidden, true, 'the viewer hides');
});

test('an unknown thread id stays out of thread state and its 404 error body is shown', async () => {
  const renderer = await bootedRenderer();
  await renderer.run('(async () => { await openThread("missing-thread-xyz"); })()');
  assert.equal(renderer.run('state.threads.has("missing-thread-xyz")'), false,
    'the 404 error body must not be stored as a thread');
  const transcript = rendererText(renderer, 'transcript');
  assert.ok(transcript.includes('Run failed'), 'the failure is announced in the transcript');
  assert.ok(transcript.includes('unknown thread'), 'the backend error message is preserved');
  assert.equal(rendererText(renderer, 'thread-title'), 'New task');
});

test('a refused run shows the backend 400 error and keeps the goal draft', async () => {
  const renderer = await bootedRenderer();
  renderer.registry.get('goal').value = 'unknown task audit run';
  renderer.registry.get('task').value = 'does-not-exist';
  renderer.registry.get('send').click();
  await until(() => rendererText(renderer, 'transcript').includes('unknown taskId'), 5000, 'refusal message');
  assert.ok(renderer.registry.get('goal').value !== '', 'the draft goal survives a refusal');
  assert.equal(renderer.run('state.summaries.length'), 0, 'a refused run creates no thread');
});

test('a dead backend makes Run fail visibly instead of silently', async () => {
  const renderer = await bootedRenderer();
  renderer.scenario.fetch = () => Promise.reject(new TypeError('Failed to fetch'));
  renderer.registry.get('goal').value = 'network failure repro';
  renderer.registry.get('send').click();
  await until(() => rendererText(renderer, 'transcript').includes('The Verity backend is not answering.'),
    5000, 'network failure message');
  assert.equal(renderer.run('state.summaries.length'), 0, 'a failed run creates no thread');
});

test('a valid run opens the thread with messages and results, and files report errors honestly', async () => {
  const renderer = await bootedRenderer();
  const id = await startDemoRun(renderer);
  const response = await realFetch(`${base}/api/threads/${id}`);
  assert.equal(response.status, 200, 'the renderer posted a well-formed run');
  const transcript = rendererText(renderer, 'transcript');
  assert.ok(transcript.includes('Dispatching'), 'the run dispatch line is rendered');
  assert.ok(transcript.includes('Promoted'), 'the promoted result is rendered');
  const stored = renderer.run(`state.threads.get(${JSON.stringify(id)})`);
  assert.equal(stored.results[0].task, 'messages', 'the wire result carries its task');
  assert.equal(stored.messages.some(message => message.role === 'result'), true, 'the result message is stored');

  await renderer.run(`(async () => { openFile("reserve.mjs"); })()`);
  await until(() => rendererText(renderer, 'file-content').includes('reserve'), 5000, 'valid file content');
  await renderer.run(`(async () => { openFile("no-such-file.mjs"); })()`);
  await until(() => rendererText(renderer, 'file-content').includes('not found'), 5000, 'file 404 message');
});
test('a promoted result shows a human-readable card with the exact receipt under a collapsed disclosure', async () => {
  const renderer = await bootedRenderer();
  const id = await startDemoRun(renderer);
  const stored = renderer.run(`state.threads.get(${JSON.stringify(id)})`);
  const result = stored.results[0];
  const transcript = renderer.registry.get('transcript');
  const card = transcript.children.find(child => child.children.some(node => node.tag === 'details'));
  assert.ok(card, 'a result card with a disclosure is rendered');
  const detail = card.children.find(node => node.className === 'detail');
  assert.ok(detail, 'the visible detail line exists');
  const visible = textOf(detail);
  assert.equal(visible, `Promoted as ${result.commit.slice(0, 8)}`,
    'the visible card shows task verdict and short commit only');
  assert.ok(!visible.includes('{') && !visible.includes('assurance'),
    'no raw JSON is initially visible in the card');
  const disclosure = card.children.find(node => node.tag === 'details');
  assert.ok(!disclosure.open, 'the exact receipt starts collapsed');
  const exact = textOf(disclosure);
  assert.ok(exact.includes(result.operation), 'disclosure reveals the full operation id');
  assert.ok(exact.includes(result.commit), 'disclosure reveals the full commit');
  assert.ok(exact.includes(JSON.stringify(result.assurance)), 'disclosure reveals the exact assurance');
});

test('a refused result keeps its full reason visible and exact under the disclosure', async () => {
  const renderer = await bootedRenderer();
  const card = renderer.run(`renderMessage({ role: 'result', data: {
    task: 'reserve', status: 'refused', detail: 'Candidate has no changes or changed paths outside approved scope',
    operation: 'op-exact-123', commit: null, assurance: null } })`);
  const detail = card.children.find(node => node.className === 'detail');
  assert.ok(textOf(detail).includes('Candidate has no changes'),
    'the refusal reason stays fully visible');
  const disclosure = card.children.find(node => node.tag === 'details');
  assert.ok(!disclosure.open, 'the disclosure starts collapsed');
  const exact = textOf(disclosure);
  assert.ok(exact.includes('op-exact-123'), 'disclosure carries the operation id');
  assert.ok(exact.includes('Candidate has no changes'), 'disclosure carries the exact result text');
});

test('promoted cards derive the visible summary from fields and keep the raw receipt under Details', async () => {
  const renderer = await bootedRenderer();
  const oldCard = renderer.run(`renderMessage({ role: 'result', data: {
    task: 'reserve', status: 'promoted', operation: 'op-old-123',
    detail: 'Promoted as abcdef12 · assurance {"message":"tested"}' } })`);
  const oldExact1 = oldCard.children.find(node => node.tag === 'details');
  assert.ok(!oldExact1.open, 'the legacy receipt starts collapsed');
  const oldVisible = textOf(oldCard.children.find(node => node.className === 'detail'));
  assert.equal(oldVisible, 'Promoted',
    'a legacy record without commit/assurance fields falls back to the status alone');
  assert.ok(!oldVisible.includes('{') && !oldVisible.includes('assurance') && !oldVisible.includes('abcdef12'),
    'no raw receipt text and no commit parsed out of prose reach the visible summary');
  assert.ok(textOf(oldExact1).includes('Promoted as abcdef12 · assurance {"message":"tested"}'),
    'Details retains the verbatim legacy detail');

  const newCard = renderer.run(`renderMessage({ role: 'result', data: {
    task: 'reserve', status: 'promoted', detail: 'Promoted as abcdef12',
    operation: 'op-exact-123', commit: 'abcdef1234567890abcdef1234567890abcdef12',
    assurance: { stock: 'bounded' } } })`);
  const newVisible = textOf(newCard.children.find(node => node.className === 'detail'));
  assert.equal(newVisible, 'Promoted as abcdef12', 'the current card keeps the accepted summary copy');
  assert.ok(!newVisible.includes('{') && !newVisible.includes('assurance'),
    'no raw technical text is initially visible on a current card');
  const newExact = textOf(newCard.children.find(node => node.tag === 'details'));
  assert.ok(newExact.includes('abcdef1234567890abcdef1234567890abcdef12')
    && newExact.includes(JSON.stringify({ stock: 'bounded' })),
    'Details retains the exact commit and assurance on a current card');
});

test('opening a file swaps the inspector rail to the file view, and Back returns to details', async () => {
  const renderer = await bootedRenderer();
  await startDemoRun(renderer);
  await renderer.run('openFile("reserve.mjs")');
  assert.equal(renderer.registry.get('file-view').hidden, false, 'the file view is the rail content');
  assert.equal(renderer.registry.get('ctx-details').hidden, true, 'details hide while a file is open');
  assert.ok(renderer.run('document.getElementById("app").classList'), 'app class hook exists');
  await renderer.run('openFile(null)');
  assert.equal(renderer.registry.get('ctx-details').hidden, false, 'details return when the file closes');
  assert.equal(renderer.registry.get('file-view').hidden, true, 'the file view hides on close');
});

// ---------- settings: provider setup, redaction, startup recovery ----------
// /api/settings is owned by the backend layer and is not implemented on this
// baseline yet; every settings assertion below runs against an explicit mock
// of the shared wire contract (real /api/state and /api/threads where noted).

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function emptySettings() {
  return { providers: [], defaultProviderId: null, costCeilingUsd: null, credentialStorage: { available: true } };
}

function providerView(id, over = {}) {
  return {
    id,
    label: over.label ?? 'Acme',
    protocol: over.protocol ?? 'openai-completions',
    baseUrl: over.baseUrl ?? 'https://api.acme.dev/v1',
    modelId: over.model ?? 'acme-model-1',
    hasApiKey: over.key ?? false,
  };
}

// Mock router for the shared settings contract; unmocked paths hit the real
// server so /api/state and /api/threads behavior stays real where used.
function makeRouter(handlers = {}) {
  return (url, options = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, '');
    if (path === '/api/settings' && (options.method ?? 'GET') === 'PUT') {
      return Promise.resolve(handlers.put
        ? handlers.put(JSON.parse(options.body))
        : jsonResponse({ error: 'PUT not mocked' }, 500));
    }
    if (path === '/api/settings') return Promise.resolve(handlers.get ? handlers.get() : jsonResponse(emptySettings()));
    if (path === '/api/tasks') {
      return Promise.resolve(handlers.tasks ? handlers.tasks() : jsonResponse({ tasks: [{ id: 'messages', goal: 'Demo messages' }] }));
    }
    if (path === '/api/state') {
      return Promise.resolve(handlers.state
        ? handlers.state()
        : jsonResponse({ hostname: 'mock-host', threads: [], pi: { ready: false, reason: 'mocked: Pi env not set' } }));
    }
    return realFetch(base + path, options);
  };
}

// Resolve elements the way the browser does: through getElementById, which
// materializes the anchor; static HTML and renderer-created rows both end up
// reachable through the live document tree.
function elem(renderer, id) {
  return renderer.run(`document.getElementById(${JSON.stringify(id)})`);
}

// Row controls are rendered into the provider list; find one by its id.
function rowElement(renderer, id) {
  const list = renderer.registry.get('provider-list');
  const visit = node => {
    if (node.id === id) return node;
    for (const child of node.children) {
      const found = visit(child);
      if (found) return found;
    }
    return null;
  };
  for (const row of list.children) {
    const found = visit(row);
    if (found) return found;
  }
  return null;
}

test('partial startup failure renders per section with retry and is never mislabeled as a run failure', async () => {
  const renderer = await bootedRenderer({ scenario: makeRouter({
    state: () => jsonResponse({ hostname: 'mock-host', threads: [{ id: 't1', title: 'Kept thread', status: 'done', messages: 2 }], pi: { ready: false } }),
    tasks: () => jsonResponse({ error: 'task catalog initialization failed: bad seed' }, 500),
    get: () => jsonResponse(emptySettings()),
  }) });
  assert.equal(elem(renderer, 'boot-notice').hidden, false, 'a failed section is announced');
  assert.ok(rendererText(renderer, 'boot-text').includes('task catalog failed to load'),
    'the notice names the catalog failure as a catalog problem');
  assert.ok(rendererText(renderer, 'boot-detail').includes('task catalog initialization failed: bad seed'),
    'the exact backend error stays available behind the notice');
  assert.equal(rendererText(renderer, 'route-label'), 'Demo ready',
    'a reachable backend is not downgraded to Checking or unreachable');
  assert.ok(rendererText(renderer, 'thread-list').includes('Kept thread'),
    'the state section still renders its data');
  assert.ok(elem(renderer, 'task').disabled, 'the task chooser is honestly disabled while the catalog is down');
  const transcript = rendererText(renderer, 'transcript');
  assert.ok(!transcript.includes('Run failed'), 'no startup failure may appear as an executed run failure');
  renderer.scenario.fetch = makeRouter({
    get: () => jsonResponse(emptySettings()),
    tasks: () => jsonResponse({ tasks: [{ id: 'messages', goal: 'Demo messages' }] }),
  });
  await renderer.run('(async () => { await retryFailedSections(); })()');
  await until(() => elem(renderer, 'boot-notice').hidden === true, 5000, 'notice to clear');
  assert.equal(elem(renderer, 'boot-notice').hidden, true, 'the notice clears after a successful retry');
  assert.equal(elem(renderer, 'task').disabled, false, 'the task chooser recovers with the catalog');
});

test('when the backend lacks /api/settings the UI reports the mismatch and keeps Settings usable', async () => {
  // Real server on this baseline serves no /api/settings yet (not mocked).
  const renderer = await bootedRenderer();
  await until(() => renderer.run('state.settings.phase') === 'error', 5000, 'settings load to fail');
  assert.equal(rendererText(renderer, 'provider-status'), 'Provider settings unavailable',
    'the composer says the status is unavailable instead of pretending');
  assert.equal(elem(renderer, 'provider-setup').hidden, false, 'the direct path to Providers stays reachable');
  await renderer.run('openSettings("providers")');
  assert.ok(rendererText(renderer, 'provider-list').includes('/api/settings'),
    'the providers tab names the missing endpoint');
  assert.equal(elem(renderer, 'settings-retry').hidden, false, 'a retry is offered');
  await renderer.run('closeSettings()');
});

test('provider setup persists through the contract PUT and the saved key is never filled back', async () => {
  const puts = [];
  const saved = emptySettings();
  const renderer = await bootedRenderer({ scenario: makeRouter({
    get: () => jsonResponse(JSON.parse(JSON.stringify(saved))),
    put: body => {
      puts.push(JSON.parse(JSON.stringify(body)));
      saved.providers = body.providers.map(provider => ({ ...provider, hasApiKey: Boolean(provider.apiKey) }));
      saved.defaultProviderId = body.defaultProviderId;
      saved.costCeilingUsd = body.costCeilingUsd;
      return jsonResponse({ providers: saved.providers, defaultProviderId: saved.defaultProviderId, costCeilingUsd: saved.costCeilingUsd, credentialStorage: { available: true } });
    },
  }) });
  await until(() => renderer.run('state.settings.phase') === 'ok', 5000, 'settings to load');
  await renderer.run('openSettings("providers")');
  await renderer.run('openProviderForm(null)');
  for (const [id, value] of [
    ['provider-label', 'Acme'],
    ['provider-protocol', 'anthropic-messages'],
    ['provider-base-url', 'https://api.acme.dev/v1'],
    ['provider-model', 'claude-x'],
    ['provider-api-key', 'sk-live-secret-1'],
  ]) elem(renderer, id).value = value;
  await renderer.run('applyProviderForm()');
  assert.ok(rendererText(renderer, 'provider-list').includes('Acme'), 'the draft list shows the new provider');
  assert.ok(rendererText(renderer, 'provider-list').includes('Anthropic Messages'), 'the protocol shows its friendly label');
  elem(renderer, 'provider-save-changes').click();
  await until(() => puts.length === 1 && renderer.run('state.settings.data.providers.length') === 1,
    5000, 'the save PUT to settle');
  const body = puts[0];
  assert.equal(body.providers.length, 1, 'the PUT is a full-list replacement');
  assert.equal(body.providers[0].protocol, 'anthropic-messages', 'the exact wire protocol name is sent');
  assert.equal(body.providers[0].baseUrl, 'https://api.acme.dev/v1', 'the base URL is sent');
  assert.equal(body.providers[0].modelId, 'claude-x', 'the model id is sent');
  assert.equal(body.providers[0].apiKey, 'sk-live-secret-1', 'the freshly typed key is carried only in the PUT body');
  assert.ok(!('hasApiKey' in body.providers[0]), 'the view-only field is never sent back');
  assert.equal(body.defaultProviderId, null, 'no default was chosen yet');
  assert.equal(body.costCeilingUsd, null, 'an unset ceiling stays null (unconfigured)');
  assert.equal(elem(renderer, 'provider-api-key').value, '', 'the key input is cleared right after saving');
  const providerId = renderer.run('state.settings.data.providers[0].id');
  await renderer.run(`openProviderForm(${JSON.stringify(providerId)})`);
  assert.equal(elem(renderer, 'provider-api-key').value, '', 'a saved key is never filled back into the UI');
  assert.ok(rendererText(renderer, 'key-indicator').includes('Leave blank to keep it'),
    'the saved-key indicator explains the empty field');
  assert.ok(!rendererText(renderer, 'provider-list').includes('sk-live-secret-1'),
    'no key material is rendered anywhere in the provider list');
  await renderer.run('closeProviderForm()');
});

test('a failed provider save preserves every edit and shows the backend error', async () => {
  const renderer = await bootedRenderer({ scenario: makeRouter({
    get: () => jsonResponse(emptySettings()),
    put: () => jsonResponse({ error: 'base URL rejected by the backend' }, 400),
  }) });
  await until(() => renderer.run('state.settings.phase') === 'ok', 5000, 'settings to load');
  await renderer.run('openSettings("providers")');
  await renderer.run('openProviderForm(null)');
  for (const [id, value] of [
    ['provider-label', 'Acme'],
    ['provider-protocol', 'openai-responses'],
    ['provider-base-url', 'https://api.acme.dev/v1'],
    ['provider-model', 'acme-model-1'],
  ]) elem(renderer, id).value = value;
  await renderer.run('applyProviderForm()');
  elem(renderer, 'provider-save-changes').click();
  await until(() => rendererText(renderer, 'provider-error') !== '', 5000, 'save error');
  assert.ok(rendererText(renderer, 'provider-error').includes('base URL rejected by the backend'),
    'the backend error message is shown verbatim');
  assert.ok(rendererText(renderer, 'provider-list').includes('Acme'), 'the draft provider survives the failed save');
  assert.equal(elem(renderer, 'provider-dirty').hidden, false, 'the unsaved-changes marker stays on');
  // An invalid ceiling is refused before any PUT is attempted.
  elem(renderer, 'ceiling-input').value = 'abc';
  await renderer.run('saveProviderDraft()');
  assert.ok(rendererText(renderer, 'provider-error').includes('positive number'),
    'a non-positive ceiling is refused client-side with guidance');
});

test('default selection, deletion, and cancel round-trip through the full-list PUT', async () => {
  const puts = [];
  let stored = { providers: [providerView('p1', { key: true })], defaultProviderId: null, costCeilingUsd: null, credentialStorage: { available: true } };
  const renderer = await bootedRenderer({ scenario: makeRouter({
    get: () => jsonResponse(JSON.parse(JSON.stringify(stored))),
    put: body => {
      puts.push(JSON.parse(JSON.stringify(body)));
      stored = {
        providers: body.providers.map(provider => ({ ...provider, hasApiKey: Boolean(provider.apiKey) })),
        defaultProviderId: body.defaultProviderId,
        costCeilingUsd: body.costCeilingUsd,
        credentialStorage: { available: true },
      };
      return jsonResponse(JSON.parse(JSON.stringify(stored)));
    },
  }) });
  await until(() => renderer.run('state.settings.phase') === 'ok', 5000, 'settings to load');
  await renderer.run('openSettings("providers")');
  // Mark p1 as the default through the row's radio control.
  const radio = rowElement(renderer, 'default-p1');
  radio.checked = true;
  radio.dispatch('change');
  await until(() => elem(renderer, 'provider-dirty').hidden === false, 5000, 'dirty marker');
  elem(renderer, 'provider-save-changes').click();
  await until(() => puts.length === 1 && renderer.run('state.settings.data.defaultProviderId') === 'p1',
    5000, 'the default PUT to settle');
  assert.equal(puts[0].defaultProviderId, 'p1', 'the chosen default is sent');
  assert.ok(!('apiKey' in puts[0].providers[0]), 'saving without typing a key sends no key field, so the saved key is preserved');
  await until(() => rendererText(renderer, 'provider-status') === 'Acme · acme-model-1', 5000,
    'the composer reflects the saved default route');
  // A local default change is visible in the draft and cancel reverts it.
  const noDefault = rowElement(renderer, 'default-none');
  noDefault.checked = true;
  noDefault.dispatch('change');
  assert.equal(elem(renderer, 'provider-dirty').hidden, false, 'the unsaved default change is flagged');
  await renderer.run('revertProviderDraft()');
  await until(() => elem(renderer, 'provider-dirty').hidden === true, 5000, 'cancel to settle');
  assert.equal(renderer.run('state.settings.data.defaultProviderId'), 'p1', 'cancel restores the saved default');
  // Two-step delete removes the whole provider entry from the draft.
  const del = rowElement(renderer, 'delete-p1');
  del.click();
  assert.equal(del.textContent, 'Confirm delete', 'the first click only arms the delete');
  del.click();
  await until(() => rendererText(renderer, 'provider-list').includes('No providers configured'), 5000, 'row removed');
  elem(renderer, 'provider-save-changes').click();
  await until(() => puts.length === 2 && renderer.run('state.settings.data.providers.length') === 0,
    5000, 'the delete PUT to settle');
  assert.equal(puts[1].providers.length, 0, 'deletion removes the whole entry in the replacement list');
  assert.equal(puts[1].defaultProviderId, null, 'the default of a deleted provider clears');
});

test('the composer points at Providers when unconfigured and names the route when configured', async () => {
  const unconfigured = await bootedRenderer({ scenario: makeRouter({ get: () => jsonResponse(emptySettings()) }) });
  await until(() => rendererText(unconfigured, 'provider-status') === 'No provider configured', 5000, 'unconfigured status');
  assert.equal(elem(unconfigured, 'provider-setup').hidden, false, 'the direct path to Providers is visible');
  elem(unconfigured, 'provider-setup').click();
  assert.equal(unconfigured.run('state.settings.open'), true, 'the status click opens Settings');
  assert.equal(unconfigured.run('state.settings.tab'), 'providers', 'it lands on the Providers section');
  const configured = await bootedRenderer({ scenario: makeRouter({
    get: () => jsonResponse({ providers: [providerView('p1', { label: 'Acme', model: 'acme-model-1' })], defaultProviderId: 'p1', costCeilingUsd: 5, credentialStorage: { available: false, reason: 'keyring locked' } }),
  }) });
  await until(() => rendererText(configured, 'provider-status') === 'Acme · acme-model-1', 5000, 'configured status');
  assert.equal(elem(configured, 'provider-setup').hidden, true, 'no setup nudge when a default provider exists');
});

test('the identity menu opens upward, closes on Escape and outside click, and reaches categorized Settings', async () => {
  const renderer = await bootedRenderer();
  const button = elem(renderer, 'identity-btn');
  const menu = elem(renderer, 'identity-menu');
  // The stub registry does not parse the markup's hidden attribute; mirror it.
  menu.hidden = true;
  button.click();
  assert.equal(menu.hidden, false, 'the identity menu opens from the bottom-left button');
  assert.equal(button.attrs['aria-expanded'], 'true', 'the button tracks menu state for assistive tech');
  for (const handler of renderer.documentHandlers.keydown ?? []) handler({ key: 'Escape', preventDefault() {} });
  assert.equal(menu.hidden, true, 'Escape closes the menu');
  button.click();
  for (const handler of renderer.documentHandlers.click ?? []) handler({ target: elem(renderer, 'goal') });
  assert.equal(menu.hidden, true, 'a click outside the menu closes it');
  button.click();
  elem(renderer, 'menu-settings').click();
  assert.equal(renderer.run('state.settings.open'), true, 'the Settings item opens the dialog');
  assert.equal(renderer.run('state.settings.tab'), 'general', 'Settings opens on the General section');
  assert.equal(menu.hidden, true, 'the menu closes behind the dialog');
  elem(renderer, 'settings-nav-providers').click();
  assert.equal(renderer.run('state.settings.tab'), 'providers', 'the category rail switches sections');
  elem(renderer, 'settings-close').click();
  assert.equal(renderer.run('state.settings.open'), false, 'close dismisses the dialog');
});

test('the approved spending ceiling saves through the same contract PUT and validates input', async () => {
  const puts = [];
  let stored = emptySettings();
  const renderer = await bootedRenderer({ scenario: makeRouter({
    get: () => jsonResponse(JSON.parse(JSON.stringify(stored))),
    put: body => {
      puts.push(JSON.parse(JSON.stringify(body)));
      stored = { providers: [], defaultProviderId: null, costCeilingUsd: body.costCeilingUsd, credentialStorage: { available: true } };
      return jsonResponse(JSON.parse(JSON.stringify(stored)));
    },
  }) });
  await until(() => renderer.run('state.settings.phase') === 'ok', 5000, 'settings to load');
  await renderer.run('openSettings("general")');
  elem(renderer, 'ceiling-input').value = '25.5';
  elem(renderer, 'general-save').click();
  await until(() => puts.length === 1 && renderer.run('state.settings.data.costCeilingUsd') === 25.5,
    5000, 'the ceiling PUT to settle');
  assert.equal(puts[0].costCeilingUsd, 25.5, 'the approved ceiling is saved as a finite positive number');
  assert.equal(renderer.run('state.settings.data.costCeilingUsd'), 25.5, 'the saved ceiling round-trips');
  elem(renderer, 'ceiling-input').value = '0';
  elem(renderer, 'general-save').click();
  await until(() => rendererText(renderer, 'general-error') !== '', 5000, 'validation error');
  assert.ok(rendererText(renderer, 'general-error').includes('positive'), 'zero is refused with guidance');
  assert.equal(puts.length, 1, 'an invalid ceiling sends no request');
});
