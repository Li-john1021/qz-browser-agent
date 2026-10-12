import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { transformSync } from "esbuild";
import {
  computeModelSuggestionState,
  filterModelOptions,
  normalizeModelOptions,
} from "../../src/shared/settings-menu-utils.js";
import { matchConfiguredModelCapabilities } from "../../src/shared/models/model-capabilities.js";

export function createResponse(status, body = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return text;
    },
    async json() {
      return JSON.parse(text || "{}");
    },
  };
}

export function createStreamResponse(lines = []) {
  const encoder = new TextEncoder();
  const chunks = lines.map(line => encoder.encode(line));
  let index = 0;
  return {
    ok: true,
    status: 200,
    body: {
      getReader() {
        return {
          async read() {
            if (index >= chunks.length) return { done: true, value: undefined };
            return { done: false, value: chunks[index++] };
          },
          async cancel() {},
          releaseLock() {},
        };
      },
    },
    async text() {
      return "";
    },
  };
}

export const storageData = {};
export const fetchCalls = [];

globalThis.chrome = {
  storage: {
    local: {
      async get(key) {
        if (Array.isArray(key)) {
          return Object.fromEntries(key.map(item => [item, storageData[item]]));
        }
        if (typeof key === "string") return { [key]: storageData[key] };
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
      async remove(key) {
        const keys = Array.isArray(key) ? key : [key];
        keys.forEach(item => delete storageData[item]);
      },
    },
  },
};

let extraResponse;
export function setExtraResponse(handler) { extraResponse = handler; }

globalThis.fetch = async (url, options = {}) => {
  const headers = options.headers || {};
  const auth = String(headers.Authorization || headers["x-api-key"] || "").trim();
  const method = String(options.method || "GET").toUpperCase();
  fetchCalls.push({ url: String(url), auth, method, headers, body: options.body || "" });
  const contributed = extraResponse?.(url, options);
  if (contributed) return contributed;
  if (/bad/i.test(auth)) {
    return createResponse(401, { error: { message: "invalid api key" } });
  }
  if (method === "POST" && /\/tool-object\/chat\/completions$/.test(String(url))) {
    return createResponse(200, {
      choices: [{
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "call_data_object",
            type: "function",
            function: {
              name: "data_store",
              arguments: { action: "list", table: "weather" },
            },
          }],
        },
        finish_reason: "tool_calls",
      }],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    });
  }
  if (method === "POST" && /\/tool-stream\/chat\/completions$/.test(String(url))) {
    return createStreamResponse([
      `data:${JSON.stringify({
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: "call_data_stream",
              type: "function",
              function: { name: "data_store", arguments: "" },
              input: { action: "schema", table: "weather" },
            }],
          },
          finish_reason: null,
        }],
      })}\n\n`,
      `data:${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}\n\n`,
      "data: [DONE]\n\n",
    ]);
  }
  if (method === "POST" && /\/tool-whitespace-stream\/chat\/completions$/.test(String(url))) {
    const fragments = [
      "{\"source\":\"function demo() {\\n",
      "    ",
      "return",
      " ",
      "0;\\n}\"}",
    ];
    return createStreamResponse([
      ...fragments.map((argumentsFragment, index) => `data:${JSON.stringify({
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              ...(index === 0 ? {
                id: "call_whitespace_stream",
                type: "function",
                function: { name: "run_script", arguments: argumentsFragment },
              } : {
                function: { arguments: argumentsFragment },
              }),
            }],
          },
          finish_reason: null,
        }],
      })}\n\n`),
      `data:${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}\n\n`,
      "data: [DONE]\n\n",
    ]);
  }
  if (method === "POST" && /\/retry-success\/chat\/completions$/.test(String(url))) {
    const attempts = fetchCalls.filter(call => /\/retry-success\/chat\/completions$/.test(call.url)).length;
    if (attempts === 1) {
      return createResponse(503, { error: { message: "service unavailable" } });
    }
    return createResponse(200, {
      choices: [{ message: { role: "assistant", content: "retry ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
    });
  }
  if (method === "POST" && /\/retry-quota\/chat\/completions$/.test(String(url))) {
    return createResponse(429, { error: { message: "insufficient_quota" } });
  }
  if (method === "POST" && /\/chat\/completions$/.test(String(url))) {
    return createResponse(200, {
      choices: [{ message: { role: "assistant", content: "openai ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    });
  }
  if (method === "POST" && /\/messages$/.test(String(url))) {
    return createResponse(200, {
      content: [{ type: "text", text: "anthropic ok" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 2 },
    });
  }
  if (method === "GET" && /\/codex\/models(?:\?|$)/.test(String(url))) {
    return createResponse(200, {
      models: [
        {
          slug: "gpt-5.4",
        },
        {
          slug: "gpt-5.6-sol",
          supported_reasoning_levels: [
            { effort: "low" },
            { effort: "medium" },
            { effort: "high" },
            { effort: "xhigh" },
            { effort: "max" },
            { effort: "ultra" },
          ],
          default_reasoning_level: "low",
        },
        {
          model: "gpt-5.6-luna",
          supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
          defaultReasoningEffort: "medium",
        },
        {
          slug: "gpt-6-astra",
          display_name: "GPT-6-Astra",
          context_window: 272000,
          input_modalities: ["text", "image"],
        },
        {
          slug: "codex-auto-review",
          visibility: "hide",
        },
      ],
    });
  }
  return createResponse(200, {
    data: [
      { id: "model-a", owned_by: "test" },
      { id: "model-b", owned_by: "test" },
    ],
  });
};

export const llm = await import("../../src/background/llm/index.js");

export function resetStorage() {
  for (const key of Object.keys(storageData)) delete storageData[key];
  fetchCalls.length = 0;
}

export function presetByProviderModel(config, provider, model) {
  return (config.presets || []).find(preset => preset.provider === provider && preset.model === model);
}

export function readProjectFile(relativePath) {
  const original = new URL(`../../${relativePath}`, import.meta.url);
  const file = existsSync(original) ? original : new URL(`../../${relativePath.replace(/\.js$/, ".ts")}`, import.meta.url);
  const source = readFileSync(file, "utf8");
  return file.pathname.endsWith(".ts") ? transformSync(source, { loader: "ts", charset: "utf8" }).code : source;
}

export function readSettingsFeature() {
  return readProjectFile("src/capabilities/settings/settings-feature.js");
}

export function extractPresetChangeHandler(source) {
  const marker = '$("#cfg-preset").addEventListener("change", () => {';
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, "missing preset change handler");
  const braceStart = source.indexOf("{", start);
  let depth = 0;
  for (let i = braceStart; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(braceStart, i + 1);
    }
  }
  assert.fail("unterminated preset change handler");
}

export function extractFunction(source, name) {
  const pattern = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`);
  const match = pattern.exec(source);
  assert.ok(match, `missing function ${name}`);
  const braceStart = source.indexOf("{", match.index);
  let depth = 0;
  for (let i = braceStart; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(braceStart, i + 1);
    }
  }
  assert.fail(`unterminated function ${name}`);
}

export const sampleModels = normalizeModelOptions([
  "gpt-5.4",
  "gpt-5.4-mini",
  { id: "deepseek-chat", ownedBy: "DeepSeek 128K" },
  { id: "moonshot-v1", ownedBy: "Kimi 128K" },
  "GPT-5.4",
]);
