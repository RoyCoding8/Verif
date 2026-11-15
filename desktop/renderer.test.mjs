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
    dataset: {}, style: {},
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
  const document = {
    getElementById: id => {
      if (!registry.has(id)) registry.set(id, makeElement('div'));
      return registry.get(id);
    },
    createElement: tag => makeElement(tag),
    createDocumentFragment: () => makeElement('#fragment'),
    createTextNode: text => { const node = makeElement('#text'); node.ownText = text; return node; },
    documentElement: { dataset: {} },
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

async function bootedRenderer() {
  const renderer = makeRenderer();
  const source = await readFile(new URL('./public/app.js', import.meta.url), 'utf8');
  vm.runInContext(source, renderer.context, { filename: 'app.js' });
  renderer.run('boot()');
  await until(() => rendererText(renderer, 'host') !== '', 5000, 'boot to render the host');
  return renderer;
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
  renderer.registry.get('goal').value = 'Reserve the demo room for the walkthrough';
  renderer.registry.get('send').click();
  await until(() => renderer.run('state.summaries.length') === 1, 30000, 'thread creation');
  const id = renderer.run('state.summaries[0].id');
  const response = await realFetch(`${base}/api/threads/${id}`);
  assert.equal(response.status, 200, 'the renderer posted a well-formed run');
  await until(async () => (await (await realFetch(`${base}/api/threads/${id}`)).json()).status === 'done',
    90000, 'fixture run to finish');
  await renderer.run(`(async () => { await openThread(${JSON.stringify(id)}); })()`);
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
test('opening a file swaps the inspector rail to the file view, and Back returns to details', async () => {
  const renderer = await bootedRenderer();
  renderer.registry.get('goal').value = 'Reserve the demo room for the walkthrough';
  renderer.registry.get('send').click();
  await until(() => renderer.run('state.summaries.length') === 1, 30000, 'thread creation');
  const id = renderer.run('state.summaries[0].id');
  await renderer.run(`(async () => { await openThread(${JSON.stringify(id)}); })()`);
  await renderer.run('openFile("reserve.mjs")');
  assert.equal(renderer.registry.get('file-view').hidden, false, 'the file view is the rail content');
  assert.equal(renderer.registry.get('ctx-details').hidden, true, 'details hide while a file is open');
  assert.ok(renderer.run('document.getElementById("app").classList'), 'app class hook exists');
  await renderer.run('openFile(null)');
  assert.equal(renderer.registry.get('ctx-details').hidden, false, 'details return when the file closes');
  assert.equal(renderer.registry.get('file-view').hidden, true, 'the file view hides on close');
});

