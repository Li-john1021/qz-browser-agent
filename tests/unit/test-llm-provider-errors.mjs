import assert from "node:assert/strict";

import test from "node:test";

import {
  chatOpenAi,
  chatStreamOpenAi,
} from "../../src/capabilities/provider-openai/adapter.js";

import {
  chatAnthropic,
  chatStreamAnthropic,
} from "../../src/capabilities/provider-anthropic/adapter.js";

import { chatStreamCodex } from "../../src/capabilities/provider-codex/adapter.js";

import {
  capLlmProviderBackoffMs,
  LLM_PROVIDER_BACKOFF_MAX_MS,
  normalizeLlmFailure,
  retryAfterMsFromHeaders,
} from "../../src/background/llm/provider-errors.js";

import { formatOutputTruncatedError } from "../../src/background/llm/protocol-shared.js";

import { collectStream, collect, providerErrorEnvelope, escapeRegExp, jsonResponse, sseResponse, rawSseResponse, noRetryOptions, config, anthropicConfig, codexConfig } from '../support/llm-provider-errors-fixture.mjs';

test("locally detected output truncation keeps an actionable deterministic error", () => {
  const failure = normalizeLlmFailure(new Error(formatOutputTruncatedError("length")), {
    phase: "stream",
  });

  assert.equal(failure.kind, "invalid_request");
  assert.match(failure.message, /输出达到长度上限/);
  assert.match(failure.message, /缩小工具参数|执行脚本/);
  assert.doesNotMatch(failure.message, /LLM output was truncated/);
});

for (const stream of [true, false]) {
  test(`unsupported content type gets actionable copy from data-only error_finish (stream=${stream})`, async () => {
    const rawMessage = "The provided messages input is invalid. The error info is [Unexpected item type in content.].";
    const content = `data: ${JSON.stringify({error:{code:"invalid_parameter_error",type:"invalid_request_error",message:rawMessage}})}`;
    globalThis.fetch = async () => stream
      ? sseResponse([{choices:[{index:0,delta:{content},finish_reason:"error_finish"}]}])
      : jsonResponse({choices:[{index:0,message:{role:"assistant",content},finish_reason:"error_finish"}]});
    const events = [];
    await assert.rejects(stream ? collectStream(events) : chatOpenAi([{role:"user",content:"test"}], [], null, {}, config()), error => {
      assert.equal(error.kind, "invalid_request");
      assert.equal(error.code, "invalid_parameter_error");
      assert.match(error.message, /可能不支持图片或截图/);
      assert.match(error.message, /切换支持图片的模型/);
      assert.doesNotMatch(error.message, /data:|Unexpected|invalid_parameter_error/);
      assert.equal(error.providerMessage, rawMessage);
      return true;
    });
    assert.equal(events.some(event => event.type === "text_delta"), false);
  });
}

test("unrelated parameter errors keep their original diagnostics", () => {
  const failure = normalizeLlmFailure(new Error("Invalid image URL"), {code:"invalid_parameter_error"});
  assert.equal(failure.kind, "invalid_request");
  assert.match(failure.message, /Invalid image URL/);
  assert.doesNotMatch(failure.message, /可能不支持图片/);
});

test("OpenAI non-stream errors preserve provider code and message without exposing the raw envelope", async () => {
  globalThis.fetch = async () => jsonResponse(providerErrorEnvelope());

  await assert.rejects(
    chatOpenAi([], [], null, noRetryOptions(), config()),
    error => (
      error?.name === "LlmProviderError"
      && error?.kind === "stream_protocol"
      && error?.code === "PROXY_014"
      && /PROXY_014/.test(error.message)
      && /private tool arguments/.test(error.message)
    ),
  );
});

test("OpenAI errors without a standard message preserve their bounded envelope", async () => {
  globalThis.fetch = async () => jsonResponse({
    error: {
      reason: "provider rejected malformed tool schema",
      diagnostic: { field: "tools[3].parameters" },
    },
  });

  await assert.rejects(
    chatOpenAi([], [], null, noRetryOptions(), config()),
    error => (
      error?.code === "LLM_PROVIDER_RESPONSE_ERROR"
      && /provider rejected malformed tool schema/.test(error.message)
      && /tools\[3\]\.parameters/.test(error.message)
    ),
  );
});

test("OpenAI stream errors are rejected before becoming assistant text", async () => {
  globalThis.fetch = async () => sseResponse([
    providerErrorEnvelope(),
  ]);
  const events = [];

  await assert.rejects(
    collectStream(events),
    error => error?.name === "LlmProviderError" && error?.kind === "stream_protocol" && error?.code === "PROXY_014",
  );
  assert.equal(events.some(event => event.type === "text_delta"), false);
});

test("OpenAI event:error SSE rejects a bare provider error payload", async () => {
  globalThis.fetch = async () => rawSseResponse([
    "id:1",
    "event:error",
    ":HTTP_STATUS/429",
    `data:${JSON.stringify({
      request_id: "req-allocation-quota",
      code: "Throttling.AllocationQuota",
      message: "Allocated quota exceeded, please increase your quota limit.",
    })}`,
    "",
  ].join("\n"));
  const events = [];

  await assert.rejects(
    collectStream(events),
    error => (
      error?.name === "LlmProviderError"
      && error?.kind === "quota"
      && error?.code === "Throttling.AllocationQuota"
      && error?.status === 429
      && error?.requestId === "req-allocation-quota"
      && /Allocated quota exceeded/.test(error.message)
    ),
  );
  assert.equal(events.some(event => event.type === "text_delta"), false);
});

test("OpenAI error_finish unwraps an embedded event:error frame", async () => {
  const embeddedError = [
    "id:1",
    "event:error",
    ":HTTP_STATUS/429",
    `data:${JSON.stringify({
      request_id: "req-embedded-allocation-quota",
      code: "Throttling.AllocationQuota",
      message: "Allocated quota exceeded, please increase your quota limit.",
    })}`,
    "",
  ].join("\n");
  globalThis.fetch = async () => sseResponse([{
    choices: [{
      index: 0,
      delta: { role: "assistant", content: embeddedError },
      finish_reason: "error_finish",
    }],
  }]);
  const events = [];

  await assert.rejects(
    collectStream(events),
    error => (
      error?.name === "LlmProviderError"
      && error?.kind === "quota"
      && error?.code === "Throttling.AllocationQuota"
      && error?.status === 429
      && error?.requestId === "req-embedded-allocation-quota"
      && /Allocated quota exceeded/.test(error.message)
    ),
  );
  assert.equal(events.some(event => event.type === "text_delta"), false);
});

test("OpenAI error_finish preserves its raw content when it cannot be decoded", async () => {
  globalThis.fetch = async () => sseResponse([{
    choices: [{
      index: 0,
      delta: { role: "assistant", content: "private unstructured provider failure" },
      finish_reason: "error_finish",
    }],
  }]);
  const events = [];

  await assert.rejects(
    collectStream(events),
    error => (
      error?.name === "LlmProviderError"
      && error?.kind === "unknown"
      && error?.code === "LLM_PROVIDER_ERROR"
      && error?.message === "private unstructured provider failure"
    ),
  );
  assert.equal(events.some(event => event.type === "text_delta"), false);
});

test("OpenAI bounds an unparsed error_finish before exposing it", async () => {
  globalThis.fetch = async () => sseResponse([{
    choices: [{
      index: 0,
      delta: { role: "assistant", content: "x".repeat(5000) },
      finish_reason: "error_finish",
    }],
  }]);

  await assert.rejects(
    collectStream([]),
    error => error?.kind === "unknown" && error?.message.length === 4000,
  );
});

test("OpenAI non-stream error_finish follows the same embedded error contract", async () => {
  const embeddedError = [
    "event:error",
    ":HTTP_STATUS/429",
    `data:${JSON.stringify({
      request_id: "req-non-stream-allocation-quota",
      code: "Throttling.AllocationQuota",
      message: "private allocation quota detail",
    })}`,
    "",
  ].join("\n");
  globalThis.fetch = async () => jsonResponse({
    choices: [{
      index: 0,
      message: { role: "assistant", content: embeddedError },
      finish_reason: "error_finish",
    }],
  });

  await assert.rejects(
    chatOpenAi([], [], null, noRetryOptions(), config()),
    error => (
      error?.kind === "quota"
      && error?.status === 429
      && error?.code === "Throttling.AllocationQuota"
      && error?.requestId === "req-non-stream-allocation-quota"
      && /private allocation/.test(error.message)
    ),
  );
});

test("ordinary assistant text is not inspected as an embedded error without error_finish", async () => {
  const content = "示例协议文本：event:error\ndata:{\"code\":\"Example\"}";
  globalThis.fetch = async () => sseResponse([
    { choices: [{ delta: { content }, finish_reason: null }] },
    { choices: [{ delta: {}, finish_reason: "stop" }] },
    "[DONE]",
  ]);
  const events = [];

  await collectStream(events);
  assert.equal(events.find(event => event.type === "done")?.message?.content, content);
});

test("ordinary assistant JSON may mention insufficient_quota without becoming an error", async () => {
  const content = JSON.stringify({
    error: {
      code: "insufficient_quota",
      message: "quota exhausted",
      type: "insufficient_quota",
    },
  });
  globalThis.fetch = async () => sseResponse([
    { choices: [{ delta: { content }, finish_reason: null }] },
    { choices: [{ delta: {}, finish_reason: "stop" }] },
    "[DONE]",
  ]);
  const events = [];

  await collectStream(events);

  assert.equal(events.find(event => event.type === "done")?.message?.content, content);
});

test("OpenAI event:error SSE does not require an HTTP status comment", async () => {
  globalThis.fetch = async () => rawSseResponse([
    "event:error",
    `data:${JSON.stringify({
      request_id: "req-without-status",
      code: "Provider.StreamError",
      message: "private provider detail",
    })}`,
    "",
  ].join("\n"));

  await assert.rejects(
    collectStream([]),
    error => (
      error?.name === "LlmProviderError"
      && error?.kind === "stream_protocol"
      && error?.code === "Provider.StreamError"
      && error?.requestId === "req-without-status"
      && !Object.prototype.hasOwnProperty.call(error, "status")
      && /private provider detail/.test(error.message)
    ),
  );
});

test("bare code and message data outside event:error is not broadened into a provider error", async () => {
  globalThis.fetch = async () => rawSseResponse([
    "event:message",
    `data:${JSON.stringify({
      code: "Throttling.AllocationQuota",
      message: "ordinary data without an SSE error event",
    })}`,
    "",
  ].join("\n"));

  await assert.rejects(
    collectStream([]),
    error => error?.name !== "LlmProviderError" && /finish_reason/.test(error?.message || ""),
  );
});

test("chunked provider error content is rejected before its identifying payload is emitted", async () => {
  globalThis.fetch = async () => sseResponse([
    { choices: [{ delta: { content: "{" }, finish_reason: null }] },
    { choices: [{ delta: { content: "\"error\":{\"code\":\"PROXY_014\",\"message\":\"private tool arguments\"}}" }, finish_reason: null }] },
    { choices: [{ delta: {}, finish_reason: "stop" }] },
    "[DONE]",
  ]);
  const events = [];

  await assert.rejects(
    collectStream(events),
    error => error?.name === "LlmProviderError" && error?.kind === "stream_protocol" && error?.code === "PROXY_014",
  );
  assert.equal(events.some(event => event.type === "done"), false);
  assert.equal(events.filter(event => event.type === "text_delta").map(event => event.delta).join("").includes("PROXY_014"), false);
});

test("provider error content appended after normal text is not emitted as assistant text", async () => {
  const prefix = "需要正确传递 blocks 数组参数。\n";
  globalThis.fetch = async () => sseResponse([
    { choices: [{ delta: { content: prefix }, finish_reason: null }] },
    { choices: [{ delta: { content: JSON.stringify(providerErrorEnvelope()) }, finish_reason: null }] },
  ]);
  const events = [];

  await assert.rejects(
    collectStream(events),
    error => error?.name === "LlmProviderError" && error?.kind === "stream_protocol" && error?.code === "PROXY_014",
  );
  assert.equal(events.filter(event => event.type === "text_delta").map(event => event.delta).join(""), prefix);
});

test("ordinary JSON containing an error field remains valid assistant content", async () => {
  const content = JSON.stringify({ error: { field: "example" }, ok: true });
  globalThis.fetch = async () => sseResponse([
    { choices: [{ delta: { content }, finish_reason: null }] },
    { choices: [{ delta: {}, finish_reason: "stop" }] },
    "[DONE]",
  ]);
  const events = [];

  await collectStream(events);
  assert.equal(events.find(event => event.type === "done")?.message?.content, content);
  assert.equal(events.filter(event => event.type === "text_delta").map(event => event.delta).join(""), content);
});

for (const status of [401, 403]) {
  for (const stream of [true, false]) {
    test(`HTTP ${status} takes precedence over a generic provider request error (stream=${stream})`, async () => {
      const message = "Authentication Fails, Your api key: ****-key is invalid";
      globalThis.fetch = async () => new Response(JSON.stringify({
        error: { code: "invalid_request_error", type: "invalid_request_error", message },
      }), { status, headers: { "content-type": "application/json" } });
      const events = [];

      await assert.rejects(
        stream ? collectStream(events) : chatOpenAi([], [], null, noRetryOptions(), config()),
        error => {
          assert.equal(error.kind, "auth");
          assert.equal(error.status, status);
          assert.equal(error.code, "invalid_request_error");
          assert.equal(error.providerMessage, message);
          return true;
        },
      );
      assert.equal(events.some(event => event.type === "text_delta"), false);
    });
  }
}

test("cancellation remains distinct from HTTP authentication failures", () => {
  const abort = new DOMException("user stop", "AbortError");
  assert.equal(normalizeLlmFailure(abort, { status: 401, code: "invalid_request_error" }), abort);
  assert.equal(abort.kind, "aborted");
});

test("specific provider errors retain their meaning with HTTP 403", () => {
  for (const [code, message, kind] of [
    ["AllocationQuota.FreeTierOnly", "free quota exhausted", "quota"],
    ["rate_limit_exceeded", "slow down", "transient"],
    ["LLM_PROVIDER_ERROR", "monthly usage limit reached", "quota"],
  ]) {
    const error = normalizeLlmFailure(new Error(message), { status: 403, code });
    assert.equal(error.kind, kind);
    assert.equal(error.status, 403);
  }
});

test("Anthropic HTTP and SSE failures use the same provider error contract", async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({
    type: "error",
    error: { type: "authentication_error", message: "private Anthropic auth detail" },
  }), { status: 401 });
  await assert.rejects(
    chatAnthropic([], [], null, noRetryOptions(), anthropicConfig()),
    error => error?.kind === "auth" && error?.status === 401 && /private Anthropic/.test(error.message),
  );

  globalThis.fetch = async () => sseResponse([{
    type: "error",
    error: { type: "overloaded_error", message: "private Anthropic overload detail" },
  }]);
  await assert.rejects(
    collect(chatStreamAnthropic([], [], null, noRetryOptions(), anthropicConfig())),
    error => error?.kind === "transient" && error?.code === "overloaded_error" && /private Anthropic/.test(error.message),
  );
});

test("Codex response.failed preserves structured context overflow semantics", async () => {
  globalThis.fetch = async () => sseResponse([{
    type: "response.failed",
    response: {
      error: {
        code: "context_length_exceeded",
        message: "private Codex context detail",
      },
    },
  }]);

  await assert.rejects(
    collect(chatStreamCodex([], [], null, noRetryOptions(), codexConfig())),
    error => (
      error?.kind === "context_overflow"
      && error?.code === "context_length_exceeded"
      && /private Codex/.test(error.message)
    ),
  );
});

test("provider failures normalize structured facts before bounded text fallbacks", () => {
  const cases = [
    {
      name: "authentication",
      error: new Error("private auth detail"),
      hints: { status: 401, code: "invalid_api_key" },
      expected: { kind: "auth", status: 401, code: "invalid_api_key" },
    },
    {
      name: "allocation quota wins over HTTP 429",
      error: new Error("private allocation detail"),
      hints: { status: 429, code: "Throttling.AllocationQuota", requestId: "req-quota" },
      expected: { kind: "quota", status: 429, code: "Throttling.AllocationQuota", requestId: "req-quota" },
    },
    {
      name: "ordinary rate limit",
      error: new Error("private rate detail"),
      hints: { status: 429, code: "RateLimitExceeded", retryAfterMs: 2500 },
      expected: { kind: "transient", status: 429, code: "RateLimitExceeded", retryAfterMs: 2500 },
    },
    {
      name: "context overflow",
      error: new Error("private context detail"),
      hints: { status: 400, code: "context_length_exceeded" },
      expected: { kind: "context_overflow", status: 400, code: "context_length_exceeded" },
    },
    {
      name: "content filter",
      error: new Error("private moderation detail"),
      hints: { status: 400, code: "content_filter" },
      expected: { kind: "content_filter", status: 400, code: "content_filter" },
    },
    {
      name: "invalid request",
      error: new Error("private invalid detail"),
      hints: { status: 422, code: "bad_parameters" },
      expected: { kind: "invalid_request", status: 422, code: "bad_parameters" },
    },
    {
      name: "transient provider failure",
      error: new Error("private unavailable detail"),
      hints: { status: 503, code: "service_unavailable" },
      expected: { kind: "transient", status: 503, code: "service_unavailable" },
    },
    {
      name: "stream protocol",
      error: Object.assign(new Error("stream disconnected before finish_reason"), { code: "Provider.StreamError" }),
      hints: {},
      expected: { kind: "stream_protocol", code: "Provider.StreamError" },
    },
  ];

  for (const item of cases) {
    const normalized = normalizeLlmFailure(item.error, item.hints);
    assert.equal(normalized.name, "LlmProviderError", item.name);
    for (const [key, value] of Object.entries(item.expected)) {
      assert.equal(normalized[key], value, `${item.name}: ${key}`);
    }
    assert.equal(normalizeLlmFailure(normalized), normalized, `${item.name}: normalization must be idempotent`);
    assert.match(normalized.message, new RegExp(escapeRegExp(item.error.message)), `${item.name}: provider details must remain visible`);
  }

  const abort = new DOMException("user stop", "AbortError");
  assert.equal(normalizeLlmFailure(abort), abort);
  assert.equal(abort.kind, "aborted");
});

test("structured provider details are visible but bounded", () => {
  const failure = normalizeLlmFailure(new Error("x".repeat(5000)), {
    code: "LLM_PROVIDER_RESPONSE_ERROR",
  });

  assert.match(failure.message, /LLM_PROVIDER_RESPONSE_ERROR/);
  assert.ok(failure.message.endsWith("x".repeat(4000)));
  assert.equal(failure.message.includes("x".repeat(4001)), false);
});

test("Retry-After parsing supports milliseconds, seconds, and HTTP dates", () => {
  assert.equal(retryAfterMsFromHeaders(new Headers({ "retry-after-ms": "1250" })), 1250);
  assert.equal(retryAfterMsFromHeaders(new Headers({ "retry-after": "2.5" })), 2500);
  assert.equal(
    retryAfterMsFromHeaders(new Headers({ "retry-after": "Tue, 21 Jul 2026 10:00:05 GMT" }), () => Date.parse("Tue, 21 Jul 2026 10:00:00 GMT")),
    5000,
  );
});

test("shared provider cooldowns accept valid delays and cap pathological ones", () => {
  assert.equal(capLlmProviderBackoffMs(null), null);
  assert.equal(capLlmProviderBackoffMs(-1), null);
  assert.equal(capLlmProviderBackoffMs(2500.9), 2500);
  assert.equal(capLlmProviderBackoffMs(Number.POSITIVE_INFINITY), null);
  assert.equal(capLlmProviderBackoffMs(999_999_999), LLM_PROVIDER_BACKOFF_MAX_MS);
});

test("OpenAI stream capture falls back to the completion id as the vendor request id", async () => {
  globalThis.fetch = async () => sseResponse([
    { id: "chatcmpl-fallback-1", choices: [{ delta: { content: "hi" } }] },
    {
      id: "chatcmpl-fallback-1",
      choices: [{ delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    },
    "[DONE]",
  ]);
  const rawExchange = {};

  for await (const event of chatStreamOpenAi([], [], null, { ...noRetryOptions(), rawExchange }, config())) {
    void event;
  }

  assert.equal(rawExchange.responseId, "chatcmpl-fallback-1");
  assert.equal(
    rawExchange.requestId,
    "chatcmpl-fallback-1",
    "gateways without a dedicated request id still populate dashscope_request_id",
  );
});

test("OpenAI stream capture prefers the explicit request_id over the completion id", async () => {
  globalThis.fetch = async () => sseResponse([
    { id: "chatcmpl-2", request_id: "req-explicit-2", choices: [{ delta: { content: "hi" } }] },
    {
      id: "chatcmpl-2",
      request_id: "req-explicit-2",
      choices: [{ delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    },
    "[DONE]",
  ]);
  const rawExchange = {};

  for await (const event of chatStreamOpenAi([], [], null, { ...noRetryOptions(), rawExchange }, config())) {
    void event;
  }

  assert.equal(rawExchange.requestId, "req-explicit-2");
  assert.equal(rawExchange.responseId, "chatcmpl-2");
});

test("OpenAI non-stream capture falls back to the completion id as the vendor request id", async () => {
  globalThis.fetch = async () => jsonResponse({
    id: "chatcmpl-nonstream-1",
    choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
  const rawExchange = {};

  await chatOpenAi([], [], null, { ...noRetryOptions(), rawExchange }, config());

  assert.equal(rawExchange.requestId, "chatcmpl-nonstream-1");
  assert.equal(rawExchange.responseId, "chatcmpl-nonstream-1");
});

test("OpenAI stream capture records the wire finish_reason", async () => {
  globalThis.fetch = async () => sseResponse([
    { id: "chatcmpl-fr", choices: [{ delta: { content: "hi" } }] },
    {
      id: "chatcmpl-fr",
      choices: [{ delta: {}, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    },
    "[DONE]",
  ]);
  const rawExchange = {};

  for await (const event of chatStreamOpenAi([], [], null, { ...noRetryOptions(), rawExchange }, config())) {
    void event;
  }

  assert.equal(rawExchange.finishReason, "tool_calls");
});

test("OpenAI non-stream capture records the wire finish_reason", async () => {
  globalThis.fetch = async () => jsonResponse({
    id: "chatcmpl-fr2",
    choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "length" }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  });
  const rawExchange = {};

  await assert.rejects(
    chatOpenAi([], [], null, { ...noRetryOptions(), rawExchange }, config()),
    /finish_reason=length/,
  );
  assert.equal(rawExchange.finishReason, "length", "the wire finish_reason is captured even when the call fails");
});

test("OpenAI capture keeps only the first value of a duplicated response header", async () => {
  const body = [
    'data: {"id":"chatcmpl-hdr","choices":[{"index":0,"delta":{"content":"hi"}}]}',
    "",
    'data: {"id":"chatcmpl-hdr","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}',
    "",
    "data: [DONE]",
    "",
  ].join("\n");
  const headers = new Headers({ "content-type": "text/event-stream" });
  headers.append("x-request-id", "req-duplicated");
  headers.append("x-request-id", "req-duplicated");
  globalThis.fetch = async () => new Response(body, { status: 200, headers });
  const rawExchange = {};

  for await (const event of chatStreamOpenAi([], [], null, { ...noRetryOptions(), rawExchange }, config())) {
    void event;
  }

  assert.equal(rawExchange.requestId, "req-duplicated");
});

test("OpenAI requests send the W3C traceparent header when the caller provides one", async () => {
  let seenHeaders = null;
  globalThis.fetch = async (_url, init) => {
    seenHeaders = init?.headers;
    return sseResponse([
      {
        id: "chatcmpl-tp",
        choices: [{ delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      },
      "[DONE]",
    ]);
  };
  const traceparent = "00-00112233445566778899aabbccddeeff-0011223344556677-01";

  for await (const event of chatStreamOpenAi([], [], null, {
    ...noRetryOptions(),
    traceparent,
    baggage: "gen_ai.conversation.id=s1",
  }, config())) {
    void event;
  }

  const headers = new Headers(seenHeaders);
  assert.equal(headers.get("traceparent"), traceparent);
  assert.equal(headers.get("baggage"), "gen_ai.conversation.id=s1");
});

test("OpenAI requests omit the traceparent header by default", async () => {
  let seenHeaders = null;
  globalThis.fetch = async (_url, init) => {
    seenHeaders = init?.headers;
    return sseResponse([
      {
        id: "chatcmpl-tp2",
        choices: [{ delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      },
      "[DONE]",
    ]);
  };

  for await (const event of chatStreamOpenAi([], [], null, noRetryOptions(), config())) {
    void event;
  }

  assert.equal(new Headers(seenHeaders).get("traceparent"), null);
  assert.equal(new Headers(seenHeaders).get("baggage"), null);
});
