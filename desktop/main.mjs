import { app, BrowserWindow, dialog, ipcMain, net, protocol, safeStorage } from "electron";
import { readFile, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RpcClient, SessionManager } from "@earendil-works/pi-coding-agent";
import { compactInstructions } from "./composer.mjs";
import { createProviderStore } from "./providers.mjs";

const page = "verity://desktop/index.html";
const assets = new Set(["/index.html", "/app.mjs", "/composer.mjs", "/style.css"]);
protocol.registerSchemesAsPrivileged([{ scheme: "verity", privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
const cli = new URL("./cli.js", import.meta.resolve("@earendil-works/pi-coding-agent/rpc-entry"));
const providerExtension = fileURLToPath(new URL("./pi-providers.mjs", import.meta.url));
const providers = createProviderStore(join(app.getPath("userData"), "providers.json"), safeStorage);
const imageTypes = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" };
const imageLimit = 10 * 1024 * 1024;
const modelKey = ({ provider, id }) => JSON.stringify([provider, id]);
let window;
let project;
let changing = false;
let quitting = false;

async function snapshot() {
  const { client, cwd, busy } = project;
  const [state, messages, sessions, stats, levels] = await Promise.all([
    client.getState(), client.getMessages(), SessionManager.list(cwd), client.getSessionStats(),
    client.getAvailableThinkingLevels(),
  ]);
  return {
    cwd,
    id: state.sessionId,
    name: state.sessionName ?? "",
    active: busy || state.isStreaming || state.isCompacting,
    model: state.model ? modelKey(state.model) : "",
    thinking: { level: state.thinkingLevel, levels },
    usage: { total: stats.tokens.total, context: stats.contextUsage },
    pending: state.pendingMessageCount,
    sessions: sessions.map(({ id, name, firstMessage }) => ({ id, title: name || firstMessage })),
    messages: messages.filter(({ role }) => role === "user" || role === "assistant").map(({ role, content }) => ({
      role,
      text: typeof content === "string" ? content : content.filter(({ type }) => type === "text").map(({ text }) => text).join("\n"),
    })),
  };
}

async function exclusive(action) {
  if (changing) throw new Error("Pi is busy");
  changing = true;
  try {
    return await action();
  } finally {
    changing = false;
  }
}

function changeSession(action) {
  if (project?.busy) throw new Error("Pi is busy");
  return exclusive(action);
}

function enqueue(method, text) {
  return exclusive(async () => {
    const { client, image, busy } = project;
    if (!busy || !(await client.getState()).isStreaming) throw new Error("No response is running");
    if (typeof text !== "string" || !text.trim()) throw new Error("Enter a message");
    if (compactInstructions(text) !== null) throw new Error("Wait for the response to finish before compacting");
    const disposition = await client[method](text, image ? [image] : undefined);
    const state = await client.getState();
    if (disposition === "queued" && !state.isStreaming && state.pendingMessageCount) {
      await client.clearQueue();
      throw new Error("Response finished before the message could be queued");
    }
    project.image = null;
  });
}

const providerActions = {
  providers: providers.list,
  saveProvider: (input) => exclusive(() => providers.save(input)),
  removeProvider: (id) => exclusive(() => providers.remove(id)),
};

const actions = {
  ...providerActions,
  open: () => changeSession(async () => {
    const result = await dialog.showOpenDialog(window, { properties: ["openDirectory"] });
    if (result.canceled) return null;
    const [cwd] = result.filePaths;
    const env = await providers.childEnv();
    const args = ["--tools", "read,grep,find,ls"];
    if (env.VERITY_DESKTOP_PROVIDERS) args.push("-e", providerExtension);
    const client = new RpcClient({ cliPath: fileURLToPath(cli), cwd, args, env });
    try {
      await client.start();
      const models = await client.getAvailableModels();
      await project?.client.stop();
      project = { client, cwd, image: null, busy: false };
      client.onEvent((event) => {
        if (project?.client !== client || window.isDestroyed()) return;
        if (event.type === "agent_settled") {
          project.busy = false;
          window.webContents.send("pi:event", { type: "settled" });
        }
        if (event.type === "tool_execution_start") {
          window.webContents.send("pi:event", { type: "tool_execution_start", toolCallId: event.toolCallId, toolName: event.toolName });
        }
        if (event.type === "tool_execution_end") {
          window.webContents.send("pi:event", { type: "tool_execution_end", toolCallId: event.toolCallId });
        }
        if (event.type === "queue_update") {
          window.webContents.send("pi:event", { type: "queue", count: event.steering.length + event.followUp.length });
        }
        if (event.type === "message_start" && event.message.role === "assistant") {
          window.webContents.send("pi:event", { type: "response" });
        }
        if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
          window.webContents.send("pi:event", { type: "text", delta: event.assistantMessageEvent.delta });
        }
        if (event.type === "message_end" && event.message.stopReason === "error") {
          window.webContents.send("pi:event", { type: "error", message: event.message.errorMessage || "Pi could not finish the response" });
        }
      });
      const customNames = new Map((await providers.list()).map(({ id, label }) => [id, label]));
      return { cwd, models: models.map((model) => ({
        value: modelKey(model), label: `${model.id} · ${customNames.get(model.provider) ?? model.provider}`,
      })) };
    } catch (error) {
      await client.stop();
      if (project?.client === client) project = undefined;
      throw error;
    }
  }),
  state: snapshot,
  new: () => changeSession(async () => {
    const { cancelled } = await project.client.newSession();
    if (cancelled) throw new Error("Pi kept the current conversation");
    project.image = null;
  }),
  resume: (id) => changeSession(async () => {
    const session = (await SessionManager.list(project.cwd)).find((entry) => entry.id === id);
    if (!session) throw new Error("Conversation no longer exists");
    const { cancelled } = await project.client.switchSession(session.path);
    if (cancelled) throw new Error("Pi kept the current conversation");
    project.image = null;
  }),
  rename: (name) => changeSession(async () => {
    if (typeof name !== "string" || !name.trim()) throw new Error("Enter a conversation name");
    await project.client.setSessionName(name.trim());
  }),
  forkMessages: () => project.client.getForkMessages(),
  fork: (entryId) => changeSession(async () => {
    if (typeof entryId !== "string" || !entryId) throw new Error("Choose a message to fork from");
    const result = await project.client.fork(entryId);
    if (!result.cancelled) project.image = null;
    return result;
  }),
  clone: () => changeSession(async () => {
    const result = await project.client.clone();
    if (!result.cancelled) project.image = null;
    return result;
  }),
  exportHtml: () => changeSession(async () => {
    const { canceled, filePath } = await dialog.showSaveDialog(window, {
      defaultPath: "conversation.html",
      filters: [{ name: "HTML", extensions: ["html"] }],
    });
    if (canceled || !filePath) return null;
    const { path } = await project.client.exportHtml(filePath);
    return basename(path);
  }),
  model: (value) => changeSession(async () => {
    const models = await project.client.getAvailableModels();
    const model = models.find((candidate) => modelKey(candidate) === value);
    if (!model) throw new Error("This model is unavailable");
    await project.client.setModel(model.provider, model.id);
  }),
  thinking: (level) => changeSession(async () => {
    const levels = await project.client.getAvailableThinkingLevels();
    if (!levels.includes(level)) throw new Error("Thinking level is unavailable for this model");
    await project.client.setThinkingLevel(level);
  }),
  attach: () => changeSession(async () => {
    const result = await dialog.showOpenDialog(window, {
      properties: ["openFile"],
      filters: [{ name: "Images", extensions: Object.keys(imageTypes).map((type) => type.slice(1)) }],
    });
    if (result.canceled) return null;
    const [path] = result.filePaths;
    const mimeType = imageTypes[extname(path).toLowerCase()];
    if (!mimeType || (await stat(path)).size > imageLimit) throw new Error("Choose an image under 10 MB");
    project.image = { type: "image", mimeType, data: await readFile(path, "base64") };
    return path.split(/[\\/]/).at(-1);
  }),
  detach: () => { project.image = null; },
  send: (text) => changeSession(async () => {
    if (typeof text !== "string" || !text.trim()) throw new Error("Enter a message");
    const { client } = project;
    const state = await client.getState();
    if (state.pendingMessageCount) throw new Error("Clear queued messages before sending");
    const instructions = compactInstructions(text);
    if (instructions !== null) {
      if (state.isStreaming || state.isCompacting) throw new Error("Pi is busy");
      if (!state.model) throw new Error("Choose a model before compacting");
      await client.compact(instructions || undefined);
      return "handled";
    }
    project.busy = true;
    try {
      const result = await client.prompt(text, project.image ? [project.image] : undefined);
      project.image = null;
      if (result === "handled") project.busy = false;
      return result;
    } catch (error) {
      project.busy = false;
      throw error;
    }
  }),
  steer: (text) => enqueue("steer", text),
  followUp: (text) => enqueue("followUp", text),
  clearQueue: () => exclusive(() => project.client.clearQueue()).then(() => undefined),
  stop: () => exclusive(() => project.client.abort()),
  completions: async () => [...new Set(["/compact", ...(await project.client.getCommands()).map(({ name, source }) => (
    source === "skill" ? `$${name.replace(/^skill:/, "")}` : `/${name}`
  ))])],
};

app.on("before-quit", (event) => {
  if (!project || quitting) return;
  event.preventDefault();
  quitting = true;
  project.client.stop().catch(console.error).finally(() => app.quit());
});
app.on("window-all-closed", () => app.quit());
app.whenReady().then(async () => {
  protocol.handle("verity", ({ url }) => {
    const { hostname, pathname } = new URL(url);
    if (hostname !== "desktop" || !assets.has(pathname)) return new Response(null, { status: 404 });
    return net.fetch(new URL(`.${pathname}`, import.meta.url).href);
  });
  window = new BrowserWindow({
    width: 1240, height: 820, minWidth: 680, minHeight: 460,
    title: "Verity",
    webPreferences: { preload: fileURLToPath(new URL("./preload.cjs", import.meta.url)) },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_content, _permission, answer) => answer(false));
  ipcMain.handle("pi:request", (event, action, value) => {
    if (event.sender !== window.webContents || event.senderFrame?.url !== page || !Object.hasOwn(actions, action)) {
      throw new Error("Unknown desktop request");
    }
    if (action !== "open" && !project && !Object.hasOwn(providerActions, action)) throw new Error("Open a project first");
    return actions[action](value);
  });
  await window.loadURL(page);
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
