import type { createWorkspaceComposition } from "../app/workspace-composition.js";
import type { createChatWorkspaceFeature } from "../chat/chat-workspace-feature.js";
import type { createSessionState } from "../sessions/session-state.js";
import type { createPerfTrace } from "./perf-trace.js";

/** Explicit in-process test seam. Production never loads scripts or installs a harness. */
export interface ConversationTestContext {
  root: Document; workspace: ReturnType<typeof createWorkspaceComposition>; chat: ReturnType<typeof createChatWorkspaceFeature>;
  sessionState: ReturnType<typeof createSessionState>; perf: ReturnType<typeof createPerfTrace>;
  getCurrentSessionId(): string | null; resetNavigation(): void; nowTimestamp(): string;
}
declare global {
  var __QZ_CONVERSATION_BENCHMARK__: boolean | undefined;
  var __QZ_INSTALL_CONVERSATION_BENCHMARK__: ((context: ConversationTestContext) => void) | undefined;
}
export function isConversationBenchmarkHarness() { return globalThis.__QZ_CONVERSATION_BENCHMARK__ === true; }
