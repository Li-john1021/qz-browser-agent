import type { ModelService } from "../../sdk/background/services.js";

/** Narrow the public port at runtime too; internal gateway options never cross this adapter. */
export function createCapabilityChat(chat: ModelService["chat"]): ModelService["chat"] {
  return (messages, tools, signal, options = {}) => chat(messages, tools, signal, {
    sessionId: options.sessionId,
    runId: options.runId,
  });
}
