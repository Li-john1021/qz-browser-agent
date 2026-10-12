import { t } from "../shared/i18n/backend.js";
type Fields = Record<string, unknown>;
type RateMatch = ReturnType<typeof matchSiteOpenRateLimitUrl>;
interface RateAcquisition { queued: boolean; host: string; minOpenIntervalMs: number; waitMs?: number; nextIntervalMs?: number; nextAllowedAt?: number }
interface RateRequest {
  host: string; sessionKey: string; minOpenIntervalMs: number; signal: AbortSignal | null;
  emitUpdate: ((update: Fields) => unknown) | null;
  resolve(result: RateAcquisition): void; reject(error: unknown): void;
}
interface HostState {
  host: string; running: boolean; nextAllowedAt: number;
  sessionQueues: Map<string, RateRequest[]>; sessionOrder: string[];
}
interface SchedulerEnvironment { now(): number; random(): number; delay(ms: number, signal: AbortSignal | null): Promise<unknown> }
interface RateInput { host?: unknown; minOpenIntervalMs?: unknown; sessionId?: unknown; signal?: AbortSignal | null; emitUpdate?: ((update: Fields) => unknown) | null }
interface RateOptions { name?: string; args?: Fields; url?: string; guardrails?: unknown; context?: { sessionId?: string }; signal?: AbortSignal | null; emitUpdate?: ((update: Fields) => unknown) | null }
const object = (value: unknown): Fields => value && typeof value === "object" ? value as Fields : {};
import {
  matchSiteOpenRateLimitUrl,
} from "../shared/security-guardrails.js";

const DEFAULT_SESSION_KEY = "__default_session__";
const SITE_OPEN_RATE_LIMIT_JITTER_RATIO = 0.2;
const NAVIGATION_OPEN_TARGET_EXTRACTORS: Readonly<Record<string, (args: Fields) => unknown>> = Object.freeze({
  open_tab: args => args?.url,
  navigate: args => args?.url,
});

export function resolveToolNavigationOpenRateLimit(name = "", args: Fields = {}, guardrails: unknown = {}) {
  const extractor = NAVIGATION_OPEN_TARGET_EXTRACTORS[String(name || "")];
  if (typeof extractor !== "function") return null;
  const url = String(extractor(args) || "").trim();
  return resolveUrlNavigationOpenRateLimit(url, guardrails);
}

export function resolveUrlNavigationOpenRateLimit(url = "", guardrails: unknown = {}) {
  const value = String(url || "").trim();
  if (!value) return null;
  return matchSiteOpenRateLimitUrl(value, guardrails);
}

export function createSiteOpenRateLimitScheduler(options: Partial<SchedulerEnvironment> = {}) {
  const now = typeof options.now === "function" ? options.now : () => Date.now();
  const delay = typeof options.delay === "function" ? options.delay : defaultAbortableDelay;
  const random = typeof options.random === "function" ? options.random : () => Math.random();
  const hostStates = new Map<string, HostState>();

  function getHostState(host: unknown) {
    const key = String(host || "").toLowerCase();
    let state = hostStates.get(key);
    if (!state) {
      state = {
        host: key,
        running: false,
        nextAllowedAt: 0,
        sessionQueues: new Map(),
        sessionOrder: [],
      };
      hostStates.set(key, state);
    }
    return state;
  }

  function acquire(input: RateInput = {}) {
    const host = String(input.host || "").toLowerCase();
    const minOpenIntervalMs = Math.max(0, Math.round(Number(input.minOpenIntervalMs || 0)));
    if (!host || minOpenIntervalMs <= 0) return Promise.resolve({ queued: false, host, minOpenIntervalMs });
    if (input.signal?.aborted) return Promise.reject(makeAbortError(host));

    const state = getHostState(host);
    const sessionKey = normalizeSessionKey(input.sessionId);
    let request!: RateRequest;
    const promise = new Promise<RateAcquisition>((resolve, reject) => {
      request = {
        host,
        sessionKey,
        minOpenIntervalMs,
        signal: input.signal || null,
        emitUpdate: typeof input.emitUpdate === "function" ? input.emitUpdate : null,
        resolve,
        reject,
      };
    });

    enqueueRequest(state, request);
    emitInitialQueuedUpdateIfNeeded(state, request, { now });
    const onAbort = () => {
      if (!removeQueuedRequest(state, request)) return;
      request.reject(makeAbortError(host));
      drainHostQueue(state, { now, delay, random });
    };
    request.signal?.addEventListener?.("abort", onAbort, { once: true });
    drainHostQueue(state, { now, delay, random });
    return promise.finally(() => {
      request.signal?.removeEventListener?.("abort", onAbort);
    });
  }

  function record(input: RateInput = {}) {
    const host = String(input.host || "").toLowerCase();
    const minOpenIntervalMs = Math.max(0, Math.round(Number(input.minOpenIntervalMs || 0)));
    if (!host || minOpenIntervalMs <= 0) return null;
    const state = getHostState(host);
    const nextIntervalMs = sampleSiteOpenIntervalMs(minOpenIntervalMs, random);
    state.nextAllowedAt = Math.max(Number(state.nextAllowedAt || 0), now() + nextIntervalMs);
    if (countQueuedRequests(state) > 0) drainHostQueue(state, { now, delay, random });
    return {
      host,
      minOpenIntervalMs,
      nextIntervalMs,
      nextAllowedAt: state.nextAllowedAt,
    };
  }

  function snapshot(host = "") {
    const state = hostStates.get(String(host || "").toLowerCase());
    if (!state) return null;
    return {
      host: state.host,
      running: state.running,
      nextAllowedAt: state.nextAllowedAt,
      activeSessions: state.sessionOrder.length,
      queuedRequests: countQueuedRequests(state),
    };
  }

  function reset() {
    hostStates.clear();
  }

  return { acquire, record, snapshot, reset };
}

const siteOpenRateLimitScheduler = createSiteOpenRateLimitScheduler();

export async function enforceSiteOpenRateLimitForTool({
  name = "",
  args = {},
  guardrails = {},
  context = {},
  signal = null,
  emitUpdate = null,
}: RateOptions = {}) {
  const match = resolveToolNavigationOpenRateLimit(name, args, guardrails);
  return enforceSiteOpenRateLimitMatch({ match, context, signal, emitUpdate });
}

export async function enforceSiteOpenRateLimitForUrl({
  url = "",
  guardrails = {},
  context = {},
  signal = null,
  emitUpdate = null,
}: RateOptions = {}) {
  const match = resolveUrlNavigationOpenRateLimit(url, guardrails);
  return enforceSiteOpenRateLimitMatch({ match, context, signal, emitUpdate });
}

export function recordSiteOpenRateLimitForUrl({
  url = "",
  guardrails = {},
}: Pick<RateOptions, "url" | "guardrails"> = {}) {
  const match = resolveUrlNavigationOpenRateLimit(url, guardrails);
  if (!match?.host || !(Number(match.minOpenIntervalMs) > 0)) return null;
  const recorded = siteOpenRateLimitScheduler.record({
    host: match.host,
    minOpenIntervalMs: match.minOpenIntervalMs,
  });
  return recorded ? { ...recorded, match } : null;
}

async function enforceSiteOpenRateLimitMatch({
  match = null,
  context = {},
  signal = null,
  emitUpdate = null,
}: Pick<RateOptions, "context" | "signal" | "emitUpdate"> & { match?: RateMatch } = {}) {
  if (!match?.host || !(Number(match.minOpenIntervalMs) > 0)) return null;
  const acquired = await siteOpenRateLimitScheduler.acquire({
    host: match.host,
    minOpenIntervalMs: match.minOpenIntervalMs,
    sessionId: context?.sessionId || "",
    signal,
    emitUpdate: (update) => {
      if (typeof emitUpdate !== "function") return;
      emitUpdate({
        ...update,
        match,
      });
    },
  });
  return acquired ? { ...acquired, match } : null;
}

export function resetSiteOpenRateLimitSchedulerForTests() {
  siteOpenRateLimitScheduler.reset();
}

function enqueueRequest(state: HostState, request: RateRequest) {
  const queue = state.sessionQueues.get(request.sessionKey) || [];
  if (!state.sessionQueues.has(request.sessionKey)) {
    state.sessionQueues.set(request.sessionKey, queue);
    state.sessionOrder.push(request.sessionKey);
  }
  queue.push(request);
}

function emitInitialQueuedUpdateIfNeeded(state: HostState, request: RateRequest, { now }: Pick<SchedulerEnvironment, "now">) {
  const waitMs = Math.max(0, Math.ceil(Number(state.nextAllowedAt || 0) - now()));
  if (!state.running && waitMs <= 0) return;
  emitRequestUpdate(request, {
    phase: "queued",
    statusText: t("browser.rateLimitWait"),
    host: state.host,
    waitMs,
    minOpenIntervalMs: request.minOpenIntervalMs,
    activeSessions: state.sessionOrder.length,
    queuedRequests: countQueuedRequests(state),
  });
}

function removeQueuedRequest(state: HostState, request: RateRequest) {
  const queue = state.sessionQueues.get(request.sessionKey);
  if (!queue) return false;
  const index = queue.indexOf(request);
  if (index < 0) return false;
  queue.splice(index, 1);
  if (queue.length === 0) {
    state.sessionQueues.delete(request.sessionKey);
    state.sessionOrder = state.sessionOrder.filter(item => item !== request.sessionKey);
  }
  return true;
}

function nextQueuedRequest(state: HostState): RateRequest | null {
  while (state.sessionOrder.length > 0) {
    const sessionKey = state.sessionOrder.shift()!;
    const queue = state.sessionQueues.get(sessionKey);
    if (!queue?.length) {
      state.sessionQueues.delete(sessionKey);
      continue;
    }
    const request = queue.shift()!;
    if (queue.length > 0) state.sessionOrder.push(sessionKey);
    else state.sessionQueues.delete(sessionKey);
    return request;
  }
  return null;
}

function drainHostQueue(state: HostState, env: SchedulerEnvironment) {
  if (state.running) return;
  state.running = true;
  Promise.resolve().then(() => drainHostQueueLoop(state, env));
}

async function drainHostQueueLoop(state: HostState, { now, delay, random }: SchedulerEnvironment) {
  try {
    while (true) {
      let request = nextQueuedRequest(state);
      if (!request) return;
      if (request.signal?.aborted) {
        request.reject(makeAbortError(state.host));
        continue;
      }

      let totalWaitMs = 0;
      while (true) {
        const waitMs = Math.max(0, Math.ceil(Number(state.nextAllowedAt || 0) - now()));
        if (waitMs <= 0) break;
        emitRequestUpdate(request, {
          phase: "queued",
          statusText: t("browser.rateLimitWait"),
          host: state.host,
          waitMs,
          minOpenIntervalMs: request.minOpenIntervalMs,
          activeSessions: state.sessionOrder.length + 1,
          queuedRequests: countQueuedRequests(state) + 1,
        });
        try {
          await delay(waitMs, request.signal);
        } catch (err) {
          request.reject(isAbortLike(err) ? makeAbortError(state.host) : err);
          request = null;
          break;
        }
        totalWaitMs += waitMs;
        if (request.signal?.aborted) {
          request.reject(makeAbortError(state.host));
          request = null;
          break;
        }
      }
      if (!request) {
        continue;
      }

      if (request.signal?.aborted) {
        request.reject(makeAbortError(state.host));
        continue;
      }

      const nextIntervalMs = sampleSiteOpenIntervalMs(request.minOpenIntervalMs, random);
      state.nextAllowedAt = now() + nextIntervalMs;
      emitRequestUpdate(request, {
        phase: "running",
        statusText: t("browser.opening"),
        host: state.host,
        waitMs: totalWaitMs,
        minOpenIntervalMs: request.minOpenIntervalMs,
        nextIntervalMs,
        activeSessions: state.sessionOrder.length,
        queuedRequests: countQueuedRequests(state),
      });
      request.resolve({
        queued: totalWaitMs > 0,
        host: state.host,
        waitMs: totalWaitMs,
        minOpenIntervalMs: request.minOpenIntervalMs,
        nextIntervalMs,
        nextAllowedAt: state.nextAllowedAt,
      });
    }
  } finally {
    state.running = false;
    if (countQueuedRequests(state) > 0) drainHostQueue(state, { now, delay, random });
  }
}

function emitRequestUpdate(request: RateRequest, update: Fields = {}) {
  try {
    request.emitUpdate?.(update);
  } catch (_err) {
    // Tool state updates are best effort and must not affect throttling.
  }
}

function countQueuedRequests(state: HostState) {
  let count = 0;
  for (const queue of state.sessionQueues.values()) count += queue.length;
  return count;
}

function normalizeSessionKey(sessionId: unknown = "") {
  const value = String(sessionId || "").trim();
  return value || DEFAULT_SESSION_KEY;
}

function sampleSiteOpenIntervalMs(baseIntervalMs: number, random: () => number) {
  const base = Math.max(0, Math.round(Number(baseIntervalMs || 0)));
  if (base <= 0) return 0;
  const sample = clampNumber(Number(random?.()), 0, 1);
  const factor = 1 - SITE_OPEN_RATE_LIMIT_JITTER_RATIO + sample * SITE_OPEN_RATE_LIMIT_JITTER_RATIO * 2;
  return Math.max(1, Math.round(base * factor));
}

function clampNumber(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function defaultAbortableDelay(ms: number, signal: AbortSignal | null) {
  const waitMs = Math.max(0, Number(ms) || 0);
  if (waitMs <= 0) return Promise.resolve();
  if (signal?.aborted) return Promise.reject(makeAbortError());
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal?.removeEventListener?.("abort", onAbort);
    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      reject(makeAbortError());
    };
    const timer = setTimeout(finish, waitMs);
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}

function makeAbortError(host = "") {
  const err = new Error(host ? `Navigation rate-limit wait aborted for ${host}` : "Navigation rate-limit wait aborted");
  err.name = "ToolExecutionError";
  return Object.assign(err, { code: "OPERATION_ABORTED", details: {
    host: host || undefined,
    phase: "security_guardrail_rate_limit",
  } });
}

function isAbortLike(err: unknown) {
  return object(err).name === "AbortError" || object(err).code === "OPERATION_ABORTED" || /aborted/i.test(String(object(err).message || ""));
}
