import { assertModelRequestSize } from './image-budget.js';
import { shouldTraceStreamDelta, trace } from "../trace.js";
import {
  capLlmProviderBackoffMs,
  normalizeLlmFailure,
  retryAfterMsFromHeaders,
} from "./provider-errors.js";

import type { RuntimeConfig } from "../../sdk/background/providers.js";
import type { HeaderReader, LlmFailure, LlmFailureKind } from './provider-errors.js';

interface TimeoutMeta { timeoutMs: number; timedOut: boolean; parentAborted: boolean; parentSignal?: AbortSignal | null }
export interface LlmRetrySettings { maxRetries?: unknown; baseDelayMs?: unknown; maxDelayMs?: unknown; jitterRatio?: unknown }
export interface LlmRetryOptions {
  retry?: LlmRetrySettings; maxRetries?: unknown; retryBaseDelayMs?: unknown; retryMaxDelayMs?: unknown; retryJitterRatio?: unknown;
}
export interface LlmRetryPolicy { maxRetries: number; baseDelayMs: number; maxDelayMs: number; jitterRatio: number }
export interface ProviderResponseEvent {
  status: number; headers: HeaderReader; ok: boolean; phase: string; kind?: LlmFailureKind;
  code?: string; requestId?: string; retryAfterMs?: number | null;
}
export interface ProviderBackoffEvent { status: number; retryAfterMs: number; phase: string; code?: string; requestId?: string }
export interface ProviderDelayHint { retryAfterMs?: number | null; providerRetryAfterMs?: number | null }
interface RetryDetails { attempt: number; maxRetries: number; delayMs: number; retryAfterMs?: number | null; status?: number; kind?: LlmFailureKind; code?: string; requestId?: string; reason?: string }
export interface LlmRetryEvent extends RetryDetails { type: 'llm_retry'; provider: string; model: string; phase: string }
export interface LlmTransportOptions extends LlmRetryOptions {
  onBeforeRetryAttempt?(event: { attempt: number; maxAttempts: number; phase: string }): unknown;
  onRetry?(event: LlmRetryEvent): unknown;
  onProviderBackoff?(event: ProviderBackoffEvent): unknown;
  onProviderResponse?(event: ProviderResponseEvent): ProviderDelayHint | null | void | Promise<ProviderDelayHint | null | void>;
}

export const REQUEST_TIMEOUT = 120000;
export const LLM_RETRY_DEFAULT_MAX_RETRIES = 5;

const LLM_RETRY_BASE_DELAY_MS = 1000;
const LLM_RETRY_MAX_DELAY_MS = 30000;
const LLM_RETRY_DEFAULT_JITTER_RATIO = 0.2;
const timeoutSignalMeta = new WeakMap<AbortSignal, TimeoutMeta>();

export async function fetchLlmEndpointWithRetry(config: RuntimeConfig, phase: string, init: RequestInit, options: LlmTransportOptions = {}): Promise<Response> {
  assertModelRequestSize(init.body);
  const retry = createLlmRetryPolicy(options);
  const timeoutMeta = init?.signal ? timeoutSignalMeta.get(init.signal) : null;
  const waitSignal = timeoutMeta ? timeoutMeta.parentSignal : init?.signal;
  let lastError: Error | null = null;

  for (let attemptIndex = 0; attemptIndex <= retry.maxRetries; attemptIndex++) {
    if (attemptIndex > 0 && typeof options.onBeforeRetryAttempt === "function") {
      await options.onBeforeRetryAttempt({
        attempt: attemptIndex + 1,
        maxAttempts: retry.maxRetries + 1,
        phase,
      });
    }
    const attempt = makeRetryAttemptInit(init, timeoutMeta);

    try {
      const resp = await fetchLlmEndpoint(config, phase, attempt.init);
      if (resp.ok) {
        await emitProviderResponse({
          status: resp.status,
          headers: resp.headers,
          ok: true,
          phase,
        }, options);
        attempt.cleanup();
        return resp;
      }

      const text = await resp.text().catch(() => "");
      const failure = normalizeLlmFailure(new Error(`LLM API ${resp.status}`), {
        status: resp.status,
        headers: resp.headers,
        body: text,
        provider: config.provider,
        phase,
      });
      const retryAfterMs = retryAfterMsFromHeaders(resp.headers);
      const learned = await emitProviderResponse({
        status: resp.status,
        headers: resp.headers,
        ok: false,
        phase,
        kind: failure.kind,
        code: failure.code,
        requestId: failure.requestId,
        retryAfterMs,
      }, options);
      const effectiveRetryAfterMs = capLlmProviderBackoffMs(maxNonNegativeDelay(learned?.retryAfterMs, retryAfterMs));
      const providerRetryAfterMs = capLlmProviderBackoffMs(maxNonNegativeDelay(learned?.providerRetryAfterMs, retryAfterMs));
      const retryDelayMs = effectiveRetryAfterMs == null
        ? null
        : capLlmRetryDelayMs(effectiveRetryAfterMs, retry);
      if (failure.kind === "transient" && providerRetryAfterMs != null) {
        await emitProviderBackoff({
          status: resp.status,
          retryAfterMs: providerRetryAfterMs,
          phase,
          code: failure.code,
          requestId: failure.requestId,
        }, options);
      }
      const shouldRetry = attemptIndex < retry.maxRetries
        && failure.kind === "transient";
      if (!shouldRetry) {
        attempt.cleanup();
        return responseFromConsumedText(resp, text);
      }

      attempt.cleanup();
      await emitLlmRetryAndWait(config, phase, {
        attempt: attemptIndex + 1,
        maxRetries: retry.maxRetries,
        delayMs: retryDelayMs ?? retry.delayMs(attemptIndex),
        retryAfterMs: effectiveRetryAfterMs,
        status: resp.status,
        kind: failure.kind,
        code: failure.code,
        requestId: failure.requestId,
        reason: failure.message,
      }, options, waitSignal);
    } catch (err) {
      attempt.cleanup();
      lastError = err instanceof Error ? err : new Error(String(err || "LLM request failed"));
      const failure = normalizeLlmFailure(lastError, { phase });
      const shouldRetry = attemptIndex < retry.maxRetries
        && isRetryableLlmFetchFailure(lastError, attempt.init?.signal, failure);
      if (!shouldRetry) throw lastError;

      await emitLlmRetryAndWait(config, phase, {
        attempt: attemptIndex + 1,
        maxRetries: retry.maxRetries,
        delayMs: retry.delayMs(attemptIndex),
        kind: failure.kind,
        code: failure.code,
        requestId: failure.requestId,
        reason: failure.message,
      }, options, waitSignal);
    }
  }

  throw lastError || new Error("LLM request failed after retries");
}

export function withTimeout(parentSignal: AbortSignal | null | undefined, timeoutMs: number) {
  const ctrl = new AbortController();
  const meta = { timeoutMs, timedOut: false, parentAborted: false, parentSignal };
  timeoutSignalMeta.set(ctrl.signal, meta);
  const abortFromParent = () => {
    meta.parentAborted = true;
    ctrl.abort(parentSignal?.reason || new DOMException("Aborted by parent signal", "AbortError"));
  };
  const timer = setTimeout(() => {
    meta.timedOut = true;
    ctrl.abort(new DOMException(`Request timed out after ${Math.round(timeoutMs / 1000)}s`, "TimeoutError"));
  }, timeoutMs);

  if (parentSignal?.aborted) {
    abortFromParent();
  } else {
    parentSignal?.addEventListener("abort", abortFromParent, { once: true });
  }

  return {
    signal: ctrl.signal,
    cleanup() {
      clearTimeout(timer);
      parentSignal?.removeEventListener("abort", abortFromParent);
    },
  };
}

export async function readWithIdleTimeout<T>(reader: Pick<ReadableStreamDefaultReader<T>, "read" | "cancel">, timeoutMs: number, signal?: AbortSignal | null): Promise<ReadableStreamReadResult<T>> {
  const cancelReader = (reason?: unknown) => {
    try { void Promise.resolve(reader.cancel(reason)).catch(() => {}); } catch (_error) {}
  };
  if (signal?.aborted) {
    cancelReader(signal.reason);
    throw new DOMException("Aborted", "AbortError");
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        onAbort = () => {
          cancelReader(signal?.reason);
          reject(new DOMException("Aborted", "AbortError"));
        };
        timer = setTimeout(() => {
          cancelReader();
          reject(new DOMException(`LLM stream idle timeout after ${Math.round(timeoutMs / 1000)}s`, "TimeoutError"));
        }, timeoutMs);
        signal?.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener?.("abort", onAbort);
  }
}

function makeRetryAttemptInit(init: RequestInit = {}, timeoutMeta: TimeoutMeta | null | undefined = null) {
  if (!timeoutMeta) {
    return {
      init,
      cleanup() {},
    };
  }

  const attemptTimeout = withTimeout(timeoutMeta.parentSignal, timeoutMeta.timeoutMs);
  return {
    init: { ...init, signal: attemptTimeout.signal },
    cleanup: attemptTimeout.cleanup,
  };
}

export function createLlmRetryPolicy(options: LlmRetryOptions = {}) {
  const raw = options.retry && typeof options.retry === "object" ? options.retry : {};
  const maxRetries = normalizeRetryInteger(
    raw.maxRetries ?? options.maxRetries,
    LLM_RETRY_DEFAULT_MAX_RETRIES,
    0,
    LLM_RETRY_DEFAULT_MAX_RETRIES,
  );
  const baseDelayMs = normalizeRetryInteger(
    raw.baseDelayMs ?? options.retryBaseDelayMs,
    LLM_RETRY_BASE_DELAY_MS,
    0,
    60000,
  );
  const maxDelayMs = normalizeRetryInteger(
    raw.maxDelayMs ?? options.retryMaxDelayMs,
    LLM_RETRY_MAX_DELAY_MS,
    0,
    120000,
  );
  const jitterRatio = normalizeRetryNumber(
    raw.jitterRatio ?? options.retryJitterRatio,
    LLM_RETRY_DEFAULT_JITTER_RATIO,
    0,
    0.5,
  );

  const retry = {
    maxRetries,
    baseDelayMs,
    maxDelayMs: Math.max(baseDelayMs, maxDelayMs),
    jitterRatio,
  };
  return Object.freeze({
    ...retry,
    delayMs: (attemptIndex: number) => resolveLlmRetryDelayMs(attemptIndex, retry),
  });
}

function normalizeRetryInteger(value: unknown, fallback: number, min: number, max: number) {
  const number = Number(value);
  const normalized = Number.isFinite(number) ? Math.floor(number) : fallback;
  return Math.max(min, Math.min(max, normalized));
}

function normalizeRetryNumber(value: unknown, fallback: number, min: number, max: number) {
  const number = Number(value);
  const normalized = Number.isFinite(number) ? number : fallback;
  return Math.max(min, Math.min(max, normalized));
}

function responseFromConsumedText(resp: Response, text: string) {
  return new Response(text, {
    status: resp.status,
    statusText: resp.statusText,
    headers: resp.headers,
  });
}

function isRetryableLlmFetchFailure(err: Error, signal: AbortSignal | null | undefined, failure: LlmFailure = normalizeLlmFailure(err)) {
  const timeoutMeta = signal ? timeoutSignalMeta.get(signal) : null;
  if (timeoutMeta?.parentAborted) return false;
  if (timeoutMeta?.timedOut) return false;
  if (signal?.aborted || err?.name === "AbortError") return false;
  return failure.kind === "transient";
}

function resolveLlmRetryDelayMs(attemptIndex: number, retry: LlmRetryPolicy) {
  const delayMs = retry.baseDelayMs * Math.max(1, 2 ** attemptIndex);
  const jitter = retry.jitterRatio > 0
    ? 1 + ((Math.random() * 2) - 1) * retry.jitterRatio
    : 1;
  return capLlmRetryDelayMs(delayMs * jitter, retry);
}

function capLlmRetryDelayMs(delayMs: unknown, retry: LlmRetryPolicy) {
  const value = Number.isFinite(Number(delayMs)) ? Number(delayMs) : retry.baseDelayMs;
  return Math.max(0, Math.min(retry.maxDelayMs, Math.floor(value)));
}

async function emitLlmRetryAndWait(config: RuntimeConfig, phase: string, retryEvent: RetryDetails, options: LlmTransportOptions, signal: AbortSignal | null | undefined) {
  const event: LlmRetryEvent = {
    type: "llm_retry",
    provider: String(config.providerLabel || config.provider || ""),
    model: config.model || "",
    phase,
    ...retryEvent,
  };
  trace(`LLM retry ${event.attempt}/${event.maxRetries} ${event.provider} ${phase}: ${event.reason || "transient error"}, wait=${event.delayMs}ms`);

  if (typeof options.onRetry === "function") {
    try {
      await Promise.resolve(options.onRetry(event));
    } catch (err) {
      trace(`LLM retry callback failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  await waitForAbortableDelay(event.delayMs, signal);
}

async function emitProviderBackoff(event: ProviderBackoffEvent, options: LlmTransportOptions) {
  if (typeof options.onProviderBackoff !== "function") return;
  try {
    await Promise.resolve(options.onProviderBackoff(event));
  } catch (err) {
    trace(`LLM provider backoff callback failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function emitProviderResponse(event: ProviderResponseEvent, options: LlmTransportOptions) {
  if (typeof options.onProviderResponse !== "function") return null;
  try {
    return (await Promise.resolve(options.onProviderResponse(event))) ?? null;
  } catch (err) {
    trace(`LLM provider response callback failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

function maxNonNegativeDelay(...values: unknown[]) {
  const delays = values
    .filter(value => value != null && value !== "")
    .map(Number)
    .filter(value => Number.isFinite(value) && value >= 0);
  return delays.length ? Math.floor(Math.max(...delays)) : null;
}

export function waitForAbortableDelay(delayMs: number, signal?: AbortSignal | null): Promise<void> {
  if (signal?.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
  const ms = Math.max(0, Number(delayMs) || 0);
  if (!ms) return Promise.resolve();

  let onAbort: (() => void) | undefined;
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  }).finally(() => {
    if (onAbort) signal?.removeEventListener?.("abort", onAbort);
  });
}

async function fetchLlmEndpoint(config: RuntimeConfig, phase: string, init: RequestInit) {
  try {
    return await fetch(config.endpoint || "", init);
  } catch (err) {
    throw normalizeLlmFetchError(err, config, phase, init?.signal);
  }
}

function normalizeLlmFetchError(error: unknown, config: RuntimeConfig, phase: string, signal?: AbortSignal | null) {
  const err = error instanceof Error ? error : new Error(String(error || "unknown error"));
  const provider = config.providerLabel || config.provider || "unknown";
  const endpoint = config.endpoint || config.customEndpoint || "unknown endpoint";
  const original = err?.message || String(err || "unknown error");
  const prefix = `LLM fetch failed during ${phase}: ${provider} ${endpoint}`;
  const timeoutMeta = signal ? timeoutSignalMeta.get(signal) : null;
  const timeoutMs = timeoutMeta?.timeoutMs || REQUEST_TIMEOUT;

  if (timeoutMeta?.timedOut || err?.name === "TimeoutError") {
    const timeout = new Error(`${prefix} timed out after ${Math.round(timeoutMs / 1000)}s before the response stream opened. Original error: ${original}`);
    timeout.name = "TimeoutError";
    return timeout;
  }
  if (err?.name === "AbortError" || signal?.aborted) {
    const reason = timeoutMeta?.parentAborted
      ? "was aborted by the parent run/user signal"
      : "was aborted before the response stream opened";
    return new DOMException(`${prefix} ${reason}. Original error: ${original}`, "AbortError");
  }
  return new Error(`${prefix}. Check network/proxy/auth/CORS or provider availability. Original error: ${original}`);
}

/** Byte framing only: each adapter keeps its JSON/error/terminal-event semantics. */
export async function* readSseFrames(
  reader: ReadableStreamDefaultReader<Uint8Array>, idleTimeoutMs: number, signal: AbortSignal,
  { trace: timing, acceptDoneMarker = false }: {
    trace?: (stage: string, fields: Record<string, unknown>) => void; acceptDoneMarker?: boolean;
  } = {},
): AsyncGenerator<{ event: string; data: string }> {
  const decoder = new TextDecoder();
  let buffer = "", event = "";
  let data: string[] = [];
  let reads = 0, totalBytes = 0, lastReadAt = 0;
  const flush = () => {
    const frame = data.length ? { event, data: data.join("\n") } : null;
    event = "";
    data = [];
    return frame;
  };
  while (true) {
    const started = Date.now();
    const { done, value } = await readWithIdleTimeout(reader, idleTimeoutMs, signal);
    const readMs = Date.now() - started;
    if (done) {
      timing?.("llm_reader_done", { reads, bytes: totalBytes, readMs });
      buffer += decoder.decode();
      break;
    }
    const now = Date.now(), bytes = value.byteLength;
    const gapMs = lastReadAt ? now - lastReadAt : 0;
    lastReadAt = now;
    reads += 1;
    totalBytes += bytes;
    if (shouldTraceStreamDelta(reads, gapMs) || readMs >= 500) {
      timing?.("llm_reader_chunk", { n: reads, bytes, totalBytes, readMs, gapMs });
    }
    buffer += decoder.decode(value, { stream: true });
    let newline;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      if (!line) {
        const frame = flush();
        if (frame) yield frame;
      } else if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    }
  }
  const tail = buffer.trim().replace(/\r$/, "");
  if (tail.startsWith("data:")) data.push(tail.slice(5).trimStart());
  else if (tail.startsWith("event:")) event = tail.slice(6).trim();
  else if (tail.startsWith("{") || (acceptDoneMarker && tail === "[DONE]")) data.push(tail);
  const frame = flush();
  if (frame) yield frame;
}
