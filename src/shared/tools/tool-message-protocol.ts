import { t } from "../i18n/backend.js";
import type { ModelMessage, ModelToolCall } from "../contracts/model-message.js";


export function repairToolMessageSequence(messages: readonly ModelMessage[], options: { interruptedReason?: string } = {}) {
  const source: readonly ModelMessage[] = Array.isArray(messages) ? messages : [];
  const interruptedReason = String(options.interruptedReason || t("session.toolAborted"));
  const repaired: ModelMessage[] = [];
  let pending: { calls: ModelToolCall[]; ids: Set<string>; seen: Set<string>; deferredMessages: ModelMessage[] } | null = null;
  let inserted = 0;
  let dropped = 0;

  const closePending = () => {
    if (!pending) return;
    for (const call of pending.calls) {
      if (!call?.id || pending.seen.has(call.id)) continue;
      repaired.push(createInterruptedToolMessage(call, interruptedReason));
      pending.seen.add(call.id);
      inserted++;
    }
    flushDeferredMessages();
    pending = null;
  };

  const flushDeferredMessages = () => {
    if (!pending?.deferredMessages?.length) return;
    for (const deferred of pending.deferredMessages) repaired.push(deferred);
    pending.deferredMessages = [];
  };

  for (const msg of source) {
    if (!msg || typeof msg !== "object" || typeof msg.role !== "string") {
      dropped++;
      continue;
    }

    if (msg.role === "tool") {
      const toolCallId = String(msg.tool_call_id || "").trim();
      if (pending && pending.ids.has(toolCallId) && !pending.seen.has(toolCallId)) {
        repaired.push(msg);
        pending.seen.add(toolCallId);
        if (pending.seen.size >= pending.ids.size) {
          flushDeferredMessages();
          pending = null;
        }
      } else {
        dropped++;
      }
      continue;
    }

    if (pending && isDeferredToolCompanionMessage(msg)) {
      pending.deferredMessages.push(msg);
      continue;
    }

    if (pending) closePending();

    repaired.push(msg);
    if (msg.role === "assistant" && Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
      const calls = msg.tool_calls.filter(call => call?.id);
      if (calls.length) {
        pending = {
          calls,
          ids: new Set(calls.map(call => call.id)),
          seen: new Set(),
          deferredMessages: [],
        };
      }
    }
  }

  if (pending) closePending();

  const changed = inserted > 0
    || dropped > 0
    || repaired.length !== source.length
    || repaired.some((msg, index) => msg !== source[index]);

  return { messages: repaired, changed, inserted, dropped };
}

function isDeferredToolCompanionMessage(msg: ModelMessage) {
  return msg?.role === "user" && msg._origin === "tool_image";
}

function createInterruptedToolMessage(toolCall: ModelToolCall, reason: string): ModelMessage {
  return {
    role: "tool",
    tool_call_id: String(toolCall.id),
    content: JSON.stringify({
      error: reason,
      code: "TOOL_ABORTED",
      interrupted: true,
      tool: String(toolCall.function?.name || "tool"),
    }),
  };
}
