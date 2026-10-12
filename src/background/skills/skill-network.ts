import { t } from "../../shared/i18n/backend.js";
import { base64ToBytes, bytesToBase64 } from "../../shared/bytes.js";
import {
  getSecurityGuardrails,
  matchBlockedUrl,
} from "../../shared/security-guardrails.js";

type Fields = Record<string, unknown>;
interface NetworkPolicy {
  allowedMethods?: readonly string[]; allowedOrigins?: readonly { setting?: string; origin?: string }[];
  browserManagedHeaders?: readonly string[]; maxRequestBytes?: number; maxResponseBytes?: number;
}
interface Execution { pluginId: string; skillName: string; network: NetworkPolicy; config: Fields; signal: AbortSignal | null }
interface ExecutionDescriptor {
  plugin?: { id?: string; skillName?: string; network?: NetworkPolicy };
  pluginId?: string; skillName?: string; network?: NetworkPolicy; config?: Fields; signal?: AbortSignal | null;
}
type NetworkSender = chrome.runtime.MessageSender & { documentUrl?: string };
type Dnr = Pick<typeof chrome.declarativeNetRequest, "getSessionRules" | "updateSessionRules">;
interface NetworkOptions {
  fetch?: typeof globalThis.fetch;
  declarativeNetRequest?: Dnr;
  runtime?: Pick<typeof chrome.runtime, "id" | "getURL">;
  getSecurityGuardrails?: typeof getSecurityGuardrails;
  validateSender?(sender: NetworkSender): boolean;
}
interface FetchRequest { url: string; method: string; headers: [string, string][]; bodyBase64: string }
interface ManagedHeader { name: string; value: string }
const record = (value: unknown): Fields => value && typeof value === "object" && !Array.isArray(value) ? value as Fields : {};
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

const MAX_HEADER_COUNT = 96;
const MAX_HEADER_BYTES = 64 * 1024;
const MAX_MANAGED_URL_LENGTH = 2048;
const DNR_RULE_ID_MIN = 1_930_000_000;
const DNR_RULE_ID_MAX = 1_939_999_999;
const FORBIDDEN_REQUEST_HEADERS = new Set([
  "accept-charset",
  "accept-encoding",
  "access-control-request-headers",
  "access-control-request-method",
  "connection",
  "content-length",
  "cookie",
  "cookie2",
  "dnt",
  "expect",
  "host",
  "keep-alive",
  "origin",
  "permissions-policy",
  "referer",
  "set-cookie",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "via",
  "x-http-method",
  "x-http-method-override",
  "x-method-override",
]);

export class SkillNetworkError extends Error {
  constructor(readonly code: string, message: string, public details: Fields = {}) {
    super(message);
    this.name = "SkillNetworkError";
  }
}

export function createSkillNetworkService(options: NetworkOptions = {}) {
  const fetchImpl = options.fetch || globalThis.fetch?.bind(globalThis);
  const dnr = options.declarativeNetRequest || globalThis.chrome?.declarativeNetRequest;
  const runtime = options.runtime || globalThis.chrome?.runtime;
  const getGuardrails = options.getSecurityGuardrails || getSecurityGuardrails;
  const executions = new Map<string, Execution>();
  const activeFetches = new Map<string, { requestId: string; callId: string; controller: AbortController }>();
  let managedHeaderQueue: Promise<unknown> = Promise.resolve();
  let nextRuleId = DNR_RULE_ID_MIN;
  let nextFetchSequence = 0;
  let managedHeaderCleanup = startManagedHeaderCleanup();

  if (typeof fetchImpl !== "function") throw new TypeError("Skill network service requires fetch");

  function registerExecution(requestId: unknown, descriptor: ExecutionDescriptor = {}) {
    const id = String(requestId || "").trim();
    if (!id) throw new SkillNetworkError("SKILL_NETWORK_EXECUTION_INVALID", t("skill.networkRequestIdMissing"));
    const plugin = descriptor.plugin || {};
    executions.set(id, {
      pluginId: String(plugin.id || descriptor.pluginId || ""),
      skillName: String(plugin.skillName || descriptor.skillName || ""),
      network: plugin.network || descriptor.network || {},
      config: descriptor.config && typeof descriptor.config === "object" ? { ...descriptor.config } : {},
      signal: descriptor.signal || null,
    });
    return () => {
      executions.delete(id);
      for (const active of activeFetches.values()) {
        if (active.requestId === id) active.controller.abort();
      }
    };
  }

  async function execute(message: Fields = {}, sender: NetworkSender = {}) {
    assertTrustedOffscreenSender(sender, runtime, options);
    const requestId = String(message.requestId || "").trim();
    const execution = executions.get(requestId);
    if (!execution) {
      throw new SkillNetworkError("SKILL_NETWORK_EXECUTION_EXPIRED", t("skill.networkExpired"));
    }
    if (execution.signal?.aborted) throw abortedError();

    const callId = String(message.callId || "").trim() || `legacy_${++nextFetchSequence}`;
    const fetchKey = `${requestId}\n${callId}`;
    if (activeFetches.has(fetchKey)) {
      throw new SkillNetworkError("SKILL_NETWORK_CALL_DUPLICATE", t("skill.networkDuplicateCall"), { requestId, callId });
    }
    const controller = new AbortController();
    const abortFromExecution = () => controller.abort();
    if (execution.signal) execution.signal.addEventListener("abort", abortFromExecution, { once: true });
    activeFetches.set(fetchKey, { requestId, callId, controller });

    try {
      const request = normalizeFetchRequest(message.request, execution.network);
      assertRequestAllowed(request, execution);
      const blocked = matchBlockedUrl(request.url, await getGuardrails());
      if (blocked) {
        throw new SkillNetworkError("SECURITY_GUARDRAIL_BLOCKED", t("skill.networkBlocked"), {
          pluginId: execution.pluginId,
          skillName: execution.skillName,
          host: blocked.host,
          blockedType: blocked.type,
        });
      }
      if (controller.signal.aborted) throw abortedError();

      const managedHeaders = takeManagedHeaders(request.headers, execution.network);
      const operation = async () => {
        if (managedHeaders.length) await ensureManagedHeaderCleanup();
        if (controller.signal.aborted) throw abortedError();
        return await performFetch(request, execution, managedHeaders, controller.signal);
      };
      if (!managedHeaders.length) return await operation();
      const run = managedHeaderQueue.then(operation, operation);
      managedHeaderQueue = run.catch(() => {});
      return await run;
    } finally {
      activeFetches.delete(fetchKey);
      execution.signal?.removeEventListener?.("abort", abortFromExecution);
    }
  }

  function cancel(message: Fields = {}, sender: NetworkSender = {}) {
    assertTrustedOffscreenSender(sender, runtime, options);
    const requestId = String(message.requestId || "").trim();
    const callId = String(message.callId || "").trim();
    const active = activeFetches.get(`${requestId}\n${callId}`);
    if (!active) return { cancelled: false, requestId, callId };
    active.controller.abort();
    return { cancelled: true, requestId, callId };
  }

  async function performFetch(request: FetchRequest, execution: Execution, managedHeaders: ManagedHeader[], signal: AbortSignal) {
    const headers = new Headers();
    for (const [name, value] of request.headers) {
      if (managedHeaders.some(item => item.name === name)) continue;
      headers.append(name, value);
    }
    const init: RequestInit = {
      method: request.method,
      headers,
      redirect: "error",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      signal,
    };
    if (request.bodyBase64 && !["GET", "HEAD"].includes(request.method)) {
      init.body = base64ToBytes(request.bodyBase64);
    }

    let removeRule: (() => Promise<void>) | null = null;
    let operationError: unknown = null;
    try {
      if (managedHeaders.length) removeRule = await installManagedHeaderRule(request, managedHeaders);
      const response = await fetchImpl(request.url, init);
      const contentLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(contentLength) && contentLength > Number(execution.network.maxResponseBytes)) {
        throw new SkillNetworkError("SKILL_NETWORK_RESPONSE_TOO_LARGE", t("skill.networkResponseTooLarge"), {
          maxResponseBytes: execution.network.maxResponseBytes,
        });
      }
      const bytes = await readResponseBytes(response, execution.network.maxResponseBytes);
      return {
        status: response.status,
        statusText: response.statusText,
        headers: Array.from(response.headers.entries()),
        bodyBase64: bytesToBase64(bytes),
        url: response.url || request.url,
        redirected: response.redirected === true,
      };
    } catch (error) {
      operationError = record(error).name === "AbortError" ? abortedError() : error;
      throw operationError;
    } finally {
      try {
        await removeRule?.();
      } catch (cleanupError) {
        if (operationError) {
          const fields = record(operationError);
          fields.details = {
            ...record(fields.details),
            managedHeaderCleanupFailed: true,
          };
        } else {
          throw new SkillNetworkError("SKILL_NETWORK_RULE_CLEANUP_FAILED", t("skill.networkCleanupFailed"), {
            message: errorMessage(cleanupError),
          });
        }
      }
    }
  }

  async function installManagedHeaderRule(request: FetchRequest, managedHeaders: ManagedHeader[]) {
    if (!dnr?.updateSessionRules) {
      throw new SkillNetworkError("SKILL_NETWORK_MANAGED_HEADER_UNAVAILABLE", t("skill.networkHeadersUnsupported"));
    }
    if (request.url.length > MAX_MANAGED_URL_LENGTH) {
      throw new SkillNetworkError("SKILL_NETWORK_URL_TOO_LONG", t("skill.networkManagedUrlTooLong"));
    }
    const ruleId = allocateRuleId();
    const condition: chrome.declarativeNetRequest.RuleCondition = {
      regexFilter: `^${escapeRegex(request.url)}$`,
      isUrlFilterCaseSensitive: true,
      requestMethods: [request.method.toLowerCase() as chrome.declarativeNetRequest.RequestMethod],
      resourceTypes: ["xmlhttprequest" as chrome.declarativeNetRequest.ResourceType, "other" as chrome.declarativeNetRequest.ResourceType],
    };
    const extensionId = String(runtime?.id || "").trim();
    if (extensionId) condition.initiatorDomains = [extensionId];
    await dnr.updateSessionRules({
      removeRuleIds: [ruleId],
      addRules: [{
        id: ruleId,
        priority: 10_000,
        action: {
          type: "modifyHeaders" as chrome.declarativeNetRequest.RuleActionType,
          requestHeaders: managedHeaders.map(({ name, value }) => ({
            header: canonicalHeaderName(name),
            operation: "set" as chrome.declarativeNetRequest.HeaderOperation,
            value,
          })),
        },
        condition,
      }],
    });
    return async () => {
      await dnr.updateSessionRules({ removeRuleIds: [ruleId] });
    };
  }

  function allocateRuleId() {
    const id = nextRuleId;
    nextRuleId = nextRuleId >= DNR_RULE_ID_MAX ? DNR_RULE_ID_MIN : nextRuleId + 1;
    return id;
  }

  function startManagedHeaderCleanup() {
    return removeStaleManagedHeaderRules(dnr).then(
      () => null,
      error => error,
    );
  }

  async function ensureManagedHeaderCleanup() {
    let error = await managedHeaderCleanup;
    if (error) {
      managedHeaderCleanup = startManagedHeaderCleanup();
      error = await managedHeaderCleanup;
    }
    if (!error) return;
    throw new SkillNetworkError("SKILL_NETWORK_RULE_CLEANUP_FAILED", t("skill.networkExpiredCleanupFailed"), {
      message: errorMessage(error),
    });
  }

  return Object.freeze({ registerExecution, execute, cancel });
}

async function removeStaleManagedHeaderRules(dnr: Dnr | undefined) {
  if (!dnr?.getSessionRules || !dnr?.updateSessionRules) return;
  const rules = await dnr.getSessionRules();
  const removeRuleIds = (Array.isArray(rules) ? rules : [])
    .map(rule => Number(rule?.id))
    .filter(id => Number.isInteger(id) && id >= DNR_RULE_ID_MIN && id <= DNR_RULE_ID_MAX);
  if (removeRuleIds.length) await dnr.updateSessionRules({ removeRuleIds });
}

async function readResponseBytes(response: Response, maxBytes: unknown) {
  const limit = Math.max(0, Number(maxBytes) || 0);
  const reader = response?.body?.getReader?.();
  if (!reader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    assertResponseSize(bytes.byteLength, limit);
    return bytes;
  }
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value || []);
      total += chunk.byteLength;
      if (total > limit) {
        await reader.cancel("response too large").catch(() => {});
        assertResponseSize(total, limit);
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock?.();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function assertResponseSize(actualBytes: number, maxBytes: number) {
  if (actualBytes <= maxBytes) return;
  throw new SkillNetworkError("SKILL_NETWORK_RESPONSE_TOO_LARGE", t("skill.networkResponseTooLarge"), {
    maxResponseBytes: maxBytes,
  });
}

function normalizeFetchRequest(value: unknown, network: NetworkPolicy = {}): FetchRequest {
  const input = record(value);
  let url;
  try {
    url = new URL(String(input.url || ""));
  } catch (_err) {
    throw new SkillNetworkError("SKILL_NETWORK_URL_INVALID", t("skill.fetchHttpRequired"));
  }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) {
    throw new SkillNetworkError("SKILL_NETWORK_URL_INVALID", t("skill.fetchNoCredentials"));
  }
  url.hash = "";
  const method = String(input.method || "GET").trim().toUpperCase();
  const headers = normalizeRequestHeaders(input.headers);
  const bodyBase64 = String(input.bodyBase64 || "");
  const bodyBytes = bodyBase64 ? decodedBase64Length(bodyBase64) : 0;
  const maxRequestBytes = Number(network.maxRequestBytes) || 0;
  if (bodyBytes > maxRequestBytes) {
    throw new SkillNetworkError("SKILL_NETWORK_REQUEST_TOO_LARGE", t("skill.networkBodyTooLarge"), { maxRequestBytes });
  }
  if (["GET", "HEAD"].includes(method) && bodyBase64) {
    throw new SkillNetworkError("SKILL_NETWORK_BODY_NOT_ALLOWED", t("skill.requestBodyNotAllowed", { method: String(method) }));
  }
  return { url: url.href, method, headers, bodyBase64 };
}

function normalizeRequestHeaders(value: unknown): [string, string][] {
  const input = Array.isArray(value) ? value : [];
  if (input.length > MAX_HEADER_COUNT) {
    throw new SkillNetworkError("SKILL_NETWORK_HEADERS_INVALID", t("skill.fetchTooManyHeaders"));
  }
  const out: [string, string][] = [];
  let totalBytes = 0;
  for (const row of input) {
    if (!Array.isArray(row) || row.length < 2) continue;
    const name = String(row[0] || "").trim().toLowerCase();
    const headerValue = String(row[1] ?? "");
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name) || /[\r\n\0]/.test(headerValue)) {
      throw new SkillNetworkError("SKILL_NETWORK_HEADERS_INVALID", t("skill.fetchInvalidHeaders"));
    }
    if (FORBIDDEN_REQUEST_HEADERS.has(name) || name.startsWith("proxy-") || name.startsWith("sec-")) {
      throw new SkillNetworkError("SKILL_NETWORK_HEADER_FORBIDDEN", t("skill.headerForbidden", { name: String(name) }));
    }
    totalBytes += name.length + headerValue.length;
    if (totalBytes > MAX_HEADER_BYTES) {
      throw new SkillNetworkError("SKILL_NETWORK_HEADERS_INVALID", t("skill.fetchHeadersTooLarge"));
    }
    out.push([name, headerValue]);
  }
  return out;
}

function assertRequestAllowed(request: FetchRequest, execution: Execution) {
  const allowedMethods = Array.isArray(execution.network.allowedMethods) ? execution.network.allowedMethods : [];
  if (!allowedMethods.includes(request.method)) {
    throw new SkillNetworkError("SKILL_NETWORK_METHOD_NOT_ALLOWED", t("skill.methodNotAllowed", { method: String(request.method) }), {
      pluginId: execution.pluginId,
      method: request.method,
    });
  }
  const allowedOrigins = resolveAllowedOrigins(execution.network.allowedOrigins, execution.config);
  const origin = new URL(request.url).origin;
  if (!allowedOrigins.includes(origin)) {
    throw new SkillNetworkError("SKILL_NETWORK_ORIGIN_NOT_ALLOWED", t("skill.networkOriginDenied"), {
      pluginId: execution.pluginId,
      skillName: execution.skillName,
      origin,
    });
  }
}

function resolveAllowedOrigins(declarations: NetworkPolicy["allowedOrigins"], config: Fields) {
  const origins: string[] = [];
  for (const declaration of Array.isArray(declarations) ? declarations : []) {
    const value = declaration?.setting ? config?.[declaration.setting] : declaration?.origin;
    try {
      const url = new URL(String(value || ""));
      if (/^https?:$/.test(url.protocol) && !url.username && !url.password && !origins.includes(url.origin)) {
        origins.push(url.origin);
      }
    } catch (_err) {
      // A missing dynamic origin is reported as a normal permission denial.
    }
  }
  return origins;
}

function takeManagedHeaders(headers: [string, string][], network: NetworkPolicy) {
  const allowed = new Set(Array.isArray(network.browserManagedHeaders) ? network.browserManagedHeaders : []);
  const managed = [];
  for (const [name, value] of headers) {
    if (name !== "date") continue;
    if (!allowed.has(name)) {
      throw new SkillNetworkError("SKILL_NETWORK_MANAGED_HEADER_NOT_ALLOWED", t("skill.managedHeaderUndeclared", { name: String(name) }));
    }
    managed.push({ name, value });
  }
  return managed;
}

function assertTrustedOffscreenSender(sender: NetworkSender, runtime: NetworkOptions["runtime"], options: NetworkOptions) {
  if (typeof options.validateSender === "function") {
    if (options.validateSender(sender) !== true) throw untrustedSenderError();
    return;
  }
  const expected = runtime?.getURL?.("offscreen.html") || "";
  const actual = String(sender?.url || sender?.documentUrl || "").replace(/[?#].*$/, "");
  if (!expected || actual !== expected || (runtime?.id && sender?.id !== runtime.id)) throw untrustedSenderError();
}

function untrustedSenderError() {
  return new SkillNetworkError("SKILL_NETWORK_CALLER_UNTRUSTED", t("skill.networkCallerDenied"));
}

function abortedError() {
  return new SkillNetworkError("OPERATION_ABORTED", t("skill.networkCancelled"));
}

function decodedBase64Length(value: unknown) {
  const text = String(value || "").replace(/\s/g, "");
  if (!text) return 0;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length % 4 !== 0) {
    throw new SkillNetworkError("SKILL_NETWORK_BODY_INVALID", t("skill.fetchEncodingInvalid"));
  }
  const padding = text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0;
  return (text.length / 4) * 3 - padding;
}

function canonicalHeaderName(name: string) {
  return String(name || "").split("-").map(part => part ? `${part[0].toUpperCase()}${part.slice(1)}` : "").join("-");
}

function escapeRegex(value: unknown) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
