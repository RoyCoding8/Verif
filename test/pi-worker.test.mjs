import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runPiWorker } from "../src/pi-worker.mjs";

async function fixture(t) {
  const dir = await mkdtemp(path.join(process.cwd(), ".pi-worker-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function fakeSdk({ activeTools, promptError, messages, stats } = {}) {
  const state = { options: undefined, disposed: false, prompt: undefined };
  const sdk = {
    createExtensionRuntime: () => ({}),
    Type: {
      String: () => ({ type: "string" }),
      Object: (properties, options) => ({ type: "object", properties, ...options }),
    },
    SessionManager: { inMemory: (cwd) => ({ cwd }) },
    SettingsManager: { inMemory: () => ({ mode: "memory" }) },
    async createAgentSession(options) {
      state.options = options;
      return {
        session: {
          messages,
          getSessionStats: () => stats,
          async prompt(prompt) { state.prompt = prompt; if (promptError) throw promptError; },
          getLastAssistantText: () => "candidate summary",
          getActiveToolNames: () => activeTools ?? options.tools,
          async dispose() { state.disposed = true; },
        },
      };
    },
  };
  return { sdk, state };
}

test("creates an isolated, explicit SDK session and exposes a candidate summary", async (t) => {
  const workspace = await fixture(t);
  const { sdk, state } = fakeSdk();
  const result = await runPiWorker({
    workspace,
    goal: "Inspect the source",
    scope: { read: ["src"], write: ["src"], forbidden: ["src/private"] },
    sdk,
  });

  assert.deepEqual(result, { status: "candidate", summary: "candidate summary" });
  assert.deepEqual(state.options.tools, ["read", "write", "edit", "search"]);
  assert.deepEqual(state.options.customTools.map((tool) => tool.name), state.options.tools);
  assert.equal(state.options.cwd, workspace);
  assert.equal(state.options.sessionManager.cwd, workspace);
  assert.equal(state.options.settingsManager.mode, "memory");
  assert.deepEqual(state.options.resourceLoader.getSkills(), { skills: [], diagnostics: [] });
  assert.deepEqual(state.options.resourceLoader.getPrompts(), { prompts: [], diagnostics: [] });
  assert.deepEqual(state.options.resourceLoader.getAgentsFiles(), { agentsFiles: [] });
  assert.equal(state.disposed, true);
});

test("an explicitly selected Pi model reports usage and refuses failed provider responses", async t => {
  const workspace = await fixture(t);
  const modelRuntime = {};
  const model = {};
  const tokens = { input: 23, output: 7, cacheRead: 0, cacheWrite: 0, total: 30 };
  const { sdk, state } = fakeSdk({ stats: { tokens, cost: 0.01 }, messages: [{ role: "assistant", stopReason: "stop" }] });
  const request = { workspace, goal: "Inspect the source", scope: { read: [], write: [], forbidden: [] }, model, modelRuntime };
  const result = await runPiWorker({ ...request, sdk });
  assert.deepEqual(result.usage, { tokens, estimatedCost: 0.01 });
  assert.equal(state.options.model, model);
  assert.equal(state.options.modelRuntime, modelRuntime);
  const failed = fakeSdk({ messages: [{ role: "assistant", stopReason: "error", errorMessage: "provider detail" }] });
  await assert.rejects(runPiWorker({ ...request, sdk: failed.sdk }), /Pi did not complete the model request/);
  assert.equal(failed.state.disposed, true);
});

test("scoped tools read, edit, write, search, and limit named feedback checks", async (t) => {
  const workspace = await fixture(t);
  await mkdir(path.join(workspace, "src"));
  await writeFile(path.join(workspace, "src", "input.txt"), "alpha\nbeta\n");
  const { sdk, state } = fakeSdk();
  const checks = [];
  await runPiWorker({
    workspace,
    goal: "Update one line",
    scope: { read: ["src"], write: ["src"], forbidden: ["src/private"] },
    runCheck: async (name, context) => { checks.push({ name, context }); return "observed feedback"; },
    approvedChecks: ["unit"],
    sdk,
  });

  const tool = (name) => state.options.customTools.find((candidate) => candidate.name === name);
  assert.equal((await tool("read").execute("1", { path: "src/input.txt" })).content[0].text, "alpha\nbeta\n");
  assert.equal((await tool("edit").execute("2", { path: "src/input.txt", oldText: "beta", newText: "gamma" })).isError, undefined);
  assert.equal(await readFile(path.join(workspace, "src", "input.txt"), "utf8"), "alpha\ngamma\n");
  assert.equal((await tool("write").execute("3", { path: "src/output.txt", content: "delta" })).isError, undefined);
  assert.equal(await readFile(path.join(workspace, "src", "output.txt"), "utf8"), "delta");
  const search = await tool("search").execute("4", { query: "gamma" });
  assert.match(search.content[0].text, /src\/input\.txt:2:gamma/);
  assert.equal((await tool("run_check").execute("5", { name: "unapproved" })).isError, true);
  const checkSignal = new AbortController().signal;
  assert.equal((await tool("run_check").execute("6", { name: "unit" }, checkSignal)).content[0].text, "observed feedback");
  assert.deepEqual(checks, [{ name: "unit", context: { workspace, signal: checkSignal } }]);
  assert.match(state.prompt, /Approved feedback checks: unit/);
  assert.match(tool("run_check").description, /unit/);
});

test("writes a specifically approved nested file without requiring write scope on its parent", async (t) => {
  const workspace = await fixture(t);
  await mkdir(path.join(workspace, "src", "nested"), { recursive: true });
  const { sdk, state } = fakeSdk();
  await runPiWorker({
    workspace,
    goal: "Write the approved file",
    scope: { read: [], write: ["src/nested/output.txt"], forbidden: [] },
    sdk,
  });

  const write = state.options.customTools.find((tool) => tool.name === "write");
  const result = await write.execute("write", { path: "src/nested/output.txt", content: "approved" });
  assert.equal(result.isError, undefined);
  assert.equal(await readFile(path.join(workspace, "src", "nested", "output.txt"), "utf8"), "approved");
});

test("blocks forbidden, git, traversal, out-of-scope, and symlink paths", async (t) => {
  const workspace = await fixture(t);
  const outside = path.join(path.dirname(workspace), `${path.basename(workspace)}-outside`);
  await mkdir(outside);
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(path.join(outside, "secret.txt"), "secret");
  await mkdir(path.join(workspace, "src"));
  await writeFile(path.join(workspace, "src", "private.txt"), "private");
  await symlink(outside, path.join(workspace, "src", "linked"), "junction");
  const { sdk, state } = fakeSdk();
  await runPiWorker({
    workspace,
    goal: "Read source",
    scope: { read: ["src"], write: ["src"], forbidden: ["src/private.txt"] },
    sdk,
  });
  const read = state.options.customTools.find((tool) => tool.name === "read");
  for (const pathName of ["../outside/secret.txt", ".git/config", "src/private.txt", "src/linked/secret.txt", "outside/secret.txt"]) {
    assert.equal((await read.execute("read", { path: pathName })).isError, true, pathName);
  }
});

test("applies Windows path rules to scope and tool paths", async (t) => {
  if (process.platform !== "win32") return t.skip("Windows path rules are platform-specific");
  const workspace = await fixture(t);
  for (const invalid of ["src/file.txt:stream", "src/CON.log", "src/NUL", "src/trailing.", "src/trailing "]) {
    await assert.rejects(runPiWorker({
      workspace,
      goal: "Inspect",
      scope: { read: [invalid], write: [], forbidden: [] },
      sdk: fakeSdk().sdk,
    }), /Invalid Windows read scope path component/);
  }
  await mkdir(path.join(workspace, "src"));
  await writeFile(path.join(workspace, "src", "secret.txt"), "secret");
  const { sdk, state } = fakeSdk();
  await runPiWorker({
    workspace,
    goal: "Read the allowed source",
    scope: { read: ["SRC"], write: [], forbidden: ["SRC/Secret.txt"] },
    sdk,
  });
  const read = state.options.customTools.find((tool) => tool.name === "read");
  const search = state.options.customTools.find((tool) => tool.name === "search");
  for (const invalid of ["src/secret.txt:stream", "src/CON.log", "src/NUL", "src/trailing.", "src/trailing "]) {
    assert.equal((await read.execute("read", { path: invalid })).isError, true, invalid);
  }
  assert.equal((await read.execute("read", { path: "src/secret.txt" })).isError, true);
  assert.equal((await search.execute("search", { query: "secret" })).content[0].text, "No matches");
});

test("rejects active-tool mismatches and disposes the session", async (t) => {
  const workspace = await fixture(t);
  const { sdk, state } = fakeSdk({ activeTools: ["read", "bash"] });
  await assert.rejects(runPiWorker({
    workspace,
    goal: "Inspect",
    scope: { read: [], write: [], forbidden: [] },
    sdk,
  }), /active tools mismatch/);
  assert.equal(state.disposed, true);
});

test("disposes the session when prompting fails", async (t) => {
  const workspace = await fixture(t);
  const { sdk, state } = fakeSdk({ promptError: new Error("provider unavailable") });
  await assert.rejects(runPiWorker({
    workspace,
    goal: "Inspect",
    scope: { read: [], write: [], forbidden: [] },
    sdk,
  }), /provider unavailable/);
  assert.equal(state.disposed, true);
});

test("aborts and disposes the session when the caller cancels", async (t) => {
  const workspace = await fixture(t);
  const { sdk, state } = fakeSdk();
  sdk.createAgentSession = async (options) => {
    state.options = options;
    return {
      session: {
        async prompt(prompt) { state.prompt = prompt; await new Promise((resolve) => { state.finish = resolve; }); },
        getActiveToolNames: () => options.tools,
        async abort() { state.finish(); },
        async dispose() { state.disposed = true; },
      },
    };
  };
  const controller = new AbortController();
  const pending = runPiWorker({
    workspace,
    goal: "Inspect",
    scope: { read: [], write: [], forbidden: [] },
    signal: controller.signal,
    sdk,
  });
  while (!state.prompt) await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(state.disposed, true);
});

test("the installed Pi SDK accepts the isolated no-model session configuration", {
  skip: process.env.VERITY_PI_SDK_SMOKE !== "1" && "set VERITY_PI_SDK_SMOKE=1 to run the optional SDK smoke",
}, async (t) => {
  const workspace = await fixture(t);
  const codingAgent = await import("@earendil-works/pi-coding-agent");
  const { Type } = await import("typebox");
  const sdk = {
    ...codingAgent,
    Type,
    async createAgentSession(options) {
      const created = await codingAgent.createAgentSession(options);
      created.session.prompt = async () => {};
      return created;
    },
  };
  const result = await runPiWorker({
    workspace,
    goal: "No model request is made by this smoke",
    scope: { read: [], write: [], forbidden: [] },
    sdk,
  });
  assert.equal(result.status, "candidate");
});
