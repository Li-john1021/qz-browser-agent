interface BridgeConfig {
  enabled: boolean; endpoint: string; clientId: string; token: string;
  pollIntervalMs: number; pollTimeoutMs: number; requestTimeoutMs: number;
  maxBatch: number; includeCapabilities: boolean;
}
interface BridgeDependencies {
  dispatch?: (request: { id: string; method: string; params: Record<string, unknown>; raw: Record<string, unknown> }) => unknown | Promise<unknown>;
  describe?: () => unknown | Promise<unknown>;
  trace?: (message: string) => void;
}
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

const BRIDGE_STORAGE_KEY = "_qingzhou_mcp_bridge";
const LLM_CONFIG_STORAGE_KEY = "llmConfig";
const BRIDGE_PROTOCOL_VERSION = 1;
const DEFAULT_ENDPOINT = "http://127.0.0.1:18765";
const DEFAULT_POLL_INTERVAL_MS = 750;
const DEFAULT_POLL_TIMEOUT_MS = 30000;
const DEFAULT_REQUEST_TIMEOUT_MS = 120000;
const DEFAULT_MAX_BATCH = 4;
const STATUS_TRACE_MIN_INTERVAL_MS = 60000;

export function qingzhouMcpBridgeStorageKey() {
  return BRIDGE_STORAGE_KEY;
}

export async function getQingzhouMcpBridgeConfig() {
  const data = await chrome.storage.local.get([BRIDGE_STORAGE_KEY, LLM_CONFIG_STORAGE_KEY]);
  return normalizeBridgeConfig(data?.[BRIDGE_STORAGE_KEY], {
    debugMode: record(data?.[LLM_CONFIG_STORAGE_KEY]).debugMode === true,
  });
}

export async function saveQingzhouMcpBridgeConfig(patch: Partial<BridgeConfig> = {}) {
  const current = await getQingzhouMcpBridgeConfig();
  const next = normalizeBridgeConfig({ ...current, ...(patch || {}) });
  await chrome.storage.local.set({ [BRIDGE_STORAGE_KEY]: next });
  return next;
}

export function startQingzhouMcpBridge(dependencies: BridgeDependencies = {}) {
  const runtime = new QingzhouMcpBridgeRuntime(dependencies);
  runtime.start();
  return runtime;
}

class QingzhouMcpBridgeRuntime {
  config = normalizeBridgeConfig();
  timer: ReturnType<typeof setTimeout> | null = null;
  started = false;
  generation = 0;
  inFlight = false;
  activeRequests = new Map<string, Promise<void>>();
  failureCount = 0;
  storageListener: ((changes: Record<string, chrome.storage.StorageChange>, areaName: string) => void) | null = null;
  connected = false;
  lastStatusTraceAt = 0;
  lastStatusTraceKey = "";
  private trace: (message: string) => void;
  constructor(private readonly dependencies: BridgeDependencies = {}) {
    this.trace = dependencies.trace || defaultTrace;
  }

  start() {
    if (this.started) return this;
    this.started = true;
    this.storageListener = (changes, areaName) => {
      if (areaName !== "local") return;
      if (!changes?.[BRIDGE_STORAGE_KEY] && !changes?.[LLM_CONFIG_STORAGE_KEY]) return;
      getQingzhouMcpBridgeConfig()
        .then((config) => this.applyConfig(config))
        .catch((err) => this.trace(`[mcp-bridge] config refresh failed: ${err?.message || err}`));
    };
    chrome.storage?.onChanged?.addListener?.(this.storageListener);
    getQingzhouMcpBridgeConfig()
      .then((config) => this.applyConfig(config))
      .catch((err) => this.trace(`[mcp-bridge] config load failed: ${err?.message || err}`));
    return this;
  }

  stop() {
    this.generation += 1;
    this.started = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.storageListener) chrome.storage?.onChanged?.removeListener?.(this.storageListener);
    this.storageListener = null;
  }

  applyConfig(config: unknown) {
    const next = normalizeBridgeConfig(config);
    if (Object.entries(next).every(([key, value]) => this.config[key as keyof BridgeConfig] === value)) {
      // Unrelated model writes must not discard commands already dequeued by a poll.
      if (!this.inFlight && !this.timer) this.schedulePoll(0);
      return;
    }
    this.generation += 1;
    const previousKey = this.configKey();
    const wasEnabled = this.config.enabled === true;
    this.config = next;
    this.failureCount = 0;
    const nextKey = this.configKey();
    if (!this.config.enabled) {
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      this.connected = false;
      if (wasEnabled) {
        this.traceStatus("disabled", "[mcp-bridge] disabled", { force: true });
      }
      return;
    }
    this.connected = false;
    this.traceStatus(
      `enabled:${nextKey}`,
      `[mcp-bridge] enabled; polling ${this.config.endpoint} client=${this.config.clientId} token=${this.config.token ? "set" : "none"}`,
      { force: previousKey !== nextKey },
    );
    this.schedulePoll(0);
  }

  schedulePoll(delayMs: number) {
    if (!this.started || !this.config.enabled) return;
    if (this.timer) clearTimeout(this.timer);
    const delay = Math.max(0, Math.floor(Number(delayMs) || 0));
    this.timer = setTimeout(() => {
      this.timer = null;
      this.pollOnce().catch((err) => {
        this.handlePollFailure(err);
        this.schedulePoll(this.nextDelayMs());
      });
    }, delay);
  }

  async pollOnce() {
    if (!this.config.enabled || this.inFlight) return;
    this.inFlight = true;
    const generation = this.generation;
    const config = this.config;
    try {
      const payload = await this.buildPollPayload();
      if (generation !== this.generation || !this.started) return;
      const response = await postJson(config.endpoint, "/v1/qingzhou/poll", payload, config.token, config.pollTimeoutMs + 5000);
      if (generation !== this.generation || !this.started) return;
      this.failureCount = 0;
      if (!this.connected) {
        this.connected = true;
        this.traceStatus(
          `connected:${this.configKey()}`,
          `[mcp-bridge] connected ${this.config.endpoint} client=${this.config.clientId}`,
          { force: true },
        );
      }
      const requests = Array.isArray(response?.requests) ? response.requests.slice(0, this.config.maxBatch) : [];
      for (const request of requests) this.startRequest(request, config);
      this.schedulePoll(requests.length ? 0 : this.config.pollIntervalMs);
    } finally {
      this.inFlight = false;
      if (generation !== this.generation && this.started) this.schedulePoll(0);
    }
  }

  async buildPollPayload() {
    const client: Record<string, unknown> = {
      id: this.config.clientId || defaultClientId(),
      extensionId: chrome.runtime?.id || "",
      name: "qingzhou",
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      pollTimeoutMs: this.config.pollTimeoutMs,
      maxBatch: this.config.maxBatch,
      connectedAt: Date.now(),
    };
    if (this.dependencies.describe && this.config.includeCapabilities) {
      try {
        client.capabilities = await Promise.resolve(this.dependencies.describe());
      } catch (err) {
        client.capabilityError = errorMessage(err);
      }
    }
    return { client };
  }

  startRequest(value: unknown, config = this.config) {
    const request = record(value);
    const requestId = String(request.id || "");
    if (!requestId || this.activeRequests.has(requestId)) return;
    const task = this.handleRequest(request, config)
      .catch((err) => {
        this.trace(`[mcp-bridge] request ${requestId} failed to report result: ${normalizeTraceError(err)}`);
      })
      .finally(() => {
        this.activeRequests.delete(requestId);
      });
    this.activeRequests.set(requestId, task);
  }

  async handleRequest(request: Record<string, unknown>, config = this.config) {
    const requestId = String(request.id || "");
    if (!requestId) return;
    const startedAt = Date.now();
    try {
      if (!this.dependencies.dispatch) throw new Error("Qingzhou MCP bridge dispatcher is unavailable");
      const result = await withTimeout(
        Promise.resolve(this.dependencies.dispatch({
          id: requestId,
          method: String(request.method || ""),
          params: record(request.params),
          raw: request,
        })),
        normalizePositiveInteger(request.timeoutMs, config.requestTimeoutMs, 1000, 10 * 60 * 1000),
      );
      await this.postResult({
        requestId,
        ok: true,
        result: toJsonValue(result),
        durationMs: Date.now() - startedAt,
      }, config);
    } catch (err) {
      await this.postResult({
        requestId,
        ok: false,
        error: errorMessage(err),
        code: record(err).code || "",
        durationMs: Date.now() - startedAt,
      }, config);
    }
  }

  async postResult(payload: Record<string, unknown>, config: BridgeConfig) {
    await postJson(
      config.endpoint,
      "/v1/qingzhou/result",
      {
        clientId: config.clientId || defaultClientId(),
        ...payload,
      },
      config.token,
      15000,
    );
  }

  nextDelayMs() {
    const base = Math.max(this.config.pollIntervalMs, 1000);
    const delay = base * Math.max(1, 2 ** Math.min(this.failureCount, 4));
    return Math.min(15000, delay);
  }

  handlePollFailure(err: unknown) {
    this.failureCount += 1;
    this.connected = false;
    const message = normalizeTraceError(err);
    this.traceStatus(
      `failed:${this.configKey()}:${message}`,
      `[mcp-bridge] local bridge unavailable (${message}); retrying in debug mode`,
    );
  }

  configKey() {
    return `${this.config.enabled ? 1 : 0}|${this.config.endpoint}|${this.config.clientId}|${this.config.token ? 1 : 0}`;
  }

  traceStatus(key: string, message: string, { force = false } = {}) {
    const now = Date.now();
    const changed = key !== this.lastStatusTraceKey;
    if (!force && !changed && now - this.lastStatusTraceAt < STATUS_TRACE_MIN_INTERVAL_MS) return;
    this.lastStatusTraceKey = key;
    this.lastStatusTraceAt = now;
    this.trace(message);
  }
}

function normalizeBridgeConfig(value: unknown = {}, options: { debugMode?: boolean } = {}): BridgeConfig {
  const raw = record(value);
  const enabled = typeof raw.enabled === "boolean"
    ? raw.enabled
    : options.debugMode === true;
  return {
    enabled: enabled && Boolean(String(raw.token || "").trim()),
    endpoint: normalizeEndpoint(raw.endpoint || DEFAULT_ENDPOINT),
    clientId: String(raw.clientId || defaultClientId()).trim().slice(0, 120),
    token: String(raw.token || "").trim(),
    pollIntervalMs: normalizePositiveInteger(raw.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS, 100, 60000),
    pollTimeoutMs: normalizePositiveInteger(raw.pollTimeoutMs, DEFAULT_POLL_TIMEOUT_MS, 1000, 120000),
    requestTimeoutMs: normalizePositiveInteger(raw.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS, 1000, 10 * 60 * 1000),
    maxBatch: normalizePositiveInteger(raw.maxBatch, DEFAULT_MAX_BATCH, 1, 16),
    includeCapabilities: raw.includeCapabilities !== false,
  };
}

function normalizeEndpoint(value: unknown) {
  const text = String(value || DEFAULT_ENDPOINT).trim().replace(/\/+$/, "");
  if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(text)) return DEFAULT_ENDPOINT;
  return text;
}

function normalizePositiveInteger(value: unknown, fallback: number, min: number, max: number) {
  const number = Number(value);
  const normalized = Number.isFinite(number) ? Math.floor(number) : fallback;
  return Math.max(min, Math.min(max, normalized));
}

function normalizeTraceError(err: unknown) {
  const text = errorMessage(err || "unknown error").replace(/\s+/g, " ").trim();
  if (!text) return "unknown error";
  if (/failed to fetch|networkerror|load failed/i.test(text)) return "fetch failed";
  if (/aborted|aborterror/i.test(text)) return "request aborted";
  if (/timed out|timeout/i.test(text)) return "timeout";
  return text.slice(0, 180);
}

function defaultClientId() {
  const id = String(chrome.runtime?.id || "extension").replace(/[^a-zA-Z0-9_-]+/g, "_");
  return `qingzhou-${id || "extension"}`;
}

async function postJson(endpoint: string, path: string, body: unknown, token: string, timeoutMs: number): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${endpoint}${path}`, {
      method: "POST",
      redirect: "error",
      headers: {
        "content-type": "application/json",
        ...(token ? { "x-qingzhou-bridge-token": token } : {}),
      },
      body: JSON.stringify(body || {}),
      signal: controller.signal,
    });
    const text = await response.text().catch(() => "");
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${text.slice(0, 240)}`);
    }
    if (!text.trim()) return {};
    try {
      return record(JSON.parse(text) as unknown);
    } catch (_err) {
      throw new Error(`Invalid bridge JSON: ${text.slice(0, 240)}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Qingzhou MCP bridge request timed out after ${timeoutMs}ms`)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

function toJsonValue(value: unknown): unknown {
  if (value == null) return value;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (_err) {
    return String(value);
  }
}

function defaultTrace(message: string) {
  console.debug("[轻舟]", message);
}
