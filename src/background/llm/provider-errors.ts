import { getLanguage } from "../../shared/i18n/index.js";
import { t } from "../../shared/i18n/backend.js";
import { PRODUCT_PROVIDERS } from "../product/providers.js";

export type LlmFailureKind = 'aborted' | 'auth' | 'quota' | 'context_overflow' | 'content_filter' | 'invalid_request' | 'transient' | 'stream_protocol' | 'unknown';
export interface HeaderReader { get(name: string): string | null }
export interface LlmFailureHints {
  name?: unknown; kind?: unknown; code?: unknown; status?: unknown; statusCode?: unknown;
  message?: unknown; requestId?: unknown; request_id?: unknown; retryAfterMs?: unknown;
  body?: unknown; payload?: unknown; provider?: unknown; phase?: string;
  headers?: HeaderReader | null; now?: number | (() => number);
}
interface SourceError extends Error { status?: unknown; statusCode?: unknown; code?: unknown; requestId?: unknown; request_id?: unknown; retryAfterMs?: unknown; kind?: unknown; phase?: string }
import type { ProviderRecovery } from './provider-recovery.js';
export interface LlmFailure extends Error {
  recovery?: ProviderRecovery;
  kind: LlmFailureKind; code?: string; status?: number; requestId?: string;
  retryAfterMs?: number; phase?: string; providerMessage?: string;
}
interface FailureFacts { kind: LlmFailureKind; code?: string; status?: number; requestId?: string; retryAfterMs?: number | null; phase?: string }

const LLM_FAILURE_KINDS = new Set<string>([
  "aborted",
  "auth",
  "quota",
  "context_overflow",
  "content_filter",
  "invalid_request",
  "transient",
  "stream_protocol",
  "unknown",
]);

const CONTEXT_CODE_PATTERN = /context[_-]?(?:length|window)|maximum[_-]?context|prompt[_-]?(?:too[_-]?long|length)|input[_-]?(?:too[_-]?large|length)|too[_-]?many[_-]?tokens/i;
const CONTEXT_TEXT_PATTERN = /context length exceeded|maximum context(?: length| window)?|context window exceeded|prompt is too long|input is too large|too many input tokens|request exceeds the model(?:'s)? context/i;
const QUOTA_CODE_PATTERN = /allocationquota|insufficient[_-]?quota|quota[_-]?(?:exceeded|exhausted)|usage[_-]?limit|billing|out[_-]?of[_-]?budget|freeusagelimit|gousagelimit/i;
const QUOTA_TEXT_PATTERN = /allocated[_\s-]+quota[_\s-]+exceeded|insufficient[_\s-]+quota|quota[_\s-]+(?:has[_\s-]+been[_\s-]+)?(?:exceeded|exhausted)|monthly[_\s-]+usage[_\s-]+limit|usage[_\s-]+limit[_\s-]+reached|available[_\s-]+balance|billing|out[_\s-]+of[_\s-]+budget|increase[_\s-]+your[_\s-]+quota[_\s-]+limit/i;
const AUTH_CODE_PATTERN = /authentication|unauthori[sz]ed|invalid[_-]?(?:api[_-]?)?key|permission[_-]?denied|access[_-]?denied|forbidden/i;
const AUTH_TEXT_PATTERN = /authentication failed|invalid api key|incorrect api key|unauthori[sz]ed|permission denied|access denied|forbidden/i;
const CONTENT_FILTER_PATTERN = /content[_-]?filter|content policy|safety policy|moderation|blocked[_-]?content/i;
const TRANSIENT_CODE_PATTERN = /rate[_-]?limit|throttl|overload|resource[_-]?exhausted|service[_-]?unavailable|server[_-]?error|internal[_-]?error|timeout|network/i;
const TRANSIENT_TEXT_PATTERN = /rate.?limit|too many requests|overloaded|service unavailable|server error|internal error|network error|connection (?:refused|lost|reset)|fetch failed|failed to fetch|socket hang up|timed? out|timeout|temporarily unavailable|please retry/i;
const STREAM_PROTOCOL_PATTERN = /stream|sse|protocol|proxy|upstream|response[_-]?format/i;
const STREAM_PROTOCOL_TEXT_PATTERN = /stream (?:disconnected|ended|closed)|ended without|before (?:finish_reason|message_stop|response\.completed)|invalid .*sse|empty stream body|returned no message|not (?:a )?valid llm response/i;
const OUTPUT_TRUNCATED_TEXT_PATTERN = /^LLM output was truncated by finish_reason=[^.]+\. The partial tool call was discarded;/i;
const UNSUPPORTED_CONTENT_TYPE_PATTERN = /Unexpected item type in content\.?/i;

export const LLM_PROVIDER_BACKOFF_MAX_MS = 5 * 60_000;

export function normalizeLlmFailure(error: unknown, hints: LlmFailureHints = {}): LlmFailure {
  if (isNormalizedLlmFailure(error)) return error;

  const source: SourceError = error instanceof Error ? error : new Error(String(error || "LLM request failed"));
  const body = hints.body ?? hints.payload;
  const payload = (Number(hints.status) >= 400
    ? PRODUCT_PROVIDERS[String(hints.provider || "").toLowerCase()]?.unwrapHttpFailure?.(body, providerPayload) : null) || providerPayload(body);
  const status = firstPositiveInteger(
    hints.status,
    source.status,
    source.statusCode,
    payload.status,
    statusFromText(source.message),
  );
  const code = firstText(
    hints.code,
    source.code,
    payload.code,
    payload.type,
    "LLM_PROVIDER_ERROR",
  );
  const requestId = firstText(
    hints.requestId,
    source.requestId,
    source.request_id,
    payload.request_id,
    payload.requestId,
  );
  const retryAfterMs = firstNonNegativeNumber(
    hints.retryAfterMs,
    source.retryAfterMs,
    retryAfterMsFromHeaders(hints.headers, hints.now),
  );
  const rawMessage = firstText(
    hints.message,
    payload.message,
    typeof payload.error === "string" ? payload.error : "",
    source.message,
  );
  const kind = classifyLlmFailure({
    name: source.name,
    code,
    status,
    message: rawMessage,
    phase: hints.phase,
  });

  if (kind === "aborted") {
    assignFailureFacts(source, { kind, phase: hints.phase });
    return source;
  }

  const normalized = new Error(formatLlmFailureForUser({ kind, code, status, message: rawMessage }));
  normalized.name = "LlmProviderError";
  Object.defineProperty(normalized, "providerMessage", { value: rawMessage, enumerable: false });
  assignFailureFacts(normalized, { kind, code, status, requestId, retryAfterMs, phase: hints.phase });
  try {
    Object.defineProperty(normalized, "cause", {
      configurable: true,
      enumerable: false,
      value: source,
    });
  } catch (_error) {}
  return normalized;
}

export function classifyLlmFailure(error: LlmFailureHints = {}): LlmFailureKind {
  const name = String(error?.name || "");
  const code = String(error?.code || "");
  const message = String(error?.message || "");
  const status = firstPositiveInteger(error?.status, statusFromText(message));

  if (name === "AbortError" || code === "ABORT_ERR") return "aborted";
  if (OUTPUT_TRUNCATED_TEXT_PATTERN.test(message)) return "invalid_request";
  if (CONTEXT_CODE_PATTERN.test(code)) return "context_overflow";
  if (QUOTA_CODE_PATTERN.test(code)) return "quota";
  if (AUTH_CODE_PATTERN.test(code)) return "auth";
  if (CONTENT_FILTER_PATTERN.test(code)) return "content_filter";
  if (/^invalid_(?:parameter|request)_error$/i.test(code)) {
    return status === 401 || status === 403 ? "auth" : "invalid_request";
  }
  if (TRANSIENT_CODE_PATTERN.test(code)) return "transient";
  if (STREAM_PROTOCOL_PATTERN.test(code)) return "stream_protocol";

  if (CONTEXT_TEXT_PATTERN.test(message)) return "context_overflow";
  if (QUOTA_TEXT_PATTERN.test(message)) return "quota";
  if (AUTH_TEXT_PATTERN.test(message)) return "auth";
  if (CONTENT_FILTER_PATTERN.test(message)) return "content_filter";

  if (status === 401 || status === 403) return "auth";
  if (status === 408 || status === 425 || status === 429 || status >= 500) return "transient";
  if ([400, 404, 405, 409, 422].includes(status)) return "invalid_request";

  if (STREAM_PROTOCOL_TEXT_PATTERN.test(message)) return "stream_protocol";
  if (TRANSIENT_TEXT_PATTERN.test(message)) return "transient";
  return "unknown";
}

export function formatLlmFailureForUser(error: LlmFailureHints = {}): string {
  if (error.kind === "invalid_request"
    && /^invalid_(?:parameter|request)_error$/i.test(String(error.code || ""))
    && UNSUPPORTED_CONTENT_TYPE_PATTERN.test(String(error.message || ""))) {
    return t("provider.unsupportedImages");
  }
  if (OUTPUT_TRUNCATED_TEXT_PATTERN.test(String(error?.message || ""))) {
    return t("provider.outputTruncated");
  }
  const kind = isFailureKind(error.kind) ? error.kind : "unknown";
  const base = {
    auth: t("provider.auth"),
    quota: t("provider.quota"),
    context_overflow: t("provider.contextOverflow"),
    content_filter: t("provider.contentFilter"),
    invalid_request: t("provider.invalidRequest"),
    transient: t("provider.transient"),
    stream_protocol: t("provider.streamProtocol"),
    aborted: t("provider.aborted"),
    unknown: t("provider.unknown"),
  }[kind];
  const details = [];
  const code = String(error?.code || "").trim();
  const status = firstPositiveInteger(error?.status);
  if (code && code !== "LLM_PROVIDER_ERROR") details.push(code);
  if (status) details.push(`HTTP ${status}`);
  const summary = details.length
    ? (getLanguage() === "zh-CN"
      ? `${base.slice(0, -1)}（${details.join("，")}）。`
      : `${base.replace(/\.$/u, "")} (${details.join(", ")}).`)
    : base;
  const providerMessage = String(error?.message || "").trim();
  if (!providerMessage || providerMessage === summary) return summary;
  return `${summary}\n${providerMessage.slice(0, 4000)}`;
}

export function llmFailureFacts(error: unknown) {
  const normalized = normalizeLlmFailure(error);
  return {
    kind: normalized.kind,
    code: normalized.code,
    ...(normalized.status ? { status: normalized.status } : {}),
    ...(normalized.requestId ? { requestId: normalized.requestId } : {}),
    ...(normalized.retryAfterMs != null ? { retryAfterMs: normalized.retryAfterMs } : {}),
    ...(normalized.phase ? { phase: normalized.phase } : {}),
  };
}

export function retryAfterMsFromHeaders(headers: HeaderReader | null | undefined, now: number | (() => number) = Date.now): number | null {
  if (!headers?.get) return null;
  const retryAfterMsHeader = headers.get("retry-after-ms");
  const retryAfterMs = Number(retryAfterMsHeader);
  if (retryAfterMsHeader != null && retryAfterMsHeader !== "" && Number.isFinite(retryAfterMs) && retryAfterMs >= 0) {
    return Math.floor(retryAfterMs);
  }

  const retryAfter = headers.get("retry-after");
  if (!retryAfter) return null;
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.floor(seconds * 1000);
  const dateMs = Date.parse(retryAfter);
  const currentTime = typeof now === "function" ? Number(now()) : Number(now);
  if (Number.isFinite(dateMs)) return Math.max(0, Math.floor(dateMs - (Number.isFinite(currentTime) ? currentTime : Date.now())));
  return null;
}

export function capLlmProviderBackoffMs(value: unknown): number | null {
  if (value == null || value === "") return null;
  const milliseconds = Number(value);
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return null;
  return Math.min(LLM_PROVIDER_BACKOFF_MAX_MS, Math.floor(milliseconds));
}

function isFailureKind(value: unknown): value is LlmFailureKind {
  return typeof value === "string" && LLM_FAILURE_KINDS.has(value);
}

function isNormalizedLlmFailure(error: unknown): error is LlmFailure {
  return error instanceof Error && isFailureKind((error as SourceError).kind);
}

function providerPayload(value: unknown): Record<string, unknown> {
  let root = value;
  if (typeof root === "string") {
    try {
      root = JSON.parse(root);
    } catch (_error) {
      return { message: root };
    }
  }
  if (!root || typeof root !== "object" || Array.isArray(root)) return {};
  const object = root as Record<string, unknown>;
  if (object.error && typeof object.error === "object" && !Array.isArray(object.error)) {
    return { ...object, ...object.error };
  }
  return object;
}

function assignFailureFacts(error: SourceError, { kind, code, status, requestId, retryAfterMs, phase }: FailureFacts): asserts error is LlmFailure {
  error.kind = kind;
  if (code) error.code = code;
  else if (kind !== "aborted") error.code = "LLM_PROVIDER_ERROR";
  if (status) error.status = status;
  if (requestId) error.requestId = requestId;
  if (retryAfterMs != null) error.retryAfterMs = retryAfterMs;
  if (phase) error.phase = String(phase);
}

function statusFromText(value: unknown): number {
  const match = String(value || "").match(/(?:HTTP|LLM API)\s+(\d{3})\b/i);
  return match ? Number(match[1]) : 0;
}

function firstPositiveInteger(...values: unknown[]): number {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number) && number > 0) return Math.floor(number);
  }
  return 0;
}

function firstNonNegativeNumber(...values: unknown[]): number | null {
  for (const value of values) {
    if (value == null || value === "") continue;
    const number = Number(value);
    if (Number.isFinite(number) && number >= 0) return Math.floor(number);
  }
  return null;
}

function firstText(...values: unknown[]): string {
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (text) return text;
  }
  return "";
}
