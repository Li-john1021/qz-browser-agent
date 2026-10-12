import assert from "node:assert/strict";
import test from "node:test";
import { providers } from "@opencode-ai/models/snapshot";

import {
  buildRunProfile,
  buildRunProfilePromptSection,
} from "../../src/background/agent/run-profile.js";

test("the first run loads the packaged directory before resolving its output limit", async t => {
  const model = Object.values(providers.openai.models).find(model => model.limit.output > 1024 && model.limit.output < 32768);
  const previousChrome = globalThis.chrome;
  globalThis.chrome = { runtime: { getURL: path => `chrome-extension://fixture/${path}` } };
  t.after(() => { globalThis.chrome = previousChrome; });
  const fetch = t.mock.method(globalThis, "fetch", async url => {
    assert.equal(url, "chrome-extension://fixture/vendor/models-dev/providers.json");
    return Response.json(providers);
  });
  const config = { provider: "openai", model: model.id };
  const profiles = await Promise.all([buildRunProfile({ config }), buildRunProfile({ config })]);
  assert.equal(fetch.mock.callCount(), 1);
  for (const profile of profiles) assert.equal(profile.model.maxOutputTokens, model.limit.output);
});

test("run profile emits the session kinds referenced by the kernel", () => {
  const rootSection = buildRunProfilePromptSection({
    session: { kind: "user", canManageSessions: true },
    model: {},
    features: {},
  });
  const restrictedSection = buildRunProfilePromptSection({
    session: { kind: "restricted", canManageSessions: false },
    model: {},
    features: {},
  });

  assert.match(rootSection, /Session 类型: user-created root session/);
  assert.match(restrictedSection, /Session 类型: restricted session/);
});

test("run profile never fetches external model metadata", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = () => {
    fetchCalls += 1;
    throw new Error("external model metadata is unavailable");
  };

  try {
    const profile = await buildRunProfile({
      sessionId: "session_deepseek",
      config: {
        provider: "deepseek",
        model: "deepseek-chat",
        endpoint: "https://api.deepseek.com/chat/completions",
        contextWindow: 128000,
        vision: false,
        toolCalling: true,
        trimOldToolResults: true,
      },
    });

    assert.equal(fetchCalls, 0);
    assert.equal(profile.model.contextWindow, 128000);
    assert.equal(profile.model.vision, false);
    assert.equal(profile.model.maxOutputTokens, 32768);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("run profile preserves bundled provider output limits without network access", async () => {
  const profile = await buildRunProfile({
    sessionId: "session_glm",
    config: {
      provider: "zhipuai",
      model: "GLM-4V-Flash",
      endpoint: "https://open.bigmodel.cn/api/paas/v4/chat/completions",
      contextWindow: 16384,
      vision: true,
      toolCalling: true,
      trimOldToolResults: true,
    },
  });

  assert.equal(profile.model.maxOutputTokens, 1024);
  assert.equal(profile.model.contextWindow, 16384);
  assert.equal(profile.model.vision, true);
});

test("run profile exposes the current OS in the prompt", async () => {
  const config = {
    provider: "deepseek",
    model: "deepseek-chat",
    endpoint: "https://api.deepseek.com/chat/completions",
    contextWindow: 128000,
    vision: true,
    toolCalling: true,
    trimOldToolResults: true,
  };
  const macProfile = await buildRunProfile({
    sessionId: "session_mac",
    config,
    platformInfo: { os: "mac", arch: "arm64" },
  });
  assert.deepEqual(macProfile.platform, {
    os: "mac",
    label: "macOS",
  });
  assert.match(
    buildRunProfilePromptSection(macProfile),
    /当前操作系统: macOS/u,
  );

  const windowsProfile = await buildRunProfile({
    sessionId: "session_windows",
    config,
    platformInfo: { os: "win", arch: "x86-64" },
  });
  assert.deepEqual(windowsProfile.platform, {
    os: "win",
    label: "Windows",
  });
  assert.match(
    buildRunProfilePromptSection(windowsProfile),
    /当前操作系统: Windows/u,
  );
});

test("custom run profiles use the supplied configuration without loading a directory", async () => {
  const originalChrome = globalThis.chrome;
  globalThis.chrome = new Proxy({}, { get() { throw new Error("must not read Chrome"); } });
  try {
    const profile = await buildRunProfile({ config: { provider: "test", model: "test" }, platformInfo: { os: "linux" } });
    assert.deepEqual(profile.platform, { os: "linux", label: "Linux" });
  } finally { globalThis.chrome = originalChrome; }
});
