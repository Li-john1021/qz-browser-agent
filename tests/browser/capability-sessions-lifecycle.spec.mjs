import { expect, test } from "./fixtures.mjs";

test.beforeEach(async ({ page }) => {
  await page.goto("/tests/git-skill-source/probe.html");
  await page.evaluate(async () => {
    const html = await fetch("/extension/sidepanel/sidepanel.html").then(response => response.text());
    const parsed = new DOMParser().parseFromString(html, "text/html");
    document.body.replaceChildren(...Array.from(parsed.body.children, element => document.importNode(element, true)));
    document.head.innerHTML = '<link rel="stylesheet" href="/extension/sidepanel/sidepanel.css">';
    document.querySelector("#app").removeAttribute("data-workspace-booting");
    document.querySelectorAll(".tab-panel, #messages, #chat-dock, #session-title-bar").forEach(element => element.classList.add("hidden"));
    document.querySelector("#sessions-panel").classList.remove("hidden");
    const { createMemoryStorage } = await import("/tests/support/memory-storage.mjs");
    const { SESSIONS_KEY } = await import("/extension/shared/session/session-store.js");
    const records = [{ id: "current", title: "Current task", status: "completed", parentSessionId: "root", updatedAt: "2026-09-18 12:00:00" }];
    globalThis.chrome = { storage: { local: createMemoryStorage({ [SESSIONS_KEY]: { current: records[0] } }) } };
    const { createSessionState } = await import("/extension/sidepanel/features/sessions/session-state.js");
    const { createWorkspaceExtensions } = await import("/extension/sidepanel/features/app/workspace-extensions.js");
    const { createSidepanelUiRuntime } = await import("/extension/sidepanel/capability-host/runtime.js");
    const { default: capability } = await import("/extension/capabilities/sessions/ui.js");
    const state = createSessionState();
    const effects = [], errors = [], pending = [], calls = [];
    const extensions = createWorkspaceExtensions(error => errors.push(String(error)));
    const f = { currentPage: "sessions", deferList: false, deferArtifacts: false, effects, errors, pending, calls,
      sessions: records };
    const effect = name => (...args) => { effects.push({ name, args }); };
    const write = method => (...args) => { effects.push({ name: method, args }); return state[method](...args); };
    const host = {
      root: document, settings: {}, extensions,
      async request(type, payload) {
        calls.push({ type, payload });
        if ((type === "list_sessions" && f.deferList) || (type === "get_session_artifacts" && f.deferArtifacts)) {
          return new Promise(resolve => pending.push({ type, payload, resolve }));
        }
        if (type === "list_sessions") return { sessions: f.sessions };
        if (type === "get_session_artifacts") return { artifacts: { dataTables: [{ table: "current_results", count: 2 }] } };
        if (type === "list_automations") return { automations: [], runs: {} };
        return {};
      },
      send: effect("send"), navigate: () => true, notifyViewChange: effect("view"),
      getCurrentSessionId: () => "current", getCurrentPage: () => f.currentPage,
      getRunContext: () => ({ runStatus: "idle", activeRunId: null, currentSessionId: "current" }),
      showToast: effect("toast"), hideToast: () => false,
      syncKeepAlive: effect("keepAlive"), dialogs: { confirm: async () => true },
      sessions: {
        getRuntime: id => state.getRuntime(id), getRecord: id => state.getRecord(id),
        mergeRecord: write("mergeRecord"), mergeRecords: write("mergeRecords"), mergeRuntime: write("mergeRuntime"),
        updateRuntime: () => false, isDeleted: () => false, getTranscript: () => [], hasTranscript: () => true,
        open: effect("open"), export: effect("export"), isExporting: () => false,
      },
      chat: { refresh: effect("chatRefresh"), scheduleRender: effect("chatRender"), clearInlineActions() {},
        appendNote: effect("note"), isGoalClearPending: () => false, renderGoal() {}, flashAction() {} },
    };
    f.runtime = createSidepanelUiRuntime({ host, onError: error => errors.push(String(error)) });
    f.mount = () => {
      const mounted = f.runtime.mountAll([{ id: "sessions", setup: capability }]);
      // The generic shell reveals the active page; this fixture mounts only the registry.
      document.querySelector("#sessions-panel").classList.remove("hidden");
      return mounted;
    };
    f.settlePending = async (type, response) => {
      const index = pending.findIndex(item => item.type === type);
      if (index < 0) throw new Error(`Missing pending ${type}`);
      pending.splice(index, 1)[0].resolve(response);
      // Drain request, projection and the callback chain before observing late writes.
      await new Promise(resolve => setTimeout(resolve, 80));
    };
    f.mount();
    window.__sessionsCapability = f;
  });
});

test("unmounted Sessions cannot hydrate state or retain DOM listeners, and remount recovers", async ({ page }) => {
  await page.evaluate(() => {
    const f = window.__sessionsCapability;
    f.deferList = true;
    f.runtime.activatePage("sessions");
  });
  await expect.poll(() => page.evaluate(() => window.__sessionsCapability.pending.some(item => item.type === "list_sessions"))).toBe(true);
  await page.evaluate(async () => {
    const f = window.__sessionsCapability;
    await f.runtime.unmount("sessions");
    f.effects.length = 0;
    document.querySelector("#sessions-list").innerHTML = '<div class="session-card" data-id="removed">kept after unmount</div>';
    document.querySelector(".session-card").click();
    await f.settlePending("list_sessions", { sessions: [{ id: "stale", title: "Late task", status: "running", runId: "stale-run" }] });
  });
  await expect(page.locator("#sessions-list")).toHaveText("kept after unmount");
  expect(await page.evaluate(() => window.__sessionsCapability.effects)).toEqual([]);
  await page.evaluate(() => {
    const f = window.__sessionsCapability;
    f.deferList = false;
    f.mount();
    f.runtime.activatePage("sessions");
  });
  await expect(page.locator('.session-card[data-id="current"]')).toBeVisible();
  await page.locator('.session-card[data-id="current"]').dispatchEvent("click");
  expect(await page.evaluate(() => window.__sessionsCapability.effects.filter(item => item.name === "open").map(item => item.args[0]))).toEqual(["current"]);
  expect(await page.evaluate(() => window.__sessionsCapability.errors)).toEqual([]);
  await page.evaluate(() => window.__sessionsCapability.runtime.dispose());
});

test("late background artifact hydration is isolated and missing optional Data UI explains recovery", async ({ page }) => {
  await page.evaluate(() => {
    const f = window.__sessionsCapability;
    f.currentPage = "chat";
    f.deferArtifacts = true;
    f.runtime.emit({ type: "session_resources_changed", sessionId: "background" });
  });
  await expect.poll(() => page.evaluate(() => window.__sessionsCapability.pending.some(item => item.type === "get_session_artifacts"))).toBe(true);
  await page.evaluate(async () => {
    const f = window.__sessionsCapability;
    await f.runtime.unmount("sessions");
    f.effects.length = 0;
    document.querySelector("#artifacts-body").textContent = "new owner";
    await f.settlePending("get_session_artifacts", { artifacts: { dataTables: [{ table: "late_results", count: 99 }] } });
  });
  expect(await page.evaluate(() => window.__sessionsCapability.effects)).toEqual([]);
  await expect(page.locator("#artifacts-body")).toHaveText("new owner");
  await page.evaluate(() => {
    const f = window.__sessionsCapability;
    f.deferArtifacts = false;
    f.mount();
    f.runtime.emit({ type: "session_resources_changed", sessionId: "background" });
  });
  await expect.poll(() => page.evaluate(() => window.__sessionsCapability.effects.some(item => item.name === "send" && item.args[0].type === "sync_session_artifact_list_summary"))).toBe(true);
  const summaries = await page.evaluate(() => window.__sessionsCapability.effects.filter(item => item.name === "send").map(item => item.args[0]));
  expect(summaries.some(item => item.artifacts?.data.some(table => table.table === "current_results"))).toBe(true);
  expect(JSON.stringify(summaries)).not.toContain("late_results");
  await page.evaluate(() => {
    const button = document.createElement("button");
    button.dataset.artifactAction = "open-data";
    button.dataset.table = "current_results";
    document.body.append(button);
    button.click();
  });
  await expect.poll(() => page.evaluate(() => window.__sessionsCapability.effects.filter(item => item.name === "toast").map(item => item.args[0]))).toEqual(["当前未安装数据表界面能力。"]);
  expect(await page.evaluate(() => window.__sessionsCapability.errors)).toEqual([]);
  await page.evaluate(() => window.__sessionsCapability.runtime.dispose());
});
