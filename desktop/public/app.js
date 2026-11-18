// Verity desktop renderer. Vanilla DOM against the desktop/server.mjs contract.
//
// Data shapes (from desktop/server.mjs):
//   state   { hostname, threads: ThreadSummary[], pi: { ready, reason?, ceilingUsd? } }
//   summary { id, title, taskId, mode, status, createdAt, messages: number }
//   thread  summary + messages: Message[], results?: Result[], workspace?: Workspace
//   message { role: user|system|agent|result|error, text?, data?: Result, ts }
//   result  { task, status: promoted|refused|blocked, detail, operation?,
//             commit?, assurance? }
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

// The three wire protocols the backend accepts, with the labels users see.
const PROTOCOLS = {
  'openai-completions': 'OpenAI Chat Completions',
  'openai-responses': 'OpenAI Responses',
  'anthropic-messages': 'Anthropic Messages',
};

const state = {
  // Independent boot sections: each settles on its own so one failure never
  // blanks the other two or gets mislabeled as a failed run.
  boot: { state: 'pending', stateError: null, tasks: 'pending', tasksError: null },
  settings: {
    phase: 'pending', // pending | ok | error
    error: null,
    open: false,
    tab: 'general',
    data: { providers: [], defaultProviderId: null, costCeilingUsd: null, credentialStorage: { available: true } },
    draft: null, // { providers, defaultProviderId } unsaved providers edits
    dirty: false,
    form: null, // provider entry being added/edited; apiKey lives only here transiently
  },
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
    const input = $('theme-' + choice);
    input.classList.toggle('is-active', state.appearance === choice);
    // Native radios carry the selected state; the class only mirrors it for
    // the check harness.
    input.checked = state.appearance === choice;
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

// ---------- settings wire boundary ----------

// GET /api/settings: { providers: ProviderView[], defaultProviderId,
// costCeilingUsd, credentialStorage }. The backend never returns key
// material; anything else is an interface mismatch we surface, not guess.
async function fetchSettings() {
  let response;
  try {
    response = await fetch('/api/settings');
  } catch {
    throw new Error('The Verity backend is not answering.');
  }
  if (response.status === 404) {
    throw new Error('This backend does not serve /api/settings yet, so provider setup is unavailable.');
  }
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? ('Request failed with HTTP ' + response.status));
  state.settings.data = normalizeSettings(body);
}

function normalizeSettings(body) {
  const protocols = Object.keys(PROTOCOLS);
  const providers = (Array.isArray(body?.providers) ? body.providers : []).map(entry => {
    if (!entry || typeof entry.id !== 'string' || typeof entry.label !== 'string') {
      throw new Error('The backend sent a malformed provider entry.');
    }
    if (!protocols.includes(entry.protocol)) {
      throw new Error(`The backend sent unknown protocol "${entry.protocol}" for provider ${entry.id}.`);
    }
    return {
      id: entry.id,
      label: entry.label,
      protocol: entry.protocol,
      baseUrl: String(entry.baseUrl ?? ''),
      modelId: String(entry.modelId ?? ''),
      hasApiKey: Boolean(entry.hasApiKey),
    };
  });
  const ids = new Set(providers.map(provider => provider.id));
  const defaultProviderId = body?.defaultProviderId != null && ids.has(body.defaultProviderId)
    ? body.defaultProviderId
    : null;
  const ceiling = body?.costCeilingUsd;
  if (ceiling != null && !(typeof ceiling === 'number' && Number.isFinite(ceiling) && ceiling > 0)) {
    throw new Error('The backend sent an invalid spending ceiling.');
  }
  const credential = body?.credentialStorage ?? {};
  return {
    providers,
    defaultProviderId,
    costCeilingUsd: ceiling ?? null,
    credentialStorage: { available: Boolean(credential.available), reason: credential.reason },
  };
}

// One PUT path for both Settings saves: full-list replacement per contract.
// Saved keys are never sent back; apiKey is included only when freshly typed.
async function putSettings(payload, errorElementId) {
  try {
    const body = await fetchJson('/api/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    state.settings.data = normalizeSettings(body);
    state.settings.draft = null;
    state.settings.dirty = false;
    state.settings.form = null;
    state.settings.phase = 'ok';
    clearProviderKeyInput();
    await loadStateSection();
    renderAll();
    return true;
  } catch (error) {
    $(errorElementId).textContent = error.message ?? 'Saving settings failed.';
    return false;
  }
}

// Single source for the ceiling: blank means unconfigured (null), anything
// else must be a finite positive number before paid runs may start.
function readCeiling() {
  const raw = $('ceiling-input').value.trim();
  if (raw === '') return { value: null };
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return { error: 'The spending ceiling must be a positive number of US dollars, or blank to leave spending disabled.' };
  }
  return { value: parsed };
}

function providersToInput(providers) {
  return providers.map(provider => {
    const input = {
      id: provider.id,
      label: provider.label,
      protocol: provider.protocol,
      baseUrl: provider.baseUrl,
      modelId: provider.modelId,
    };
    if (provider.apiKey) input.apiKey = provider.apiKey;
    return input;
  });
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
  // Run failures only: startup section failures render in the boot notice so
  // a dead backend or broken catalog is never mislabeled as an executed run.
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

// ---------- boot sections ----------

// Each boot section settles independently; a failure records its own error
// and leaves the other sections usable.
async function loadStateSection() {
  try {
    await fetchState();
    state.boot.state = 'ok';
    state.boot.stateError = null;
  } catch (error) {
    state.boot.state = 'error';
    state.boot.stateError = error.message;
  }
}

async function loadTasksSection() {
  try {
    await fetchTasks();
    state.boot.tasks = 'ok';
    state.boot.tasksError = null;
  } catch (error) {
    state.boot.tasks = 'error';
    state.boot.tasksError = error.message;
  }
}

async function loadSettingsSection() {
  state.settings.phase = 'pending';
  try {
    await fetchSettings();
    state.settings.phase = 'ok';
    state.settings.error = null;
  } catch (error) {
    state.settings.phase = 'error';
    state.settings.error = error.message;
  }
}

function failedBootSections() {
  const failed = [];
  if (state.boot.state === 'error') {
    failed.push(['The Verity backend is unreachable, so threads and run status are unavailable.', state.boot.stateError]);
  }
  if (state.boot.tasks === 'error') {
    failed.push(['The task catalog failed to load, so the demo task list is unavailable.', state.boot.tasksError]);
  }
  return failed;
}

function renderBootNotice() {
  const notice = $('boot-notice');
  const failed = failedBootSections();
  if (!failed.length) {
    notice.hidden = true;
    return;
  }
  notice.hidden = false;
  $('boot-text').textContent = failed.map(entry => entry[0]).join(' ');
  $('boot-detail').textContent = failed.map(entry => entry[1]).join(' | ');
}

async function retryFailedSections() {
  const jobs = [];
  if (state.boot.state === 'error') jobs.push(loadStateSection());
  if (state.boot.tasks === 'error') jobs.push(loadTasksSection());
  if (state.settings.phase === 'error') jobs.push(loadSettingsSection());
  await Promise.all(jobs);
  renderAll();
}

// ---------- rendering: shell chrome ----------

function renderSidebar() {
  $('host').textContent = state.hostname || 'unknown host';
  const list = $('thread-list');
  list.textContent = '';
  if (state.boot.state === 'error') {
    list.appendChild(el('div', 'side-empty', 'Threads unavailable: the backend is unreachable.'));
    return;
  }
  if (!state.summaries.length) {
    list.appendChild(el('div', 'side-empty', 'No threads yet.'));
    return;
  }
  for (const summary of state.summaries) {
    const row = el('md-list-item', 'thread-row');
    row.type = 'button';
    row.classList.toggle('is-active', state.view.kind === 'thread' && state.view.id === summary.id);
    const dot = el('span', 'dot ' + (DOTS[summary.status] ?? 'dot-queued'));
    dot.title = summary.status ?? 'queued';
    dot.slot = 'start';
    row.appendChild(dot);
    const title = el('span', 'title', summary.title || 'Untitled');
    title.slot = 'headline';
    row.appendChild(title);
    const count = el('span', 'count', String(summary.messages ?? 0));
    count.slot = 'end';
    row.appendChild(count);
    row.addEventListener('click', () => { closePanes(); openThread(summary.id); });
    list.appendChild(row);
  }
}

function renderComposer() {
  const select = $('task');
  const previous = select.value;
  select.textContent = '';
  if (!state.tasks.length) {
    const option = document.createElement('md-select-option');
    option.value = '';
    option.headline = 'No tasks available';
    select.appendChild(option);
    select.disabled = true;
  } else {
    select.disabled = false;
    for (const task of state.tasks) {
      const option = document.createElement('md-select-option');
      option.value = task.id;
      option.headline = task.id + ' - ' + task.goal;
      option.title = task.goal;
      select.appendChild(option);
    }
    if (state.tasks.some(task => task.id === previous)) select.value = previous;
    else if (state.tasks.some(task => task.id === 'messages')) select.value = 'messages';
    else select.value = state.tasks[0].id;
  }

  const piOption = $('mode').querySelector('md-select-option[value="pi"]');
  piOption.disabled = !state.pi.ready;
  piOption.title = state.pi.ready ? 'Runs the real Pi agent loop' : (state.pi.reason ?? 'Pi is not configured');

  const routeLabel = $('route-label');
  if (state.boot.state === 'error') {
    routeLabel.textContent = 'Backend unreachable';
  } else if (state.boot.state === 'pending') {
    routeLabel.textContent = 'Checking…';
  } else {
    const piSelected = $('mode').value === 'pi';
    const ready = piSelected ? state.pi.ready : true;
    routeLabel.textContent = piSelected
      ? (state.pi.ready ? 'Pi ready' : 'Pi unavailable')
      : 'Demo ready';
    $('route-dot').className = 'dot ' + (ready ? 'dot-done' : 'dot-queued');
  }
  renderProviderStatus();
  renderModeNote();
}

// Composer status of the configured route, derived from /api/settings only.
function renderProviderStatus() {
  const status = $('provider-status');
  const setup = $('provider-setup');
  const settings = state.settings;
  if (settings.phase === 'error') {
    status.textContent = 'Provider settings unavailable';
    setup.hidden = false;
    return;
  }
  if (settings.phase !== 'ok') {
    status.textContent = settings.phase === 'pending' ? 'Checking providers…' : '';
    setup.hidden = true;
    return;
  }
  const providers = settings.data.providers;
  const def = providers.find(provider => provider.id === settings.data.defaultProviderId);
  if (def) {
    status.textContent = `${def.label} · ${def.modelId}`;
    setup.hidden = true;
  } else {
    status.textContent = providers.length ? 'No default provider selected' : 'No provider configured';
    setup.hidden = false;
  }
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

function renderResultDetails(data) {
  const disclosure = el('details', 'result-details');
  disclosure.appendChild(el('summary', null, 'Details'));
  const list = el('div', 'result-exact');
  const rows = [];
  if (data.operation) rows.push(['Operation', String(data.operation)]);
  if (data.commit) rows.push(['Commit', String(data.commit)]);
  if (data.assurance) rows.push(['Assurance', JSON.stringify(data.assurance)]);
  if (data.detail) rows.push(['Result', String(data.detail)]);
  for (const [key, value] of rows) {
    const row = el('div', 'result-row');
    row.appendChild(el('span', 'k', key));
    row.appendChild(el('span', 'v', value));
    list.appendChild(row);
  }
  disclosure.appendChild(list);
  return disclosure;
}

function renderMessage(message) {
  if (message.role === 'result') {
    const data = message.data ?? {};
    const card = el('div', 'msg msg-result');
    const head = el('div', 'head');
    head.appendChild(el('span', 'task', data.task ?? 'task'));
    head.appendChild(chip(RESULT_CHIPS, data.status, data.status));
    card.appendChild(head);
    // Legacy details can include raw receipts; keep them inside the disclosure.
    const detail = el('div', 'detail');
    detail.appendChild(richText(
      data.status === 'promoted'
        ? (data.commit ? `Promoted as ${String(data.commit).slice(0, 8)}` : RESULT_CHIPS.promoted[1])
        : (data.detail ?? ''),
    ));
    card.appendChild(detail);
    card.appendChild(renderResultDetails(data));
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
  $('run-progress').hidden = status !== 'running';
}

// ---------- rendering: inspector ----------

function renderContext() {
  const thread = currentThread();

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
    const row = el('md-list-item', 'file-row');
    row.type = 'button';
    const label = el('span', null, path);
    label.slot = 'headline';
    row.appendChild(label);
    row.title = path;
    row.classList.toggle('is-active', state.files.path === path);
    row.addEventListener('click', () => { closePanes(); openFile(path); });
    list.appendChild(row);
  }
  $('file-path').disabled = !thread;
  $('file-form').querySelector('md-text-button, button').disabled = !thread;

  const view = $('file-view');
  const details = $('ctx-details');
  const name = $('file-name');
  const content = $('file-content');
  details.hidden = Boolean(state.files.path && thread);
  $('app').classList.toggle('file-open', Boolean(state.files.path && thread));
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

// ---------- settings dialog ----------

const SETTINGS_TABS = ['general', 'appearance', 'providers'];

function copySettingsData() {
  return JSON.parse(JSON.stringify({
    providers: state.settings.data.providers,
    defaultProviderId: state.settings.data.defaultProviderId,
  }));
}

function settingsDraft() {
  state.settings.draft ??= copySettingsData();
  return state.settings.draft;
}

function openSettings(tab) {
  state.settings.tab = SETTINGS_TABS.includes(tab) ? tab : state.settings.tab;
  state.settings.open = true;
  // Remember the control that opened Settings so focus can return to it on
  // close (falls back to the identity button when it disappeared).
  state.settings.opener = (typeof document !== 'undefined' && document.activeElement) || null;
  closeIdentityMenu(false);
  const dialog = $('settings-dialog');
  if (typeof dialog.showModal === 'function') dialog.showModal();
  renderSettings();
  const active = $('settings-nav-' + state.settings.tab);
  if (typeof active.focus === 'function') active.focus();
}

// Focus returns to the visible opener; if it disappeared (menu item inside
// a closed menu, a setup button hidden after a successful save), fall back
// to the stable identity button.
function restoreSettingsFocus() {
  const opener = state.settings.opener;
  state.settings.opener = null;
  const visible = opener && typeof opener.focus === 'function' && !opener.hidden
    && (opener.offsetParent === undefined || opener.offsetParent !== null);
  const target = visible ? opener : $('identity-btn');
  if (target && typeof target.focus === 'function') target.focus();
}

function closeSettings() {
  state.settings.open = false;
  const dialog = $('settings-dialog');
  if (typeof dialog.close === 'function' && dialog.open) dialog.close();
  state.settings.form = null;
  state.settings.draft = null;
  state.settings.dirty = false;
  clearProviderKeyInput();
  $('provider-form').hidden = true;
  restoreSettingsFocus();
}

// Keys never live anywhere but the transient password input and the PUT
// body; this runs on save success, cancel, and dialog close.
function clearProviderKeyInput() {
  const key = $('provider-api-key');
  if (key) key.value = '';
}

function setSettingsTab(tab) {
  if (!SETTINGS_TABS.includes(tab)) return;
  state.settings.tab = tab;
  renderSettings();
}

function renderSettings() {
  const tab = state.settings.tab;
  $('settings-section-title').textContent = { general: 'General', appearance: 'Appearance', providers: 'Providers' }[tab];
  for (const name of SETTINGS_TABS) {
    $('settings-section-' + name).hidden = name !== tab;
    const nav = $('settings-nav-' + name);
    nav.classList.toggle('is-active', name === tab);
    nav.setAttribute?.('aria-current', name === tab ? 'true' : 'false');
  }
  renderSettingsGeneral();
  renderSettingsProviders();
}

function renderSettingsGeneral() {
  const input = $('ceiling-input');
  if (typeof document !== 'undefined' && document.activeElement !== input) {
    input.value = state.settings.data.costCeilingUsd ?? '';
  }
}

function renderSettingsProviders() {
  const section = $('provider-list');
  const dirtyBadge = $('provider-dirty');
  const credStatus = $('cred-status');
  $('provider-error').textContent = '';
  const settings = state.settings;
  if (settings.phase === 'error') {
    credStatus.textContent = '';
    section.textContent = '';
    section.appendChild(el('div', 'side-empty', settings.error ?? 'Provider settings are unavailable.'));
    $('settings-retry').hidden = false;
    dirtyBadge.hidden = true;
    return;
  }
  $('settings-retry').hidden = true;
  const stored = settings.data.credentialStorage;
  // A reason may arrive with its own trailing period; strip it so the fixed
  // sentence structure never renders a double period.
  const reason = stored.reason ? String(stored.reason).trim().replace(/\.+\s*$/, '') : '';
  credStatus.textContent = stored.available
    ? 'Saved keys are stored in protected local storage on this device.'
    : `Protected key storage is unavailable${reason ? ': ' + reason : ''}. Keys can still be used for runs from this session.`;
  credStatus.classList.toggle('cred-warn', !stored.available);

  const draft = settings.phase === 'ok' ? settingsDraft() : null;
  const providers = draft?.providers ?? [];
  section.textContent = '';
  if (!providers.length) {
    section.appendChild(el('div', 'side-empty', 'No providers configured. Add one to route runs to a model.'));
  }
  for (const provider of providers) {
    section.appendChild(renderProviderRow(provider, draft));
  }
  section.appendChild(renderNoDefaultRow(draft));
  dirtyBadge.hidden = !state.settings.dirty;
}

function renderNoDefaultRow(draft) {
  const row = el('div', 'provider-row provider-row-none');
  const radio = document.createElement('input');
  radio.type = 'radio';
  radio.name = 'default-provider';
  radio.value = '';
  radio.id = 'default-none';
  radio.checked = draft.defaultProviderId == null;
  radio.addEventListener('change', () => {
    if (radio.checked) { draft.defaultProviderId = null; state.settings.dirty = true; }
    renderSettingsProviders();
  });
  const radioLabel = el('label', 'provider-default-label');
  radioLabel.appendChild(radio);
  radioLabel.appendChild(document.createTextNode('No default'));
  row.appendChild(radioLabel);
  row.appendChild(el('span', 'provider-meta', 'Runs refuse to start until a default provider is chosen.'));
  return row;
}

function renderProviderRow(provider, draft) {
  const row = el('div', 'provider-row');
  const radio = document.createElement('input');
  radio.type = 'radio';
  radio.name = 'default-provider';
  radio.value = provider.id;
  radio.id = 'default-' + provider.id;
  radio.checked = draft.defaultProviderId === provider.id;
  radio.addEventListener('change', () => {
    if (radio.checked) { draft.defaultProviderId = provider.id; state.settings.dirty = true; }
    renderSettingsProviders();
  });
  const radioLabel = el('label', 'provider-default-label');
  radioLabel.appendChild(radio);
  radioLabel.appendChild(document.createTextNode('Default'));
  row.appendChild(radioLabel);

  const text = el('div', 'provider-text');
  text.appendChild(el('span', 'provider-name', provider.label));
  const keyState = provider.apiKey ? ' · key set (unsaved)' : provider.hasApiKey ? ' · key saved' : ' · no key';
  text.appendChild(el('span', 'provider-meta', `${PROTOCOLS[provider.protocol] ?? provider.protocol} · ${provider.modelId}${keyState}`));
  row.appendChild(text);

  const edit = el('md-text-button', null, 'Edit');
  edit.type = 'button';
  edit.id = 'edit-' + provider.id;
  edit.addEventListener('click', () => openProviderForm(provider.id));
  row.appendChild(edit);

  // A staged (typed but unsaved) key can be dropped on its own without
  // canceling the other draft edits, and without touching the saved key.
  if (provider.apiKey) {
    const clearKey = el('md-text-button', null, 'Clear staged key');
    clearKey.type = 'button';
    clearKey.id = 'clear-key-' + provider.id;
    clearKey.addEventListener('click', () => {
      const staged = state.settings.draft?.providers.find(entry => entry.id === provider.id);
      if (staged) delete staged.apiKey;
      state.settings.dirty = true;
      renderSettingsProviders();
    });
    row.appendChild(clearKey);
  }

  const remove = el('md-text-button', 'provider-delete', 'Delete');
  remove.type = 'button';
  remove.id = 'delete-' + provider.id;
  remove.addEventListener('click', () => {
    if (remove.dataset.armed !== '1') {
      remove.dataset.armed = '1';
      remove.textContent = 'Confirm delete';
      return;
    }
    state.settings.draft.providers = state.settings.draft.providers.filter(entry => entry.id !== provider.id);
    if (state.settings.draft.defaultProviderId === provider.id) state.settings.draft.defaultProviderId = null;
    state.settings.dirty = true;
    renderSettingsProviders();
  });
  row.appendChild(remove);
  return row;
}

function openProviderForm(id) {
  const draft = settingsDraft();
  const existing = id ? draft.providers.find(provider => provider.id === id) ?? null : null;
  state.settings.form = existing
    ? { id: existing.id, label: existing.label, protocol: existing.protocol, baseUrl: existing.baseUrl, modelId: existing.modelId }
    : { id: null };
  $('provider-label').value = existing?.label ?? '';
  $('provider-protocol').value = existing?.protocol ?? 'openai-completions';
  $('provider-base-url').value = existing?.baseUrl ?? '';
  $('provider-model').value = existing?.modelId ?? '';
  // Existing saved keys are never filled back into the UI.
  clearProviderKeyInput();
  const indicator = $('key-indicator');
  indicator.hidden = !(existing?.hasApiKey || existing?.apiKey);
  indicator.textContent = existing?.apiKey
    ? 'An unsaved key is staged for this provider. Leave blank to keep it, or clear it from the provider list.'
    : existing?.hasApiKey ? 'A key is already saved for this provider. Leave blank to keep it.' : '';
  $('provider-form-error').textContent = '';
  $('provider-form').hidden = false;
  $('provider-label').focus?.();
}

function closeProviderForm() {
  state.settings.form = null;
  $('provider-form').hidden = true;
  clearProviderKeyInput();
}

// Material fields own their error state (red outline plus error text, wired
// to the internal input's aria-invalid), so the form drives that API.
function setRequiredFieldValidity(invalidIds) {
  const all = ['provider-label', 'provider-base-url', 'provider-model'];
  for (const fieldId of all) {
    const field = $(fieldId);
    const invalid = invalidIds ? invalidIds.includes(fieldId) : false;
    field.error = invalid;
    field.errorText = invalid ? 'Required.' : '';
  }
}

function applyProviderForm() {
  const form = state.settings.form;
  if (!form) return;
  const label = $('provider-label').value.trim();
  const protocol = $('provider-protocol').value;
  const baseUrl = $('provider-base-url').value.trim();
  const modelId = $('provider-model').value.trim();
  const apiKey = $('provider-api-key').value;
  const missing = [
    ['provider-label', label],
    ['provider-base-url', baseUrl],
    ['provider-model', modelId],
  ].filter(([, value]) => !value).map(([fieldId]) => fieldId);
  const problem = !PROTOCOLS[protocol] ? 'Choose one of the three supported protocols.'
    : missing.length ? 'Name, base URL and model are required.'
    : null;
  if (problem) {
    $('provider-form-error').textContent = problem;
    setRequiredFieldValidity(missing);
    return;
  }
  setRequiredFieldValidity(null);
  const draft = settingsDraft();
  // The saved-key flag is view-only state that must survive edits: a fresh
  // entry object would otherwise make an edited provider look keyless even
  // though its saved key is preserved server-side.
  const previous = form.id ? draft.providers.find(provider => provider.id === form.id) : null;
  const entry = { id: form.id ?? newProviderId(), label, protocol, baseUrl, modelId, hasApiKey: Boolean(previous?.hasApiKey) };
  if (apiKey) entry.apiKey = apiKey;
  else if (previous?.apiKey) {
    // Keep an unsaved typed key from a previous apply; saved keys stay server-side.
    entry.apiKey = previous.apiKey;
  }
  state.settings.draft.providers = form.id
    ? draft.providers.map(provider => (provider.id === form.id ? entry : provider))
    : [...draft.providers, entry];
  state.settings.dirty = true;
  closeProviderForm();
  renderSettingsProviders();
}

function newProviderId() {
  let id;
  do { id = 'prov-' + Math.random().toString(36).slice(2, 10); }
  while (state.settings.draft?.providers.some(provider => provider.id === id));
  return id;
}

function revertProviderDraft() {
  state.settings.draft = null;
  state.settings.dirty = false;
  closeProviderForm();
  renderSettingsProviders();
}

async function saveProviderDraft() {
  const draft = settingsDraft();
  const ceiling = readCeiling();
  if (ceiling.error) {
    $('provider-error').textContent = ceiling.error;
    return;
  }
  const saved = await putSettings({
    providers: providersToInput(draft.providers),
    defaultProviderId: draft.defaultProviderId,
    costCeilingUsd: ceiling.value,
  }, 'provider-error');
  if (saved) closeProviderForm();
}

async function saveGeneral() {
  const ceiling = readCeiling();
  if (ceiling.error) {
    $('general-error').textContent = ceiling.error;
    return;
  }
  $('general-error').textContent = '';
  const current = state.settings.draft ?? copySettingsData();
  await putSettings({
    providers: providersToInput(current.providers),
    defaultProviderId: current.defaultProviderId,
    costCeilingUsd: ceiling.value,
  }, 'general-error');
}

// ---------- identity menu (bottom-left, opens upward) ----------
// The Material menu owns its surface, anchor placement (it flips above the
// bottom-left button) and outside-click dismissal; this only mirrors the
// trigger's aria-expanded state and the explicit focus contract.

function toggleIdentityMenu(open) {
  const menu = $('identity-menu');
  const show = open ?? !menu.open;
  if (!show) { closeIdentityMenu(false); return; }
  menu.open = true;
  $('identity-btn').setAttribute?.('aria-expanded', 'true');
  $('menu-settings')?.focus?.();
}

function closeIdentityMenu(refocus) {
  const menu = $('identity-menu');
  if (!menu.open) return;
  menu.open = false;
  $('identity-btn').setAttribute?.('aria-expanded', 'false');
  if (refocus) $('identity-btn')?.focus?.();
}

// ---------- top-level render ----------

function renderAll() {
  renderSidebar();
  renderThreadHead();
  renderTranscript();
  renderComposer();
  renderContext();
  renderFiles();
  renderBootNotice();
  if (state.settings.open) renderSettings();
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
  $('identity-btn').addEventListener('click', () => toggleIdentityMenu());
  $('menu-settings').addEventListener('click', () => { toggleIdentityMenu(false); openSettings('general'); });
  $('provider-setup').addEventListener('click', () => openSettings('providers'));
  for (const tab of SETTINGS_TABS) {
    $('settings-nav-' + tab).addEventListener('click', () => setSettingsTab(tab));
  }
  $('settings-close').addEventListener('click', closeSettings);
  $('settings-dialog').addEventListener('close', closeSettings);
  $('settings-dialog').addEventListener('click', event => {
    // A click on the dialog itself is a backdrop click; close without losing saved state.
    if (event.target === $('settings-dialog')) closeSettings();
  });
  $('general-save').addEventListener('click', () => { saveGeneral(); });
  $('provider-add').addEventListener('click', () => openProviderForm(null));
  $('provider-apply').addEventListener('click', applyProviderForm);
  $('provider-cancel-form').addEventListener('click', closeProviderForm);
  for (const fieldId of ['provider-label', 'provider-base-url', 'provider-model']) {
    // Material text fields re-emit the native input event at the host, so
    // typing clears the field-level error state immediately.
    $(fieldId).addEventListener('input', () => {
      $(fieldId).error = false;
      $(fieldId).errorText = '';
    });
  }
  $('provider-revert').addEventListener('click', revertProviderDraft);
  $('provider-save-changes').addEventListener('click', () => { saveProviderDraft(); });
  $('settings-retry')?.addEventListener?.('click', () => { loadSettingsSection().then(renderAll); });
  $('boot-retry').addEventListener('click', () => { retryFailedSections(); });
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
  $('mode').addEventListener('change', renderComposer);
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
      if (event.key !== 'Escape') return;
      const menu = $('identity-menu');
      if (menu.open) {
        // Claim Escape before the menu closes itself mid-bubble so the file
        // view and panes stay put behind it.
        event.preventDefault?.();
        event.stopPropagation?.();
        closeIdentityMenu(true);
        return;
      }
      const active = document.activeElement;
      // An open Material select dismisses its own menu on this key first.
      if (active && active.open) return;
      if ($('settings-dialog').open) return; // the dialog handles Escape
      if (state.files.path) {
        state.files.path = null;
        renderFiles();
        return;
      }
      closePanes();
    }, true);
    document.addEventListener('click', event => {
      const menu = $('identity-menu');
      if (!menu.open) return;
      const target = event.target;
      if (target && (menu.contains?.(target) || $('identity-btn').contains?.(target))) return;
      closeIdentityMenu(false);
    });
  }
}

// ---------- boot ----------

// Sections settle independently: a failed catalog or dead backend renders
// its own recovery path instead of leaving "Checking…" and a blank dropdown.
async function boot() {
  initTheme();
  bindUi();
  connectEvents();
  await Promise.all([loadStateSection(), loadTasksSection(), loadSettingsSection()]);
  renderAll();
}

boot();
