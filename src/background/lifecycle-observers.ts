import { withDeadline } from "./internal/abortable.js";
import type { LifecycleEvent, LifecycleObserver } from "../sdk/background/observers.js";

export interface ObserverDiagnostic { readonly observerId: string; readonly code: string }

/** Observers see immutable metadata only. Full model exchanges belong to a separately authorized adapter. */
export function createLifecycleObservers(
  definitions: readonly LifecycleObserver[],
  { onDiagnostic = (_diagnostic: ObserverDiagnostic) => {} } = {},
) {
  const ids = new Set<string>();
  const report = (observerId: string, code: string) => {
    try { onDiagnostic({ observerId, code }); } catch { /* A diagnostic cannot affect Session state. */ }
  };
  const states = definitions.map(definition => {
    if (!definition.id || ids.has(definition.id)) throw new Error(`Duplicate or empty observer: ${definition.id}`);
    ids.add(definition.id);
    const capacity = definition.capacity ?? 64;
    const timeoutMs = definition.timeoutMs ?? 3000;
    if (!Number.isInteger(capacity) || capacity < 1 || !Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error(`Invalid observer limits: ${definition.id}`);
    return { definition: Object.freeze({ ...definition }), capacity, timeoutMs, queue: [] as LifecycleEvent[],
      controller: new AbortController(), active: null as Promise<void> | null, inFlight: false, disabled: false, overflowReported: false };
  });

  async function drain(state: typeof states[number]) {
    while (state.queue.length && !state.disabled) {
      const event = state.queue.shift()!;
      state.inFlight = true;
      try {
        await withDeadline(signal => state.definition.onEvent(event, signal), {
          signal: state.controller.signal, timeoutMs: state.timeoutMs,
        });
      } catch (error) {
        if (state.controller.signal.aborted) return;
        if (error instanceof DOMException && error.name === "TimeoutError") {
          // Disable an uncooperative observer instead of accumulating timed-out promises.
          state.disabled = true;
          state.queue.length = 0;
          report(state.definition.id, "OBSERVER_TIMEOUT");
        } else report(state.definition.id, "OBSERVER_FAILED");
      } finally { state.inFlight = false; }
    }
    state.overflowReported = false;
  }

  function schedule(state: typeof states[number]) {
    state.active = Promise.resolve().then(() => drain(state)).finally(() => {
      state.active = null;
      if (state.queue.length && !state.disabled) schedule(state);
    });
  }

  return Object.freeze({
    emit(sessionId: string, input: unknown, phase: LifecycleEvent["phase"] = "emitted") {
      if (!sessionId || !input || typeof input !== "object") return;
      const raw = input as Record<string, unknown>;
      const text = (value: unknown) => typeof value === "string" ? value.slice(0, 200) : "";
      const message = raw.message && typeof raw.message === "object" ? raw.message as Record<string, unknown> : null;
      const event: LifecycleEvent = Object.freeze({
        type: text(raw.type), phase, sessionId, runId: text(raw.runId), timestamp: Date.now(),
        ...(typeof raw.epoch === "number" ? { epoch: raw.epoch } : {}),
        ...(typeof raw.eventSeq === "number" ? { eventSeq: raw.eventSeq } : {}),
        ...(raw.toolCallId ? { toolCallId: text(raw.toolCallId) } : {}),
        ...(raw.status ? { status: text(raw.status) } : {}),
        ...(raw.code ? { code: text(raw.code) } : {}),
        ...(message ? { message: Object.freeze({ role: text(message.role), _origin: text(message._origin) }) } : {}),
      });
      for (const state of states) {
        if (state.disabled) continue;
        try { if (state.definition.accepts && !state.definition.accepts(event)) continue; }
        catch { report(state.definition.id, "OBSERVER_FAILED"); continue; }
        if (state.queue.length + Number(state.inFlight) >= state.capacity) {
          if (!state.overflowReported) report(state.definition.id, "OBSERVER_OVERFLOW");
          state.overflowReported = true;
          continue;
        }
        state.queue.push(event);
        if (!state.active) schedule(state);
      }
    },
    async flush() { while (states.some(state => state.active)) await Promise.all(states.map(state => state.active)); },
    dispose() {
      for (const state of states) {
        state.disabled = true;
        state.queue.length = 0;
        state.controller.abort();
      }
    },
  });
}
