import { t } from "../../shared/i18n/backend.js";
import { normalizeMcpHeaders } from "../../shared/skills/skill-manifest.js";
import { ToolExecutionError } from "../tools/arguments.js";
type Fields = Record<string, unknown>;
export interface McpServerInput extends Fields { id?: string; name?: string; url?: string; pluginId?: string; headers?: unknown; enabled?: boolean; timeoutMs?: number; timeout?: number; callTimeoutMs?: number }
interface McpOptions { signal?: AbortSignal | null; timeout?: number }
type McpTool = NonNullable<ReturnType<typeof normalizeMcpTool>>;
interface McpState {
  key: string; server: ReturnType<typeof normalizeMcpServer>; connected: boolean; client: Client | null; transport: StreamableHTTPClientTransport | null;
  tools: McpTool[] | null; toolsListedAt: number; toolsConfigHash: string; serverInfo: Fields; serverCapabilities: Fields;
  connectPromise: Promise<ConnectedMcpState> | null;
  toolsReady: boolean; toolsPromise: Promise<McpTool[]> | null;
}
type ConnectedMcpState = McpState & { client: Client };
interface MetadataCache { version: number; entries: Record<string, unknown> }
interface MetadataError { section: string; code: unknown; message: unknown }
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { getMcpSdk } from "#mcp-sdk";

const DEFAULT_MCP_TIMEOUT_MS = 30000;
const MCP_SESSION_NOT_FOUND_STATUS = 404;
const MCP_METADATA_CACHE_STORAGE_KEY = "_qingzhou_mcp_metadata_cache_v1";
const MCP_METADATA_CACHE_VERSION = 1;
const MCP_METADATA_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MCP_METADATA_CACHE_MAX_ENTRIES = 200;

const clientStateByKey = new Map<string, McpState>();
let memoryMetadataCache: MetadataCache | null = null;

export function mcpServerCacheKey(server: McpServerInput = {}) {
  return [
    String(server.pluginId || ""),
    String(server.id || server.name || "default"),
    String(server.url || ""),
  ].join("::");
}

export function mcpServerResult(server: McpServerInput = {}) {
  const headers = server.headers && typeof server.headers === "object" && !Array.isArray(server.headers)
    ? server.headers
    : {};
  return {
    id: String(server.id || server.name || "default"),
    name: String(server.name || server.id || "default"),
    type: "mcp",
    transport: "http",
    url: String(server.url || ""),
    enabled: server.enabled !== false,
    timeoutMs: normalizeMcpTimeout(server.timeoutMs ?? server.timeout),
    headers: { ...headers },
    headerNames: Object.keys(headers),
  };
}

export async function listMcpServerTools(server: McpServerInput = {}, { refresh = false, signal = null }: { refresh?: boolean; signal?: AbortSignal | null } = {}) {
  const normalized = normalizeMcpServer(server);
  const state = getOrCreateMcpServerState(normalized);
  const configHash = mcpServerConfigHash(normalized);
  if (!refresh) {
    if (Array.isArray(state.tools) && state.toolsConfigHash === configHash && !isExpiredCacheTime(state.toolsListedAt)) {
      return state.tools;
    }
    const cached = await readMcpToolsCache(normalized, { configHash });
    if (cached) {
      state.tools = cached.tools;
      state.toolsListedAt = cached.cachedAt;
      state.toolsConfigHash = cached.configHash;
      state.serverInfo = cached.serverInfo || state.serverInfo || {};
      state.serverCapabilities = cached.serverCapabilities || state.serverCapabilities || {};
      return state.tools;
    }
  }
  return await withMcpSessionRetry(normalized, signal, state => loadMcpTools(state, { refresh: true, signal }));
}

export async function callMcpServerTool(server: McpServerInput = {}, toolName = "", args: unknown = {}, { signal = null }: McpOptions = {}) {
  const normalized = normalizeMcpServer(server);
  const name = String(toolName || "").trim();
  if (!name) {
    const err = new ToolExecutionError("MCP_TOOL_NAME_REQUIRED", "MCP tool name is required");
    throw err;
  }
  const result = await withMcpSessionRetry(normalized, signal, async (state) => {
    await loadMcpTools(state, { signal });
    assertCurrentMcpState(state);
    return await state.client.callTool({
      name,
      arguments: record(args),
    }, undefined, {
      signal: signal ?? undefined,
      timeout: normalizeMcpTimeout(normalized.callTimeoutMs ?? normalized.timeoutMs),
    });
  });
  return normalizeMcpToolResult(result, { server: normalized, toolName: name });
}

export async function inspectMcpServer(server: McpServerInput = {}, {
  refresh = false,
  signal = null,
  includeResources = false,
  includePrompts = false,
  limit = 100,
}: { refresh?: boolean; signal?: AbortSignal | null; includeResources?: boolean; includePrompts?: boolean; limit?: number } = {}) {
  const normalized = normalizeMcpServer(server);
  const tools = await listMcpServerTools(normalized, { refresh, signal });
  const state = getOrCreateMcpServerState(normalized);
  const maxItems = finitePositiveInteger(limit) || 100;
  const out: { server: ReturnType<typeof mcpServerResult>; tools: McpTool[]; errors: MetadataError[]; resources?: unknown; prompts?: unknown } & Fields = {
    ok: true,
    server: mcpServerResult(normalized),
    cacheKey: mcpServerCacheKey(normalized),
    configHash: mcpServerConfigHash(normalized),
    cachedAt: state.toolsListedAt || 0,
    serverInfo: state.serverInfo || {},
    capabilities: state.serverCapabilities || {},
    tools: tools.slice(0, maxItems),
    toolCount: tools.length,
    truncated: tools.length > maxItems,
    errors: [],
  };

  if (includeResources || includePrompts) {
    const connected = await ensureMcpServerConnected(normalized, { signal });
    if (includeResources) {
      const resources = await collectMcpMetadata(connected, "resources", async () => {
        if (!connected.client.getServerCapabilities?.()?.resources) return { skipped: true, reason: "capability_not_advertised" };
        const listed = await connected.client.listResources({}, { signal: signal ?? undefined, timeout: normalizeMcpTimeout(normalized.timeoutMs) });
        const templates = await connected.client.listResourceTemplates({}, { signal: signal ?? undefined, timeout: normalizeMcpTimeout(normalized.timeoutMs) })
          .catch(err => ({ error: normalizeMcpSdkError(err) }));
        return { listed, templates };
      });
      if (resources.error) out.errors.push(resources.error);
      else out.resources = summarizeMcpResources(resources.value, maxItems);
    }
    if (includePrompts) {
      const prompts = await collectMcpMetadata(connected, "prompts", async () => {
        if (!connected.client.getServerCapabilities?.()?.prompts) return { skipped: true, reason: "capability_not_advertised" };
        return await connected.client.listPrompts({}, { signal: signal ?? undefined, timeout: normalizeMcpTimeout(normalized.timeoutMs) });
      });
      if (prompts.error) out.errors.push(prompts.error);
      else out.prompts = summarizeMcpPrompts(prompts.value, maxItems);
    }
  }
  return out;
}

export function resetMcpServerState(server: McpServerInput = {}) {
  void closeMcpServerState(clientStateByKey.get(mcpServerCacheKey(normalizeMcpServer(server))));
}

async function withMcpSessionRetry<T>(server: McpServerInput, signal: AbortSignal | null, operation: (state: ConnectedMcpState) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    let state: ConnectedMcpState | undefined;
    try {
      state = await ensureMcpServerConnected(server, { signal });
      const result = await operation(state);
      assertCurrentMcpState(state);
      return result;
    } catch (err) {
      if (attempt > 0 || !isMcpSessionNotFoundError(err)) throw normalizeMcpSdkError(err);
      await closeMcpServerState(state);
    }
  }
}

async function loadMcpTools(state: ConnectedMcpState, { refresh = false, signal = null }: { refresh?: boolean; signal?: AbortSignal | null } = {}): Promise<McpTool[]> {
  assertCurrentMcpState(state);
  if (state.toolsPromise) return await state.toolsPromise;
  if (state.toolsReady && !refresh) return state.tools || [];
  // A persisted catalog cannot initialize a new SDK Client's output validators.
  state.toolsReady = false;
  state.toolsPromise = (async () => {
    const result = await state.client.listTools({}, {
      signal: signal ?? undefined,
      timeout: normalizeMcpTimeout(state.server.timeoutMs),
    });
    assertCurrentMcpState(state);
    state.tools = result.tools.map(normalizeMcpTool).filter(tool => tool !== null);
    state.toolsListedAt = Date.now();
    state.toolsConfigHash = mcpServerConfigHash(state.server);
    await writeMcpToolsCache(state);
    assertCurrentMcpState(state);
    state.toolsReady = true;
    return state.tools;
  })().catch(async err => {
    // SDK schema compilation can fail after clearing validators; abort in-flight calls too.
    await closeMcpServerState(state);
    throw err;
  }).finally(() => { state.toolsPromise = null; });
  return await state.toolsPromise;
}

function assertCurrentMcpState(state: McpState) {
  if (clientStateByKey.get(state.key) !== state) throw new ToolExecutionError("MCP_CONNECTION_CLOSED", t("mcp.closed"));
}

async function ensureMcpServerConnected(server: McpServerInput = {}, { signal = null }: McpOptions = {}): Promise<ConnectedMcpState> {
  const normalized = normalizeMcpServer(server);
  if (normalized.enabled === false) {
    const err = new ToolExecutionError("MCP_SERVER_DISABLED", `MCP server is disabled: ${normalized.id}`);
    throw err;
  }
  let state = getOrCreateMcpServerState(normalized);
  if (state.connected && state.client) {
    state.server = normalized;
    return state as ConnectedMcpState;
  }
  if (state?.connectPromise) return await state.connectPromise;
  state.connectPromise = connectMcpState(state, { signal }).finally(() => {
    state.connectPromise = null;
  });
  return await state.connectPromise;
}

function getOrCreateMcpServerState(server: McpServerInput = {}): McpState {
  const normalized = normalizeMcpServer(server);
  const key = mcpServerCacheKey(normalized);
  let state = clientStateByKey.get(key);
  if (!state) {
    state = {
      key,
      server: normalized,
      connected: false,
      client: null,
      transport: null,
      tools: null,
      toolsListedAt: 0,
      toolsConfigHash: "",
      serverInfo: {},
      serverCapabilities: {},
      connectPromise: null,
      toolsReady: false,
      toolsPromise: null,
    };
    clientStateByKey.set(key, state);
  } else {
    state.server = normalized;
  }
  return state;
}

async function connectMcpState(state: McpState, { signal = null }: McpOptions = {}): Promise<ConnectedMcpState> {
  const { Client, StreamableHTTPClientTransport, CfWorkerJsonSchemaValidator } = getMcpSdk();
  const server = state.server;
  const transport = new StreamableHTTPClientTransport(new URL(server.url), {
    requestInit: {
      headers: server.headers,
    },
  });
  const client: Client = new Client({
    name: "qz-browser-agent",
    version: "0.2.9",
  }, {
    // MV3 forbids Ajv's generated functions; keep output validation without runtime code generation.
    jsonSchemaValidator: new CfWorkerJsonSchemaValidator({ draft: "7", shortcircuit: false }),
  });
  state.transport = transport;
  state.client = client;
  try {
    await client.connect(transport, {
      signal: signal ?? undefined,
      timeout: normalizeMcpTimeout(server.timeoutMs),
    });
    assertCurrentMcpState(state);
    state.connected = true;
    state.serverInfo = client.getServerVersion?.() || {};
    state.serverCapabilities = client.getServerCapabilities?.() || {};
    return state as ConnectedMcpState;
  } catch (err) {
    await closeMcpServerState(state);
    throw normalizeMcpSdkError(err);
  }
}

async function closeMcpServerState(state?: McpState) {
  if (!state) return;
  if (clientStateByKey.get(state.key) === state) clientStateByKey.delete(state.key);
  state.toolsReady = false;
  try {
    await state.client?.close();
  } catch (_err) {
    // Closing a broken transport is best-effort.
  }
}

function normalizeMcpServer(server: McpServerInput = {}) {
  const url = normalizeMcpUrl(server.url);
  if (!url) {
    const err = new ToolExecutionError("MCP_SERVER_URL_INVALID", "MCP server url is required and must be http(s)");
    throw err;
  }
  return {
    ...server,
    id: String(server.id || server.name || "default").trim() || "default",
    name: String(server.name || server.id || "default").trim() || "default",
    transport: "http",
    url,
    enabled: server.enabled !== false,
    headers: normalizeMcpHeaders(server.headers),
    timeoutMs: normalizeMcpTimeout(server.timeoutMs ?? server.timeout),
    callTimeoutMs: normalizeOptionalMcpTimeout(server.callTimeoutMs),
  };
}

function normalizeMcpUrl(value = "") {
  try {
    const url = new URL(String(value || "").trim());
    if (!/^https?:$/i.test(url.protocol)) return "";
    url.hash = "";
    return url.href;
  } catch (_err) {
    return "";
  }
}

function normalizeMcpTimeout(value: unknown) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MCP_TIMEOUT_MS;
  return Math.max(1000, Math.min(10 * 60 * 1000, Math.floor(n)));
}

function finitePositiveInteger(value: unknown) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

function normalizeOptionalMcpTimeout(value: unknown) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.max(1000, Math.min(10 * 60 * 1000, Math.floor(n)));
}

function normalizeMcpTool(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const tool = record(value);
  const name = String(tool.name || "").trim();
  if (!name) return null;
  return {
    name,
    title: String(tool.title || record(tool.annotations).title || name).trim() || name,
    description: String(tool.description || "").trim(),
    inputSchema: normalizeInputSchema(tool.inputSchema),
    ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
    ...(tool.execution ? { execution: tool.execution } : {}),
    annotations: tool.annotations && typeof tool.annotations === "object" && !Array.isArray(tool.annotations)
      ? { ...tool.annotations }
      : {},
  };
}

function normalizeInputSchema(value: unknown = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { type: "object", properties: {} };
  const schema = record(value);
  return {
    ...schema,
    type: "object",
    properties: schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)
      ? schema.properties
      : {},
  };
}

function normalizeMcpToolResult(value: unknown = {}, { server = {}, toolName = "" }: { server?: McpServerInput; toolName?: string } = {}) {
  const result = record(value);
  const content = Array.isArray(result?.content) ? result.content : [];
  const text = content
    .filter(item => item?.type === "text" && typeof item.text === "string")
    .map(item => item.text)
    .join("\n");
  return {
    ok: result?.isError !== true,
    isError: result?.isError === true,
    server: String(server.id || server.name || ""),
    tool: toolName,
    content,
    ...(text ? { text } : {}),
    ...(result?.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}),
    ...(result && typeof result === "object" && !Array.isArray(result) ? { raw: result } : {}),
  };
}

async function readMcpToolsCache(server: McpServerInput = {}, { configHash = "" } = {}) {
  const cache = await readMcpMetadataCache();
  const entry = record(cache.entries[mcpServerCacheKey(server)]);
  if (!entry || entry.version !== MCP_METADATA_CACHE_VERSION) return null;
  if (entry.configHash !== configHash) return null;
  if (isExpiredCacheTime(entry.cachedAt)) return null;
  const tools = Array.isArray(entry.tools) ? entry.tools.map(normalizeMcpTool).filter(tool => tool !== null) : [];
  return {
    ...entry,
    tools,
    cachedAt: Number(entry.cachedAt),
    configHash: String(entry.configHash),
    serverInfo: record(entry.serverInfo),
    serverCapabilities: record(entry.serverCapabilities),
  };
}

async function writeMcpToolsCache(state: McpState) {
  const cache = await readMcpMetadataCache();
  assertCurrentMcpState(state);
  cache.entries[state.key] = {
    version: MCP_METADATA_CACHE_VERSION,
    configHash: state.toolsConfigHash,
    cachedAt: state.toolsListedAt,
    tools: state.tools,
    serverInfo: sanitizeCacheObject(state.serverInfo),
    serverCapabilities: sanitizeCacheObject(state.serverCapabilities),
  };
  pruneMcpMetadataCache(cache);
  await writeMcpMetadataCache(cache);
}

async function readMcpMetadataCache(): Promise<MetadataCache> {
  if (memoryMetadataCache) return memoryMetadataCache;
  const fallback: MetadataCache = { version: MCP_METADATA_CACHE_VERSION, entries: {} };
  try {
    const storage = globalThis.chrome?.storage?.local;
    if (!storage?.get) {
      memoryMetadataCache = fallback;
      return memoryMetadataCache;
    }
    const data = await storage.get(MCP_METADATA_CACHE_STORAGE_KEY);
    const raw = record(data?.[MCP_METADATA_CACHE_STORAGE_KEY]);
    memoryMetadataCache = raw && typeof raw === "object" && !Array.isArray(raw)
      ? {
        version: MCP_METADATA_CACHE_VERSION,
        entries: record(raw.entries),
      }
      : fallback;
    pruneMcpMetadataCache(memoryMetadataCache);
    return memoryMetadataCache;
  } catch (_err) {
    memoryMetadataCache = fallback;
    return memoryMetadataCache;
  }
}

async function writeMcpMetadataCache(cache: MetadataCache) {
  memoryMetadataCache = {
    version: MCP_METADATA_CACHE_VERSION,
    entries: cache.entries && typeof cache.entries === "object" && !Array.isArray(cache.entries) ? cache.entries : {},
  };
  try {
    const storage = globalThis.chrome?.storage?.local;
    if (!storage?.set) return;
    await storage.set({ [MCP_METADATA_CACHE_STORAGE_KEY]: memoryMetadataCache });
  } catch (_err) {
    // Metadata cache is an optimization; MCP calls should not fail because storage is unavailable.
  }
}

function pruneMcpMetadataCache(cache: MetadataCache) {
  const entries = cache.entries && typeof cache.entries === "object" && !Array.isArray(cache.entries) ? cache.entries : {};
  for (const [key, entry] of Object.entries(entries)) {
    if (!entry || record(entry).version !== MCP_METADATA_CACHE_VERSION || isExpiredCacheTime(record(entry).cachedAt)) delete entries[key];
  }
  const ordered = Object.entries(entries)
    .sort((a, b) => Number(record(b[1]).cachedAt || 0) - Number(record(a[1]).cachedAt || 0));
  for (const [key] of ordered.slice(MCP_METADATA_CACHE_MAX_ENTRIES)) delete entries[key];
  cache.entries = entries;
}

function isExpiredCacheTime(value: unknown) {
  const time = Number(value);
  return !Number.isFinite(time) || time <= 0 || Date.now() - time > MCP_METADATA_CACHE_MAX_AGE_MS;
}

function mcpServerConfigHash(server: McpServerInput = {}) {
  const relevant = {
    id: server.id,
    name: server.name,
    transport: "http",
    url: server.url,
    enabled: server.enabled !== false,
    headers: server.headers || {},
    timeoutMs: server.timeoutMs,
    callTimeoutMs: server.callTimeoutMs,
  };
  return hashString(stableStringify(relevant));
}

function stableStringify(value: unknown): string | undefined {
  if (value == null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(record(value)[key])}`).join(",")}}`;
}

function hashString(value = "") {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function sanitizeCacheObject(value: unknown): Fields {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  try {
    return record(JSON.parse(JSON.stringify(value)));
  } catch (_err) {
    return {};
  }
}

async function collectMcpMetadata(_state: McpState, label: string, fn: () => Promise<unknown>): Promise<{ value: unknown; error?: never } | { error: MetadataError; value?: never }> {
  try {
    return { value: await fn() };
  } catch (err) {
    const normalized = record(normalizeMcpSdkError(err));
    return {
      error: {
        section: label,
        code: normalized?.code || "",
        message: normalized?.message || String(err),
      },
    };
  }
}

function summarizeMcpResources(input: unknown = {}, limit = 100) {
  const value = record(input);
  if (value?.skipped) return value;
  const resources = Array.isArray(record(value.listed).resources) ? (record(value.listed).resources as unknown[]) : [];
  const templates = Array.isArray(record(value.templates).resourceTemplates) ? (record(value.templates).resourceTemplates as unknown[]) : [];
  const templateError = record(value.templates).error;
  return {
    resources: resources.slice(0, limit).map(normalizeMcpResource).filter(Boolean),
    resourceCount: resources.length,
    resourceTemplates: templates.slice(0, limit).map(normalizeMcpResourceTemplate).filter(Boolean),
    resourceTemplateCount: templates.length,
    truncated: resources.length > limit || templates.length > limit,
    ...(templateError ? { templateError: { code: record(templateError).code || "", message: record(templateError).message || String(templateError) } } : {}),
  };
}

function summarizeMcpPrompts(input: unknown = {}, limit = 100) {
  const value = record(input);
  if (value?.skipped) return value;
  const prompts = Array.isArray(value?.prompts) ? value.prompts : [];
  return {
    prompts: prompts.slice(0, limit).map(normalizeMcpPrompt).filter(Boolean),
    promptCount: prompts.length,
    truncated: prompts.length > limit,
  };
}

function normalizeMcpResource(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const resource = record(value);
  const uri = String(resource.uri || "").trim();
  if (!uri) return null;
  return {
    uri,
    name: String(resource.name || uri).trim() || uri,
    description: String(resource.description || "").trim(),
    mimeType: String(resource.mimeType || "").trim(),
  };
}

function normalizeMcpResourceTemplate(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const template = record(value);
  const uriTemplate = String(template.uriTemplate || "").trim();
  if (!uriTemplate) return null;
  return {
    uriTemplate,
    name: String(template.name || uriTemplate).trim() || uriTemplate,
    description: String(template.description || "").trim(),
    mimeType: String(template.mimeType || "").trim(),
  };
}

function normalizeMcpPrompt(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const prompt = record(value);
  const name = String(prompt.name || "").trim();
  if (!name) return null;
  return {
    name,
    title: String(prompt.title || prompt.name || "").trim(),
    description: String(prompt.description || "").trim(),
    arguments: Array.isArray(prompt.arguments) ? prompt.arguments : [],
  };
}

function isMcpSessionNotFoundError(error: unknown) {
  const err = record(error);
  return Number(err?.status ?? err?.code) === MCP_SESSION_NOT_FOUND_STATUS
    || /\b404\b/.test(String(err?.message || ""));
}

function normalizeMcpSdkError(value: unknown) {
  if (!value || typeof value !== "object") return value;
  const err = record(value);
  if (err.code && typeof err.code === "string") return err;
  const next = Object.assign(new Error(String(err.message || value)), {
    name: String(err.name || "McpSdkError"),
    code: Number.isFinite(Number(err.code)) ? `MCP_${Number(err.code)}` : (err.code || "MCP_SDK_ERROR"),
    status: Number.isFinite(Number(err.code)) ? Number(err.code) : err.status,
    details: err.details || err.data,
  });
  return next;
}

function record(value: unknown): Fields { return value && typeof value === "object" && !Array.isArray(value) ? value as Fields : {}; }
