import type { AgentEvent } from '../../src/shared/contracts/agent-event.js';
import { updateTranscriptWithAgentEvent } from '../../src/shared/session/session-codec.js';

declare const emit: (event: AgentEvent) => void;
const tool = { toolName: 'read_page', toolCapabilityId: 'browser', toolTitle: 'Read page',
  toolFamilyId: 'browser', toolFamilyTitle: 'Browser' };

emit({ type: 'tool_execution_end', ...tool, toolCallId: 'call-1', args: {}, result: null, isError: false });
// A streamed tool can precede its provider id; a user can be accepted before a run starts.
emit({ type: 'tool_call_update', ...tool, argsText: '{', argsComplete: false, phase: 'preparing' });
emit({ type: 'message_start', clientMessageId: 'message-1', deliveryStatus: 'accepted',
  message: { role: 'user', content: 'hello' } });
emit({ type: 'llm_retry', attempt: 1, maxRetries: 3, delayMs: 100, phase: 'request' });
emit({ type: 'llm_retry', attempt: 2, maxAttempts: 2, reason: 'context_overflow' });
// The fallback message may contain multimodal content, interpreted by the projection.
emit({ type: 'message_update', content: [{ type: 'text', text: 'done' }], delta: [{ type: 'text', text: 'done' }] });

// @ts-expect-error event names form a closed protocol.
emit({ type: 'tool_exection_end', ...tool, toolCallId: 'call-1', args: {}, result: {}, isError: false });
// @ts-expect-error execution always has a stable call identity, even though streaming may not.
emit({ type: 'tool_execution_end', ...tool, args: {}, result: {}, isError: false });
// @ts-expect-error completion must carry its result (which can itself be undefined).
emit({ type: 'tool_execution_end', ...tool, toolCallId: 'call-1', args: {}, isError: false });
// @ts-expect-error success/failure must be explicit.
emit({ type: 'tool_execution_end', ...tool, toolCallId: 'call-1', args: {}, result: {} });
// @ts-expect-error a run must identify itself when it starts.
emit({ type: 'agent_start' });
// @ts-expect-error stringification belongs at the boundary, not in event consumers.
emit({ type: 'error', message: { error: 'failed' } });
declare const untrusted: Record<string, unknown> & { type: string };
// @ts-expect-error arbitrary external objects cannot enter the typed producer path.
emit(untrusted);

function consume(event: AgentEvent) {
  updateTranscriptWithAgentEvent([], event);
  if (event.type === 'tool_execution_end') {
    const identity: string = event.toolCallId;
    const failed: boolean = event.isError;
    void [identity, failed];
    // @ts-expect-error results remain opaque until their specific owner validates them.
    event.result.text;
  } else if (event.type === 'agent_end') {
    // @ts-expect-error unrelated payloads are not optional properties on every event.
    event.toolCallId;
  }
}
void consume;
