import { compactInstructions, ComposerRecall, insertAtSelection } from "./composer.mjs";

const request = window.pi.request;
const byId = (id) => document.getElementById(id);
const open = byId("open");
const newChat = byId("new");
const clone = byId("clone");
const fork = byId("fork");
const exportHtml = byId("export");
const chat = byId("chat");
const message = byId("message");
const attach = byId("attach");
const detach = byId("detach");
const model = byId("model");
const thinking = byId("thinking");
const send = byId("send");
const completionList = byId("completions");
const error = byId("error");
const notice = byId("notice");
const sessionRow = byId("session");
const sessionNameEl = byId("session-name");
const renameBtn = byId("rename");
const usageEl = byId("usage");
const toolActivity = byId("tool-activity");
const forkDialog = byId("fork-dialog");
const forkMessages = byId("fork-messages");
const forkCancel = byId("fork-cancel");
const settings = byId("settings");
const settingsDialog = byId("settings-dialog");
const providerForm = byId("provider-form");
const providerFields = byId("provider-fields");
const providerProfile = byId("provider-profile");
const providerNote = byId("provider-note");
const providerRemove = byId("provider-remove");
const queue = byId("queue");
const steer = byId("steer");
const followUp = byId("follow-up");
const clearQueue = byId("clear-queue");
const recall = new ComposerRecall();
let ready = false;
let busy = false;
let compacting = false;
let pending = false;
let pendingCount = 0;
let persisted = false;
let history = [];
let commands = [];
let stream;
let activeSessionName = "";
let renaming = false;
let profiles = [];
const runningTools = new Map();

function renderTools() {
  toolActivity.replaceChildren(...[...runningTools.values()].map((name) => {
    const item = document.createElement("span");
    item.className = "tool-activity-item";
    item.textContent = name;
    return item;
  }));
  toolActivity.hidden = runningTools.size === 0;
}

function controls() {
  open.disabled = busy || pending;
  settings.disabled = pending;
  for (const control of [model, thinking, newChat, attach, detach]) control.disabled = !ready || busy || pending;
  clone.disabled = fork.disabled = exportHtml.disabled = !persisted || busy || pending;
  for (const button of byId("sessions").children) button.disabled = busy || pending;
  renameBtn.disabled = !ready || busy || pending || renaming || sessionRow.hidden;
  message.disabled = !ready;
  const text = message.value;
  const hasText = Boolean(text.trim());
  const compact = compactInstructions(text) !== null;
  const canSend = hasText && (model.value || (!compact && text.startsWith("/")));
  send.disabled = !ready || pending || (!busy && !canSend);
  const label = busy ? "Stop response" : "Send message";
  send.textContent = busy ? "■" : "↑";
  send.title = label;
  send.setAttribute("aria-label", label);
  queue.hidden = !busy && !pendingCount;
  steer.hidden = followUp.hidden = !busy;
  steer.disabled = followUp.disabled = !busy || pending || compact || !hasText;
  clearQueue.hidden = !pendingCount;
  clearQueue.disabled = pending;
  byId("pending").textContent = pendingCount ? `${pendingCount} queued` : "";
  byId("status").textContent = compacting ? "Compacting context" : busy ? "Responding" : ready ? "Read-only built-in tools" : "";
}

function appendMessage(role, text) {
  const item = document.createElement("article");
  item.className = role;
  item.textContent = text;
  chat.append(item);
  item.scrollIntoView({ block: "end" });
  return item;
}

async function refresh() {
  const state = await request("state");
  model.value = state.model;
  thinking.replaceChildren(...state.thinking.levels.map((level) => new Option(
    level === "xhigh" ? "Extra high" : level[0].toUpperCase() + level.slice(1), level,
  )));
  thinking.hidden = state.thinking.levels.length < 2;
  thinking.value = state.thinking.level;
  busy = state.active;
  pendingCount = state.pending;
  history = state.messages.filter(({ role }) => role === "user").map(({ text }) => text).reverse();
  stream = undefined;
  const active = state.sessions.find((session) => session.id === state.id);
  persisted = Boolean(active);
  activeSessionName = state.name;
  chat.replaceChildren();
  for (const item of state.messages) if (item.text) appendMessage(item.role, item.text);
  if (!chat.childElementCount) {
    const title = document.createElement("h1");
    title.textContent = "What are you working on?";
    chat.append(title);
  }
  const rows = state.sessions.map(({ id, title }) => {
    const button = document.createElement("button");
    button.textContent = title || "Conversation";
    button.title = button.textContent;
    if (id === state.id) button.setAttribute("aria-current", "true");
    button.onclick = () => run(async () => {
      await request("resume", id);
      clearDraft();
      await refresh();
    });
    return button;
  });
  byId("sessions").replaceChildren(...rows);
  sessionRow.hidden = !state.id;
  if (!renaming) sessionNameEl.textContent = state.name || active?.title || "New chat";
  const { total, context } = state.usage;
  const contextText = context?.tokens == null ? "" : ` · ${context.tokens} / ${context.contextWindow} context`;
  usageEl.textContent = `${total} tokens${contextText}`;
  controls();
}

function errorText(cause) {
  return String(cause.message || cause).replace(/^Error invoking remote method '[^']+': Error: /, "");
}

function showError(cause) {
  error.textContent = errorText(cause);
  error.hidden = false;
}

async function run(action) {
  if (pending) return;
  pending = true;
  error.hidden = true;
  notice.textContent = "";
  controls();
  try { await action(); } catch (cause) { showError(cause); }
  finally { pending = false; controls(); }
}

function clearDraft() {
  message.value = "";
  detach.hidden = true;
  updateCompletions();
}

function showProvider() {
  const current = profiles.find(({ id }) => id === providerProfile.value);
  for (const field of ["label", "api", "baseUrl", "modelId", "apiKey"]) {
    providerForm.elements[field].value = current?.[field] ?? (field === "api" ? "openai-completions" : "");
  }
  providerForm.elements.apiKey.required = !current;
  providerForm.elements.apiKey.placeholder = current ? "Leave blank to keep the saved key" : "";
  providerForm.elements.api.onchange();
  providerRemove.disabled = !current;
  providerNote.textContent = "";
}

async function listProviders(selected = "") {
  profiles = await request("providers");
  providerProfile.replaceChildren(new Option("Add a provider", ""), ...profiles.map(({ label, id }) => new Option(label, id)));
  providerProfile.value = selected;
  showProvider();
}

async function updateProviders(action) {
  providerFields.disabled = true;
  try {
    await action();
    providerNote.textContent = ready ? "Reopen the project to apply provider changes." : "Provider settings saved.";
  } catch (cause) {
    providerNote.textContent = errorText(cause);
  } finally {
    providerFields.disabled = false;
  }
}

settings.onclick = () => run(async () => {
  await listProviders();
  settingsDialog.showModal();
});
providerProfile.onchange = showProvider;
providerForm.elements.api.onchange = () => {
  providerForm.elements.baseUrl.placeholder = providerForm.elements.api.value === "anthropic-messages"
    ? "https://api.anthropic.com" : "https://api.openai.com/v1";
};
byId("settings-close").onclick = () => settingsDialog.close();
settingsDialog.oncancel = (event) => { if (providerFields.disabled) event.preventDefault(); };
settingsDialog.onclose = () => { providerForm.elements.apiKey.value = ""; };
providerForm.onsubmit = (event) => {
  event.preventDefault();
  const input = Object.fromEntries(new FormData(providerForm));
  if (!input.id) delete input.id;
  providerForm.elements.apiKey.value = "";
  return updateProviders(async () => {
    const saved = await request("saveProvider", input);
    await listProviders(saved.id);
  });
};
providerRemove.onclick = () => updateProviders(async () => {
  await request("removeProvider", providerProfile.value);
  await listProviders();
});

open.onclick = () => run(async () => {
  const project = await request("open");
  if (!project) return;
  ready = true;
  byId("project").textContent = project.cwd.split(/[\\/]/).filter(Boolean).at(-1);
  byId("path").textContent = project.cwd;
  model.replaceChildren(new Option(project.models.length ? "Choose a model" : "Add a provider in Settings", ""),
    ...project.models.map(({ label, value }) => new Option(label, value)));
  clearDraft();
  commands = await request("completions");
  await refresh();
  message.focus();
});
newChat.onclick = () => run(async () => { await request("new"); clearDraft(); await refresh(); message.focus(); });
clone.onclick = () => run(async () => {
  const result = await request("clone");
  if (result.cancelled) return;
  clearDraft();
  await refresh();
  message.focus();
});
fork.onclick = () => run(async () => {
  const messages = await request("forkMessages");
  if (!messages.length) throw new Error("No messages to fork from");
  forkMessages.replaceChildren(...messages.map(({ entryId, text }) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = text;
    button.title = text;
    button.onclick = () => run(async () => {
      forkDialog.close();
      const result = await request("fork", entryId);
      if (result.cancelled) return;
      clearDraft();
      message.value = result.text;
      updateCompletions();
      await refresh();
      message.focus();
    });
    return button;
  }));
  forkDialog.showModal();
});
forkCancel.onclick = () => forkDialog.close();
exportHtml.onclick = () => run(async () => {
  const name = await request("exportHtml");
  if (name) notice.textContent = `Saved ${name}`;
});
model.onchange = () => run(async () => { try { await request("model", model.value); } finally { await refresh(); } });
thinking.onchange = () => run(async () => { try { await request("thinking", thinking.value); } finally { await refresh(); } });
attach.onclick = () => run(async () => {
  const name = await request("attach");
  if (!name) return;
  detach.textContent = `${name} ×`;
  detach.hidden = false;
});
detach.onclick = () => run(async () => { await request("detach"); detach.hidden = true; });
for (const [button, action] of [[steer, "steer"], [followUp, "followUp"]]) {
  button.onclick = () => run(async () => {
    const text = message.value;
    await request(action, text);
    detach.hidden = true;
    if (message.value === text) message.value = "";
    updateCompletions();
    message.focus();
  });
}
clearQueue.onclick = () => run(() => request("clearQueue"));

byId("composer").onsubmit = (event) => {
  event.preventDefault();
  if (send.disabled) return;
  run(async () => {
    if (busy) { await request("stop"); await refresh(); return; }
    const text = message.value;
    compacting = compactInstructions(text) !== null;
    let item;
    if (compacting) controls();
    else {
      chat.querySelector("h1")?.remove();
      item = appendMessage("user", text);
      busy = true;
    }
    try {
      const disposition = await request("send", text);
      if (!compacting) detach.hidden = true;
      if (message.value === text) message.value = "";
      updateCompletions();
      if (disposition === "handled") await refresh();
      if (compacting) notice.textContent = "Context compacted";
    } catch (cause) {
      item?.remove();
      busy = false;
      throw cause;
    } finally {
      compacting = false;
    }
  });
};

function valueAtCaret() {
  return { text: message.value, selection: { start: message.selectionStart, end: message.selectionEnd } };
}

function updateCompletions() {
  const prefix = message.value.match(/^(?:\/|\$)[^\s]*$/)?.[0];
  const matches = prefix ? commands.filter((command) => command.startsWith(prefix)).slice(0, 6) : [];
  completionList.replaceChildren(...matches.map((command) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = command;
    button.onclick = () => {
      message.select();
      const value = command.startsWith("$") ? `/skill:${command.slice(1)} ` : `${command} `;
      const { text, caret } = insertAtSelection(valueAtCaret(), value);
      message.value = text;
      message.setSelectionRange(caret, caret);
      message.focus();
      updateCompletions();
      controls();
    };
    return button;
  }));
  completionList.hidden = !matches.length;
}

message.oninput = () => { updateCompletions(); controls(); };
message.onkeydown = (event) => {
  if (event.isComposing) return;
  if (event.key === "Tab" && !event.shiftKey && !completionList.hidden) {
    event.preventDefault();
    completionList.firstElementChild.click();
  } else if (event.key === "Enter" && !event.shiftKey && !busy) {
    event.preventDefault();
    byId("composer").requestSubmit();
  } else {
    const recalled = recall.handleKeyPress(event, valueAtCaret(), history);
    if (recalled === null) return;
    event.preventDefault();
    message.value = recalled;
    message.oninput();
  }
};

renameBtn.onclick = () => {
  if (renameBtn.disabled) return;
  const title = sessionNameEl.textContent;
  renaming = true;
  controls();
  const input = document.createElement("input");
  input.type = "text";
  input.id = "rename-input";
  input.value = activeSessionName;
  input.setAttribute("aria-label", "Conversation name");
  sessionNameEl.replaceChildren(input);
  input.focus();
  input.select();
  const close = () => {
    if (!renaming) return;
    renaming = false;
    sessionNameEl.textContent = title;
    controls();
  };
  input.onkeydown = (event) => {
    if (event.isComposing || (event.key !== "Enter" && event.key !== "Escape")) return;
    event.preventDefault();
    const name = event.key === "Enter" ? input.value.trim() : "";
    close();
    renameBtn.focus();
    if (name) run(async () => {
      await request("rename", name);
      await refresh();
    });
  };
  input.onblur = close;
};

window.pi.onEvent(({ type, delta, count, toolCallId, toolName, message: problem }) => {
  if (type === "text") {
    stream ??= appendMessage("assistant", "");
    stream.append(delta);
    stream.scrollIntoView({ block: "end" });
  } else if (type === "tool_execution_start") {
    runningTools.set(toolCallId, toolName);
    renderTools();
  } else if (type === "tool_execution_end") {
    runningTools.delete(toolCallId);
    renderTools();
  } else if (type === "error") {
    showError(problem);
  } else if (type === "queue") {
    pendingCount = count;
    controls();
  } else if (type === "response") {
    stream = undefined;
  } else if (type === "settled") {
    runningTools.clear();
    renderTools();
    refresh().catch(showError);
  }
});
