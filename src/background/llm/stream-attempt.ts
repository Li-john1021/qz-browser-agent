import { toolIdentityEventFields } from '../../shared/tools/tool-identity.js';
import type { AgentEvent } from '../../shared/contracts/agent-event.js';
import type { ModelEvent, ModelMessage } from './protocol-registry.js';

export interface StreamedTool { id: string; name: string }
interface StreamHooks {
  callId: string;
  emit(event: AgentEvent): void;
  trace(stage: string, fields: Record<string, unknown>): void;
  toolIdentity(name: string): object;
  toolSpanId(id: string): string;
  indexedToolSpanId(index: number): string;
  usage(value: Record<string, unknown> | undefined): void;
}

/** Consume one attempt. No config reads, retries, message commits, or lifecycle writes. */
export function createStreamAttempt(hooks: StreamHooks) {
  const state = {
    content: '', thinking: '', traceId: '', replaySensitive: false, yields: 0,
    message: null as ModelMessage | null,
    tools: new Map<number, StreamedTool>(),
  };
  let started = false;
  let deltaCount = 0;
  let deltaChars = 0;
  let lastDeltaAt = 0;
  function start(meta: Pick<ModelEvent, 'streamTraceId' | 'contentIndex' | 'outputIndex' | 'itemId'> = {}) {
    if (started) return;
    started = true;
    if (meta.streamTraceId) state.traceId = String(meta.streamTraceId);
    hooks.trace('agent_message_start', { output: meta.outputIndex, content: meta.contentIndex, itemId: meta.itemId });
    hooks.emit({ type: 'message_start', spanId: hooks.callId, message: { role: 'assistant', content: '' }, ...meta, streamTraceId: state.traceId || meta.streamTraceId || hooks.callId });
  }
  async function consume(chunks: AsyncIterable<ModelEvent>) {
    for await (const chunk of chunks) {
      state.yields++;
      if (chunk.streamTraceId) state.traceId = chunk.streamTraceId;
      if (chunk.type === 'thinking_delta') {
        state.replaySensitive = true;
        state.thinking += chunk.delta;
        hooks.emit({ type: 'thinking_update', spanId: hooks.callId, delta: chunk.delta, thinking: state.thinking });
      } else if (chunk.type === 'text_delta') {
        state.replaySensitive = true;
        start({ contentIndex: chunk.contentIndex, outputIndex: chunk.outputIndex, streamTraceId: chunk.streamTraceId });
        const now = Date.now();
        const gapMs = lastDeltaAt ? now - lastDeltaAt : 0;
        lastDeltaAt = now;
        deltaCount++;
        deltaChars += chunk.delta.length;
        if (deltaCount <= 3 || deltaCount % 20 === 0 || gapMs >= 500) {
          hooks.trace('agent_text_delta', { n: deltaCount, chars: deltaChars, deltaChars: chunk.delta.length, gapMs });
        }
        state.content += chunk.delta;
        hooks.emit({ type: 'message_update', spanId: hooks.callId, streamTraceId: state.traceId || hooks.callId, delta: chunk.delta, content: state.content });
      } else if (chunk.type === 'tool_call_update') {
        state.replaySensitive = true;
        const index = Number.isFinite(Number(chunk.index)) ? Number(chunk.index) : state.tools.size;
        if (chunk.toolCallId) state.tools.set(index, { id: chunk.toolCallId, name: chunk.toolName || state.tools.get(index)?.name || '' });
        const streamedIndex = Number.isFinite(Number(chunk.index)) ? Number(chunk.index) : Math.max(0, state.tools.size - 1);
        const name = chunk.toolName || state.tools.get(streamedIndex)?.name || '';
        hooks.emit({
          type: 'tool_call_update', spanId: chunk.toolCallId ? hooks.toolSpanId(chunk.toolCallId) : hooks.indexedToolSpanId(chunk.index ?? 0),
          parentSpanId: hooks.callId, toolCallId: chunk.toolCallId, toolName: name,
          ...toolIdentityEventFields(hooks.toolIdentity(name)), index: chunk.index, delta: chunk.delta,
          argsText: chunk.arguments || '', argsComplete: chunk.argsComplete === true, phase: chunk.argsComplete === true ? 'running' : 'preparing',
        });
      } else if (chunk.type === 'usage') {
        hooks.usage(chunk.usage);
      } else if (chunk.type === 'done') {
        state.message = chunk.message;
        state.message._streamTraceId = state.traceId || hooks.callId;
        if (state.message._usage) hooks.usage(state.message._usage);
        hooks.trace('agent_call_done', { yields: state.yields, chars: state.content.length, thinking: state.thinking.length, tools: state.message.tool_calls?.length || 0 });
      }
      // A start without a delta is diagnostic only; it must not create visible text.
    }
  }
  return { state, start, consume };
}
