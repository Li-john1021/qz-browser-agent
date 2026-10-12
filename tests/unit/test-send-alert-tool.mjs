import assert from "node:assert/strict";
import { transformSync } from "esbuild";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getLastTranscriptToolName } from "../../src/shared/session/session-codec.js";
import { getCoreToolMetadata } from "../../src/shared/tools/tool-metadata.js";
import { createToolView } from "../../src/sidepanel/tools/renderer-host.js";

const storageData = {};
const notifications = [];
let now = 1782000000000;
const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

const originalDateNow = Date.now;
Date.now = () => now;

globalThis.chrome = {
  storage: {
    local: {
      async get(key) {
        if (typeof key === "string") return { [key]: storageData[key] };
        if (Array.isArray(key)) {
          return Object.fromEntries(key.map(item => [item, storageData[item]]));
        }
        if (key && typeof key === "object") {
          return Object.fromEntries(
            Object.entries(key).map(([item, fallback]) => [item, storageData[item] ?? fallback]),
          );
        }
        return { ...storageData };
      },
      async set(values) {
        Object.assign(storageData, values);
      },
    },
  },
  notifications: {
    getPermissionLevel(callback) {
      callback("granted");
    },
    create(notificationId, options, callback) {
      notifications.push({ notificationId, options });
      callback(notificationId);
    },
  },
  runtime: {
    getURL(path) {
      return `chrome-extension://qingzhou/${path}`;
    },
    lastError: null,
  },
};

const { executeTool, getToolSchemas } = await importTools();

try {
  await testSchemaIsVisible();
  await testSendsNotification();
  await testDuplicateSuppression();
  await testMinimumIntervalSuppression();
  await testWindowRateLimitSuppression();
  testLastTranscriptToolName();
  testCompletionNotificationSuppressionContract();
  await testSendAlertRendererContract();
} finally {
  Date.now = originalDateNow;
}

console.log("send_alert tool tests passed");

async function importTools() {
  const shouldSuppressPdfWarning = (args) => {
    const text = args.map(item => String(item)).join(" ");
    return /Cannot load "@napi-rs\/canvas"|Cannot polyfill `(DOMMatrix|ImageData|Path2D)`/.test(text);
  };
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.log = (...args) => {
    if (shouldSuppressPdfWarning(args)) return;
    originalLog(...args);
  };
  console.warn = (...args) => {
    if (shouldSuppressPdfWarning(args)) return;
    originalWarn(...args);
  };
  try {
    return await import("../../src/background/tools/runtime.js");
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
  }
}

function resetMocks() {
  for (const key of Object.keys(storageData)) delete storageData[key];
  notifications.length = 0;
  now = 1782000000000;
}

async function testSchemaIsVisible() {
  const schema = getToolSchemas().find(item => item?.function?.name === "send_alert");
  assert.ok(schema, "send_alert should be visible to the model");
  assert.equal(schema.function.parameters.required.includes("message"), true, "message should be required");
  assert.match(schema.function.description, /全局流控/, "description should mention global rate limiting");
}

async function testSendsNotification() {
  resetMocks();
  const result = await executeTool("send_alert", {
    title: "需要处理",
    message: "登录页面需要你确认。",
    level: "warning",
  }, null, { sessionId: "session42" });

  assert.equal(result.sent, true);
  assert.equal(result.suppressed, false);
  assert.equal(result.level, "warning");
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].options.title, "需要处理");
  assert.equal(notifications[0].options.message, "登录页面需要你确认。");
  assert.equal(notifications[0].options.priority, 1);
  assert.match(notifications[0].options.iconUrl, /icons\/icon128\.png$/);
  assert.match(result.notificationId, /^qz_alert_session_session42_/, "alerts should retain their source Session across service-worker restarts");
}

async function testDuplicateSuppression() {
  resetMocks();
  await executeTool("send_alert", {
    title: "需要处理",
    message: "请完成验证码。",
    dedupeKey: "captcha",
  });
  now += 6000;
  const duplicate = await executeTool("send_alert", {
    title: "需要处理",
    message: "请完成验证码。",
    dedupeKey: "captcha",
  });

  assert.equal(duplicate.sent, false);
  assert.equal(duplicate.suppressed, true);
  assert.equal(duplicate.reason, "duplicate");
  assert.equal(notifications.length, 1);
  assert.ok(duplicate.retryAfterMs > 0);
}

async function testMinimumIntervalSuppression() {
  resetMocks();
  await executeTool("send_alert", {
    title: "第一条",
    message: "需要你看一下。",
    dedupeKey: "first",
  });
  now += 1000;
  const tooSoon = await executeTool("send_alert", {
    title: "第二条",
    message: "这是另一条提醒。",
    dedupeKey: "second",
  });

  assert.equal(tooSoon.sent, false);
  assert.equal(tooSoon.suppressed, true);
  assert.equal(tooSoon.reason, "too_soon");
  assert.equal(notifications.length, 1);
  assert.ok(tooSoon.retryAfterMs >= 3900);
}

async function testWindowRateLimitSuppression() {
  resetMocks();
  for (let i = 0; i < 3; i += 1) {
    const result = await executeTool("send_alert", {
      title: `提醒 ${i}`,
      message: `第 ${i} 条提醒`,
      dedupeKey: `rate-${i}`,
    });
    assert.equal(result.sent, true);
    now += 6000;
  }

  const limited = await executeTool("send_alert", {
    title: "第四条",
    message: "一分钟内的第四条应该被拦截。",
    dedupeKey: "rate-4",
  });

  assert.equal(limited.sent, false);
  assert.equal(limited.suppressed, true);
  assert.equal(limited.reason, "rate_limited");
  assert.equal(notifications.length, 3);
  assert.ok(limited.retryAfterMs > 0);
}

function testLastTranscriptToolName() {
  assert.equal(getLastTranscriptToolName([
    { type: "user", text: "提醒我" },
    { type: "tool", name: "send_alert", phase: "done", isRunning: false },
    { type: "assistant", content: "已提醒" },
  ]), "send_alert");

  assert.equal(getLastTranscriptToolName([
    { type: "tool", name: "send_alert", phase: "done", isRunning: false },
    { type: "tool", name: "read_dom", phase: "running", isRunning: true },
  ]), "send_alert");

  assert.equal(getLastTranscriptToolName([
    { type: "tool", name: "send_alert", phase: "done", isRunning: false },
    { type: "tool", name: "data_store", phase: "done", isRunning: false },
  ]), "data_store");
}

function testCompletionNotificationSuppressionContract() {
  const notifications = readSource(join(root, "src/background/services/chrome-notifications.js"));
  const automationRuntime = readSource(join(root, "src/background/automation/runtime.js"));
  assert.match(
    notifications,
    /async function notifyCompleted[\s\S]*await shouldSuppress\(id\)/,
    "root completion notification should check the last tool call before showing task-complete alert",
  );
  assert.match(
    notifications,
    /async function shouldSuppress[\s\S]*getLastToolName\(transcript\) === "send_alert"/,
    "completion suppression should be driven by the last completed tool name",
  );
  assert.match(
    automationRuntime,
    /!failed && (run\d*)\.sessionId && await sessions\.shouldSuppressNotification\?\.\(\1\.sessionId\)/,
    "successful automation completion notifications should also avoid duplicating send_alert",
  );
}

async function testSendAlertRendererContract() {
  const css = readSource(join(root, "src/capabilities/wait/ui.css"));
  const visualTest = readSource(join(root, "tests/tool-timeline/visual-test.js"));
  const { toolRendererRegistry } = await import("../../src/sidepanel/tools/tool-renderer.js");
  const rendererId = getCoreToolMetadata("send_alert").profileFamily;
  assert.equal(toolRendererRegistry.resolve(rendererId).id, rendererId);
  const document = { createElement(tagName) {
    return {
      tagName, style: {}, children: [], innerHTML: "",
      set textContent(value) { this.innerHTML = String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"); },
      appendChild(child) { this.children.push(child); },
    };
  } };
  const previousDocument = globalThis.document;
  globalThis.document = document;
  try {
    const render = (args, result) => {
      const view = createToolView({ id: "alert", name: "send_alert", rendererId, profileFamily: rendererId, args, result });
      const output = toolRendererRegistry.renderStatic(view, document);
      assert.equal(output.children.length, 1, "the alert profile must emit only the message section");
      assert.equal(output.children[0].className, "tool-alert-message", "the registered profile must render, rather than fall back");
      return output.children[0].innerHTML;
    };
    const html = render({ message: "draft" }, { message: "Done <b>safe</b> https://example.test/result" });
    assert.match(html, /Done &lt;b&gt;safe&lt;\/b&gt;/, "alert messages remain plain escaped text");
    assert.match(html, /<a href="https:\/\/example\.test\/result"[^>]+>https:\/\/example\.test\/result<\/a>/);
    assert.equal(render({ message: "argument fallback" }, {}), "argument fallback");
    assert.equal(render({}, { sent: false }), "提醒已被流控，未重复发送。");
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
  assert.equal(toolRendererRegistry.resolve(rendererId).showRawData, false,
    "send_alert declares that its renderer does not expose duplicate raw data");
  assert.match(css, /\.tool-alert-message\s*\{[\s\S]*white-space:\s*pre-wrap/, "send_alert message should have plain text styling");
  assert.match(visualTest, /if \(name === "send_alert"\)/, "visual component matrix should include a real send_alert sample");
}

function readSource(path) {
  const sourcePath = existsSync(path) ? path : path.replace(/\.js$/, ".ts");
  const source = readFileSync(sourcePath, "utf8");
  return sourcePath.endsWith(".ts") ? transformSync(source, { loader: "ts", target: "esnext", format: "esm", charset: "utf8" }).code : source;
}
