import assert from "node:assert/strict";

const storageData = {};
const fetchCalls = [];
let codexStreamMode = "normal";
let codexConnectFailuresRemaining = 0;
let openAiChatMode = "normal";

function createResponse(status, body = {}) {
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

function createStreamResponse(chunks = []) {
  const encoder = new TextEncoder();
  return {
    ok: true,
    status: 200,
    headers: { get() { return null; } },
    body: new ReadableStream({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    }),
    async text() {
      return "";
    },
    async json() {
      return {};
    },
  };
}

function createOpenStreamResponse(chunks = []) {
  const encoder = new TextEncoder();
  return {
    ok: true,
    status: 200,
    headers: { get() { return null; } },
    body: new ReadableStream({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }
      },
    }),
    async text() {
      return "";
    },
    async json() {
      return {};
    },
  };
}

function sseData(payload) {
  return `data: ${typeof payload === "string" ? payload : JSON.stringify(payload)}\n\n`;
}

function sseEvent(type, payload) {
  return `event: ${type}\ndata: ${typeof payload === "string" ? payload : JSON.stringify(payload)}\n\n`;
}

globalThis.chrome = {
  storage: {
    local: {
      async get(key) {
        if (typeof key === "string") return { [key]: storageData[key] };
        if (Array.isArray(key)) return Object.fromEntries(key.map(item => [item, storageData[item]]));
        return {};
      },
      async set(values) {
        Object.assign(storageData, values);
      },
      async remove(key) {
        delete storageData[key];
      },
    },
  },
};

globalThis.fetch = async (url, options = {}) => {
  const call = { url: String(url), options, body: JSON.parse(String(options.body || "{}")) };
  fetchCalls.push(call);
  if (/\/codex\/responses(?:\?|$)/.test(call.url)) {
    if (codexStreamMode === "connect-failures" && codexConnectFailuresRemaining > 0) {
      codexConnectFailuresRemaining -= 1;
      throw new TypeError("Failed to fetch");
    }
    if (codexStreamMode === "terminal-open") {
      return createOpenStreamResponse([
        sseData({
          type: "response.output_item.done",
          output_index: 0,
          item: {
            type: "message",
            id: "msg_1",
            role: "assistant",
            content: [{ type: "output_text", text: "codex answer" }],
            status: "completed",
          },
        }),
        sseData({
          type: "response.completed",
          response: { status: "completed" },
        }),
      ]);
    }
    if (codexStreamMode === "event-line-delta") {
      return createStreamResponse([
        sseEvent("response.reasoning_summary_text.delta", { output_index: 0, delta: "codex stream reasoning" }),
        sseEvent("response.output_text.delta", { output_index: 1, delta: "codex " }),
        sseEvent("response.output_text.delta", { output_index: 1, delta: "stream answer" }),
        sseEvent("response.output_item.done", {
          output_index: 1,
          item: {
            type: "message",
            id: "msg_1",
            role: "assistant",
            content: [{ type: "output_text", text: "codex stream answer" }],
            status: "completed",
          },
        }),
        sseEvent("response.completed", {
          response: { status: "completed" },
        }),
      ]);
    }
    if (codexStreamMode === "responses-slot-lifecycle") {
      return createStreamResponse([
        sseEvent("response.output_item.added", {
          output_index: 0,
          item: {
            id: "rs_1",
            type: "reasoning",
            content: [],
            encrypted_content: "encrypted-slot-reasoning",
            summary: [],
          },
          sequence_number: 2,
        }),
        sseEvent("response.output_item.done", {
          output_index: 0,
          item: {
            id: "rs_1",
            type: "reasoning",
            content: [],
            encrypted_content: "encrypted-slot-reasoning",
            summary: [],
          },
          sequence_number: 3,
        }),
        sseEvent("response.output_item.added", {
          output_index: 1,
          item: {
            id: "msg_1",
            type: "message",
            status: "in_progress",
            content: [],
            phase: "final_answer",
            role: "assistant",
          },
          sequence_number: 4,
        }),
        sseEvent("response.content_part.added", {
          output_index: 1,
          content_index: 0,
          item_id: "msg_1",
          part: { type: "output_text", annotations: [], logprobs: [], text: "" },
          sequence_number: 5,
        }),
        sseEvent("response.output_text.delta", {
          output_index: 1,
          content_index: 0,
          item_id: "msg_1",
          delta: "好的",
          sequence_number: 6,
        }),
        sseEvent("response.output_text.delta", {
          output_index: 1,
          content_index: 0,
          item_id: "msg_1",
          delta: "，流式",
          sequence_number: 7,
        }),
        sseEvent("response.output_item.done", {
          output_index: 1,
          item: {
            type: "message",
            id: "msg_1",
            role: "assistant",
            content: [{ type: "output_text", text: "好的，流式" }],
            status: "completed",
            phase: "final_answer",
          },
          sequence_number: 8,
        }),
        sseEvent("response.completed", {
          response: { status: "completed" },
          sequence_number: 9,
        }),
      ]);
    }
    return createStreamResponse([
      sseData({
        type: "response.output_item.done",
        output_index: 0,
        item: {
          type: "reasoning",
          id: "rs_1",
          summary: [{ type: "summary_text", text: "codex reasoning" }],
          encrypted_content: "encrypted-codex-reasoning",
        },
      }),
      sseData({
        type: "response.output_item.done",
        output_index: 1,
        item: {
          type: "message",
          id: "msg_1",
          role: "assistant",
          content: [{ type: "output_text", text: "codex answer" }],
          status: "completed",
        },
      }),
      sseData({
        type: "response.completed",
        response: {
          status: "completed",
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            total_tokens: 15,
            input_tokens_details: { cached_tokens: 3 },
          },
        },
      }),
    ]);
  }
  if (/\/anthropic\/messages$/.test(call.url)) {
    if (call.body.stream) {
      return createStreamResponse([
        sseData({ type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 0 } } }),
        sseData({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }),
        sseData({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "anthropic stream thinking" } }),
        sseData({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig-stream" } }),
        sseData({ type: "content_block_stop", index: 0 }),
        sseData({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }),
        sseData({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "anthropic stream answer" } }),
        sseData({ type: "content_block_stop", index: 1 }),
        sseData({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 4 } }),
        sseData({ type: "message_stop" }),
      ]);
    }
    return createResponse(200, {
      content: [
        { type: "thinking", thinking: "anthropic thinking", signature: "sig-1" },
        { type: "text", text: "anthropic answer" },
      ],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 4 },
    });
  }
  if (call.body.stream) {
    if (openAiChatMode === "reasoning-only") {
      return createStreamResponse([
        sseData({ choices: [{ delta: { reasoning: "openai stream reasoning only" } }] }),
        sseData({
          choices: [{ delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
        }),
        sseData("[DONE]"),
      ]);
    }
    return createStreamResponse([
      sseData({ choices: [{ delta: { reasoning: "openai stream reasoning" } }] }),
      sseData({ choices: [{ delta: { content: "openai stream answer" } }] }),
      sseData({
        choices: [{ delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
      }),
      sseData("[DONE]"),
    ]);
  }
  if (openAiChatMode === "reasoning-only") {
    return createResponse(200, {
      choices: [{
        message: {
          role: "assistant",
          content: null,
          reasoning_content: "openai reasoning only",
        },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
    });
  }
  return createResponse(200, {
    choices: [{
      message: {
        role: "assistant",
        content: "openai answer",
        reasoning_content: "openai reasoning",
      },
      finish_reason: "stop",
    }],
    usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
  });
};

const llmModule = await import("../../src/background/llm/index.js");
const llm = llmModule.createLlmGateway({ rateGovernor: null });

await assertRawCustomConfigIsNormalized();
await assertModelParametersPassThroughProtocolBodies();
await assertOpenAiReasoningStateRoundTrips();
await assertOpenAiStreamReasoningStateRoundTrips();
await assertOpenAiReasoningOnlyResponseIsNotReplayable();
await assertOpenAiStreamReasoningOnlyResponseIsNotReplayable();
await assertOpenAiReasoningOnlyHistoryIsFiltered();
await assertOpenAiToolCallReasoningStateRoundTrips();
await assertOpenAiReasoningStateDoesNotCrossModel();
await assertOpenAiReasoningStateDoesNotCrossEndpoint();
await assertAnthropicThinkingStateRoundTrips();
await assertAnthropicStreamThinkingStateRoundTrips();
await assertCodexUsesUnifiedTransportRetryBudget();
await assertCodexStreamStopsAtTerminalEvent();
await assertCodexSseEventNameDeltasStream();
await assertCodexResponsesSlotLifecycleStreams();
await assertCodexReasoningDefaultsToMedium();
await assertCodexResponsesReasoningStateRoundTrips();

console.log("llm provider state tests passed");

async function assertRawCustomConfigIsNormalized() {
  fetchCalls.length = 0;
  await llm.chat([{ role: "user", content: "hello" }], [], null, {
    config: {
      provider: "custom",
      customProtocol: "openai",
      customEndpoint: "https://provider.test/openai/chat/completions",
      apiKey: "test-key",
      model: "deepseek-v4-flash",
    },
  });
  assert.equal(fetchCalls.at(-1).url, "https://provider.test/openai/chat/completions");
}

async function assertModelParametersPassThroughProtocolBodies() {
  const tools = [{
    type: "function",
    function: {
      name: "lookup",
      description: "Lookup a value",
      parameters: { type: "object", properties: { query: { type: "string" } } },
    },
  }];

  fetchCalls.length = 0;
  await llm.chat([{ role: "user", content: "hello" }], [], null, {
    config: {
      provider: "deepseek",
      apiKey: "test-key",
      model: "deepseek-v4-flash",
      modelParameters: {
        reasoning_effort: "low",
        thinking: { type: "disabled" },
      },
    },
  });
  const deepSeekBody = fetchCalls.at(-1).body;
  assert.equal(deepSeekBody.reasoning_effort, "low");
  assert.deepEqual(deepSeekBody.thinking, { type: "disabled" });

  fetchCalls.length = 0;
  await llm.chat([{ role: "user", content: "hello" }], [], null, {
    config: {
      provider: "kimicode",
      apiKey: "test-key",
      model: "k3",
      modelParameters: {
        thinking: { type: "enabled", budget_tokens: 8192 },
      },
    },
  });
  const kimiCodeBody = fetchCalls.at(-1).body;
  assert.deepEqual(kimiCodeBody.thinking, { type: "enabled", budget_tokens: 8192 });

  fetchCalls.length = 0;
  await llm.chat([{ role: "user", content: "hello" }], tools, null, {
    config: {
      provider: "custom",
      customProtocol: "openai",
      customEndpoint: "https://provider.test/openai/chat/completions",
      apiKey: "test-key",
      model: "openai-compatible-model",
      modelParameters: {
        temperature: 0.25,
        max_tokens: 321,
        tool_choice: "none",
        model: "must-not-win",
        messages: [{ role: "user", content: "must-not-win" }],
        stream: "must-not-win",
      },
    },
  });
  const openAiBody = fetchCalls.at(-1).body;
  assert.equal(openAiBody.temperature, 0.25);
  assert.equal(openAiBody.max_tokens, 321);
  assert.equal(openAiBody.tool_choice, "none");
  assert.equal(openAiBody.model, "openai-compatible-model");
  assert.equal(openAiBody.messages[0].content, "hello");
  assert.equal(openAiBody.stream, false);
  assert.equal(openAiBody.tools[0].function.name, "lookup");

  fetchCalls.length = 0;
  await llm.chat([
    { role: "system", content: "system-owned" },
    { role: "user", content: "hello" },
  ], tools, null, {
    config: {
      provider: "custom",
      customProtocol: "anthropic",
      customEndpoint: "https://provider.test/anthropic/messages",
      apiKey: "test-key",
      model: "anthropic-compatible-model",
      modelParameters: {
        temperature: 0.4,
        max_tokens: 654,
        thinking: { type: "enabled", budget_tokens: 2048 },
        system: "must-not-win",
        tools: [],
      },
    },
  });
  const anthropicBody = fetchCalls.at(-1).body;
  assert.equal(anthropicBody.temperature, 0.4);
  assert.equal(anthropicBody.max_tokens, 654);
  assert.deepEqual(anthropicBody.thinking, { type: "enabled", budget_tokens: 2048 });
  assert.deepEqual(anthropicBody.system, [{ type: "text", text: "system-owned" }]);
  assert.equal(anthropicBody.tools[0].name, "lookup");

  storageData.openaiCodexAuth = {
    access: "codex-access",
    refresh: "",
    expires: Date.now() + 60 * 60 * 1000,
    accountId: "acct_test",
  };
  fetchCalls.length = 0;
  await llm.chat([{ role: "user", content: "hello" }], tools, null, {
    config: {
      provider: "openaicodex",
      model: "gpt-5.6-sol",
      codexReasoningEffort: "medium",
      modelParameters: {
        reasoning: { effort: "max", summary: "detailed" },
        text: { verbosity: "high" },
        tool_choice: "required",
        parallel_tool_calls: false,
        store: true,
        input: [{ role: "user", content: "must-not-win" }],
      },
    },
    sessionId: "model-parameters-test",
  });
  const codexBody = fetchCalls.at(-1).body;
  assert.deepEqual(codexBody.reasoning, { effort: "max", summary: "detailed" });
  assert.deepEqual(codexBody.text, { verbosity: "high" });
  assert.equal(codexBody.tool_choice, "required");
  assert.equal(codexBody.parallel_tool_calls, false);
  assert.equal(codexBody.store, false);
  assert.equal(codexBody.input.at(-1).role, "user");
  assert.equal(codexBody.tools[0].name, "lookup");
}

async function assertOpenAiReasoningStateRoundTrips() {
  fetchCalls.length = 0;
  const config = {
    provider: "custom",
    customProtocol: "openai",
    customEndpoint: "https://provider.test/openai/chat/completions",
    endpoint: "https://provider.test/openai/chat/completions",
    apiKey: "test-key",
    model: "deepseek-v4-flash",
  };

  const first = await llm.chat([{ role: "user", content: "hello" }], [], null, { config });
  assert.equal(first.message._thinking, "openai reasoning");
  assert.equal(first.message._providerState.kind, "openai_reasoning");
  assert.equal(first.message._providerState.reasoningField, "reasoning_content");

  fetchCalls.length = 0;
  await llm.chat([
    first.message,
    { role: "user", content: "continue" },
  ], [], null, { config });
  const body = fetchCalls.at(-1).body;
  assert.equal(body.messages[0].role, "assistant");
  assert.equal(body.messages[0].reasoning_content, "openai reasoning");
  assert.equal(body.messages[0]._providerState, undefined);
  assert.equal(body.messages[0]._thinking, undefined);
}

async function assertOpenAiStreamReasoningStateRoundTrips() {
  fetchCalls.length = 0;
  const config = {
    provider: "custom",
    customProtocol: "openai",
    customEndpoint: "https://provider.test/openai/chat/completions",
    apiKey: "test-key",
    model: "deepseek-v4-flash",
  };

  let first = null;
  for await (const chunk of llm.chatStream([{ role: "user", content: "hello" }], [], null, { config })) {
    if (chunk.type === "done") first = chunk.message;
  }
  assert.equal(first._thinking, "openai stream reasoning");
  assert.equal(first._providerState.kind, "openai_reasoning");
  assert.equal(first._providerState.reasoningField, "reasoning");

  fetchCalls.length = 0;
  await llm.chat([
    first,
    { role: "user", content: "continue" },
  ], [], null, { config });
  const body = fetchCalls.at(-1).body;
  assert.equal(body.messages[0].reasoning, "openai stream reasoning");
}

async function assertOpenAiReasoningOnlyResponseIsNotReplayable() {
  fetchCalls.length = 0;
  const config = {
    provider: "custom",
    customProtocol: "openai",
    customEndpoint: "https://provider.test/openai/chat/completions",
    apiKey: "test-key",
    model: "deepseek-v4-flash",
  };

  openAiChatMode = "reasoning-only";
  let first;
  try {
    first = await llm.chat([{ role: "user", content: "finish silently" }], [], null, { config });
  } finally {
    openAiChatMode = "normal";
  }
  assert.equal(first.message.content, null);
  assert.equal(first.message._thinking, "openai reasoning only");
  assert.equal(first.message._providerState, undefined);

  fetchCalls.length = 0;
  await llm.chat([
    first.message,
    { role: "user", content: "continue" },
  ], [], null, { config });
  assert.deepEqual(fetchCalls.at(-1).body.messages.map(message => message.role), ["user"]);
}

async function assertOpenAiStreamReasoningOnlyResponseIsNotReplayable() {
  fetchCalls.length = 0;
  const config = {
    provider: "custom",
    customProtocol: "openai",
    customEndpoint: "https://provider.test/openai/chat/completions",
    apiKey: "test-key",
    model: "deepseek-v4-flash",
  };

  openAiChatMode = "reasoning-only";
  let first = null;
  try {
    for await (const chunk of llm.chatStream([{ role: "user", content: "finish silently" }], [], null, { config })) {
      if (chunk.type === "done") first = chunk.message;
    }
  } finally {
    openAiChatMode = "normal";
  }
  assert.equal(first.content, null);
  assert.equal(first._thinking, "openai stream reasoning only");
  assert.equal(first._providerState, undefined);
}

async function assertOpenAiReasoningOnlyHistoryIsFiltered() {
  fetchCalls.length = 0;
  const config = {
    provider: "custom",
    customProtocol: "openai",
    customEndpoint: "https://provider.test/openai/chat/completions",
    apiKey: "test-key",
    model: "deepseek-v4-flash",
  };
  const first = await llm.chat([{ role: "user", content: "hello" }], [], null, { config });
  const pollutedAssistant = { ...first.message, content: null };

  fetchCalls.length = 0;
  await llm.chat([
    pollutedAssistant,
    { role: "user", content: "continue" },
  ], [], null, { config });
  const messages = fetchCalls.at(-1).body.messages;
  assert.deepEqual(messages.map(message => message.role), ["user"]);
  assert.equal(JSON.stringify(messages).includes("openai reasoning"), false);
}

async function assertOpenAiToolCallReasoningStateRoundTrips() {
  fetchCalls.length = 0;
  const config = {
    provider: "custom",
    customProtocol: "openai",
    customEndpoint: "https://provider.test/openai/chat/completions",
    apiKey: "test-key",
    model: "deepseek-v4-flash",
  };
  const first = await llm.chat([{ role: "user", content: "hello" }], [], null, { config });
  const toolAssistant = {
    ...first.message,
    content: null,
    tool_calls: [{
      id: "call_1",
      type: "function",
      function: { name: "inspect_page", arguments: "{}" },
    }],
  };

  fetchCalls.length = 0;
  await llm.chat([
    toolAssistant,
    { role: "tool", tool_call_id: "call_1", content: "ok" },
    { role: "user", content: "continue" },
  ], [], null, { config });
  const replayed = fetchCalls.at(-1).body.messages[0];
  assert.equal(replayed.content, null);
  assert.equal(replayed.reasoning_content, "openai reasoning");
  assert.equal(replayed.tool_calls[0].function.name, "inspect_page");
}

async function assertOpenAiReasoningStateDoesNotCrossModel() {
  fetchCalls.length = 0;
  const firstConfig = {
    provider: "custom",
    customProtocol: "openai",
    customEndpoint: "https://provider.test/openai/chat/completions",
    endpoint: "https://provider.test/openai/chat/completions",
    apiKey: "test-key",
    model: "deepseek-v4-flash",
  };
  const nextConfig = { ...firstConfig, model: "deepseek-v4-pro" };
  const first = await llm.chat([{ role: "user", content: "hello" }], [], null, { config: firstConfig });

  fetchCalls.length = 0;
  await llm.chat([
    first.message,
    { role: "user", content: "continue" },
  ], [], null, { config: nextConfig });
  const body = fetchCalls.at(-1).body;
  assert.equal(body.messages[0].reasoning_content, undefined);
}

async function assertOpenAiReasoningStateDoesNotCrossEndpoint() {
  fetchCalls.length = 0;
  const firstConfig = {
    provider: "custom",
    customProtocol: "openai",
    customEndpoint: "https://provider-a.test/openai/chat/completions",
    apiKey: "test-key",
    model: "deepseek-v4-flash",
  };
  const nextConfig = { ...firstConfig, customEndpoint: "https://provider-b.test/openai/chat/completions" };
  const first = await llm.chat([{ role: "user", content: "hello" }], [], null, { config: firstConfig });

  fetchCalls.length = 0;
  await llm.chat([
    first.message,
    { role: "user", content: "continue" },
  ], [], null, { config: nextConfig });
  const body = fetchCalls.at(-1).body;
  assert.equal(body.messages[0].reasoning_content, undefined);
}

async function assertAnthropicThinkingStateRoundTrips() {
  fetchCalls.length = 0;
  const config = {
    provider: "custom",
    customProtocol: "anthropic",
    customEndpoint: "https://provider.test/anthropic/messages",
    endpoint: "https://provider.test/anthropic/messages",
    apiKey: "test-key",
    model: "kimi-for-coding",
  };

  const first = await llm.chat([{ role: "user", content: "hello" }], [], null, { config });
  assert.equal(first.message._thinking, "anthropic thinking");
  assert.equal(first.message._providerState.kind, "anthropic_thinking");
  assert.deepEqual(first.message._providerState.thinkingBlocks, [{
    type: "thinking",
    thinking: "anthropic thinking",
    signature: "sig-1",
  }]);

  fetchCalls.length = 0;
  await llm.chat([
    first.message,
    { role: "user", content: "continue" },
  ], [], null, { config });
  const body = fetchCalls.at(-1).body;
  assert.equal(body.messages[0].role, "assistant");
  assert.deepEqual(body.messages[0].content[0], {
    type: "thinking",
    thinking: "anthropic thinking",
    signature: "sig-1",
  });
  assert.deepEqual(body.messages[0].content[1], { type: "text", text: "anthropic answer" });
}

async function assertAnthropicStreamThinkingStateRoundTrips() {
  fetchCalls.length = 0;
  const config = {
    provider: "custom",
    customProtocol: "anthropic",
    customEndpoint: "https://provider.test/anthropic/messages",
    apiKey: "test-key",
    model: "kimi-for-coding",
  };

  let first = null;
  for await (const chunk of llm.chatStream([{ role: "user", content: "hello" }], [], null, { config })) {
    if (chunk.type === "done") first = chunk.message;
  }
  assert.equal(first._thinking, "anthropic stream thinking");
  assert.equal(first._providerState.kind, "anthropic_thinking");
  assert.deepEqual(first._providerState.thinkingBlocks, [{
    type: "thinking",
    thinking: "anthropic stream thinking",
    signature: "sig-stream",
  }]);
  assert.deepEqual(first._usage, {
    input_tokens: 10,
    output_tokens: 4,
    total_tokens: 14,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  });

  fetchCalls.length = 0;
  await llm.chat([
    first,
    { role: "user", content: "continue" },
  ], [], null, { config });
  const body = fetchCalls.at(-1).body;
  assert.deepEqual(body.messages[0].content[0], {
    type: "thinking",
    thinking: "anthropic stream thinking",
    signature: "sig-stream",
  });
}

async function assertCodexResponsesReasoningStateRoundTrips() {
  fetchCalls.length = 0;
  storageData.openaiCodexAuth = {
    access: "codex-access",
    refresh: "",
    expires: Date.now() + 60 * 60 * 1000,
    accountId: "acct_test",
  };
  const config = {
    provider: "openaicodex",
    model: "gpt-5.4",
    codexReasoningEffort: "high",
  };

  const first = await llm.chat([{ role: "user", content: "hello" }], [], null, { config, sessionId: "state-test" });
  assert.equal(first.message.content, "codex answer");
  assert.equal(first.message._thinking, "codex reasoning");
  assert.equal(first.message._providerState.kind, "openai_responses_reasoning");
  assert.equal(first.message._providerState.reasoningItems[0].encrypted_content, "encrypted-codex-reasoning");

  fetchCalls.length = 0;
  await llm.chat([
    first.message,
    { role: "user", content: "continue" },
  ], [], null, { config, sessionId: "state-test" });
  const body = fetchCalls.at(-1).body;
  assert.equal(body.input[0].type, "reasoning");
  assert.equal(body.input[0].encrypted_content, "encrypted-codex-reasoning");
  assert.equal(body.input[1].type, "message");

  fetchCalls.length = 0;
  await llm.chat([
    { ...first.message, content: null },
    { role: "user", content: "continue from reasoning only" },
  ], [], null, { config, sessionId: "state-test" });
  const stateOnlyBody = fetchCalls.at(-1).body;
  assert.equal(stateOnlyBody.input[0].type, "reasoning");
  assert.equal(stateOnlyBody.input[0].encrypted_content, "encrypted-codex-reasoning");
  assert.equal(stateOnlyBody.input[1].role, "user");
}

async function assertCodexReasoningDefaultsToMedium() {
  storageData.openaiCodexAuth = {
    access: "codex-access",
    refresh: "",
    expires: Date.now() + 60 * 60 * 1000,
    accountId: "acct_test",
  };

  fetchCalls.length = 0;
  await llm.chat([{ role: "user", content: "hello" }], [], null, {
    config: {
      provider: "openaicodex",
      model: "gpt-5.6-sol",
    },
    sessionId: "reasoning-default-test",
  });
  assert.equal(fetchCalls.at(-1).body.reasoning.effort, "medium");

  for (const removed of ["none", "minimal"]) {
    fetchCalls.length = 0;
    await llm.chat([{ role: "user", content: "hello" }], [], null, {
      config: {
        provider: "openaicodex",
        model: "gpt-5.6-sol",
        codexReasoningEffort: removed,
      },
      sessionId: `reasoning-${removed}-test`,
    });
    assert.equal(fetchCalls.at(-1).body.reasoning.effort, "medium");
  }

  fetchCalls.length = 0;
  await llm.chat([{ role: "user", content: "hello" }], [], null, {
    config: {
      provider: "openaicodex",
      model: "gpt-5.6-luna",
      codexReasoningEffort: "ultra",
    },
    sessionId: "reasoning-model-limit-test",
  });
  assert.equal(fetchCalls.at(-1).body.reasoning.effort, "medium");
}

async function assertCodexStreamStopsAtTerminalEvent() {
  fetchCalls.length = 0;
  storageData.openaiCodexAuth = {
    access: "codex-access",
    refresh: "",
    expires: Date.now() + 60 * 60 * 1000,
    accountId: "acct_test",
  };
  const config = {
    provider: "openaicodex",
    model: "gpt-5.4",
  };

  codexStreamMode = "terminal-open";
  const controller = new AbortController();
  const abortTimer = setTimeout(() => controller.abort(), 250);
  try {
    const first = await llm.chat([{ role: "user", content: "hello" }], [], controller.signal, { config, sessionId: "terminal-open-test" });
    assert.equal(first.message.content, "codex answer");
  } finally {
    clearTimeout(abortTimer);
    codexStreamMode = "normal";
  }
}

async function assertCodexSseEventNameDeltasStream() {
  fetchCalls.length = 0;
  storageData.openaiCodexAuth = {
    access: "codex-access",
    refresh: "",
    expires: Date.now() + 60 * 60 * 1000,
    accountId: "acct_test",
  };
  const config = {
    provider: "openaicodex",
    model: "gpt-5.4",
  };

  codexStreamMode = "event-line-delta";
  const chunks = [];
  try {
    for await (const chunk of llm.chatStream([{ role: "user", content: "hello" }], [], null, { config, sessionId: "event-line-delta-test" })) {
      chunks.push(chunk);
    }
  } finally {
    codexStreamMode = "normal";
  }

  assert.deepEqual(
    chunks.filter(chunk => chunk.type === "thinking_delta").map(chunk => chunk.delta),
    ["codex stream reasoning"],
  );
  assert.deepEqual(
    chunks.filter(chunk => chunk.type === "text_delta").map(chunk => chunk.delta),
    ["codex ", "stream answer"],
  );
  assert.equal(chunks.at(-1).type, "done");
  assert.equal(chunks.at(-1).message.content, "codex stream answer");
}

async function assertCodexResponsesSlotLifecycleStreams() {
  fetchCalls.length = 0;
  storageData.openaiCodexAuth = {
    access: "codex-access",
    refresh: "",
    expires: Date.now() + 60 * 60 * 1000,
    accountId: "acct_test",
  };
  const config = {
    provider: "openaicodex",
    model: "gpt-5.4",
  };

  codexStreamMode = "responses-slot-lifecycle";
  const chunks = [];
  try {
    for await (const chunk of llm.chatStream([{ role: "user", content: "hello" }], [], null, { config, sessionId: "slot-lifecycle-test" })) {
      chunks.push(chunk);
    }
  } finally {
    codexStreamMode = "normal";
  }

  assert.deepEqual(
    chunks.map(chunk => chunk.type).filter(type => ["thinking_start", "thinking_end", "text_start", "text_delta", "text_end"].includes(type)),
    ["thinking_start", "thinking_end", "text_start", "text_delta", "text_delta", "text_end"],
  );
  assert.deepEqual(
    chunks.filter(chunk => chunk.type === "text_delta").map(chunk => chunk.delta),
    ["好的", "，流式"],
  );
  assert.equal(chunks.find(chunk => chunk.type === "text_start").outputIndex, 1);
  assert.equal(chunks.at(-1).type, "done");
  assert.equal(chunks.at(-1).message.content, "好的，流式");
  assert.equal(chunks.at(-1).message._providerState.reasoningItems[0].encrypted_content, "encrypted-slot-reasoning");
}

async function assertCodexUsesUnifiedTransportRetryBudget() {
  storageData.openaiCodexAuth = {
    access: "codex-access",
    refresh: "",
    expires: Date.now() + 60 * 60 * 1000,
    accountId: "acct_test",
  };
  const config = {
    provider: "openaicodex",
    endpoint: "https://chatgpt.com/backend-api/codex/responses",
    model: "gpt-5.4",
  };

  const requestOptions = {
    config,
    sessionId: "retry-test",
    retry: { baseDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 },
  };
  const codexRequestCount = () => fetchCalls.filter(call => /\/codex\/responses(?:\?|$)/.test(call.url)).length;

  codexStreamMode = "connect-failures";
  try {
    fetchCalls.length = 0;
    codexConnectFailuresRemaining = 5;
    const result = await llm.chat([{ role: "user", content: "hello" }], [], null, requestOptions);
    assert.equal(result.message.content, "codex answer");
    assert.equal(codexRequestCount(), 6, "Codex must inherit the shared initial request plus five retries");

    fetchCalls.length = 0;
    codexConnectFailuresRemaining = 1;
    await assert.rejects(
      llm.chat([{ role: "user", content: "hello" }], [], null, {
        ...requestOptions,
        retry: { ...requestOptions.retry, maxRetries: 0 },
      }),
      error => error?.kind === "transient",
    );
    assert.equal(codexRequestCount(), 1, "an explicit zero retry budget must reach the transport unchanged");

    fetchCalls.length = 0;
    codexConnectFailuresRemaining = 6;
    await assert.rejects(
      llm.chat([{ role: "user", content: "hello" }], [], null, requestOptions),
      error => error?.kind === "transient",
    );
    assert.equal(codexRequestCount(), 6, "persistent connect failures must stop after the shared budget is exhausted");
  } finally {
    codexStreamMode = "normal";
    codexConnectFailuresRemaining = 0;
  }
}
