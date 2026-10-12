import type { ContextSource } from "#sdk/background/context";
import type { LifecycleObserver } from "#sdk/background/observers";
import { t } from "./i18n.js";

/** A capability factory adapts its read-only Session port to a bounded context source. */
export function taskNoteSource(readNote: (sessionId: string, signal?: AbortSignal) => Promise<string>): ContextSource {
  return { id: "example.task-note", get title() { return t("taskNote"); }, maxChars: 1000, timeoutMs: 500,
    read: request => readNote(request.sessionId, request.signal) };
}

/** Send committed completion identity to an injected sink; conversation text remains private. */
export function completionObserver(record: (sessionId: string, runId: string) => Promise<void>): LifecycleObserver {
  return { id: "example.completions", capacity: 16, timeoutMs: 1000,
    accepts: event => event.type === "agent_end" && event.phase === "committed",
    onEvent: event => record(event.sessionId, event.runId) };
}
