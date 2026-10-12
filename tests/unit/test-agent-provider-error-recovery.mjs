import { createTestAgentServices } from "../support/agent-services.mjs";

import { attachProviderRecovery, providerRecoveryHint } from "../../src/background/llm/provider-recovery.js";

import { chatStreamOpenAi } from "../../src/capabilities/provider-openai/adapter.js";

import assert from "node:assert/strict";

import test from "node:test";

import { updateTranscriptWithAgentEvent } from "../../src/shared/session/session-codec.js";

import { normalizeLlmFailure } from "../../src/background/llm/provider-errors.js";

import {
  clearTraceLog,
  getTraceLog,
  setTraceDebugMode,
  trace,
} from "../../src/background/trace.js";

import { createAgent, createLoopAgent } from '../support/agent-provider-error-recovery-fixture.mjs';

test("stream fallback rolls back the failed stream before returning its replacement", async () => {
  const rawEnvelope = '{"error":{"code":"PROXY_014","message":"private tool arguments"}}';
  const streamedContent = `正在重新组织参数。\n${rawEnvelope}`;
  const providerError = new Error("模型服务未能完成本次响应（PROXY_014）。");
  providerError.name = "LlmProviderResponseError";
  providerError.code = "PROXY_014";

  let fallbackOptions = null;
  const agent = createAgent({
    async *chatStream() {
      yield { type: "text_delta", delta: streamedContent };
      throw providerError;
    },
    async chat(_messages, _tools, _signal, options) {
      fallbackOptions = options;
      return {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "call-document",
            type: "function",
            function: { name: "document_create", arguments: "{}" },
          }],
        },
      };
    },
  });

  let transcript = [];
  const events = [];
  agent.subscribe(event => {
    events.push(event);
    transcript = updateTranscriptWithAgentEvent(transcript, event).transcript;
  });

  const result = await agent._callLLM(new AbortController().signal);
  assert.equal(result.tool_calls[0].function.name, "document_create");
  const assistant = transcript.find(entry => entry.type === "assistant");
  assert.equal(assistant?.content, "");
  assert.equal(JSON.stringify(transcript).includes("PROXY_014"), false);
  assert.equal(JSON.stringify(transcript).includes("private tool arguments"), false);
  assert.equal(fallbackOptions?.retry?.maxRetries, 0, "the one semantic fallback must not start another transport retry budget");
  assert.equal(events.filter(event => event.type === "llm_retry" && event.reason === "stream_protocol").length, 1);
});

test("deterministic provider failures stop without a compatibility fallback", async () => {
  const cases = [
    { kind: "auth", status: 401, code: "invalid_api_key" },
    { kind: "quota", status: 429, code: "insufficient_quota" },
    { kind: "quota", status: 200, code: "tpm_limit_exceeded" },
    { kind: "invalid_request", status: 422, code: "bad_parameters" },
    { kind: "content_filter", status: 400, code: "content_filter" },
  ];

  for (const item of cases) {
    let fallbackCalls = 0;
    const failure = normalizeLlmFailure(new Error(item.code === "tpm_limit_exceeded"
      ? "private provider detail: Allocated quota exceeded"
      : "private provider detail"), item);
    const agent = createAgent({
      async *chatStream() { throw failure; },
      async chat() {
        fallbackCalls += 1;
        throw new Error("fallback must not run");
      },
    });
    const events = [];
    agent.subscribe(event => events.push(event));

    const result = await agent._callLLM(new AbortController().signal);
    assert.equal(result._stopReason, "error", item.kind);
    assert.equal(result._error.kind, item.kind, item.kind);
    assert.equal(result._error.code, item.code, item.kind);
    assert.equal(fallbackCalls, 0, item.kind);
    assert.equal(events.some(event => event.type === "llm_retry"), false, item.kind);
    assert.match(result.content, /private provider detail/, item.kind);
  }
});

test("terminal provider failure trace includes a bounded original message", async () => {
  await clearTraceLog();
  setTraceDebugMode(true);
  try {
    const rawMessage = `provider diagnostic ${"x".repeat(650)} root-cause-tail`;
    const failure = normalizeLlmFailure(new Error("OpenAI SSE error event"), {
      code: "LLM_PROVIDER_RESPONSE_ERROR",
      phase: "stream",
      payload: { message: rawMessage },
    });
    const agent = createAgent({
      async *chatStream() { throw failure; },
      async chat() { throw new Error("fallback must not run"); },
    });

    await agent._callLLM(new AbortController().signal);
    const entry = (await getTraceLog()).find(line => line.includes("llm_failure"));
    assert.match(entry || "", /provider diagnostic/);
    assert.doesNotMatch(entry || "", /OpenAI SSE error event/);
    assert.doesNotMatch(entry || "", /root-cause-tail/);
  } finally {
    setTraceDebugMode(false);
    await clearTraceLog();
  }
});

test("unsupported image failure keeps raw diagnostics out of user text", async () => {
  await clearTraceLog();
  setTraceDebugMode(true);
  try {
    const rawMessage = "The provided messages input is invalid. The error info is [Unexpected item type in content.].";
    const failure = normalizeLlmFailure(new Error("OpenAI SSE error event"), {
      code: "invalid_parameter_error",
      payload: { message: rawMessage },
    });
    const agent = createAgent({
      async *chatStream() { throw failure; },
      async chat() { throw new Error("fallback must not run"); },
    });
    const result = await agent._callLLM(new AbortController().signal);
    assert.match(result.content, /可能不支持图片或截图/);
    assert.doesNotMatch(result.content, /Unexpected/);
    assert.match((await getTraceLog()).join("\n"), /Unexpected item type in content/);
  } finally {
    setTraceDebugMode(false);
    await clearTraceLog();
  }
});

test("agent loop keeps normalized provider facts on its terminal error", async () => {
  const agent = createLoopAgent([{
    role: "assistant",
    content: "❌ LLM 调用失败: 模型服务鉴权失败。",
    _stopReason: "error",
    _error: { kind: "auth", code: "invalid_api_key", status: 401, requestId: "req-auth" },
  }]);
  let transcript = [];
  agent.subscribe(event => {
    transcript = updateTranscriptWithAgentEvent(transcript, event).transcript;
  });

  await assert.rejects(
    agent._runLoop(new AbortController().signal),
    error => error?.kind === "auth"
      && error?.code === "invalid_api_key"
      && error?.status === 401
      && error?.requestId === "req-auth",
  );
  assert.equal(agent.messages.some(message => message.role === "assistant"), false, "a UI error must not enter future model context");
  assert.match(transcript.find(entry => entry.type === "assistant")?.content || "", /模型服务鉴权失败/);
});

test("agent terminal event exposes normalized provider facts", async () => {
  const agent = createAgent({ chat: async () => ({}), chatStream: async function* () {} });
  agent._runLoop = async () => {
    const error = new Error("模型服务鉴权失败。");
    Object.assign(error, {
      kind: "auth",
      code: "invalid_api_key",
      status: 401,
      requestId: "req-terminal",
    });
    throw error;
  };
  agent._flushPendingContextEvents = async () => {};
  agent._pruneOldToolResultsIfNeeded = async () => false;
  const events = [];
  agent.subscribe(event => events.push(event));

  await agent._runWithLifecycle();

  const terminal = events.find(event => event.type === "error");
  assert.equal(terminal?.kind, "auth");
  assert.equal(terminal?.code, "invalid_api_key");
  assert.equal(terminal?.status, 401);
  assert.equal(terminal?.requestId, "req-terminal");
});

test("AllocationQuota waits two seconds before retrying the current stream", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let streamCalls = 0;
  let chatCalls = 0;
  const streamOptions = [];
  const allocationQuota = normalizeLlmFailure(new Error("private provider detail"), {
    kind: "quota",
    status: 429,
    code: "Throttling.AllocationQuota",
  });
  const agent = createAgent({
    async *chatStream(_messages, _tools, _signal, options) {
      streamCalls += 1;
      streamOptions.push(options);
      if (streamCalls === 1) {
        yield { type: "text_delta", delta: "临时正文" };
        throw allocationQuota;
      }
      yield { type: "text_delta", delta: "重试成功" };
      yield { type: "done", message: { role: "assistant", content: "重试成功" } };
    },
    async chat() {
      chatCalls += 1;
      throw new Error("non-stream fallback must not run");
    },
  });
  let transcript = [];
  const events = [];
  let resolveRetryStarted;
  const retryStarted = new Promise(resolve => { resolveRetryStarted = resolve; });
  agent.subscribe(event => {
    events.push(event);
    transcript = updateTranscriptWithAgentEvent(transcript, event).transcript;
    if (event.type === "llm_retry" && event.reason === "allocation_quota") resolveRetryStarted(event);
  });

  const resultPromise = agent._callLLM(new AbortController().signal);
  const retryEvent = await retryStarted;
  assert.equal(retryEvent.delayMs, 2000);
  assert.equal(streamCalls, 1);
  t.mock.timers.tick(1999);
  await Promise.resolve();
  assert.equal(streamCalls, 1);
  t.mock.timers.tick(1);
  const result = await resultPromise;
  assert.equal(result.content, "重试成功");
  assert.equal(streamCalls, 2);
  assert.equal(chatCalls, 0);
  assert.equal(streamOptions[1]?.retry?.maxRetries, 0);
  assert.equal(events.filter(event => event.type === "llm_retry" && event.reason === "allocation_quota").length, 1);
  assert.equal(transcript.find(entry => entry.type === "assistant")?.content, "重试成功");
  assert.equal(JSON.stringify(transcript).includes("临时正文"), false);
});

test("a repeated AllocationQuota stops after the delayed request-local retry", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let streamCalls = 0;
  let chatCalls = 0;
  const allocationQuota = normalizeLlmFailure(new Error("private provider detail"), {
    kind: "quota",
    status: 429,
    code: "Throttling.AllocationQuota",
  });
  const agent = createAgent({
    async *chatStream() {
      streamCalls += 1;
      throw allocationQuota;
    },
    async chat() {
      chatCalls += 1;
      throw new Error("non-stream fallback must not run");
    },
  });
  const events = [];
  let resolveRetryStarted;
  const retryStarted = new Promise(resolve => { resolveRetryStarted = resolve; });
  agent.subscribe(event => {
    events.push(event);
    if (event.type === "llm_retry" && event.reason === "allocation_quota") resolveRetryStarted(event);
  });

  const resultPromise = agent._callLLM(new AbortController().signal);
  const retryEvent = await retryStarted;
  assert.equal(retryEvent.delayMs, 2000);
  t.mock.timers.tick(2000);
  const result = await resultPromise;
  assert.equal(streamCalls, 2);
  assert.equal(chatCalls, 0);
  assert.equal(result._stopReason, "error");
  assert.equal(result._error.kind, "quota");
  assert.equal(result._error.code, "Throttling.AllocationQuota");
  assert.equal(events.filter(event => event.type === "llm_retry" && event.reason === "allocation_quota").length, 1);
});

test("AllocationQuota does not retry after cancellation", async () => {
  let streamCalls = 0;
  const controller = new AbortController();
  const allocationQuota = normalizeLlmFailure(new Error("private provider detail"), {
    kind: "quota",
    status: 429,
    code: "Throttling.AllocationQuota",
  });
  const agent = createAgent({
    async *chatStream() {
      streamCalls += 1;
      throw allocationQuota;
    },
    async chat() { throw new Error("non-stream fallback must not run"); },
  });
  agent.subscribe(event => {
    if (event.type === "llm_retry") controller.abort();
  });

  await assert.rejects(
    () => agent._callLLM(controller.signal),
    error => error?.name === "AbortError",
  );
  assert.equal(streamCalls, 1);
});

test("an unparsed provider error reaches the user without losing its raw message", async () => {
  const rawMessage = "private unstructured provider failure";
  const failure = normalizeLlmFailure(new Error("OpenAI provider returned error_finish"), {
    code: "LLM_PROVIDER_ERROR",
    phase: "stream",
  });
  failure.message = rawMessage;
  const agent = createAgent({
    async *chatStream() { throw failure; },
    async chat() { throw new Error("fallback must not run"); },
  });

  const result = await agent._callLLM(new AbortController().signal);
  assert.equal(result._stopReason, "error");
  assert.equal(result._error.kind, "unknown");
  assert.match(result.content, new RegExp(rawMessage));
});

test("a transient mid-stream failure receives one bounded compatibility retry", async () => {
  let streamCalls = 0;
  let fallbackCalls = 0;
  let fallbackOptions = null;
  const agent = createAgent({
    async *chatStream() {
      streamCalls += 1;
      yield { type: "text_delta", delta: "临时正文" };
      throw normalizeLlmFailure(new Error("connection lost"), { status: 503, code: "service_unavailable" });
    },
    async chat(_messages, _tools, _signal, options) {
      fallbackCalls += 1;
      fallbackOptions = options;
      return { message: { role: "assistant", content: "恢复后的正文" } };
    },
  });
  let transcript = [];
  const events = [];
  agent.subscribe(event => {
    events.push(event);
    transcript = updateTranscriptWithAgentEvent(transcript, event).transcript;
  });

  const result = await agent._callLLM(new AbortController().signal);
  assert.equal(result.content, "恢复后的正文");
  assert.equal(streamCalls, 1);
  assert.equal(fallbackCalls, 1);
  assert.equal(fallbackOptions?.retry?.maxRetries, 0);
  assert.equal(events.filter(event => event.type === "llm_retry" && event.reason === "transient").length, 1);
  assert.equal(transcript.find(entry => entry.type === "assistant")?.content, "恢复后的正文");
  assert.equal(JSON.stringify(transcript).includes("临时正文"), false);
});

test("a transient failure before the first stream event does not add a semantic fallback", async () => {
  let fallbackCalls = 0;
  const rateLimit = normalizeLlmFailure(new Error("private rate detail"), {
    status: 429,
    code: "RateLimitExceeded",
  });
  const agent = createAgent({
    async *chatStream() { throw rateLimit; },
    async chat() {
      fallbackCalls += 1;
      throw new Error("fallback must not run");
    },
  });
  const events = [];
  agent.subscribe(event => events.push(event));

  const result = await agent._callLLM(new AbortController().signal);
  assert.equal(result._stopReason, "error");
  assert.equal(result._error.kind, "transient");
  assert.equal(result._error.status, 429);
  assert.equal(fallbackCalls, 0);
  assert.equal(events.some(event => event.type === "llm_retry"), false);
});

test("a failed compatibility retry terminates instead of multiplying budgets", async () => {
  let fallbackCalls = 0;
  const transient = normalizeLlmFailure(new Error("network down"), { status: 503, code: "service_unavailable" });
  const agent = createAgent({
    async *chatStream() {
      yield { type: "text_delta", delta: "partial" };
      throw transient;
    },
    async chat(_messages, _tools, _signal, options) {
      fallbackCalls += 1;
      assert.equal(options?.retry?.maxRetries, 0);
      throw transient;
    },
  });

  const result = await agent._callLLM(new AbortController().signal);
  assert.equal(fallbackCalls, 1);
  assert.equal(result._stopReason, "error");
  assert.equal(result._error.kind, "transient");
});

test("provider context overflow forces one compact and retries with a rebuilt send window", async () => {
  let streamCalls = 0;
  let preparedCalls = 0;
  let compactCalls = 0;
  const streamOptions = [];
  const overflow = normalizeLlmFailure(new Error("private context detail"), {
    status: 400,
    code: "context_length_exceeded",
  });
  const agent = createAgent({
    async *chatStream(messages, _tools, _signal, options) {
      streamCalls += 1;
      streamOptions.push(options);
      if (streamCalls === 1) throw overflow;
      assert.equal(messages[0]?.content, "window-2");
      yield { type: "done", message: { role: "assistant", content: "压缩后恢复" } };
    },
    async chat() { throw new Error("non-stream fallback must not run"); },
  });
  agent._prepareSendWindowOrBlock = async () => {
    preparedCalls += 1;
    return {
      ok: true,
      status: "within_budget",
      sendBoundaryId: `boundary-${preparedCalls}`,
      sendMessages: [{ role: "user", content: `window-${preparedCalls}` }],
      contextEstimate: { tokens: 100, totalInputTokens: 100, messageCount: 1 },
    };
  };
  let compactOptions = null;
  agent.compactContext = async (_signal, options) => {
    compactCalls += 1;
    compactOptions = options;
    return { compacted: true };
  };
  const events = [];
  agent.subscribe(event => events.push(event));

  const result = await agent._callLLM(new AbortController().signal);
  assert.equal(result.content, "压缩后恢复");
  assert.equal(streamCalls, 2);
  assert.equal(preparedCalls, 2);
  assert.equal(compactCalls, 1);
  assert.equal(compactOptions.trigger, "provider_context_overflow");
  assert.equal(Object.prototype.hasOwnProperty.call(compactOptions, "dynamicContext"), true);
  assert.ok(Array.isArray(compactOptions.toolSchemas));
  assert.equal(streamOptions[1]?.retry?.maxRetries, 0);
  assert.equal(events.filter(event => event.type === "llm_retry" && event.reason === "context_overflow").length, 1);
});

test("a repeated context overflow stops after the single compact recovery", async () => {
  let streamCalls = 0;
  let compactCalls = 0;
  const overflow = normalizeLlmFailure(new Error("private context detail"), {
    status: 400,
    code: "context_length_exceeded",
  });
  const agent = createAgent({
    async *chatStream() {
      streamCalls += 1;
      throw overflow;
    },
    async chat() { throw new Error("non-stream fallback must not run"); },
  });
  agent.compactContext = async () => {
    compactCalls += 1;
    return { compacted: true };
  };

  const result = await agent._callLLM(new AbortController().signal);
  assert.equal(streamCalls, 2);
  assert.equal(compactCalls, 1);
  assert.equal(result._error.kind, "context_overflow");
});

test("context overflow stops when no safe compact segment exists", async () => {
  let streamCalls = 0;
  const overflow = normalizeLlmFailure(new Error("private context detail"), {
    status: 400,
    code: "context_length_exceeded",
  });
  const agent = createAgent({
    async *chatStream() {
      streamCalls += 1;
      throw overflow;
    },
    async chat() { throw new Error("non-stream fallback must not run"); },
  });
  agent.compactContext = async () => ({ compacted: false, plan: { reason: "no_compactable_segment" } });

  const result = await agent._callLLM(new AbortController().signal);
  assert.equal(streamCalls, 1);
  assert.equal(result._error.kind, "context_overflow");
});

test("agent retries one empty model response without persisting a phantom assistant turn", async () => {
  const agent = createLoopAgent([
    { role: "assistant", content: null, tool_calls: [], _spanId: "empty-1" },
    { role: "assistant", content: "已恢复", tool_calls: [], _spanId: "answer-2" },
  ]);
  const events = [];
  agent.subscribe(event => events.push(event));

  await agent._runLoop(new AbortController().signal);

  assert.equal(agent.messages.filter(message => message.role === "assistant").length, 1);
  assert.equal(agent.messages.at(-1).content, "已恢复");
  assert.equal(events.filter(event => event.type === "llm_retry" && event.reason === "empty_response").length, 1);
});

test("agent exposes a stable error after two consecutive empty model responses", async () => {
  const agent = createLoopAgent([
    { role: "assistant", content: "", tool_calls: [], _spanId: "empty-1" },
    { role: "assistant", content: null, tool_calls: [], _spanId: "empty-2" },
  ]);

  await assert.rejects(
    () => agent._runLoop(new AbortController().signal),
    error => error?.code === "EMPTY_LLM_RESPONSE" && error?.details?.attempts === 2,
  );
  assert.equal(agent.messages.some(message => message.role === "assistant"), false);
});

test("agent forwards its prepared-window estimate and surfaces long provider waits", async () => {
  let requestOptions = null;
  const agent = createAgent({
    async *chatStream(_messages, _tools, _signal, options) {
      requestOptions = options;
      options.onRateWait({ waitMs: 6200, waitedMs: 5000 });
      yield { type: "done", message: { role: "assistant", content: "继续" } };
    },
    async chat() {
      throw new Error("fallback should not run");
    },
  });
  agent._prepareSendWindowOrBlock = async () => ({
    ok: true,
    status: "within_budget",
    sendBoundaryId: "boundary-test",
    sendMessages: [{ role: "user", content: "hello" }],
    contextEstimate: { tokens: 4321, totalInputTokens: 4321, messageCount: 1 },
  });
  const events = [];
  agent.subscribe(event => events.push(event));

  const result = await agent._callLLM(new AbortController().signal);
  assert.equal(result.content, "继续");
  assert.equal(requestOptions.inputTokensEstimate, 4321);
  assert.equal(requestOptions.sessionId, "provider-recovery-session");
  assert.equal(requestOptions.runId, "provider-recovery-run");
  assert.equal(requestOptions.spanId, "provider-recovery-run:llm:1");
  const waitEvent = events.find(event => event.type === "llm_rate_wait");
  assert.equal(waitEvent?.waitMs, 6200);
  assert.equal(waitEvent?.runId, "provider-recovery-run");
});
