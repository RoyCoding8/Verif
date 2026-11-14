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
  tabs: [{ kind: 'files' }],
  view: { kind: 'files' },
  back: [],
  forward: [],
  files: { path: null, cache: new Map() },
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

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem('verity-theme', theme); } catch { /* storage can be denied */ }
}

function initTheme() {
  let stored = null;
  try { stored = localStorage.getItem('verity-theme'); } catch { /* storage can be denied */ }
  applyTheme(stored === 'dark' ? 'dark' : 'light');
}

// ---------- navigation ----------

function navigate(view, push = true) {
  if (push) {
    state.back.push(state.view);
    state.forward.length = 0;
  }
  if (state.view.kind === 'thread') state.lastThreadId = state.view.id;
  state.view = view;
  if (view.kind === 'thread') ensureThreadTab(view.id);
  if (view.kind === 'new' && !state.tabs.some(tab => tab.kind === 'new')) {
    state.tabs.push({ kind: 'new' });
  }
  renderAll();
}

function goBack() {
  if (!state.back.length) return;
  state.forward.push(state.view);
  const view = state.back.pop();
  if (state.view.kind === 'thread') state.lastThreadId = state.view.id;
  state.view = view;
  renderAll();
}

function goForward() {
  if (!state.forward.length) return;
  state.back.push(state.view);
  const view = state.forward.pop();
  if (state.view.kind === 'thread') state.lastThreadId = state.view.id;
  state.view = view;
  renderAll();
}

function ensureThreadTab(id) {
  if (!state.tabs.some(tab => tab.kind === 'thread' && tab.id === id)) {
    state.tabs.push({ kind: 'thread', id });
  }
}

// ---------- data loading ----------

async function fetchState() {
  const body = await (await fetch('/api/state')).json();
  state.hostname = body.hostname ?? '';
  state.summaries = body.threads ?? [];
  state.pi = body.pi ?? { ready: false };
}

async function fetchTasks() {
  const body = await (await fetch('/api/tasks')).json();
  state.tasks = body.tasks ?? [];
}

async function fetchThread(id) {
  const body = await (await fetch('/api/threads/' + encodeURIComponent(id))).json();
  state.threads.set(id, body);
  return body;
}

async function fetchFile(threadId, path) {
  const query = '/api/threads/' + encodeURIComponent(threadId) + '/file?path=' + encodeURIComponent(path);
  const response = await fetch(query);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? ('Cannot open ' + path));
  return body.content;
}

async function createThread() {
  const goalEl = $('goal');
  const goal = goalEl.value.trim();
  if (!goal) { goalEl.focus(); return; }
  const payload = {
    goal,
    taskId: $('task').value || 'messages',
    mode: $('mode').value === 'pi' ? 'pi' : 'fixture',
  };
  const response = await fetch('/api/threads', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await response.json();
  if (!response.ok) {
    pushLocalError(body.error ?? 'The controller refused the task.');
    return;
  }
  goalEl.value = '';
  state.summaries = [body, ...state.summaries.filter(entry => entry.id !== body.id)];
  navigate({ kind: 'thread', id: body.id });
  fetchThread(body.id).then(() => renderAll()).catch(() => {});
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

function renderTabs() {
  const bar = $('tabbar');
  bar.querySelectorAll('.tab[data-dynamic]').forEach(node => node.remove());
  const add = $('tab-add');
  for (const tab of state.tabs) {
    if (tab.kind === 'files') continue;
    const button = el('button', 'tab');
    button.dataset.dynamic = 'true';
    if (tab.kind === 'new') {
      button.textContent = 'New task';
      button.classList.toggle('is-active', state.view.kind === 'new');
      button.addEventListener('click', () => navigate({ kind: 'new' }));
    } else {
      const summary = state.summaries.find(entry => entry.id === tab.id);
      const title = summary?.title ?? state.threads.get(tab.id)?.title ?? 'Thread';
      button.textContent = title;
      button.title = title;
      button.classList.toggle('is-active', state.view.kind === 'thread' && state.view.id === tab.id);
      button.addEventListener('click', () => openThread(tab.id));
    }
    bar.insertBefore(button, add);
  }
  $('tab-files').classList.toggle('is-active', state.view.kind === 'files');
}

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
    row.addEventListener('click', () => openThread(summary.id));
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

  $('ws-host').textContent = state.hostname || 'unknown host';
  renderModeNote();
}

function renderModeNote() {
  const note = $('mode-note');
  if ($('mode').value === 'pi') {
    note.textContent = state.pi.ready
      ? 'Pi mode runs the real agent loop against the approved cost ceiling.'
      : 'Pi mode unavailable. ' + (state.pi.reason ?? 'No route configured.');
  } else {
    note.textContent = 'Fixture mode runs offline against the demo oracle.';
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
    const empty = el('div', 'transcript-empty');
    empty.appendChild(el('div', null, 'No thread open.'));
    empty.appendChild(el('div', null, 'Write a goal below and press Run.'));
    wrap.appendChild(empty);
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
  const chipEl = $('thread-status');
  const status = thread?.status ?? 'idle';
  const [cls, label] = THREAD_CHIPS[status] ?? ['chip-idle', 'Idle'];
  chipEl.className = 'chip ' + cls;
  chipEl.textContent = label;
}

// ---------- rendering: context panel ----------

function firstNumber(values) {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}

function costInfo(thread) {
  if (!thread) return null;
  const results = thread.results ?? [];
  const spentMicros = firstNumber([
    thread.costMicros,
    thread.cost?.spentMicros,
    ...results.map(result => result.costMicros ?? result.cost?.spentMicros),
  ]);
  const spentUsd = firstNumber([
    thread.costUsd,
    thread.cost?.spentUsd,
    ...results.map(result => result.costUsd ?? result.cost?.usd),
  ]);
  const ceilingMicros = firstNumber([thread.costCeilingMicros, thread.cost?.ceilingMicros]);
  const ceilingUsd = firstNumber([thread.costCeilingUsd, thread.cost?.ceilingUsd]) ??
    (thread.mode === 'pi' ? firstNumber([state.pi.ceilingUsd]) : null);
  const spent = spentUsd ?? (spentMicros === null ? null : spentMicros / 1e6);
  const ceiling = ceilingUsd ?? (ceilingMicros === null ? null : ceilingMicros / 1e6);
  if (spent === null) return null;
  return { spent, ceiling };
}

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
    if (changed.length) {
      const list = el('div', 'ctx-changed');
      for (const path of changed.slice(0, 12)) list.appendChild(el('div', null, path));
      if (changed.length > 12) list.appendChild(el('div', null, '+ ' + (changed.length - 12) + ' more'));
      rows.appendChild(list);
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
      row.appendChild(el('span', 'task', result.task ?? result.id ?? 'task'));
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

  const costBlock = $('ctx-cost-block');
  const costWrap = $('ctx-cost');
  costWrap.textContent = '';
  const cost = costInfo(thread);
  if (cost) {
    costBlock.hidden = false;
    const figures = el('div', 'cost-figures');
    figures.appendChild(el('span', null, '$' + cost.spent.toFixed(2) + ' spent'));
    figures.appendChild(el('span', null, cost.ceiling === null ? 'no ceiling' : '$' + cost.ceiling.toFixed(2) + ' ceiling'));
    costWrap.appendChild(figures);
    if (cost.ceiling !== null && cost.ceiling > 0) {
      const meter = el('div', 'cost-meter');
      const fill = el('div', 'cost-fill');
      fill.style.width = Math.min(100, (cost.spent / cost.ceiling) * 100).toFixed(1) + '%';
      meter.appendChild(fill);
      costWrap.appendChild(meter);
    }
  } else {
    costBlock.hidden = true;
  }
}

// ---------- rendering: files tab ----------

function renderFiles() {
  const threadId = currentThreadId();
  const thread = threadId ? state.threads.get(threadId) ?? null : null;
  const list = $('file-list');
  list.textContent = '';
  const paths = thread?.workspace?.changed ?? [];
  if (!paths.length) {
    list.appendChild(el('div', 'side-empty', thread
      ? 'No changed files in this run.'
      : 'Open a thread to browse its workspace.'));
  }
  for (const path of paths) {
    const row = el('button', 'file-row');
    row.type = 'button';
    row.textContent = path;
    row.title = path;
    row.classList.toggle('is-active', state.files.path === path);
    row.addEventListener('click', () => openFile(path));
    list.appendChild(row);
  }
  $('file-path').disabled = !thread;
  $('file-form').querySelector('button').disabled = !thread;

  const name = $('file-name');
  const content = $('file-content');
  if (!state.files.path) {
    name.textContent = '';
    content.className = 'file-content empty';
    content.textContent = thread
      ? 'Pick a changed file, or open any path from refs/heads/protected.'
      : 'No thread open.';
    return;
  }
  name.textContent = state.files.path;
  const cacheKey = threadId + '|' + state.files.path;
  if (state.files.cache.has(cacheKey)) {
    content.className = 'file-content';
    content.textContent = state.files.cache.get(cacheKey);
    return;
  }
  content.className = 'file-content empty';
  content.textContent = 'Loading ' + state.files.path + ' ...';
  fetchFile(threadId, state.files.path).then(text => {
    state.files.cache.set(cacheKey, text);
    if (state.view.kind === 'files' && state.files.path) renderFiles();
  }).catch(error => {
    content.className = 'file-content empty';
    content.textContent = error.message;
  });
}

function openFile(path) {
  state.files.path = path;
  if (state.view.kind !== 'files') navigate({ kind: 'files' });
  else renderAll();
}

// ---------- top-level render ----------

function renderAll() {
  renderTabs();
  renderSidebar();
  renderThreadHead();
  renderTranscript();
  renderComposer();
  renderContext();
  const isFiles = state.view.kind === 'files';
  $('files-view').hidden = !isFiles;
  $('thread-view').hidden = isFiles;
  if (isFiles) renderFiles();
  $('nav-back').disabled = !state.back.length;
  $('nav-forward').disabled = !state.forward.length;
}

async function openThread(id) {
  navigate({ kind: 'thread', id });
  try {
    await fetchThread(id);
  } catch {
    pushLocalError('Cannot load thread ' + id + '.');
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
        renderTabs();
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
  $('new-task').addEventListener('click', () => navigate({ kind: 'new' }));
  $('tab-add').addEventListener('click', () => navigate({ kind: 'new' }));
  $('tab-files').addEventListener('click', () => navigate({ kind: 'files' }));
  $('project-row').addEventListener('click', () => navigate({ kind: 'files' }));
  $('nav-back').addEventListener('click', goBack);
  $('nav-forward').addEventListener('click', goForward);
  $('theme-toggle').addEventListener('click', () => {
    applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
  });
  $('send').addEventListener('click', () => { createThread().catch(() => {}); });
  $('goal').addEventListener('keydown', event => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      createThread().catch(() => {});
    }
  });
  $('mode').addEventListener('change', renderModeNote);
  $('file-form').addEventListener('submit', event => {
    event.preventDefault();
    const path = $('file-path').value.trim();
    if (path) openFile(path);
  });
}

// ---------- boot ----------

async function boot() {
  initTheme();
  bindUi();
  connectEvents();
  try {
    await Promise.all([fetchState(), fetchTasks()]);
  } catch {
    pushLocalError('The Verity backend is not answering.');
    return;
  }
  renderAll();
}

boot();
