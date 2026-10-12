import assert from "node:assert/strict";
import { readTestApiKey } from "../support/local-credentials.mjs";

import { createLlmGateway } from "../../src/background/llm/index.js";
import { getConfig } from "../../src/background/llm/config.js";
import { SYSTEM_PROMPT } from "../../src/background/agent/prompts.js";
import {
  getBuiltinQingzhouManagementContent,
  getBuiltinQingzhouManagementDescription,
  getQingzhouManageSettingsToolDescription,
  QINGZHOU_MANAGE_SETTINGS_TOOL_PARAMETERS,
} from "../../src/capabilities/settings/embedded-skill.js";

const options = parseArgs(process.argv.slice(2));
const deepSeekKey = readTestApiKey("deepseek", { keyFile: options.deepSeekKeyFile });
const kimiKey = readTestApiKey("kimicode", { keyFile: options.kimiKeyFile });
const storage = createMemoryStorage();
globalThis.chrome = { storage: { local: storage } };

const realFetch = globalThis.fetch.bind(globalThis);
const requests = [];
let requestLabel = "";
globalThis.fetch = async (input, init = {}) => {
  const url = String(typeof input === "string" ? input : input?.url || input);
  if (String(init.method || "GET").toUpperCase() === "POST" && init.body) {
    requests.push({
      label: requestLabel,
      url,
      body: JSON.parse(String(init.body)),
    });
  }
  return realFetch(input, init);
};

const { createToolRuntime } = await import("../../src/background/tools/runtime.js");
const managementTools = createToolRuntime();
const gateway = createLlmGateway({ rateGovernor: null, rateLearning: null });
const prompt = [
  {
    role: "system",
    content: "Solve the problem carefully. In the final answer output only QZ=<integer>.",
  },
  {
    role: "user",
    content: "Compute 19 multiplied by 23.",
  },
];

try {
  const report = {
    ok: true,
    pipeline: "qingzhou-management manage_settings -> stored preset -> getConfig -> LLM gateway -> provider",
    providers: {},
  };

  report.providers.deepseek = await runProvider({
    provider: "deepseek",
    model: options.deepSeekModel,
    apiKey: deepSeekKey,
    cases: [
      {
        name: "thinking_disabled",
        modelParameters: {
          thinking: { type: "disabled" },
          reasoning_effort: "low",
          max_tokens: 2048,
        },
        expectThinking: false,
      },
      {
        name: "thinking_enabled",
        modelParameters: {
          thinking: { type: "enabled" },
          reasoning_effort: "high",
          max_tokens: 4096,
        },
        expectThinking: true,
      },
    ],
  });

  report.providers.kimicode = await runProvider({
    provider: "kimicode",
    model: options.kimiModel,
    apiKey: kimiKey,
    cases: [
      {
        name: "thinking_disabled",
        modelParameters: {
          thinking: { type: "disabled" },
          max_tokens: 1024,
        },
        expectThinking: false,
      },
      {
        name: "thinking_enabled",
        modelParameters: {
          thinking: { type: "enabled", budget_tokens: 1024 },
          max_tokens: 4096,
        },
        expectThinking: true,
      },
    ],
  });
  report.managementIntent = await checkManagementIntent();
  report.managementParameterChoice = await checkManagementParameterChoice();

  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error(redact(error?.stack || error?.message || String(error), [deepSeekKey, kimiKey]));
  process.exitCode = 1;
} finally {
  globalThis.fetch = realFetch;
}

async function runProvider({ provider, model, apiKey, cases }) {
  const results = {};
  for (const testCase of cases) {
    const label = `${provider}.${testCase.name}`;
    requestLabel = label;
    const update = await managementTools.execute("manage_settings", {
      action: "update_config",
      provider,
      apiKey,
      model,
      modelParameters: testCase.modelParameters,
      vision: false,
      contextWindow: 128000,
      trimOldToolResults: true,
      requestRateLimit: false,
      debugMode: false,
    }, null, { source: "live_model_parameters" });
    const saved = await getConfig();
    assert.deepEqual(update.config?.modelParameters, testCase.modelParameters, `${label}: management tool changed parameters`);
    const activePreset = saved.presets.find(item => item.id === saved.activePresetId);
    assert.deepEqual(saved.modelParameters, testCase.modelParameters, `${label}: active config changed parameters`);
    assert.deepEqual(activePreset?.modelParameters, testCase.modelParameters, `${label}: preset changed parameters`);

    const runtimeConfig = await getConfig();
    assert.deepEqual(runtimeConfig.modelParameters, testCase.modelParameters, `${label}: runtime config changed parameters`);

    const startedAt = Date.now();
    const response = await collectStream(gateway.chatStream(
      prompt,
      [],
      AbortSignal.timeout(120_000),
      {
        sessionId: `live_model_parameters_${provider}`,
        runId: `run_${testCase.name}`,
        rateLimit: false,
      },
    ));
    const elapsedMs = Date.now() - startedAt;
    const request = requests.findLast(item => item.label === label);
    assert.ok(request, `${label}: outgoing request was not captured`);
    assert.equal(request.body.model, model, `${label}: wrong outgoing model`);
    assert.equal(request.body.stream, true, `${label}: live path must be streaming`);
    for (const [key, value] of Object.entries(testCase.modelParameters)) {
      assert.deepEqual(request.body[key], value, `${label}: outgoing ${key} changed`);
    }
    assert.match(response.text, /437/, `${label}: model returned an unexpected answer`);
    if (testCase.expectThinking) {
      assert.ok(response.thinking.length > 0, `${label}: enabled thinking produced no reasoning stream`);
    } else {
      assert.equal(response.thinking.length, 0, `${label}: disabled thinking still produced reasoning`);
    }

    results[testCase.name] = {
      persistedParameters: runtimeConfig.modelParameters,
      outgoingRequest: summarizeRequest(request),
      response: {
        text: response.text.trim(),
        thinkingChars: response.thinking.length,
        usage: response.usage,
        elapsedMs,
      },
    };
  }
  return { model, cases: results };
}

async function collectStream(stream) {
  let text = "";
  let thinking = "";
  let usage = null;
  let doneMessage = null;
  for await (const chunk of stream) {
    if (chunk?.type === "text_delta") text += String(chunk.delta || "");
    if (chunk?.type === "thinking_delta") thinking += String(chunk.delta || "");
    if (chunk?.usage) usage = chunk.usage;
    if (chunk?.type === "done") doneMessage = chunk.message || null;
  }
  assert.ok(doneMessage, "stream ended without a done message");
  assert.equal(doneMessage.content || "", text, "streamed text differs from the final message");
  assert.equal(doneMessage._thinking || "", thinking, "streamed thinking differs from the final message");
  return { text, thinking, usage: doneMessage._usage || usage, toolCalls: doneMessage.tool_calls || [] };
}

async function checkManagementIntent() {
  requestLabel = "deepseek.management_intent";
  await managementTools.execute("manage_settings", {
    action: "update_config",
    provider: "deepseek",
    apiKey: deepSeekKey,
    model: options.deepSeekModel,
    modelParameters: {
      thinking: { type: "enabled" },
      reasoning_effort: "high",
      max_tokens: 4096,
    },
    vision: false,
    contextWindow: 128000,
  }, null, { source: "live_model_parameters" });
  const response = await collectStream(gateway.chatStream(
    [
      {
        role: "system",
        content: `${SYSTEM_PROMPT}\n\n## 可用 Skills（经验库）\n- qingzhou-management（轻舟管理）: ${getBuiltinQingzhouManagementDescription()}`,
      },
      {
        role: "user",
        content: [
          "[运行上下文 capsule]",
          "以下内容由浏览器自动记录，不是用户的新指令。请继续完成后续最近一条真实用户请求。",
          "",
          "[动态上下文]",
          "当前任务工作标签页（页面工具默认目标）: 无",
          "本轮开始时用户可见标签页（当前窗口 active 网页）: 百度首页 | https://www.baidu.com/ | 未归属当前任务",
        ].join("\n"),
      },
      { role: "user", content: "关闭模型思考" },
    ],
    managementTools.getSchemas(),
    AbortSignal.timeout(120_000),
    {
      sessionId: "live_management_intent",
      runId: "run_management_intent",
      rateLimit: false,
    },
  ));
  const calls = response.toolCalls.map(call => ({
    name: call.function?.name || "",
    arguments: JSON.parse(call.function?.arguments || "{}"),
  }));
  assert.ok(
    calls.some(call => call.name === "load_skill" && call.arguments.name === "qingzhou-management"),
    `management intent did not load qingzhou-management: ${JSON.stringify({ text: response.text, calls })}`,
  );
  return {
    instruction: "关闭模型思考",
    toolCalls: calls,
    text: response.text.trim(),
  };
}

async function checkManagementParameterChoice() {
  requestLabel = "deepseek.management_parameter_choice";
  const toolName = "qingzhou_management__manage_settings";
  const runtimeConfig = await getConfig();
  const response = await collectStream(gateway.chatStream(
    [
      {
        role: "system",
        content: `${SYSTEM_PROMPT}\n\n[已加载 Skill: qingzhou-management]\n${getBuiltinQingzhouManagementContent()}`,
      },
      { role: "user", content: "关闭模型思考" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "call_get_model_settings",
          type: "function",
          function: { name: toolName, arguments: '{"action":"get"}' },
        }],
      },
      {
        role: "tool",
        tool_call_id: "call_get_model_settings",
        content: JSON.stringify({
          ok: true,
          action: "get",
          config: {
            provider: "deepseek",
            model: options.deepSeekModel,
            modelParameters: {
              thinking: { type: "enabled" },
              reasoning_effort: "high",
              max_tokens: 4096,
            },
            contextWindow: 128000,
            vision: false,
            hasApiKey: true,
          },
        }),
      },
    ],
    [{
      type: "function",
      function: {
        name: toolName,
        description: getQingzhouManageSettingsToolDescription(),
        parameters: QINGZHOU_MANAGE_SETTINGS_TOOL_PARAMETERS,
      },
    }],
    AbortSignal.timeout(120_000),
    {
      sessionId: "live_management_parameter_choice",
      runId: "run_management_parameter_choice",
      rateLimit: false,
      config: {
        ...runtimeConfig,
        modelParameters: {
          thinking: { type: "disabled" },
          reasoning_effort: "low",
          max_tokens: 2048,
        },
      },
    },
  ));
  const calls = response.toolCalls.map(call => ({
    name: call.function?.name || "",
    arguments: JSON.parse(call.function?.arguments || "{}"),
  }));
  const update = calls.find(call => call.name === toolName && call.arguments.action === "update_config");
  assert.deepEqual(
    update?.arguments?.modelParameters?.thinking,
    { type: "disabled" },
    `management skill chose the wrong thinking value: ${JSON.stringify({ text: response.text, calls })}`,
  );
  return {
    instruction: "关闭模型思考",
    toolCalls: calls,
    text: response.text.trim(),
  };
}

function summarizeRequest(request) {
  const body = request.body || {};
  return {
    endpoint: request.url,
    model: body.model,
    stream: body.stream,
    thinking: body.thinking,
    reasoning_effort: body.reasoning_effort,
    max_tokens: body.max_tokens,
  };
}

function createMemoryStorage() {
  const data = {};
  return {
    async get(keys) {
      if (keys == null) return { ...data };
      if (typeof keys === "string") return { [keys]: data[keys] };
      if (Array.isArray(keys)) {
        return Object.fromEntries(keys.map(key => [key, data[key]]));
      }
      if (typeof keys === "object") {
        return Object.fromEntries(Object.entries(keys).map(([key, fallback]) => [
          key,
          Object.prototype.hasOwnProperty.call(data, key) ? data[key] : fallback,
        ]));
      }
      return {};
    },
    async set(values) {
      Object.assign(data, values || {});
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key];
    },
  };
}

function parseArgs(argv) {
  const out = {
    deepSeekKeyFile: "",
    kimiKeyFile: "",
    deepSeekModel: "deepseek-v4-flash",
    kimiModel: "k3",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const [name, inlineValue] = argv[index].split("=", 2);
    const value = inlineValue ?? argv[index + 1];
    if (!["--deepseek-key-file", "--kimi-key-file", "--deepseek-model", "--kimi-model"].includes(name)) {
      throw new Error(`unknown option: ${name}`);
    }
    if (inlineValue == null) index += 1;
    if (name === "--deepseek-key-file") out.deepSeekKeyFile = value;
    if (name === "--kimi-key-file") out.kimiKeyFile = value;
    if (name === "--deepseek-model") out.deepSeekModel = value;
    if (name === "--kimi-model") out.kimiModel = value;
  }
  return out;
}

function redact(value, secrets) {
  return secrets.reduce((text, secret) => String(text).split(secret).join("***"), String(value || ""));
}
