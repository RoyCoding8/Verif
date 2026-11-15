// Verity desktop renderer. Vanilla DOM against the desktop/server.mjs contract.
//
// Data shapes (from desktop/server.mjs):
//   state   { hostname, threads: ThreadSummary[], pi: { ready, reason?, ceilingUsd? } }
//   summary { id, title, taskId, mode, status, createdAt, messages: number }
//   thread  summary + messages: Message[], results?: Result[], workspace?: Workspace
//   message { role: user|system|agent|result|error, text?, data?: Result, ts }
//   result  { task, status: promoted|refused|blocked, detail, operation? }
//   task    { id, goal, dependencies }
//   workspace { host, ref, head, files, changed: string[] }

const $ = id => document.getElementById(id);

const THREAD_CHIPS = {
  queued: ['chip-queued', 'Queued'],
  running: ['chip-running', 'Running'],
  done: ['chip-done', 'Done'],
  attention: ['chip-attention', 'Needs attention'],
};
const RESULT_CHIPS = {
  promoted: ['chip-promoted', 'Promoted'],
  refused: ['chip-refused', 'Refused'],
  blocked: ['chip-blocked', 'Blocked'],
};
const DOTS = {
  queued: 'dot-queued',
  running: 'dot-running',
  done: 'dot-done',
  attention: 'dot-attention',
};

const state = {
  hostname: '',
  pi: { ready: false },
  summaries: [],
  tasks: [],
  threads: new Map(),
  view: { kind: 'new' },
  lastThreadId: null,
  files: { path: null, cache: new Map(), inflight: null },
  panes: { nav: false, inspector: false },
  appearance: 'system',
  sending: false,
};

// ---------- small DOM helpers ----------

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// Renders `code` spans the way the controller writes them in system lines.
function richText(text) {
  const frag = document.createDocumentFragment();
  String(text ?? '').split('`').forEach((part, index) => {
    if (!part) return;
    frag.appendChild(index % 2 ? el('span', 'code', part) : document.createTextNode(part));
  });
  return frag;
}

function chip(kindMap, key, fallback) {
  const [cls, label] = kindMap[key] ?? ['chip-idle', fallback ?? key ?? 'unknown'];
  return el('span', 'chip ' + cls, label);
}

function currentThread() {
  if (state.view.kind !== 'thread') return null;
  return state.threads.get(state.view.id) ?? null;
}

function currentThreadId() {
  return state.view.kind === 'thread' ? state.view.id : state.lastThreadId ?? null;
}

// ---------- theme ----------

function prefersDark() {
  try {
    return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;
  } catch {
    return false;
  }
}

function renderAppearance() {
  for (const choice of ['light', 'dark', 'system']) {
    $('theme-' + choice).classList.toggle('is-active', state.appearance === choice);
  }
}

function applyTheme(choice) {
  state.appearance = ['light', 'dark', 'system'].includes(choice) ? choice : 'system';
  const resolved = state.appearance === 'system' ? (prefersDark() ? 'dark' : 'light') : state.appearance;
  document.documentElement.dataset.theme = resolved;
  try { localStorage.setItem('verity-theme', state.appearance); } catch { /* storage can be denied */ }
  renderAppearance();
}

function initTheme() {
  let stored = null;
  try { stored = localStorage.getItem('verity-theme'); } catch { /* storage can be denied */ }
  applyTheme(stored ?? 'system');
  try {
    if (typeof matchMedia === 'function') {
      matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
        if (state.appearance === 'system') applyTheme('system');
      });
    }
  } catch { /* system theme tracking is best-effort */ }
}

// ---------- navigation ----------

function navigate(view) {
  if (state.view.kind === 'thread') state.lastThreadId = state.view.id;
  state.view = view;
  renderAll();
}

function isNarrow() {
  try {
    return typeof matchMedia === 'function' && matchMedia('(max-width: 1024px)').matches;
  } catch {
    return false;
  }
}

function renderScrim() {
  $('scrim').hidden = !(isNarrow() && (state.panes.nav || state.panes.inspector));
}

function closePanes() {
  state.panes.nav = false;
  state.panes.inspector = false;
  $('app').classList.toggle('nav-off', false);
  $('app').classList.toggle('inspector-off', false);
  renderScrim();
}

function togglePane(name, className) {
  state.panes[name] = !state.panes[name];
  $('app').classList.toggle(className, state.panes[name]);
  renderScrim();
}

// ---------- data loading ----------

// Single request boundary for the settled /api wire contract: every consumer
// checks HTTP success before any state is written and keeps the backend's
// error message; a dead backend becomes a visible error instead of silence.
async function fetchJson(url, options) {
  let response;
  try {
    response = await fetch(url, options);
  } catch {
    throw new Error('The Verity backend is not answering.');
  }
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? ('Request failed with HTTP ' + response.status));
  return body;
}

async function fetchState() {
  const body = await fetchJson('/api/state');
  state.hostname = body.hostname ?? '';
  state.summaries = body.threads ?? [];
  state.pi = body.pi ?? { ready: false };
}

async function fetchTasks() {
  const body = await fetchJson('/api/tasks');
  state.tasks = body.tasks ?? [];
}

async function fetchThread(id) {
  const body = await fetchJson('/api/threads/' + encodeURIComponent(id));
  state.threads.set(id, body);
  return body;
}

async function fetchFile(threadId, path) {
  const query = '/api/threads/' + encodeURIComponent(threadId) + '/file?path=' + encodeURIComponent(path);
  return (await fetchJson(query)).content;
}

async function createThread() {
  if (state.sending) return;
  const goalEl = $('goal');
  const goal = goalEl.value.trim();
  if (!goal) { if (goalEl.focus) goalEl.focus(); return; }
  const payload = {
    goal,
    taskId: $('task').value || 'messages',
    mode: $('mode').value === 'pi' ? 'pi' : 'fixture',
  };
  state.sending = true;
  $('send').disabled = true;
  $('send-label').textContent = 'Starting…';
  try {
    const body = await fetchJson('/api/threads', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    goalEl.value = '';
    state.summaries = [body, ...state.summaries.filter(entry => entry.id !== body.id)];
    navigate({ kind: 'thread', id: body.id });
    await fetchThread(body.id);
    renderAll();
  } catch (error) {
    pushLocalError(error.message ?? 'The run could not be started.');
  } finally {
    state.sending = false;
    $('send').disabled = false;
    $('send-label').textContent = 'Run';
  }
}

function pushLocalError(text) {
  const thread = currentThread();
  if (thread) {
    thread.messages.push({ role: 'error', text, ts: Date.now() });
    renderAll();
    return;
  }
  const wrap = $('transcript');
  wrap.textContent = '';
  wrap.appendChild(renderMessage({ role: 'error', text, ts: Date.now() }));
}

// ---------- rendering: shell chrome ----------

function renderSidebar() {
  $('host').textContent = state.hostname || 'unknown host';
  const list = $('thread-list');
  list.textContent = '';
  if (!state.summaries.length) {
    list.appendChild(el('div', 'side-empty', 'No threads yet.'));
    return;
  }
  for (const summary of state.summaries) {
    const row = el('button', 'thread-row');
    row.type = 'button';
    row.classList.toggle('is-active', state.view.kind === 'thread' && state.view.id === summary.id);
    const dot = el('span', 'dot ' + (DOTS[summary.status] ?? 'dot-queued'));
    dot.title = summary.status ?? 'queued';
    row.appendChild(dot);
    row.appendChild(el('span', 'title', summary.title || 'Untitled'));
    row.appendChild(el('span', 'count', String(summary.messages ?? 0)));
    row.addEventListener('click', () => { closePanes(); openThread(summary.id); });
    list.appendChild(row);
  }
}

function renderComposer() {
  const select = $('task');
  const previous = select.value;
  select.textContent = '';
  if (!state.tasks.length) {
    const option = el('option', null, 'No tasks available');
    option.value = '';
    select.appendChild(option);
    select.disabled = true;
  } else {
    select.disabled = false;
    for (const task of state.tasks) {
      const option = el('option', null, task.id + ' - ' + task.goal);
      option.value = task.id;
      option.title = task.goal;
      select.appendChild(option);
    }
    if (state.tasks.some(task => task.id === previous)) select.value = previous;
    else if (state.tasks.some(task => task.id === 'messages')) select.value = 'messages';
    else select.value = state.tasks[0].id;
  }

  const piOption = $('mode').querySelector('option[value="pi"]');
  piOption.disabled = !state.pi.ready;
  piOption.title = state.pi.ready ? 'Runs the real Pi agent loop' : (state.pi.reason ?? 'Pi is not configured');

  $('route-label').textContent = state.pi.ready ? 'Pi ready' : 'Pi unavailable';
  $('route-dot').className = 'dot ' + (state.pi.ready ? 'dot-done' : 'dot-queued');
  renderModeNote();
}

function renderModeNote() {
  const note = $('mode-note');
  if ($('mode').value === 'pi' && !state.pi.ready) {
    note.textContent = state.pi.reason ?? 'Pi is not configured.';
    note.hidden = false;
  } else {
    note.textContent = '';
    note.hidden = true;
  }
}

// ---------- rendering: transcript ----------

function renderMessage(message) {
  if (message.role === 'result') {
    const data = message.data ?? {};
    const card = el('div', 'msg msg-result');
    const head = el('div', 'head');
    head.appendChild(el('span', 'task', data.task ?? 'task'));
    head.appendChild(chip(RESULT_CHIPS, data.status, data.status));
    card.appendChild(head);
    const detail = el('div', 'detail');
    detail.appendChild(richText(data.detail ?? ''));
    card.appendChild(detail);
    if (data.operation) {
      card.appendChild(el('div', 'task', 'operation ' + String(data.operation).slice(0, 8)));
    }
    return card;
  }
  if (message.role === 'error') {
    const card = el('div', 'msg msg-error');
    card.appendChild(el('div', 'label', 'Run failed'));
    card.appendChild(el('div', null, message.text ?? ''));
    return card;
  }
  if (message.role === 'system' || message.role === 'agent') {
    const line = el('div', 'msg msg-system');
    line.appendChild(richText(message.text ?? ''));
    return line;
  }
  const card = el('div', 'msg msg-user');
  card.appendChild(richText(message.text ?? ''));
  return card;
}

function renderTranscript() {
  const wrap = $('transcript');
  wrap.textContent = '';
  const thread = currentThread();
  if (!thread) {
    wrap.appendChild(el('div', 'transcript-empty', 'Start by describing a task below.'));
    return;
  }
  if (!thread.messages.length) {
    wrap.appendChild(el('div', 'transcript-empty', 'No messages yet.'));
    return;
  }
  for (const message of thread.messages) wrap.appendChild(renderMessage(message));
  wrap.scrollTop = wrap.scrollHeight;
}

function renderThreadHead() {
  const thread = currentThread();
  $('thread-title').textContent = thread ? (thread.title || 'Untitled') : 'New task';
  $('thread-sub').textContent = thread ? ((thread.taskId ?? 'task') + ' · ' + (thread.mode ?? 'fixture')) : '';
  const chipEl = $('thread-status');
  const status = thread?.status ?? 'idle';
  const [cls, label] = THREAD_CHIPS[status] ?? ['chip-idle', 'Idle'];
  chipEl.className = 'chip ' + cls;
  chipEl.textContent = label;
}

// ---------- rendering: inspector ----------

function renderContext() {
  const thread = currentThread();
  $('ctx-title').textContent = thread ? (thread.title || 'Untitled') : 'No thread selected';

  const rows = $('ctx-rows');
  rows.textContent = '';
  const changed = thread?.workspace?.changed ?? [];
  if (thread) {
    const pairs = [
      ['Host', thread.workspace?.host ?? state.hostname ?? 'unknown'],
      ['Branch', thread.workspace?.ref ?? 'refs/heads/protected'],
      ['Head', thread.workspace?.head ?? 'unset'],
      ['Files', String(thread.workspace?.files ?? 0)],
      ['Changed', String(changed.length)],
    ];
    for (const [key, value] of pairs) {
      const row = el('div', 'ctx-row');
      row.appendChild(el('span', 'k', key));
      row.appendChild(el('span', 'v', value));
      rows.appendChild(row);
    }
  }

  const resultsBlock = $('ctx-results-block');
  const resultsWrap = $('ctx-results');
  resultsWrap.textContent = '';
  const results = thread?.results ?? [];
  if (thread && results.length) {
    resultsBlock.hidden = false;
    for (const result of results) {
      const row = el('div', 'ctx-result');
      row.appendChild(el('span', 'task', result.task ?? 'task'));
      row.appendChild(chip(RESULT_CHIPS, result.status, result.status));
      resultsWrap.appendChild(row);
    }
  } else if (thread) {
    resultsBlock.hidden = false;
    const row = el('div', 'ctx-result');
    row.appendChild(el('span', 'task', thread.taskId ?? 'task'));
    const [cls, label] = THREAD_CHIPS[thread.status] ?? ['chip-idle', 'Idle'];
    row.appendChild(el('span', 'chip ' + cls, label));
    resultsWrap.appendChild(row);
  } else {
    resultsBlock.hidden = true;
  }
}

// ---------- rendering: files ----------

function renderFiles() {
  const threadId = currentThreadId();
  const thread = threadId ? state.threads.get(threadId) ?? null : null;
  const list = $('file-list');
  list.textContent = '';
  const paths = thread?.workspace?.changed ?? [];
  if (!paths.length) {
    list.appendChild(el('div', 'side-empty', thread
      ? 'No changed files in this run.'
      : 'No thread open.'));
  }
  for (const path of paths) {
    const row = el('button', 'file-row');
    row.type = 'button';
    row.textContent = path;
    row.title = path;
    row.classList.toggle('is-active', state.files.path === path);
    row.addEventListener('click', () => { closePanes(); openFile(path); });
    list.appendChild(row);
  }
  $('file-path').disabled = !thread;
  $('file-form').querySelector('button').disabled = !thread;

  const view = $('file-view');
  const name = $('file-name');
  const content = $('file-content');
  if (!state.files.path || !thread) {
    view.hidden = true;
    name.textContent = '';
    content.textContent = '';
    return;
  }
  view.hidden = false;
  name.textContent = state.files.path;
  const cacheKey = threadId + '|' + state.files.path;
  if (state.files.cache.has(cacheKey)) {
    content.className = 'file-content';
    content.textContent = state.files.cache.get(cacheKey);
    return;
  }
  content.className = 'file-content empty';
  content.textContent = 'Loading ' + state.files.path + ' …';
  if (state.files.inflight === cacheKey) return;
  state.files.inflight = cacheKey;
  fetchFile(threadId, state.files.path).then(text => {
    state.files.cache.set(cacheKey, text);
    if (state.files.inflight === cacheKey) state.files.inflight = null;
    if (state.files.path && currentThreadId() === threadId) renderFiles();
  }).catch(error => {
    if (state.files.inflight === cacheKey) state.files.inflight = null;
    content.className = 'file-content empty';
    content.textContent = error.message;
  });
}

function openFile(path) {
  state.files.path = path;
  renderAll();
}

// ---------- top-level render ----------

function renderAll() {
  renderSidebar();
  renderThreadHead();
  renderTranscript();
  renderComposer();
  renderContext();
  renderFiles();
}

async function openThread(id) {
  navigate({ kind: 'thread', id });
  try {
    await fetchThread(id);
  } catch (error) {
    pushLocalError(error.message ?? ('Cannot load thread ' + id + '.'));
    return;
  }
  renderAll();
}

// ---------- events ----------

function connectEvents() {
  const stream = new EventSource('/api/events');
  stream.addEventListener('hello', event => {
    try {
      const body = JSON.parse(event.data);
      if (body.hostname) {
        state.hostname = body.hostname;
        renderSidebar();
      }
    } catch { /* keep the last known state */ }
  });
  stream.addEventListener('thread:created', event => {
    try {
      const summary = JSON.parse(event.data);
      if (!state.summaries.some(entry => entry.id === summary.id)) {
        state.summaries = [summary, ...state.summaries];
        renderSidebar();
      }
    } catch { /* keep the last known state */ }
  });
  stream.addEventListener('thread:update', event => {
    try {
      const thread = JSON.parse(event.data);
      state.threads.set(thread.id, thread);
      const summary = state.summaries.find(entry => entry.id === thread.id);
      if (summary) {
        summary.title = thread.title;
        summary.status = thread.status;
        summary.messages = Array.isArray(thread.messages) ? thread.messages.length : summary.messages;
      }
      if (state.view.kind === 'thread' && state.view.id === thread.id) renderAll();
      else { renderSidebar(); renderContext(); }
    } catch { /* keep the last known state */ }
  });
}

function bindUi() {
  $('new-task').addEventListener('click', () => { closePanes(); navigate({ kind: 'new' }); });
  $('project-row').addEventListener('click', () => { closePanes(); navigate({ kind: 'new' }); });
  $('nav-toggle').addEventListener('click', () => togglePane('nav', 'nav-off'));
  $('inspector-toggle').addEventListener('click', () => togglePane('inspector', 'inspector-off'));
  $('scrim').addEventListener('click', closePanes);
  $('settings-btn').addEventListener('click', () => {
    const dialog = $('settings-dialog');
    if (dialog.showModal) dialog.showModal();
  });
  for (const choice of ['light', 'dark', 'system']) {
    $('theme-' + choice).addEventListener('click', () => applyTheme(choice));
  }
  $('send').addEventListener('click', () => { createThread(); });
  $('goal').addEventListener('keydown', event => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      createThread();
    }
  });
  $('mode').addEventListener('change', renderModeNote);
  $('file-form').addEventListener('submit', event => {
    event.preventDefault();
    const path = $('file-path').value.trim();
    if (path) openFile(path);
  });
  $('file-close').addEventListener('click', () => {
    state.files.path = null;
    renderFiles();
  });
  if (typeof document.addEventListener === 'function') {
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape') closePanes();
    });
  }
}

// ---------- boot ----------

async function boot() {
  initTheme();
  bindUi();
  connectEvents();
  try {
    await Promise.all([fetchState(), fetchTasks()]);
  } catch (error) {
    pushLocalError(error.message);
    return;
  }
  renderAll();
}

boot();
