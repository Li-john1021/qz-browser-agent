import { normalizeCodexReasoningEffort } from "./options.js";
import { stringifyJsonSafe } from "#sdk/shared/format";
import { formatTraceFields, shouldTraceStreamDelta, trace } from "#sdk/background/tools";
import {
  contentToPlainText,
  createAssistantProviderState,
  formatOutputTruncatedError,
  isReplayableProviderState,
  normalizeJsonArgumentString,
  PROVIDER_STATE_OPENAI_RESPONSES_REASONING,
} from "#sdk/background/providers";
import {
  fetchLlmEndpointWithRetry,
  readSseFrames,
  withTimeout,
} from "#sdk/background/providers";
import {
  buildCodexHeaders,
  formatCodexHttpError,
  normalizeHeaderToken,
  resolveCodexAuth,
} from "./auth.js";
import { normalizeLlmFailure } from "#sdk/background/providers";

export {
  clearCodexAuth,
  getCodexAuthStatus,
  pollCodexDeviceLogin,
  startCodexDeviceLogin,
} from "./auth.js";

import type { ModelMessage, ModelToolCall } from '#sdk/shared/models';
import type { RuntimeConfig } from '#sdk/background/providers';
import type { ProviderDefinition } from '#sdk/background/providers';
import type { ModelOptions, ModelEvent } from '#sdk/background/providers';
interface CodexItem extends Record<string, unknown> {
  id?: string; type?: string; role?: string; phase?: string; name?: string; call_id?: string; arguments?: unknown;
  content?: {type?: string; text?: string; refusal?: string; reasoning_text?: string}[];
  summary?: {text?: string; summary?: string}[];
}
interface CodexEvent {
  type?: string; sequence_number?: number; output_index?: number; content_index?: number;
  item_id?: string; call_id?: string; name?: string; arguments?: unknown; delta?: unknown;
  item?: CodexItem; part?: {type?: string}; response?: {error?: unknown; status?: string; usage?: Record<string, unknown>};
}
interface ToolRecord { index: number; toolCall: ModelToolCall & {function: {name: string; arguments: string}} }
interface ToolState { records: ToolRecord[]; aliases: Map<string, ToolRecord> }
interface SlotBase { key: string; outputIndex: number | null; contentIndex: number; itemId: string; traceId: string }
type Slot = SlotBase & ({type: 'text'; text: string; phase: string} | {type: 'thinking'; thinking: string} | {type: 'tool'; record: ToolRecord});
interface ResponsesState { streamTraceId: string; slots: Map<string, Slot>; slotOrder: string[]; nextSyntheticContentIndex: number; toolState: ToolState }
type TraceTiming = (stage: string, fields?: Record<string, unknown>) => void;
type CodexBody = Record<string, unknown> & {input: object[]; tools?: object[]; prompt_cache_key?: string};

const CODEX_STREAM_OPEN_TIMEOUT = 30 * 60 * 1000;
const STREAM_IDLE_TIMEOUT = 45000;

export async function chatCodex(messages: ModelMessage[], tools: object[], signal: AbortSignal | undefined, options: ModelOptions, config: RuntimeConfig) {
  let message: ModelMessage | null = null;
  let usage: Record<string, unknown> | undefined;
  for await (const chunk of chatStreamCodex(messages, tools, signal, options, config)) {
    if (chunk.type === "usage") usage = chunk.usage;
    if (chunk.type === "done") {
      message = chunk.message;
      usage = chunk.message?._usage || usage;
    }
  }
  if (!message) throw new Error("Codex API returned no message");
  return { message, usage };
}

export async function* chatStreamCodex(messages: ModelMessage[], tools: object[], signal: AbortSignal | undefined, options: ModelOptions, config: RuntimeConfig): AsyncGenerator<ModelEvent> {
  const auth = await resolveCodexAuth(signal);
  const body = buildCodexRequestBody(config, messages, tools, options);
  const providerDef = options.providerDefinition || {};
  const streamSignal = signal || new AbortController().signal;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let sourceCleanup = () => {};
  const onAbort = () => { try { reader?.cancel(); } catch(_e) {} };

  let fullContent = "";
  let fullThinking = "";
  let usage: Record<string, unknown> | undefined;
  let terminalStatus = "";
  let sawTerminal = false;
  const streamTraceId = `${normalizeHeaderToken(options.sessionId) || "codex"}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 7)}`;
  const codexState = createCodexResponsesState(streamTraceId);
  const toolState = codexState.toolState;
  const reasoningItems = [];
  const streamTraceStartedAt = Date.now();
  let codexEventCount = 0;
  let codexTextDeltaCount = 0;
  let codexTextDeltaChars = 0;
  let codexLastTextDeltaAt = 0;
  const traceCodexTiming: TraceTiming = (stage, fields = {}) => {
    trace(`stream_trace stage=${stage} traceId=${streamTraceId} session=${normalizeHeaderToken(options.sessionId)} sinceMs=${Date.now() - streamTraceStartedAt}${formatTraceFields(fields)}`);
  };

  try {
    const source = await openCodexSseStreamSource(config, auth, body, signal, options, traceCodexTiming);
    reader = source.reader;
    sourceCleanup = source.cleanup;
    streamSignal.addEventListener("abort", onAbort, { once: true });
    trace(`codex ${source.transport} stream open, model=${config.model}, msgs=${messages.length}, session=${normalizeHeaderToken(options.sessionId)}`);
    traceCodexTiming("llm_codex_stream_open", { transport: source.transport, messages: messages.length });

    for await (const event of readCodexSseEvents(reader, STREAM_IDLE_TIMEOUT, streamSignal, { trace: traceCodexTiming })) {
      const type = String(event?.type || "");
      if (!type || type === "done_marker") continue;
      codexEventCount += 1;
      if (codexEventCount === 1) {
        traceCodexTiming("llm_codex_first_event", { event: type, sequence: event.sequence_number });
      }
      traceCodexStreamEvent(type, event);

      if (type === "error") {
        throw normalizeLlmFailure(new Error("Codex SSE error event"), {
          payload: event,
          phase: "codex stream",
        });
      }
      if (type === "response.failed") {
        const error = event.response?.error;
        throw normalizeLlmFailure(new Error("Codex response failed"), {
          payload: error,
          phase: "codex stream",
        });
      }

      if (type === "response.output_item.added") {
        const item = event.item || {};
        const { slot, created } = ensureCodexResponsesSlot(codexState, event, item);
        if (created) yield* codexSlotStartChunks(slot);
        continue;
      }

      if (type === "response.content_part.added") {
        const part = event.part || {};
        if (part.type === "output_text" || part.type === "refusal") {
          const { slot, created } = ensureCodexResponsesSlot(codexState, event, {
            id: event.item_id,
            type: "message",
            role: "assistant",
          }, "text");
          if (created) yield* codexSlotStartChunks(slot);
        }
        continue;
      }

      if (type === "response.output_text.delta" || type === "response.refusal.delta") {
        const delta = String(event.delta || "");
        if (delta) {
          const now = Date.now();
          codexTextDeltaCount += 1;
          codexTextDeltaChars += delta.length;
          const gapMs = codexLastTextDeltaAt ? now - codexLastTextDeltaAt : 0;
          codexLastTextDeltaAt = now;
          if (shouldTraceStreamDelta(codexTextDeltaCount, gapMs)) {
            traceCodexTiming("llm_codex_text_delta", {
              n: codexTextDeltaCount,
              chars: codexTextDeltaChars,
              deltaChars: delta.length,
              gapMs,
              sequence: event.sequence_number,
              output: event.output_index,
              content: event.content_index,
            });
          }
          const { slot, created } = ensureCodexResponsesSlot(codexState, event, {
            id: event.item_id,
            type: "message",
            role: "assistant",
          }, "text");
          if (created) yield* codexSlotStartChunks(slot);
          if (slot?.type === "text") slot.text += delta;
          fullContent += delta;
          yield { type: "text_delta", delta, contentIndex: slot?.contentIndex, outputIndex: slot?.outputIndex, streamTraceId };
        }
        continue;
      }

      if (type === "response.reasoning_summary_text.delta" || type === "response.reasoning_text.delta") {
        const delta = String(event.delta || "");
        if (delta) {
          const { slot, created } = ensureCodexResponsesSlot(codexState, event, {
            id: event.item_id,
            type: "reasoning",
          }, "thinking");
          if (created) yield* codexSlotStartChunks(slot);
          if (slot?.type === "thinking") slot.thinking += delta;
          fullThinking += delta;
          yield { type: "thinking_delta", delta, contentIndex: slot?.contentIndex, outputIndex: slot?.outputIndex, streamTraceId };
        }
        continue;
      }

      if (type === "response.reasoning_summary_part.done" && fullThinking && !fullThinking.endsWith("\n\n")) {
        const slot = getCodexResponsesSlot(codexState, event, "thinking");
        if (slot?.type === "thinking" && !slot.thinking.endsWith("\n\n")) slot.thinking += "\n\n";
        fullThinking += "\n\n";
        yield { type: "thinking_delta", delta: "\n\n", streamTraceId };
        continue;
      }

      if (type === "response.function_call_arguments.delta") {
        const { slot, created } = ensureCodexResponsesSlot(codexState, event, {
          ...(event.item || {}),
          type: "function_call",
        }, "tool");
        if (created) yield* codexSlotStartChunks(slot);
        const record = slot?.type === "tool" ? slot.record : ensureCodexToolRecord(toolState, event, event.item || {});
        const delta = String(event.delta || "");
        record.toolCall.function.arguments += delta;
        yield {
          type: "tool_call_update",
          index: record.index,
          toolCallId: record.toolCall.id,
          toolName: record.toolCall.function.name || "",
          delta,
          arguments: record.toolCall.function.arguments,
          argsComplete: false,
          streamTraceId,
        };
        continue;
      }

      if (type === "response.function_call_arguments.done") {
        const { slot, created } = ensureCodexResponsesSlot(codexState, event, {
          ...(event.item || {}),
          type: "function_call",
        }, "tool");
        if (created) yield* codexSlotStartChunks(slot);
        const record = slot?.type === "tool" ? slot.record : ensureCodexToolRecord(toolState, event, event.item || {});
        if (event.arguments != null) {
          record.toolCall.function.arguments = normalizeJsonArgumentString(event.arguments);
        } else {
          record.toolCall.function.arguments = normalizeJsonArgumentString(record.toolCall.function.arguments);
        }
        yield {
          type: "tool_call_update",
          index: record.index,
          toolCallId: record.toolCall.id,
          toolName: record.toolCall.function.name || "",
          delta: "",
          arguments: record.toolCall.function.arguments,
          argsComplete: true,
          streamTraceId,
        };
        continue;
      }

      if (type === "response.output_item.done") {
        const item = event.item || {};
        const { slot, created } = ensureCodexResponsesSlot(codexState, event, item);
        if (created) yield* codexSlotStartChunks(slot);
        if (item.type === "function_call") {
          const record = slot?.type === "tool" ? slot.record : ensureCodexToolRecord(toolState, event, item);
          if (item.name) record.toolCall.function.name = item.name;
          if (item.arguments != null) record.toolCall.function.arguments = normalizeJsonArgumentString(item.arguments);
          yield {
            type: "tool_call_update",
            index: record.index,
            toolCallId: record.toolCall.id,
            toolName: record.toolCall.function.name || "",
            delta: "",
            arguments: record.toolCall.function.arguments || "{}",
            argsComplete: true,
            streamTraceId,
          };
        } else if (item.type === "reasoning") {
          const reasoningItem = normalizeOpenAiResponsesReasoningItem(item);
          if (reasoningItem) reasoningItems.push(reasoningItem);
          const finalThinking = extractOpenAiResponsesReasoningText(item);
          if (slot?.type === "thinking") slot.thinking = finalThinking || slot.thinking;
          if (!fullThinking && finalThinking) {
            fullThinking = finalThinking;
          }
          yield { type: "thinking_end", content: slot?.type === "thinking" ? slot.thinking : finalThinking, contentIndex: slot?.contentIndex, outputIndex: slot?.outputIndex, streamTraceId };
        } else if (item.type === "message" && Array.isArray(item.content)) {
          const finalText = item.content.map(part => (
            part?.type === "output_text" ? part.text : part?.type === "refusal" ? part.refusal : ""
          )).join("");
          const previousText = slot?.type === "text" ? slot.text : "";
          if (finalText && finalText.length > previousText.length && finalText.startsWith(previousText)) {
            const delta = finalText.slice(previousText.length);
            if (slot?.type === "text") slot.text = finalText;
            fullContent += delta;
            yield { type: "text_delta", delta, contentIndex: slot?.contentIndex, outputIndex: slot?.outputIndex, streamTraceId };
          } else if (finalText && !previousText && (!fullContent || !fullContent.endsWith(finalText))) {
            if (slot?.type === "text") slot.text = finalText;
            fullContent += finalText;
            yield { type: "text_delta", delta: finalText, contentIndex: slot?.contentIndex, outputIndex: slot?.outputIndex, streamTraceId };
          } else if (slot?.type === "text" && finalText) {
            slot.text = finalText;
          }
          yield { type: "text_end", content: finalText, contentIndex: slot?.contentIndex, outputIndex: slot?.outputIndex, streamTraceId };
        }
        continue;
      }

      if (type === "response.completed" || type === "response.done" || type === "response.incomplete") {
        sawTerminal = true;
        const response = event.response || {};
        terminalStatus = normalizeCodexResponseStatus(response.status || type);
        usage = normalizeCodexUsage(response.usage) || undefined;
        if (usage) yield { type: "usage", usage, streamTraceId };
        break;
      }
    }
  } finally {
    streamSignal.removeEventListener("abort", onAbort);
    try { sourceCleanup(); } catch(_e) {}
    if (reader) {
      try { await reader.cancel(); } catch(_e) {}
    }
    try { reader?.releaseLock(); } catch(_e) {}
  }

  if (!sawTerminal) {
    throw new Error("Codex stream disconnected before response.completed");
  }
  if (terminalStatus === "incomplete") {
    throw new Error(formatOutputTruncatedError("incomplete"));
  }
  if (terminalStatus === "failed" || terminalStatus === "cancelled") {
    throw new Error(`Codex response ${terminalStatus}`);
  }

  const collectedContent = collectCodexTextContent(codexState) || fullContent;
  const collectedThinking = collectCodexThinkingContent(codexState) || fullThinking;
  const message: ModelMessage = { role: "assistant", content: collectedContent || null };
  const toolCalls = getCodexToolCalls(toolState);
  if (collectedThinking) message._thinking = collectedThinking.trimEnd();
  if (reasoningItems.length > 0) {
    message._providerState = createAssistantProviderState(config, providerDef, {
      kind: PROVIDER_STATE_OPENAI_RESPONSES_REASONING,
      reasoningItems,
    });
  }
  if (usage) message._usage = usage;
  message._streamTraceId = streamTraceId;
  if (toolCalls.length > 0) {
    message.content = collectedContent || null;
    message.tool_calls = toolCalls;
  }
  trace(`codex stream done, status=${terminalStatus || "completed"}, thinking=${collectedThinking.length}c, content=${collectedContent.length}c, tools=${toolCalls.length}`);
  traceCodexTiming("llm_codex_done", {
    status: terminalStatus || "completed",
    events: codexEventCount,
    deltas: codexTextDeltaCount,
    chars: collectedContent.length,
    tools: toolCalls.length,
  });
  yield { type: "done", message, streamTraceId };
}

async function openCodexSseStreamSource(config: RuntimeConfig, auth: Awaited<ReturnType<typeof resolveCodexAuth>>, body: CodexBody, signal: AbortSignal | undefined, options: ModelOptions, traceTiming: TraceTiming | null = null) {
  const { signal: requestSignal, cleanup } = withTimeout(signal, CODEX_STREAM_OPEN_TIMEOUT);
  let cleaned = false;
  try {
    const bodyText = stringifyJsonSafe(body);
    const headers = buildCodexHeaders(auth, options);
    traceTiming?.("llm_fetch_start", {
      model: config.model,
      input: body.input?.length || 0,
      tools: body.tools?.length || 0,
      bodyBytes: bodyText.length,
    });
    trace(`codex sse stream connect, model=${config.model}, input=${body.input?.length || 0}, tools=${body.tools?.length || 0}, session=${normalizeHeaderToken(options.sessionId)}`);
    const resp = await fetchLlmEndpointWithRetry(config, "codex stream", {
      method: "POST",
      headers,
      body: bodyText,
      signal: requestSignal,
    }, options);
    traceTiming?.("llm_fetch_headers", {
      status: resp.status,
      ok: resp.ok === true,
      contentType: resp.headers?.get?.("content-type") || "",
      encoding: resp.headers?.get?.("content-encoding") || "",
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw normalizeLlmFailure(new Error(formatCodexHttpError(resp.status, text)), {
        status: resp.status,
        headers: resp.headers,
        body: text,
        phase: "codex stream",
      });
    }
    if (!resp.body) {
      throw new Error("Codex API returned an empty stream body");
    }

    cleanup();
    cleaned = true;
    return {
      transport: "sse",
      reader: resp.body.getReader(),
      cleanup() {},
    };
  } finally {
    if (!cleaned) cleanup();
  }
}

// ---------------------------------------------------------------------------

function buildCodexRequestBody(config: RuntimeConfig, messages: ModelMessage[], tools: object[], options: ModelOptions = {}) {
  const converted = convertOpenAiMessagesToCodex(messages, config, options.providerDefinition);
  const reasoningEffort = normalizeCodexReasoningEffort(config.codexReasoningEffort);
  const modelParameters = config.modelParameters || {};
  const body: CodexBody = {
    ...modelParameters,
    model: config.model,
    store: false,
    stream: true,
    instructions: converted.instructions || "You are a helpful assistant.",
    input: converted.input,
    include: ["reasoning.encrypted_content"],
    prompt_cache_key: clampCodexPromptCacheKey(options.sessionId),
  };
  if (!Object.prototype.hasOwnProperty.call(modelParameters, "text")) {
    body.text = { verbosity: "low" };
  }
  if (!Object.prototype.hasOwnProperty.call(modelParameters, "reasoning")) {
    body.reasoning = { effort: reasoningEffort, summary: "auto" };
  }
  if (tools && tools.length > 0) {
    body.tools = convertToolsToCodexResponses(tools);
    if (!Object.prototype.hasOwnProperty.call(modelParameters, "tool_choice")) body.tool_choice = "auto";
    if (!Object.prototype.hasOwnProperty.call(modelParameters, "parallel_tool_calls")) body.parallel_tool_calls = true;
  } else {
    delete body.tool_choice;
    delete body.parallel_tool_calls;
  }
  if (!body.prompt_cache_key) delete body.prompt_cache_key;
  return body;
}

function convertOpenAiMessagesToCodex(messages: ModelMessage[] = [], config: RuntimeConfig = {}, providerDef: Partial<ProviderDefinition> = {}) {
  const instructions = [];
  const input: object[] = [];
  let messageIndex = 0;

  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    if (msg.role === "system") {
      const text = contentToPlainText(msg.content);
      if (text.trim()) instructions.push(text);
      continue;
    }

    if (msg.role === "user") {
      const content = convertUserContentToCodex(msg.content);
      if (content.length) input.push({ role: "user", content });
      continue;
    }

    if (msg.role === "assistant") {
      const reasoningItems = getOpenAiResponsesReplayReasoningItems(msg._providerState, config, providerDef);
      if (reasoningItems.length) input.push(...reasoningItems);
      const text = typeof msg.content === "string" ? msg.content : "";
      if (text.trim()) {
        input.push({
          type: "message",
          id: `msg_qz_${messageIndex}`,
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text, annotations: [] }],
        });
        messageIndex++;
      }
      for (const toolCall of msg.tool_calls || []) {
        const callId = normalizeCodexToolCallId(toolCall.id || `call_qz_${messageIndex}_${input.length}`);
        input.push({
          type: "function_call",
          id: makeCodexFunctionCallItemId(callId),
          call_id: callId,
          name: toolCall.function?.name || "tool",
          arguments: normalizeJsonArgumentString(toolCall.function?.arguments),
        });
      }
      continue;
    }

    if (msg.role === "tool") {
      const callId = normalizeCodexToolCallId(msg.tool_call_id || "");
      if (!callId) continue;
      input.push({
        type: "function_call_output",
        call_id: callId,
        output: contentToPlainText(msg.content),
      });
    }
  }

  return { instructions: instructions.join("\n\n"), input };
}

function getOpenAiResponsesReplayReasoningItems(state: unknown, config: RuntimeConfig = {}, providerDef: Partial<ProviderDefinition> = {}) {
  if (
    !isReplayableProviderState(state, config, providerDef)
    || state.kind !== PROVIDER_STATE_OPENAI_RESPONSES_REASONING
    || !Array.isArray(state.reasoningItems)
  ) {
    return [];
  }
  return state.reasoningItems
    .map(normalizeOpenAiResponsesReasoningItem)
    .filter((item): item is Record<string, unknown> => item !== null);
}

function normalizeOpenAiResponsesReasoningItem(value: unknown = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = record(value);
  if (item.type !== "reasoning") return null;
  const cloned = cloneJsonObject(item);
  return cloned && cloned.type === "reasoning" ? cloned : null;
}

function extractOpenAiResponsesReasoningText(item: CodexItem = {}) {
  if (!item || typeof item !== "object") return "";
  const parts = [];
  for (const summary of Array.isArray(item.summary) ? item.summary : []) {
    const text = String(summary?.text || summary?.summary || "");
    if (text) parts.push(text);
  }
  for (const block of Array.isArray(item.content) ? item.content : []) {
    const text = String(block?.text || block?.reasoning_text || "");
    if (text) parts.push(text);
  }
  return parts.join("\n\n").trim();
}

function cloneJsonObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (_err) {
    return null;
  }
}

function convertUserContentToCodex(content: unknown) {
  if (typeof content === "string") {
    const text = content.trim() ? content : "";
    return text ? [{ type: "input_text", text }] : [];
  }
  if (!Array.isArray(content)) return [];
  const blocks = [];
  for (const value of content as unknown[]) {
    const part = record(value);
    if (part?.type === "text") {
      const text = String(part.text || "");
      if (text.trim()) blocks.push({ type: "input_text", text });
    } else if (part?.type === "image_url") {
      const imageUrl = String(record(part.image_url).url || "");
      if (imageUrl) blocks.push({ type: "input_image", detail: record(part.image_url).detail || "auto", image_url: imageUrl });
    }
  }
  return blocks;
}

function convertToolsToCodexResponses(tools: object[] = []) {
  return tools.map(value => {
    const tool = record(value);
    const fn = tool.function && typeof tool.function === "object" ? record(tool.function) : tool;
    return {
      type: "function",
      name: fn.name,
      description: fn.description || "",
      parameters: fn.parameters && typeof fn.parameters === "object" ? fn.parameters : { type: "object", properties: {} },
      strict: null,
    };
  }).filter(tool => tool.name);
}

function createCodexResponsesState(streamTraceId = ""): ResponsesState {
  return {
    streamTraceId,
    slots: new Map(),
    slotOrder: [],
    nextSyntheticContentIndex: 0,
    toolState: createCodexToolState(),
  };
}

function codexResponsesSlotKey(event: CodexEvent = {}, item: CodexItem = {}, typeHint = "") {
  if (event.output_index != null) return `output:${event.output_index}`;
  const type = typeHint || codexSlotTypeForItem(item) || "unknown";
  const id = item.id || event.item_id || event.call_id || item.call_id || "";
  return id ? `synthetic:${type}:${id}` : `synthetic:${type}`;
}

function codexSlotTypeForItem(item: CodexItem = {}) {
  if (item.type === "reasoning") return "thinking";
  if (item.type === "message") return "text";
  if (item.type === "function_call") return "tool";
  return "";
}

function ensureCodexResponsesSlot(state: ResponsesState, event: CodexEvent = {}, item: CodexItem = {}, typeHint = "") {
  const key = codexResponsesSlotKey(event, item, typeHint);
  const existing = state.slots.get(key);
  if (existing) {
    updateCodexResponsesSlot(existing, event, item);
    return { slot: existing, created: false };
  }

  const slotType = codexSlotTypeForItem(item) || typeHint;
  if (!slotType) return { slot: null, created: false };

  const outputIndex = event.output_index != null ? Number(event.output_index) : null;
  const contentIndex = state.nextSyntheticContentIndex++;
  let slot: Slot | null = null;
  if (slotType === "thinking") {
    slot = {
      key,
      type: "thinking",
      outputIndex,
      contentIndex,
      itemId: item.id || event.item_id || "",
      traceId: state.streamTraceId,
      thinking: "",
    };
  } else if (slotType === "text") {
    slot = {
      key,
      type: "text",
      outputIndex,
      contentIndex,
      itemId: item.id || event.item_id || "",
      traceId: state.streamTraceId,
      phase: item.phase || "",
      text: "",
    };
  } else if (slotType === "tool") {
    const record = ensureCodexToolRecord(state.toolState, event, item);
    slot = {
      key,
      type: "tool",
      outputIndex,
      contentIndex,
      itemId: item.id || event.item_id || "",
      traceId: state.streamTraceId,
      record,
    };
  }
  if (!slot) return { slot: null, created: false };
  state.slots.set(key, slot);
  state.slotOrder.push(key);
  return { slot, created: true };
}

function updateCodexResponsesSlot(slot: Slot | null, event: CodexEvent = {}, item: CodexItem = {}) {
  if (!slot) return;
  if (item.id && !slot.itemId) slot.itemId = item.id;
  if (event.item_id && !slot.itemId) slot.itemId = event.item_id;
  if (item.phase && slot.type === "text") slot.phase = item.phase;
  if (slot.type === "tool" && item.name) slot.record.toolCall.function.name = item.name;
}

function getCodexResponsesSlot(state: ResponsesState, event: CodexEvent = {}, typeHint = "") {
  const key = codexResponsesSlotKey(event, {}, typeHint);
  const slot = state.slots.get(key);
  if (!typeHint) return slot || null;
  return slot?.type === typeHint ? slot : null;
}

function* codexSlotStartChunks(slot: Slot | null): Generator<ModelEvent> {
  if (!slot) return;
  if (slot.type === "text") {
    yield {
      type: "text_start",
      contentIndex: slot.contentIndex,
      outputIndex: slot.outputIndex,
      itemId: slot.itemId,
      phase: slot.phase,
      streamTraceId: slot.traceId,
    };
    return;
  }
  if (slot.type === "thinking") {
    yield {
      type: "thinking_start",
      contentIndex: slot.contentIndex,
      outputIndex: slot.outputIndex,
      itemId: slot.itemId,
      streamTraceId: slot.traceId,
    };
    return;
  }
  if (slot.type === "tool") {
    const record = slot.record;
    yield {
      type: "tool_call_update",
      index: record.index,
      toolCallId: record.toolCall.id,
      toolName: record.toolCall.function.name || "",
      delta: "",
      arguments: record.toolCall.function.arguments || "",
      isStart: true,
      contentIndex: slot.contentIndex,
      outputIndex: slot.outputIndex,
      streamTraceId: slot.traceId,
    };
  }
}

function collectCodexTextContent(state: ResponsesState) {
  return state.slotOrder
    .map(key => state.slots.get(key))
    .map(slot => slot?.type === "text" ? slot.text : "")
    .join("");
}

function collectCodexThinkingContent(state: ResponsesState) {
  return state.slotOrder
    .map(key => state.slots.get(key))
    .map(slot => slot?.type === "thinking" ? slot.thinking : "")
    .filter(Boolean)
    .join("\n\n");
}

function createCodexToolState(): ToolState {
  return {
    records: [],
    aliases: new Map(),
  };
}

function ensureCodexToolRecord(state: ToolState, event: CodexEvent = {}, item: CodexItem = {}) {
  const aliases = getCodexToolAliases(event, item);
  for (const alias of aliases) {
    const existing = state.aliases.get(alias);
    if (existing) {
      addCodexToolAliases(state, existing, aliases);
      if (item.name) existing.toolCall.function.name = item.name;
      return existing;
    }
  }

  const index = state.records.length;
  const callId = normalizeCodexToolCallId(item.call_id || event.call_id || `call_qz_${Date.now()}_${index}`);
  const record = {
    index,
    toolCall: {
      id: callId,
      type: "function",
      function: {
        name: item.name || event.name || "",
        arguments: item.arguments != null ? String(item.arguments) : "",
      },
    },
  };
  state.records.push(record);
  addCodexToolAliases(state, record, aliases.length ? aliases : [`record:${index}`]);
  return record;
}

function getCodexToolAliases(event: CodexEvent = {}, item: CodexItem = {}) {
  return [
    item.id ? `item:${item.id}` : "",
    event.item_id ? `item:${event.item_id}` : "",
    item.call_id ? `call:${item.call_id}` : "",
    event.call_id ? `call:${event.call_id}` : "",
    event.output_index != null ? `index:${event.output_index}` : "",
  ].filter(Boolean);
}

function addCodexToolAliases(state: ToolState, record: ToolRecord, aliases: string[] = []) {
  for (const alias of aliases) state.aliases.set(alias, record);
}

function getCodexToolCalls(state: ToolState) {
  return state.records
    .map(record => record.toolCall)
    .filter(toolCall => toolCall.function.name || toolCall.function.arguments);
}

function traceCodexStreamEvent(type = "", event: CodexEvent = {}) {
  if (!type) return;
  const sequence = Number(event.sequence_number);
  const isDelta = type.endsWith(".delta");
  if (isDelta && Number.isFinite(sequence) && sequence % 20 !== 0) return;
  const item = event.item || {};
  const summary = [
    `type=${type}`,
    event.output_index != null ? `output=${event.output_index}` : "",
    Number.isFinite(sequence) ? `seq=${sequence}` : "",
    item.type ? `item=${item.type}` : "",
    item.name ? `name=${item.name}` : "",
    event.item_id ? `itemId=${String(event.item_id).slice(0, 20)}` : "",
    event.response?.status ? `status=${event.response.status}` : "",
  ].filter(Boolean).join(" ");
  trace(`codex stream event ${summary}`);
}

function normalizeCodexToolCallId(id: unknown) {
  const normalized = String(id || "").replace(/[^a-zA-Z0-9_-]/g, "_").replace(/^_+|_+$/g, "");
  return normalized || `call_qz_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function makeCodexFunctionCallItemId(callId: unknown) {
  const suffix = normalizeCodexToolCallId(callId).slice(0, 54);
  return `fc_${suffix || Math.random().toString(36).slice(2, 10)}`.slice(0, 64);
}

function clampCodexPromptCacheKey(sessionId: unknown) {
  const normalized = normalizeHeaderToken(sessionId);
  return normalized ? `qingzhou-${normalized}`.slice(0, 64) : "";
}

async function* readCodexSseEvents(reader: ReadableStreamDefaultReader<Uint8Array>, idleTimeoutMs: number, signal: AbortSignal, options: {trace?: TraceTiming} = {}): AsyncGenerator<CodexEvent> {
  for await (const frame of readSseFrames(reader, idleTimeoutMs, signal, { ...options, acceptDoneMarker: true })) {
    const data = frame.data.trim();
    if (!data) continue;
    if (data === "[DONE]") { yield { type: "done_marker" }; continue; }
    try {
      const payload: CodexEvent = JSON.parse(data);
      if (frame.event && payload && typeof payload === "object" && !payload.type) payload.type = frame.event;
      yield payload;
    } catch (_err) {
      throw new Error(`Invalid Codex SSE JSON: ${data.slice(0, 300)}`);
    }
  }
}

function normalizeCodexUsage(usage: Record<string, unknown> = {}) {
  if (!usage || typeof usage !== "object") return null;
  const cached = Number(record(usage.input_tokens_details).cached_tokens || 0);
  const input = Math.max(0, Number(usage.input_tokens || 0) - cached);
  const output = Number(usage.output_tokens || 0);
  const total = Number(usage.total_tokens || input + output + cached);
  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: total,
    cache_read_input_tokens: cached,
    cache_creation_input_tokens: 0,
  };
}

function normalizeCodexResponseStatus(status = "") {
  const value = String(status || "").replace(/^response\./, "");
  if (value === "done") return "completed";
  return value || "completed";
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
