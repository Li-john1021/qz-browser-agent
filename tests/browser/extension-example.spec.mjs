import { expect, test } from "./fixtures.mjs";
import { ensureCapabilityExampleExtension, resolveTestAsset } from "../support/extension-build.mjs";

test.use({ viewport: { width: 760, height: 600 }, video: process.env.QINGZHOU_RECORD_DEMO ? "on" : "off", launchOptions: { slowMo: process.env.QINGZHOU_RECORD_DEMO ? 400 : 0 } });

test.beforeEach(async ({ page }) => {
  const extensionDir = await ensureCapabilityExampleExtension();
  await page.route("**/extension/**", route => {
    const pathname = decodeURIComponent(new URL(route.request().url()).pathname);
    const path = resolveTestAsset(pathname, { root: process.cwd(), extensionDir });
    return path ? route.fulfill({ path }) : route.abort();
  });
});

test("a copied capability contributes an embedded Skill with resources and read-only aliases", async ({ page }) => {
  await page.goto("/__test_health");
  const result = await page.evaluate(async () => {
    const stored = {};
    globalThis.chrome = { storage: { local: {
      async get() { return structuredClone(stored); },
      async set(values) { Object.assign(stored, structuredClone(values)); },
      async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete stored[key]; },
    } } };
    const skills = await import("/extension/background/skills/runtime.js");
    const listed = (await skills.listSkills()).find(skill => skill.name === "example-reading-guide");
    const loaded = await skills.loadSkill("EXAMPLE_READING_GUIDE");
    const resource = await skills.loadSkillResource("示例阅读指南", "references/outline.md");
    let editCode;
    try { await skills.saveSkill("示例阅读指南", "override", "replacement"); }
    catch (error) { editCode = error.code; }
    return { listed, loaded, resource, editCode, stored };
  });
  expect(result.listed?.name).toBe("example-reading-guide");
  expect(result.loaded?.content).toContain("先读取页面");
  expect(result.loaded?.readOnly).toBe(true);
  expect(result.resource.resource.content).toContain("来源链接");
  expect(result.editCode).toBe("SKILL_READ_ONLY");
  expect(result.stored).toEqual({});
});

for (const locale of ["zh-CN", "en-US"]) {
  test.describe(locale, () => {
    test.use({ locale });
    const copy = locale === "en-US" ? {
      title: "Example data", resultTitle: "Research results", summary: "(Example rows: 2)",
      description: "Display labeled values as a table that can be copied.", full: "Show full result", compact: "Show summary",
    } : {
      title: "示例数据", resultTitle: "调研结果", summary: "(2 行示例数据)",
      description: "展示一组带标签的数值，返回可复制的表格。", full: "显示完整结果", compact: "显示摘要",
    };

    test("a file-discovered Tool reaches its custom Renderer and exports a readable result", async ({ page }) => {
      await page.goto("/__test_health");
      await page.evaluate(async locale => {
        document.documentElement.lang = locale;
        document.head.innerHTML = '<link rel="stylesheet" href="/extension/sidepanel/sidepanel.css">';
        document.body.innerHTML = '<main style="padding:24px"><h1>自建 Tool + Renderer</h1><p>合成数据 · 真实工具执行与渲染</p><div id="example"></div></main>';
        globalThis.chrome = { storage: { local: { async get() { return {}; } } }, runtime: { getURL: path => `/extension/${path}` } };
        const tools = await import("/extension/background/tools/runtime.js");
        const renderer = await import("/extension/sidepanel/tools/tool-renderer.js");
        const input = { title: "浏览器调研示例", rows: [{ label: "资料整理", value: 12 }, { label: "页面对照", value: 8 }] };
        // This is the real runtime: malformed arguments fail before the handler.
        let invalidCode;
        try { await tools.executeTool("example_table", { rows: [{ label: "invalid", value: "12" }] }); }
        catch (error) { invalidCode = error.code; }
        const controller = new AbortController(); controller.abort();
        let cancelled = false;
        try { await tools.executeTool("example_table", input, controller.signal); }
        catch (error) { cancelled = error.code === "OPERATION_ABORTED"; }
        const identity = tools.getToolIdentity("example_table");
        const schema = tools.getToolSchemas().find(schema => schema.function.name === "example_table").function;
        const event = JSON.parse(JSON.stringify({ type: "tool", ...identity,
          toolCallId: "example-call", args: input, result: await tools.executeTool("example_table", input) }));
        const options = { presentationState: { userToggled: true, expanded: true } };
        const root = renderer.renderToolEvent(event, options);
        document.querySelector("#example").append(root);
        window.__example = { invalidCode, cancelled, identity, schema, async update() {
          input.rows[0].value = 24;
          event.result = await tools.executeTool("example_table", input);
          renderer.patchToolEvent(root, event, options);
        }, export() {
          return renderer.renderToolEvent(event, { static: true, lazyDetails: false }).outerHTML;
        } };
      }, locale);
      const observed = await page.evaluate(() => {
        const { invalidCode, cancelled, identity, schema } = window.__example;
        return { invalidCode, cancelled, identity, schema };
      });
      expect(observed).toMatchObject({ invalidCode: "INVALID_ARGUMENTS", cancelled: true,
        identity: { name: "example_table", title: copy.title, rendererId: "example.value-card" },
        schema: { name: "example_table", description: copy.description, parameters: {
          required: ["rows"], properties: { rows: { type: "array", items: { properties: { value: { type: "number" } } } } },
        } },
      });
      await expect(page.locator(".tool-args-preview")).toHaveText(copy.summary);
      await expect(page.locator(".tool-name")).toHaveText(copy.resultTitle);
      const button = page.locator("[data-tool-renderer] button");
      await expect(button).toHaveText(copy.full);
      await button.click();
      await expect(button).toHaveText(copy.compact);
      await expect(page.locator("[data-tool-renderer] pre")).toContainText('"value": 12');
      await expect(page.locator("[data-tool-renderer] pre")).toContainText("资料整理");
      await expect(page.locator("[data-tool-renderer] pre")).toHaveAttribute("aria-label", "浏览器调研示例");
      await page.evaluate(() => window.__example.update());
      await expect(button).toHaveText(copy.compact);
      await expect(page.locator("[data-tool-renderer] pre")).toContainText('"value": 24');
      const html = await page.evaluate(() => window.__example.export());
      const offline = await page.context().newPage();
      await offline.setContent(html);
      await expect(offline.locator("[data-tool-renderer] pre")).toContainText('"value": 24');
      await expect(offline.locator("[data-tool-renderer] pre")).toContainText("浏览器调研示例");
      await expect(offline.locator("[data-tool-renderer] pre")).toContainText("资料整理");
      await expect(offline.locator("[data-tool-renderer] pre")).toHaveAttribute("aria-label", "浏览器调研示例");
      await expect(offline.locator("[data-tool-renderer] button")).toHaveCount(0);
      await expect(offline.locator(".tool-args-preview")).toHaveText(copy.summary);
      await expect(offline.locator(".tool-name")).toHaveText(copy.resultTitle);
      await offline.close();
    });

    test("legacy and malformed results remain readable and inert in the live card and offline export", async ({ page }) => {
      const samples = [
        { id: "legacy", result: '<img src=x onerror="alert(1)">旧版记录 / legacy output' },
        { id: "malformed", result: { title: "保存 <b>原文</b>", rows: [{ label: "旧字段", value: "12" }], retained: "legacy extra" } },
      ];
      await page.goto("/__test_health");
      const exports = await page.evaluate(async samples => {
        document.body.replaceChildren();
        globalThis.chrome = { storage: { local: { async get() { return {}; } } }, runtime: { getURL: path => `/extension/${path}` } };
        const tools = await import("/extension/background/tools/runtime.js");
        const renderer = await import("/extension/sidepanel/tools/tool-renderer.js");
        return samples.map(({ id, result }) => {
          const event = { type: "tool", ...tools.getToolIdentity("example_table"),
            toolCallId: `example-${id}`, args: {}, result };
          const root = document.createElement("section");
          root.id = id;
          root.append(renderer.renderToolEvent(event, { presentationState: { userToggled: true, expanded: true } }));
          document.body.append(root);
          return renderer.renderToolEvent(event, { static: true, lazyDetails: false }).outerHTML;
        });
      }, samples);
      const offline = await page.context().newPage();
      for (const [index, sample] of samples.entries()) {
        const expected = typeof sample.result === "string" ? sample.result : JSON.stringify(sample.result, null, 2);
        const card = page.locator(`#${sample.id} [data-tool-renderer]`);
        await expect(card.locator("button")).toHaveText(copy.full);
        await card.locator("button").click();
        await expect(card.locator("pre")).toHaveText(expected);
        await expect(card.locator("pre")).toHaveAttribute("aria-label", copy.title);
        await expect(card.locator("img, b")).toHaveCount(0);
        await offline.setContent(exports[index]);
        await expect(offline.locator("[data-tool-renderer] pre")).toHaveText(expected);
        await expect(offline.locator("[data-tool-renderer] pre")).toHaveAttribute("aria-label", copy.title);
        await expect(offline.locator("[data-tool-renderer] button, [data-tool-renderer] img, [data-tool-renderer] b")).toHaveCount(0);
      }
      await offline.close();
    });

    test("a copied UI package adds navigation, settings, events and state restoration without core changes", async ({ page }) => {
      const labels = locale === "en-US" ? {
        page: "Example page", heading: "Example capability", filter: "Example filter", image: "Example package image",
        imageLink: "Example image file", updates: "Example updates", settings: "Example settings", option: "Example option", saved: "Example saved",
      } : {
        page: "示例页面", heading: "示例能力页面", filter: "示例筛选", image: "示例包图片",
        imageLink: "示例图片文件", updates: "示例更新", settings: "示例设置", option: "示例选项", saved: "示例已保存",
      };
      await page.goto("/__test_health");
      await page.evaluate(async () => {
        const html = await (await fetch("/extension/sidepanel/sidepanel.html")).text();
        const parsed = new DOMParser().parseFromString(html, "text/html");
        document.head.innerHTML = '<base href="/extension/sidepanel/"><link rel="stylesheet" href="/extension/sidepanel/sidepanel.css">';
        document.body.innerHTML = parsed.body.innerHTML;
        const { createMemoryStorage } = await import("/tests/support/memory-storage.mjs");
        const storage = createMemoryStorage();
        globalThis.chrome = { storage: { local: storage }, runtime: { getURL: path => `/extension/${path}` } };
        const [{ default: contributions }, { createSidepanelUiRuntime }, { createAppShellFeature }, { createSettingsShell }, store] = await Promise.all([
          import("/extension/capability-catalogs/ui.js"), import("/extension/sidepanel/capability-host/runtime.js"),
          import("/extension/sidepanel/features/app/app-shell-feature.js"), import("/extension/sidepanel/capability-host/settings-shell.js"),
          import("/extension/sidepanel/features/app/workspace-view-store.js"),
        ]);
        const settings = createSettingsShell(document);
        let current = "chat";
        const runtime = createSidepanelUiRuntime({ host: { root: document, settings: settings.port, extensions: {},
          notifyViewChange() {}, navigate: id => shell.switchTab(id),
        } });
        runtime.mount({ id: "test-chat", mount: () => ({ pages: [{ id: "chat", title: "对话", order: 0,
          elements: [document.querySelector("#messages"), document.querySelector("#input-area")],
        }], overlays: [settings.overlay] }) });
        const example = contributions.filter(item => item.id === "example");
        await runtime.mountAll(example);
        settings.connect(runtime);
        const shell = createAppShellFeature({ root: document, tabs: { CHAT: "chat" }, ui: runtime,
          getCurrentTab: () => current, setCurrentTab: value => { current = value; }, input: document.querySelector("#input"),
          inputArea: document.querySelector("#input-area"), runController: { renderDock() {} }, goalStrip: { renderCurrent() {} },
        });
        shell.start();
        document.querySelector("#app").removeAttribute("data-workspace-booting");
        window.__uiExample = { runtime, settings, shell, storage, example, store, current: () => current };
      });
      await expect(page.locator('[data-tab="example-page"]')).toHaveText(labels.page);
      await page.locator('[data-tab="example-page"]').click();
      await expect(page.locator("#example-page h2")).toHaveText(labels.heading);
      await expect(page.locator("#example-page")).toBeVisible();
      await expect(page.locator("#example-page")).toHaveAttribute("data-active", "true");
      await expect(page.locator("#example-page")).toHaveCSS("color", await page.locator("body").evaluate(element => getComputedStyle(element).color));
      await page.getByLabel(labels.filter).fill("restored filter");
      const restored = await page.evaluate(async () => {
        const { runtime, shell, store } = window.__uiExample;
        const view = store.normalizeWorkspaceView({ v: 2, page: "example-page", state: runtime.capturePage("example-page") });
        shell.switchTab("chat");
        document.querySelector("#example-page input").value = "changed";
        shell.switchTab(view.page, { refresh: false });
        await runtime.restorePage(view.page, view.state);
        runtime.emit({ type: "example_result", value: "accepted event" });
        return document.querySelector("#example-page input").value;
      });
      expect(restored).toBe("restored filter");
      await expect.poll(() => page.getByAltText(labels.image).evaluate(image => image.naturalWidth)).toBe(16);
      await expect(page.getByLabel(labels.imageLink)).toHaveAttribute("href", "../capabilities/example/icon.svg");
      await expect(page.getByLabel(labels.updates)).toHaveText("accepted event");
      const themeSamples = new Map();
      for (const colorScheme of ["light", "dark"]) {
        await page.emulateMedia({ colorScheme });
        const sample = await page.locator("#example-page").evaluate(element => {
          const styles = getComputedStyle(element);
          const output = getComputedStyle(element.querySelector("output"));
          const probe = document.createElement("span");
          probe.style.cssText = "color:var(--text-primary);background:var(--bg-primary);font-family:var(--font-mono)";
          element.append(probe);
          const expected = getComputedStyle(probe);
          const result = { color: styles.color, background: styles.backgroundColor, padding: styles.padding,
            outputDisplay: output.display, outputMargin: output.marginTop, outputFont: output.fontFamily,
            expectedColor: expected.color, expectedBackground: expected.backgroundColor, expectedFont: expected.fontFamily,
            secondary: output.color };
          probe.remove();
          return result;
        });
        expect(sample).toMatchObject({ color: sample.expectedColor, background: sample.expectedBackground,
          padding: "16px", outputDisplay: "block", outputMargin: "12px", outputFont: sample.expectedFont });
        themeSamples.set(colorScheme, sample);
      }
      expect(themeSamples.get("light").color).not.toBe(themeSamples.get("dark").color);
      expect(themeSamples.get("light").background).not.toBe(themeSamples.get("dark").background);
      const cascade = await page.locator("#example-page").evaluate(element => {
        const defaults = document.createElement("style");
        defaults.textContent = "@layer components { #app #example-page.capability-example-page { padding: 1px; color: red; } }";
        document.head.append(defaults);
        const actual = { padding: getComputedStyle(element).padding, color: getComputedStyle(element).color };
        defaults.remove();
        return actual;
      });
      expect(cascade).toEqual({ padding: "16px", color: themeSamples.get("dark").color });
      const exportedHtml = await page.evaluate(async () => {
        const [{ buildSessionExportHtml }, { createSessionExchangePayload }, stylesheet] = await Promise.all([
          import("/extension/sidepanel/features/export/session-export-feature.js"),
          import("/extension/shared/session/session-exchange.js"),
          fetch("/extension/sidepanel/sidepanel.css").then(response => response.text()),
        ]);
        const session = { id: "design-system-example", title: "公共设计系统" };
        const view = document.querySelector("#example-page").cloneNode(true);
        view.querySelector("a").remove(); // External resources are independent of this offline style contract.
        return buildSessionExportHtml(session, createSessionExchangePayload({ session,
          transcript: [{ type: "assistant", content: "公共设计系统" }],
        }), {
          chatHtml: view.outerHTML, stylesheet,
        });
      });
      const offline = await page.context().newPage();
      await offline.setContent(exportedHtml);
      await expect(offline.locator("#example-page h2")).toHaveText(labels.heading);
      await expect(offline.getByLabel(labels.updates)).toHaveText("accepted event");
      for (const colorScheme of ["light", "dark"]) {
        await offline.emulateMedia({ colorScheme });
        const sample = themeSamples.get(colorScheme);
        await expect(offline.locator("#example-page")).toHaveCSS("color", sample.color);
        await expect(offline.locator("#example-page")).toHaveCSS("background-color", sample.background);
        await expect(offline.locator("#example-page")).toHaveCSS("padding", "16px");
        await expect(offline.locator("#example-page output")).toHaveCSS("margin-top", "12px");
        await expect(offline.locator("#example-page output")).toHaveCSS("font-family", sample.outputFont);
        await expect(offline.locator("#example-page output")).toHaveCSS("color", sample.secondary);
      }
      await offline.close();
      await page.emulateMedia({ colorScheme: "light" });
      await page.evaluate(() => window.__uiExample.settings.open("example-settings"));
      await expect(page.locator('[data-settings-tab="example-settings"]')).toHaveText(labels.settings);
      await page.getByLabel(labels.option).fill("saved option");
      await page.locator("#btn-save-settings").click();
      await expect(page.locator("#settings-save-status")).toHaveText(labels.saved);
      expect(await page.evaluate(() => Object.values(window.__uiExample.storage.snapshot()))).toEqual([{ value: "saved option" }]);
      const retiredHidden = await page.evaluate(async () => {
        const element = document.querySelector("#example-page");
        window.__uiExample.settings.close();
        await window.__uiExample.runtime.unmount("example");
        return element.classList.contains("hidden");
      });
      expect(retiredHidden).toBe(true);
      await expect(page.locator("#messages")).toBeVisible();
      await expect(page.locator('[data-tab="example-page"]')).toHaveCount(0);
      await expect(page.locator("#example-page, #example-settings")).toHaveCount(0);
      expect(await page.evaluate(() => window.__uiExample.current())).toBe("chat");
      await page.evaluate(async () => {
        const { runtime, example, settings } = window.__uiExample;
        await runtime.mountAll(example);
        settings.open("example-settings");
      });
      await expect(page.getByLabel(labels.option)).toHaveValue("saved option");
      await expect(page.locator("#example-page, #example-settings")).toHaveCount(2);
      await page.evaluate(() => window.__uiExample.runtime.emit({ type: "example_result", value: "remounted event" }));
      await expect(page.getByLabel(labels.updates)).toHaveText("remounted event");
      await page.evaluate(async () => {
        const { runtime, shell, settings } = window.__uiExample;
        shell.stop(); settings.dispose(); await runtime.dispose();
      });
    });
  });
}

test("the same copied package supplies a local Provider, Session context, observer and document codec", async ({ page }) => {
  await page.goto("/__test_health");
  const result = await page.evaluate(async () => {
    globalThis.chrome = { storage: { local: { async get() { return {}; } } }, runtime: { getURL: path => `/extension/${path}` } };
    const { createLlmGateway, listCustomProtocols, listModels, getConfig, startProviderLogin, pollProviderLogin, clearProviderAuth } = await import("/extension/background/llm/index.js");
    const { createSessionAgentHost } = await import("/extension/background/session/agent-host.js");
    const { createLifecycleObservers } = await import("/extension/background/lifecycle-observers.js");
    const { default: observers } = await import("/extension/capability-catalogs/observers.js");
    const { documentCodecs } = await import("/extension/shared/documents/document-codecs.js");
    const originalFetch = globalThis.fetch;
    const originalDebug = console.debug;
    const completed = [];
    const diagnostics = [];
    const lifecycle = createLifecycleObservers(observers.flat(), { onDiagnostic: entry => diagnostics.push(entry) });
    try {
      // Any accidental transport fallback fails locally before a real request can leave the test.
      globalThis.fetch = async () => { throw new Error("The example Provider must remain local"); };
      console.debug = (label, identity) => { if (label === "Example task completed") completed.push(identity); };
      const gateway = createLlmGateway({ rateGovernor: null, rateLearning: null, resolveConfig: async () => ({
        provider: "custom", customProtocol: "example", customEndpoint: "https://example.invalid/v1/chat/completions",
        model: "local-fixture", apiKey: "synthetic-local-only",
      }) });
      const login = await startProviderLogin("example-local");
      const auth = await pollProviderLogin("example-local", login.loginId);
      const config = await getConfig();
      const models = await listModels({ provider: "example-local" });
      const { matchConfiguredModelCapabilities } = await import("/extension/shared/models/model-capabilities.js");
      const capabilities = await matchConfiguredModelCapabilities({ provider: "example-local", model: "local-fixture" });
      const clearedAuth = await clearProviderAuth("example-local");
      const messages = [{ role: "user", content: "A deterministic capability check" }];
      const reply = await gateway.chat(messages, []);
      const stream = [];
      for await (const event of gateway.chatStream(messages, [])) stream.push(event);

      const host = createSessionAgentHost({
        repository: {}, normalizeSessionId: String, llm: gateway, getToolRuntime: () => ({}),
        getSupervisor: () => ({ getRuntime: () => ({}) }),
        getCommands: () => ({ canUseSessionGoal: async () => false }),
        requestLocation: async () => null, getWorkingTabContext: async () => null,
      });
      const agent = host.createAgent({ sessionId: "capability-session", epoch: 3, isActive: () => true });
      const context = await agent._dynamicContextProvider({ reason: "snapshot", runId: "capability-run" });

      lifecycle.emit("capability-session", { type: "agent_end", runId: "capability-run", message: { role: "assistant", content: "private text" } });
      await lifecycle.flush();
      const beforeCommit = completed.length;
      lifecycle.emit("capability-session", { type: "agent_end", runId: "capability-run" }, "committed");
      await lifecycle.flush();

      const bytes = new TextEncoder().encode('{"text":"Hello 你好"}');
      let sizeError;
      try { await documentCodecs.parse(bytes, { filename: "note.qznote", maxBytes: 1 }); }
      catch (error) { sizeError = error.code; }
      const document = await documentCodecs.parse(bytes, { filename: "note.qznote" });
      return {
        auth, providerSummary: config.providers.find(item => item.id === "example-local"), authState: config.providerAuth["example-local"], legacyAuth: config.exampleAuthStatus, models, capabilities, clearedAuth,
        protocols: listCustomProtocols().map(protocol => protocol.id), reply: reply.message.content,
        streamed: stream.filter(event => event.type === "text_delta").map(event => event.delta).join(""),
        finish: stream.at(-1).type, sources: context.sources, contextDiagnostics: context.contextDiagnostics,
        beforeCommit, completed, diagnostics, sizeError, document,
        format: documentCodecs.inferFormat({ filename: "note.qznote" }),
        outputFormats: documentCodecs.outputFormats,
      };
    } finally {
      lifecycle.dispose();
      globalThis.fetch = originalFetch;
      console.debug = originalDebug;
    }
  });
  expect(result.protocols).toContain("example");
  expect(result.auth.status).toBe("complete");
  expect(result.authState).toEqual({ loggedIn: true });
  expect(result.legacyAuth).toEqual(result.authState);
  expect(result.clearedAuth).toEqual({ loggedIn: false });
  expect(result.providerSummary.modelOptions[0].key).toBe("exampleMode");
  expect(result.models.models.map(model => model.id)).toEqual(["local-fixture"]);
  expect(result.capabilities).toMatchObject({ matched: true, contextWindow: 64000, source: "example-package", vision: false });
  expect(result.reply).toBe("Example: A deterministic capability check");
  expect(result.streamed).toBe(result.reply);
  expect(result.finish).toBe("done");
  expect(result.sources).toEqual([{ id: "example.task-note", title: "任务笔记", text: "Example note for capability-session" }]);
  expect(result.contextDiagnostics).toEqual([]);
  expect(result.beforeCommit).toBe(0);
  expect(result.completed).toEqual([{ sessionId: "capability-session", runId: "capability-run" }]);
  expect(result.diagnostics).toEqual([]);
  expect(result.sizeError).toBe("DOCUMENT_SIZE_LIMIT");
  expect(result.document.blocks).toEqual([{ type: "paragraph", text: "Hello 你好" }]);
  expect(result.format).toBe("json-note");
  expect(result.outputFormats).not.toContain("json-note");
});


test("the copied UI ignores unloaded reads and recovers a failed settings save on remount", async ({ page }) => {
  await page.goto("/__test_health");
  const result = await page.evaluate(async () => {
    const html = await fetch("/extension/sidepanel/sidepanel.html").then(response => response.text());
    document.head.innerHTML = '<base href="/extension/sidepanel/">';
    document.body.innerHTML = new DOMParser().parseFromString(html, "text/html").body.innerHTML;
    const [{ createMemoryStorage }, { createCapabilityStateStore }, { createSidepanelUiRuntime }, { default: contributions }] = await Promise.all([
      import("/tests/support/memory-storage.mjs"), import("/extension/shared/capability-state-store.js"),
      import("/extension/sidepanel/capability-host/runtime.js"), import("/extension/capability-catalogs/ui.js"),
    ]);
    const base = createMemoryStorage();
    await createCapabilityStateStore("example", base, new AbortController().signal).set("settings", { value: "persisted" });
    let finishRead, readStarted, failSave = true;
    const started = new Promise(resolve => { readStarted = resolve; });
    const gate = new Promise(resolve => { finishRead = resolve; });
    const storage = { ...base,
      async get(key) { readStarted(); await gate; return base.get(key); },
      async set(values) { if (failSave) { failSave = false; throw new Error("storage unavailable"); } return base.set(values); },
    };
    const states = [], errors = [];
    const runtime = createSidepanelUiRuntime({ storage, host: { root: document, extensions: {}, settings: {
      getOpenGeneration: () => 1, setState: (id, state) => states.push({ id, ...state }),
    }, notifyViewChange() {} }, onError: error => errors.push(String(error)) });
    const example = contributions.filter(item => item.id === "example");
    await runtime.mountAll(example);
    const initial = document.querySelector("#example-settings input");
    const loading = runtime.getSettingsSections()[0].activate({ signal: new AbortController().signal, refresh: false })
      .then(() => "completed", error => error.name);
    await started;
    await runtime.unmount("example");
    const stateCountAtUnmount = states.length;
    finishRead();
    const late = { result: await loading, oldValue: initial.value, mounted: document.querySelectorAll("#example-settings").length };
    initial.dispatchEvent(new Event("input", { bubbles: true }));
    const retiredEffects = states.length - stateCountAtUnmount;
    await runtime.mountAll(example);
    const section = runtime.getSettingsSections()[0];
    const activation = { signal: new AbortController().signal, refresh: false };
    await section.activate(activation);
    const input = document.querySelector("#example-settings input");
    const restored = input.value;
    input.value = "recoverable draft";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    const failure = await section.save(activation);
    const failureState = { ...states.at(-1) };
    const draft = input.value;
    const retried = await section.save(activation);
    await runtime.unmount("example");
    await runtime.mountAll(example);
    await runtime.getSettingsSections()[0].activate(activation);
    const afterSave = document.querySelector("#example-settings input").value;
    await runtime.dispose();
    return { late, retiredEffects, restored, failure, failureState, retried, draft, afterSave, states, errors };
  });
  expect(result).toMatchObject({ late: { result: "completed", oldValue: "initial", mounted: 0 }, retiredEffects: 0,
    restored: "persisted", failure: false, retried: true, draft: "recoverable draft", afterSave: "recoverable draft", errors: [],
    failureState: { id: "example-settings", text: "保存失败，请重试。", tone: "error", disabled: false, busy: false },
  });
  expect(result.states.at(-1)).toMatchObject({ text: "示例已保存", tone: "saved" });
});

test("editing before the first settings read survives leaving and returning to the same group", async ({ page }) => {
  await page.goto("/__test_health");
  await page.evaluate(async () => {
    const html = await fetch("/extension/sidepanel/sidepanel.html").then(response => response.text());
    document.head.innerHTML = '<base href="/extension/sidepanel/">';
    document.body.innerHTML = new DOMParser().parseFromString(html, "text/html").body.innerHTML;
    const [{ createMemoryStorage }, { createCapabilityStateStore }, { createSidepanelUiRuntime }, { createSettingsShell }, { default: contributions }] = await Promise.all([
      import("/tests/support/memory-storage.mjs"), import("/extension/shared/capability-state-store.js"),
      import("/extension/sidepanel/capability-host/runtime.js"), import("/extension/sidepanel/capability-host/settings-shell.js"),
      import("/extension/capability-catalogs/ui.js"),
    ]);
    const base = createMemoryStorage();
    await createCapabilityStateStore("example", base, new AbortController().signal).set("settings", { value: "persisted setting" });
    let releaseRead, reads = 0;
    const gate = new Promise(resolve => { releaseRead = resolve; });
    const storage = { ...base, async get(key) { reads += 1; await gate; return base.get(key); } };
    const settings = createSettingsShell(document);
    const runtime = createSidepanelUiRuntime({ storage, host: { root: document, settings: settings.port, extensions: {}, notifyViewChange() {} } });
    const other = document.createElement("section");
    runtime.mount({ id: "other", mount: () => ({ settingsSections: [{ id: "other", title: "另一组", element: other }] }) });
    await runtime.mountAll(contributions.filter(entry => entry.id === "example"));
    settings.connect(runtime);
    settings.open("example-settings");
    document.querySelector("#app").removeAttribute("data-workspace-booting");
    window.__slowSettings = { releaseRead, reads: () => reads, runtime, settings };
  });
  await expect.poll(() => page.evaluate(() => window.__slowSettings.reads())).toBe(1);
  await page.getByLabel("示例选项").fill("draft typed while loading");
  await page.locator('[data-settings-tab="other"]').click();
  await page.locator('[data-settings-tab="example-settings"]').click();
  await page.evaluate(() => window.__slowSettings.releaseRead());
  await expect(page.getByLabel("示例选项")).toHaveValue("draft typed while loading");
  expect(await page.evaluate(() => window.__slowSettings.reads())).toBe(1);
  await page.locator("#btn-close-settings").click();
  await page.locator("#btn-settings").click();
  await expect(page.getByLabel("示例选项")).toHaveValue("persisted setting");
  expect(await page.evaluate(() => window.__slowSettings.reads())).toBe(2);
  await page.evaluate(async () => { window.__slowSettings.settings.dispose(); await window.__slowSettings.runtime.dispose(); });
});
