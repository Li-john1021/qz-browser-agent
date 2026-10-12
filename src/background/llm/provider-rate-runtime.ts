/** Provider-scoped persistence and tracing around the pure rate learner. */

import { DEFAULT_PROVIDER_RATE_POLICY } from "./provider-rate-governor.js";
import { capLlmProviderBackoffMs } from "./provider-errors.js";
import {
  parseProviderRateSignal,
  reduceProviderRateLearning,
} from "./provider-rate-learning.js";

import type { createProviderRateGovernor, RatePolicy, RatePolicyInput, RateIdentity, RateReservation, RateWaitEvent } from './provider-rate-governor.js';
import type { LearningState, LearningResult, RateSignal, RateUsage, SignalInput, CapacityPolicy } from './provider-rate-learning.js';
import type { ModelOptions } from './protocol-registry.js';
import type { ProviderDelayHint, ProviderResponseEvent } from './transport.js';
type Governor = Partial<ReturnType<typeof createProviderRateGovernor>>;
interface Storage {get(key: string): Promise<Record<string, unknown>>; set(value: Record<string, unknown>): Promise<void>}
interface RuntimeOptions {
  storage?: Storage | null; governor?: Governor | null; policy?: RatePolicyInput;
  now?: () => number; onTrace?: (event: Record<string, unknown>) => unknown; storageLoadTimeoutMs?: number;
}
type RequestIdentity = Partial<RateIdentity> & {key?: string};
interface SignalRequest extends RequestIdentity, SignalInput {usage?: RateUsage | null; windowMs?: number; source?: string}
interface BeginRequest extends RequestIdentity { estimatedTokens?: number; enforce?: boolean; signal?: AbortSignal | null; onWait?: ((event: RateWaitEvent) => unknown) | null; options?: ModelOptions }
interface ActiveAdmission { options: ModelOptions; current: RateReservation; key: string; identity: RateIdentity; providerFailures: string[]; sawRateFailure: boolean }
export type RateAdmission = ActiveAdmission | {options: ModelOptions; current: null};
interface RecordedSignal extends LearningResult {signal: RateSignal; policy: RatePolicy; retryAfterMs: number; providerRetryAfterMs: number | null}
type FailureFacts = Pick<Partial<ProviderResponseEvent>, 'status' | 'code' | 'kind' | 'retryAfterMs'>;

export const PROVIDER_RATE_LEARNING_STORAGE_KEY = "_qz_provider_rate_learning_v1";
const DEFAULT_STORAGE_LOAD_TIMEOUT_MS = 250;

export function createProviderRateLearningRuntime(options: RuntimeOptions = {}) {
  const storage = options.storage || null;
  const governor = options.governor || null;
  const fallbackPolicy = normalizePolicy(governor?.policy || options.policy || DEFAULT_PROVIDER_RATE_POLICY);
  const now = typeof options.now === "function" ? options.now : Date.now;
  const onTrace = typeof options.onTrace === "function" ? options.onTrace : null;
  const storageLoadTimeoutMs = positiveInteger(options.storageLoadTimeoutMs, DEFAULT_STORAGE_LOAD_TIMEOUT_MS);
  const states = new Map<string, unknown>();
  const restored = new Set<string>();
  let storageHydrated = typeof storage?.get !== "function";
  let hydrateTask: Promise<void> | null = null;
  let persistTail: Promise<boolean | void> = Promise.resolve();

  async function getPolicy({ key = "", ...identity }: RequestIdentity = {}) {
    const providerKey = requireProviderKey(key);
    await hydrate();
    const previous = states.get(providerKey) || null;
    const result = reduceProviderRateLearning(previous, { outcome: "failure" }, {
      now: now(),
      policy: fallbackPolicy,
    });
    if (result.state !== previous) {
      updateState(providerKey, result.state);
      void persist();
    }
    const effective = effectivePolicy(result.policy);
    if (result.staleDimensions?.length) {
      restored.add(providerKey);
      emitLearningTrace("evidence_stale", providerKey, identity, {
        signal: "expired",
        staleDimensions: result.staleDimensions.join(","),
        ...policyTraceFields(effective, effective),
        ...evidenceTraceFields(result.state),
      });
    } else if (result.pressureExpired) {
      restored.add(providerKey);
      emitLearningTrace("pressure_expired", providerKey, identity, {
        signal: "expired",
        ...policyTraceFields(fallbackPolicy, effective),
        ...evidenceTraceFields(result.state),
      });
    } else if (result.state && !restored.has(providerKey)) {
      restored.add(providerKey);
      emitLearningTrace("restored", providerKey, identity, {
        signal: "persisted",
        ...policyTraceFields(fallbackPolicy, effective),
        ...evidenceTraceFields(result.state),
      });
    }
    return effective;
  }

  async function recordProviderSignal({
    key = "",
    status = 0,
    headers = null,
    code = "",
    kind = "",
    retryAfterMs = null,
    usage = null,
    windowMs = 0,
    source = "response",
    ...identity
  }: SignalRequest = {}) {
    const signal = parseProviderRateSignal({
      status,
      headers,
      code,
      kind,
      retryAfterMs,
      now: now(),
    });
    if (signal.type === "none") return null;
    return record({
      key,
      outcome: "failure",
      signal,
      usage,
      windowMs,
      source,
      identity,
    });
  }

  async function recordSuccess({ key = "", usage = null, windowMs = 0, ...identity }: RequestIdentity & {usage?: RateUsage | null; windowMs?: number} = {}) {
    return record({
      key,
      outcome: "success",
      signal: parseProviderRateSignal({ now: now() }),
      usage,
      windowMs,
      source: "success",
      identity,
    });
  }

  async function beginRequest({
    key = "",
    estimatedTokens = 0,
    enforce = false,
    signal = null,
    onWait = null,
    options: requestOptions = {},
    ...rawIdentity
  }: BeginRequest = {}): Promise<RateAdmission> {
    const providerKey = requireProviderKey(key);
    const identity = normalizeIdentity(rawIdentity);
    const shouldEnforce = enforce === true && typeof governor?.reserve === "function";
    const shouldObserve = !shouldEnforce
      && typeof governor?.observe === "function"
      && typeof governor?.getUsage === "function";
    if (!shouldEnforce && !shouldObserve) return { options: requestOptions, current: null };

    const reserve = async () => {
      if (!shouldEnforce) {
        void hydrate();
        return governor!.observe!({
          key: providerKey,
          estimatedTokens,
          ...identity,
        });
      }
      let learnedPolicy = null;
      try {
        learnedPolicy = await getPolicy({ key: providerKey, ...identity });
      } catch (error) {
        emitRuntimeError("policy", providerKey, identity, error);
      }
      const input = {
        key: providerKey,
        estimatedTokens,
        policy: learnedPolicy,
        ...identity,
      };
      return governor!.reserve!({ ...input, signal, onWait });
    };
    const admission: ActiveAdmission = {
      options: requestOptions,
      current: await reserve(),
      key: providerKey,
      identity,
      providerFailures: [],
      sawRateFailure: false,
    };
    const onBeforeRetryAttempt = requestOptions.onBeforeRetryAttempt;
    const onProviderBackoff = requestOptions.onProviderBackoff;
    const onProviderResponse = requestOptions.onProviderResponse;
    const wrappedOptions: ModelOptions = {
      ...requestOptions,
      onBeforeRetryAttempt: async (event) => {
        admission.providerFailures.length = 0;
        if (typeof onBeforeRetryAttempt === "function") await onBeforeRetryAttempt(event);
        admission.current = await reserve();
      },
      onProviderResponse: async (event) => {
        let learned = null;
        if (!shouldEnforce && event.ok === true) {
          void recordAdmissionSignal(admission, event, "transport")
            .catch(error => emitRuntimeError("success_signal", providerKey, identity, error));
        } else {
          learned = await recordAdmissionSignal(admission, event, "transport");
        }
        const callerResult = typeof onProviderResponse === "function"
          ? await onProviderResponse(event)
          : null;
        return mergeProviderResponseAdvice(learned, callerResult);
      },
    };
    if (shouldEnforce) {
      wrappedOptions.onProviderBackoff = async (event) => {
        const retryAfterMs = capLlmProviderBackoffMs(event.retryAfterMs) ?? 0;
        if (typeof governor?.applyRetryAfter === "function") {
          governor.applyRetryAfter({
            key: providerKey,
            retryAfterMs,
            ...identity,
          });
        }
        if (typeof onProviderBackoff === "function") await onProviderBackoff({ ...event, retryAfterMs });
      };
    }
    admission.options = wrappedOptions;
    return admission;
  }

  function settleRequest({ admission, reportedTokens = 0 }: {admission?: RateAdmission; reportedTokens?: number} = {}) {
    if (!admission || !("key" in admission) || !admission.current.id) return false;
    const settled = typeof governor?.settle === "function"
      ? governor.settle(admission.current.id, Number(reportedTokens))
      : false;
    if (!admission.sawRateFailure) {
      const usage = readRateUsage(governor, admission.key, { settledOnly: true });
      void recordSuccess({
        key: admission.key,
        usage,
        windowMs: usage.windowMs,
        ...admission.identity,
      })
        .catch(error => emitRuntimeError("success", admission.key, admission.identity, error));
    }
    return settled;
  }

  async function failRequest({ admission, failure }: {admission?: RateAdmission; failure?: FailureFacts} = {}) {
    if (!admission || !("key" in admission) || !admission.key || consumeMatchingProviderFailure(admission, failure)) return null;
    return recordAdmissionSignal(admission, {
      status: failure?.status,
      code: failure?.code,
      kind: failure?.kind,
      retryAfterMs: failure?.retryAfterMs,
    }, "gateway_error");
  }

  async function recordAdmissionSignal(admission: ActiveAdmission, event: Partial<ProviderResponseEvent>, source: string) {
    const usage = readRateUsage(governor, admission.key, {
      settledOnly: true,
      includeReservationId: admission.current?.id,
    });
    let learned = null;
    try {
      learned = await recordProviderSignal({
        key: admission.key,
        status: event.status,
        headers: event.headers,
        code: event.code,
        kind: event.kind,
        retryAfterMs: event.retryAfterMs,
        usage,
        windowMs: usage.windowMs,
        source,
        ...admission.identity,
      });
    } catch (error) {
      emitRuntimeError("signal", admission.key, admission.identity, error);
    }
    if (event.ok === false && learned?.signal?.type !== "none") {
      admission.providerFailures.push(providerFailureSignature(event));
      if (admission.providerFailures.length > 4) admission.providerFailures.shift();
    }
    if (learned?.signal?.type === "rate_limit") admission.sawRateFailure = true;
    return learned;
  }

  async function record({ key, outcome, signal, usage, windowMs, source, identity }: {key: string; outcome: string; signal: RateSignal; usage: RateUsage | null; windowMs: number; source: string; identity: Partial<RateIdentity>}): Promise<RecordedSignal> {
    const providerKey = requireProviderKey(key);
    await hydrate();
    const previous = states.get(providerKey) || null;
    const previousPolicy = resolvePolicy(previous);
    const currentTime = now();
    const result = reduceProviderRateLearning(previous, {
      outcome,
      signal,
      usage,
      windowMs,
    }, {
      now: currentTime,
      policy: fallbackPolicy,
    });
    updateState(providerKey, result.state);
    if (result.changed) void persist();
    const nextPolicy = effectivePolicy(result.policy);
    if (result.changed || signal.type !== "none") {
      const phase = result.staleDimensions?.length
        ? "evidence_stale"
        : result.pressureExpired && signal.type === "none"
          ? "pressure_expired"
          : signal.type === "none" ? "learned" : "signal";
      emitLearningTrace(phase, providerKey, identity, {
        source,
        signal: signal.type,
        staleDimensions: result.staleDimensions?.join(",") || "",
        dimension: signal.dimension,
        trusted: signal.trusted === true,
        ...(result.pressureExpired ? { pressureExpired: true } : {}),
        rpm: positiveInteger(usage?.requests, 0),
        tpm: positiveInteger(usage?.tokens, 0),
        tokenUnit: "estimated",
        ...policyTraceFields(previousPolicy, nextPolicy),
        ...evidenceTraceFields(result.state),
        retryMs: result.retryAt > currentTime ? result.retryAt - currentTime : 0,
        floorRpm: fallbackPolicy.requestsPerWindow,
        floorTpm: fallbackPolicy.tokensPerWindow,
        changed: result.changed === true,
      });
    }
    return {
      ...result,
      signal,
      policy: nextPolicy,
      retryAfterMs: result.retryAt > currentTime ? result.retryAt - currentTime : 0,
      providerRetryAfterMs: signal.retryAt > currentTime ? signal.retryAt - currentTime : null,
    };
  }

  async function hydrate() {
    if (!hydrateTask) {
      hydrateTask = (async () => {
        if (typeof storage?.get !== "function") return;
        try {
          const stored = await withTimeout(
            storage.get(PROVIDER_RATE_LEARNING_STORAGE_KEY),
            storageLoadTimeoutMs,
            "provider rate learning storage load timed out",
          );
          mergeStoredProviders(stored);
          storageHydrated = true;
        } catch (error) {
          emitStorageError("load", error);
        }
      })();
    }
    await hydrateTask;
  }

  async function persist() {
    if (typeof storage?.set !== "function") return false;
    persistTail = persistTail.then(async () => {
      try {
        if (!storageHydrated && typeof storage?.get === "function") {
          mergeStoredProviders(await withTimeout(
            storage.get(PROVIDER_RATE_LEARNING_STORAGE_KEY),
            storageLoadTimeoutMs,
            "provider rate learning storage load timed out",
          ));
          storageHydrated = true;
        }
        await storage.set({
          [PROVIDER_RATE_LEARNING_STORAGE_KEY]: { version: 1, providers: Object.fromEntries(states) },
        });
        return true;
      } catch (error) {
        emitStorageError("save", error);
        return false;
      }
    });
    return persistTail;
  }

  function mergeStoredProviders(stored: Record<string, unknown>) {
    const raw = recordObject(stored?.[PROVIDER_RATE_LEARNING_STORAGE_KEY]);
    const providers = raw?.version === 1 && raw.providers && typeof raw.providers === "object"
      ? raw.providers
      : {};
    for (const [key, state] of Object.entries(providers)) {
      if (key && state && typeof state === "object" && !states.has(key)) states.set(key, state);
    }
  }

  function updateState(key: string, state: LearningState | null) {
    if (state) states.set(key, state);
    else states.delete(key);
  }

  function resolvePolicy(state: unknown) {
    if (!state) return fallbackPolicy;
    const result = reduceProviderRateLearning(state, { outcome: "failure" }, {
      now: now(),
      policy: fallbackPolicy,
    });
    return effectivePolicy(result.policy);
  }

  function effectivePolicy(learned: CapacityPolicy | null): RatePolicy {
    if (!learned) return fallbackPolicy;
    return Object.freeze({ ...fallbackPolicy, ...learned });
  }

  function emitLearningTrace(phase: string, key: string, identity: Partial<RateIdentity> = {}, fields: Record<string, unknown> = {}) {
    if (!onTrace) return;
    callListener(onTrace, {
      phase,
      provider: String(key || "").split("|", 1)[0],
      sessionId: String(identity.sessionId || "").trim(),
      runId: String(identity.runId || "").trim(),
      spanId: String(identity.spanId || "").trim(),
      ...fields,
    });
  }

  function emitStorageError(action: string, error: unknown) {
    emitLearningTrace("storage_error", "", {}, {
      action,
      error: error instanceof Error ? error.message : String(error || "storage failed"),
    });
  }

  function emitRuntimeError(action: string, key: string, identity: Partial<RateIdentity>, error: unknown) {
    emitLearningTrace("runtime_error", key, identity, {
      action,
      error: error instanceof Error ? error.message : String(error || "learning failed"),
    });
  }

  return Object.freeze({
    getPolicy,
    recordProviderSignal,
    recordSuccess,
    beginRequest,
    settleRequest,
    failRequest,
    flush: () => persistTail,
    policy: fallbackPolicy,
  });
}

function normalizePolicy(policy: RatePolicyInput = {}) {
  return Object.freeze({
    windowMs: positiveInteger(policy.windowMs, DEFAULT_PROVIDER_RATE_POLICY.windowMs),
    requestsPerWindow: positiveInteger(policy.requestsPerWindow, DEFAULT_PROVIDER_RATE_POLICY.requestsPerWindow),
    tokensPerWindow: positiveInteger(policy.tokensPerWindow, DEFAULT_PROVIDER_RATE_POLICY.tokensPerWindow),
    burstToleranceMs: positiveInteger(policy.burstToleranceMs, DEFAULT_PROVIDER_RATE_POLICY.burstToleranceMs),
    waitNoticeThresholdMs: nonNegativeInteger(
      policy.waitNoticeThresholdMs,
      DEFAULT_PROVIDER_RATE_POLICY.waitNoticeThresholdMs,
    ),
  });
}

function policyTraceFields(previous: CapacityPolicy, next: CapacityPolicy) {
  return {
    oldRpmLimit: previous.requestsPerWindow,
    rpmLimit: next.requestsPerWindow,
    oldTpmLimit: previous.tokensPerWindow,
    tpmLimit: next.tokensPerWindow,
  };
}

function evidenceTraceFields(state: LearningState | null) {
  return {
    rpmAnchor: state?.requests?.anchor || 0,
    rpmLower: state?.requests?.lower || 0,
    rpmUpper: state?.requests?.upper || 0,
    rpmExact: state?.requests?.exact || 0,
    tpmAnchor: state?.tokens?.anchor || 0,
    tpmLower: state?.tokens?.lower || 0,
    tpmUpper: state?.tokens?.upper || 0,
    tpmExact: state?.tokens?.exact || 0,
    pressurePct: state?.pressure?.scale || 100,
    pressureLowerPct: state?.pressure?.lower || 0,
    pressureUpperPct: state?.pressure?.upper || 0,
    pressureStreak: state?.pressure?.streak || 0,
    pressureExpiresAt: state?.pressure?.expiresAt || 0,
  };
}

function requireProviderKey(value: unknown) {
  const key = String(value || "").trim();
  if (!key) throw new TypeError("provider rate key is required");
  return key;
}

function normalizeIdentity(value: Partial<RateIdentity> = {}) {
  return {
    sessionId: String(value.sessionId || "").trim(),
    runId: String(value.runId || "").trim(),
    spanId: String(value.spanId || "").trim(),
  };
}

function readRateUsage(governor: Governor | null, key: string, options: {settledOnly?: boolean; includeReservationId?: string} = {}) {
  if (typeof governor?.getUsage !== "function") return { requests: 0, tokens: 0, windowMs: 0 };
  return governor.getUsage(key, options);
}

function consumeMatchingProviderFailure(admission: ActiveAdmission, failure: FailureFacts | undefined) {
  const signature = providerFailureSignature(failure);
  const index = admission.providerFailures.findIndex(value => value === signature);
  if (index < 0) return false;
  admission.providerFailures.splice(index, 1);
  return true;
}

function providerFailureSignature(value: FailureFacts = {}) {
  return [
    Number(value?.status) || 0,
    String(value?.code || "").toLowerCase(),
    String(value?.kind || "").toLowerCase(),
  ].join("|");
}

function mergeProviderResponseAdvice(learned: RecordedSignal | null, caller: ProviderDelayHint | void | null) {
  const delays = [learned?.retryAfterMs, caller?.retryAfterMs]
    .map(Number)
    .filter(value => Number.isFinite(value) && value >= 0);
  const providerDelays = [learned?.providerRetryAfterMs, caller?.providerRetryAfterMs]
    .map(Number)
    .filter(value => Number.isFinite(value) && value >= 0);
  if (!delays.length && !providerDelays.length) return learned || caller || null;
  return {
    ...(learned || {}),
    ...(caller || {}),
    ...(delays.length ? { retryAfterMs: Math.max(...delays) } : {}),
    ...(providerDelays.length ? { providerRetryAfterMs: Math.max(...providerDelays) } : {}),
  };
}

function callListener(listener: (event: Record<string, unknown>) => unknown, event: Record<string, unknown>) {
  try {
    Promise.resolve(listener(event)).catch(() => undefined);
  } catch (_error) {}
}

function withTimeout<T>(task: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([Promise.resolve(task), timeout]).finally(() => clearTimeout(timer));
}

function positiveInteger(value: unknown, fallback: number) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function nonNegativeInteger(value: unknown, fallback: number) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : fallback;
}

function recordObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
