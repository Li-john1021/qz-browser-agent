import type { ToolEvent } from "../../sdk/background/services.js";
interface ToolEventRouterHost {
  channel: { isRuntimeEvent(event: ToolEvent): boolean };
  recordTranscriptEvent(sessionId: string, event: ToolEvent): unknown;
  recordRuntimeEvent(sessionId: string, event: ToolEvent): unknown;
  handleAgentEvent(sessionId: string, event: ToolEvent): unknown;
  broadcast(event: ToolEvent): unknown;
}
export function createToolEventRouter({
  channel,
  recordTranscriptEvent,
  recordRuntimeEvent,
  handleAgentEvent,
  broadcast,
}: ToolEventRouterHost) {
  return function routeToolEvent(event: ToolEvent) {
    if (event?.sessionId && ["waiting_for_user", "user_wait_resolved"].includes(event.type)) {
      recordTranscriptEvent(event.sessionId, event);
      recordRuntimeEvent(event.sessionId, event);
      broadcast(event);
      return;
    }
    if (event?.sessionId && channel.isRuntimeEvent(event)) {
      handleAgentEvent(event.sessionId, event);
      return;
    }
    broadcast(event);
  };
}

