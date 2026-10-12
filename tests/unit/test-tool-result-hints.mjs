import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { registerWaitTools } from "../../src/capabilities/wait/tools.js";
import { registerTabsNavigationTools } from "../../src/capabilities/tabs/tools.js";
import { Agent } from "../../src/background/agent/agent.js";
import { createTestAgentOptions } from "../support/agent-services.mjs";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const tools = [
  "src/background/tools/runtime.ts",
  "src/capabilities/tabs/tools.ts",
  "src/capabilities/media/tools.ts",
].map(path => readFileSync(join(root, path), "utf8")).join("\n");

await assertImageToolInjectionIsNeutral();
const { resolveToolDefinition } = await import("../../src/background/tools/runtime.js");
assertReadImageKeepsTransparencyByDefault();
await assertToolNotesAreCompact();
await assertWaitToolNotesAreCompact();

async function assertImageToolInjectionIsNeutral() {
  const previousChrome = globalThis.chrome;
  globalThis.chrome = { runtime: { getURL: path => path } };
  let createToolRuntime;
  try {
    ({ createToolRuntime } = await import("../../src/background/tools/runtime.js"));
  } finally {
    if (previousChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = previousChrome;
  }
  const registered = createToolRuntime();
  const requests = [], executed = [];
  const names = ["read_image", "read_image_asset", "screenshot"];
  const imageUrl = "data:image/png;base64,AA==";
  const agent = new Agent("image-hints", createTestAgentOptions({
    tools: {
      getSchemas: () => [], getIdentity: registered.getIdentity, getModelPolicy: registered.getModelPolicy,
      async execute(name) { executed.push(name); return { ok: true, _image: imageUrl }; },
    },
    llm: {
      async *chatStream(messages) {
        requests.push(structuredClone(messages));
        const name = names[requests.length - 1];
        yield { type: "done", message: name
          ? { role: "assistant", content: null, tool_calls: [{ id: name, type: "function", function: { name, arguments: "{}" } }] }
          : { role: "assistant", content: "done" } };
      },
      async chat() { throw new Error("Unexpected fallback"); },
    },
  }));
  await agent.prompt("Inspect the images", {});
  assert.deepEqual(executed, names);
  const images = requests.at(-1).filter(message => Array.isArray(message.content) && message.content.some(part => part.type === "image_url"));
  assert.equal(images.length, 3);
  assert.deepEqual(images.map(message => message.content[0].text), [
    "以上工具读取到的图片，请分析其视觉内容：",
    "以上工具读取到的图片，请分析其视觉内容：",
    "以上工具返回的图片，请结合工具结果继续判断：",
  ], "real registered policies choose image-analysis hints; ordinary image tools use the neutral fallback");
  for (const message of images) {
    assert.equal(message.content[1].image_url.url, imageUrl);
    assert.doesNotMatch(message.content[0].text, /登录弹窗|验证码|必须立即调用 wait_for_user/);
  }
  assert.equal(agent.messages.at(-1).content, "done");
}

function assertReadImageKeepsTransparencyByDefault() {
  assert.match(tools, /readImageUrlAsResult\(url,[\s\S]*format = "png"/, "read_image url path should default to png");
  assert.match(tools, /registerTool\(\{\s*name:\s*"read_image"[\s\S]*format = "png"/, "read_image DOM path should default to png");
  assert.match(resolveToolDefinition("read_image").parameters.properties.format.description, /png 可保留透明通道/, "read_image schema should explain why png is the default");
}

async function assertToolNotesAreCompact() {
  const definitions = new Map();
  class ToolExecutionError extends Error {}
  registerTabsNavigationTools({
    registerTool({ name, description, parameters, execute }) {
      definitions.set(name, { description, parameters, execute });
    },
    ToolExecutionError,
    getToolRuntimeDependencies: () => ({}),
    makeSessionTabTargetError: (code, details) => Object.assign(new Error(code), { code, details }),
    assertTabAllowed: async () => undefined,
    assertUrlAllowed: () => undefined,
    enablePreNavigationNetworkWatch: async () => ({}),
  });

  const previousChrome = globalThis.chrome;
  let visibleMutations = 0;
  globalThis.chrome = {
    tabs: {
      async get(tabId) {
        return { id: tabId, active: false, title: "Background tab", url: "https://example.test/", windowId: 7 };
      },
      async update() {
        visibleMutations += 1;
        throw new Error("use_tab must not activate or focus the browser tab");
      },
    },
  };
  try {
    const result = await definitions.get("use_tab").execute({ tabId: 42 });
    assert.equal(result.tabId, 42);
    assert.equal(result.active, false);
    assert.equal(result.visibleChanged, false);
    assert.equal(result.focusedWindow, false);
    assert.equal(visibleMutations, 0);
  } finally {
    if (previousChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = previousChrome;
  }

  assert.doesNotMatch(tools, /截图已获取。请仔细查看图片内容。如果看到登录弹窗\/验证码\/授权请求，必须立即调用 wait_for_user/, "screenshot note should not repeat hard wait_for_user rules");
  assert.match(tools, /note:\s*collection[\s\S]*t\("screenshotCapturedAndSavedToTheImageCollection"\)[\s\S]*t\("elementScreenshotCaptured"\)[\s\S]*t\("screenshotCaptured"\)/, "screenshot notes should stay compact and mention optional asset saving");
}

async function assertWaitToolNotesAreCompact() {
  const definitions = new Map();
  let screenshotFails = false;
  registerWaitTools({
    registerTool: definition => definitions.set(definition.name, definition),
    getToolRuntimeDependencies: () => ({ sessions: {
      beginUserWait: async () => ({ reason: "continued" }),
      resolveUserWait() {}, rejectUserWait() {}, isWaitingForUser() { return false; },
    } }),
    captureTabScreenshot: async () => {
      if (screenshotFails) throw new Error("Screenshot unavailable");
      return { dataUrl: "data:image/png;base64,AA==" };
    },
    sendToContent: async () => ({}),
  });
  const context = { sessionId: "wait-hints", runId: "wait-run", workingTabId: 42 };
  const resumed = await definitions.get("wait_for_user").execute({ message: "Continue when ready" }, undefined, context);
  assert.equal(resumed.continued, true);
  assert.ok(resumed._image);
  assert.match(resumed.note, /用户已继续，这是当前页面状态截图，请确认并继续任务。/, "wait_for_user screenshot note should say user continued");
  screenshotFails = true;
  const fallback = await definitions.get("wait_for_user").execute({ message: "Continue when ready" }, undefined, context);
  assert.equal(fallback.continued, true);
  assert.equal(fallback._image, undefined);
  assert.match(fallback.note, /用户已继续，请确认当前页面状态后继续任务。/, "wait_for_user fallback note should say user continued");

  const previousChrome = globalThis.chrome;
  screenshotFails = false;
  try {
    for (const status of ["complete", "loading"]) {
      globalThis.chrome = { tabs: {
        get: async () => ({ id: 42, status, url: "https://example.test", title: "Page" }),
        onUpdated: { addListener() {}, removeListener() {} },
      } };
      const result = await definitions.get("wait_for_navigation").execute({ tabId: 42, screenshot: true, timeout: 0.001 }, undefined, context);
      assert.ok(result._image);
      assert.doesNotMatch(result.note, /这是当前(?:状态|页面)截图。如果看到登录\/验证码弹窗，必须调用 wait_for_user/, "navigation screenshot note should not repeat hard wait_for_user rules");
      assert.match(result.note, status === "complete" ? /页面加载完成，这是当前页面截图。/ : /页面加载超时，这是当前状态截图。/, "navigation screenshot note should describe the actual loading result");
    }
  } finally {
    if (previousChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = previousChrome;
  }
}
