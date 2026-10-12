import { t } from "../shared/i18n/backend.js";
import { withDeadline, throwIfCancelled } from "./internal/abortable.js";
import type { ContextRequest, ContextSource } from "../sdk/background/context.js";

export interface ContextDiagnostic { readonly sourceId: string; readonly code: string }
export interface ContextCapsule { readonly id: string; readonly title: string; readonly text: string }

export class ContextSourceError extends Error {
  readonly code = "CONTEXT_SOURCE_REQUIRED";
  constructor(readonly sourceId: string, readonly causeCode: string) {
    super(t("context.requiredSourceUnavailable", { sourceId: String(sourceId) }));
    this.name = "ContextSourceError";
  }
}

/** Registration order, not response timing, owns both projection order and the text budget. */
export function createContextSources(sources: readonly ContextSource[], { maxTextChars = 12000 } = {}) {
  const definitions = sources.map(source => Object.freeze({ ...source, reasons: source.reasons && Object.freeze([...source.reasons]) }));
  const ids = new Set<string>();
  for (const source of definitions) {
    if (!/^[a-z][\w.-]*$/i.test(source.id) || ids.has(source.id)) throw new Error(`Invalid or duplicate context source: ${source.id}`);
    if (source.timeoutMs !== undefined && (!Number.isFinite(source.timeoutMs) || source.timeoutMs <= 0)) throw new Error(`Invalid context deadline: ${source.id}`);
    if (source.maxChars !== undefined && (!Number.isInteger(source.maxChars) || source.maxChars < 1)) throw new Error(`Invalid context budget: ${source.id}`);
    ids.add(source.id);
  }
  if (!Number.isInteger(maxTextChars) || maxTextChars < 1) throw new Error("Invalid total context budget");

  return async (request: ContextRequest) => {
    if (!request.sessionId) throw new Error("Context collection requires a sessionId");
    throwIfCancelled(request.signal);
    const selected = definitions.filter(source => (source.reasons ?? ["snapshot"]).includes(request.reason));
    const outcomes = await Promise.all(selected.map(async source => {
      try {
        const value = await withDeadline(signal => source.read(Object.freeze({ ...request, signal })), {
          signal: request.signal, timeoutMs: source.timeoutMs ?? 3000,
        });
        throwIfCancelled(request.signal);
        if (value == null) return source.required ? { source, code: "CONTEXT_SOURCE_EMPTY" } : { source, value: null };
        if (source.title !== undefined) {
          if (typeof value !== "string") return { source, code: "CONTEXT_SOURCE_INVALID" };
          return { source, value: value.slice(0, source.maxChars ?? 4000) };
        }
        // Clone the result at the read boundary so later source writes cannot mutate a capsule.
        const json = JSON.stringify(value);
        if (!json || json.length > (source.maxChars ?? 64000)) return { source, code: "CONTEXT_SOURCE_TOO_LARGE" };
        return { source, value: JSON.parse(json) as unknown };
      } catch (error) {
        throwIfCancelled(request.signal);
        return { source, code: error instanceof DOMException && error.name === "TimeoutError" ? "CONTEXT_SOURCE_TIMEOUT" : "CONTEXT_SOURCE_FAILED" };
      }
    }));
    throwIfCancelled(request.signal);
    const values = new Map<string, unknown>();
    const capsules: ContextCapsule[] = [];
    const diagnostics: ContextDiagnostic[] = [];
    let remaining = maxTextChars;
    for (const { source, value, code } of outcomes) {
      if (code) {
        if (source.required) throw new ContextSourceError(source.id, code);
        diagnostics.push(Object.freeze({ sourceId: source.id, code }));
      } else if (source.title !== undefined && typeof value === "string") {
        if (source.required && !value) throw new ContextSourceError(source.id, "CONTEXT_SOURCE_EMPTY");
        if (source.required && !remaining) throw new ContextSourceError(source.id, "CONTEXT_SOURCE_BUDGET");
        const truncated = value.length > remaining;
        if (remaining > 0 && value) {
          const text = value.slice(0, remaining);
          remaining -= text.length;
          capsules.push(Object.freeze({ id: source.id, title: source.title.slice(0, 160), text }));
        }
        if (truncated) {
          diagnostics.push(Object.freeze({ sourceId: source.id, code: "CONTEXT_SOURCE_TRUNCATED" }));
        }
      } else if (value != null) values.set(source.id, value);
    }
    return { values, sources: Object.freeze(capsules), contextDiagnostics: Object.freeze(diagnostics) };
  };
}
