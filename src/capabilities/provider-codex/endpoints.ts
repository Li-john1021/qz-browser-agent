export const OPENAI_CODEX_DEFAULT_BASE_URL = "https://chatgpt.com/backend-api";
const OPENAI_CODEX_CLIENT_VERSION = "0.0.0";

export function resolveCodexEndpoint(baseUrl: unknown) {
  const raw = String(baseUrl || OPENAI_CODEX_DEFAULT_BASE_URL).trim();
  try {
    const url = new URL(raw);
    const path = url.pathname.replace(/\/+$/, "");
    if (path.endsWith("/codex/responses")) url.pathname = path;
    else if (path.endsWith("/codex")) url.pathname = `${path}/responses`;
    else url.pathname = `${path}/codex/responses`.replace(/\/{2,}/g, "/");
    return withCodexClientVersion(url.href);
  } catch(_e) {
    const endpoint = String(raw || OPENAI_CODEX_DEFAULT_BASE_URL).replace(/\/+$/, "");
    if (endpoint.endsWith("/codex/responses")) return withCodexClientVersion(endpoint);
    if (endpoint.endsWith("/codex")) return withCodexClientVersion(`${endpoint}/responses`);
    return withCodexClientVersion(`${endpoint}/codex/responses`);
  }
}

export function resolveCodexModelsEndpoint(baseUrl: unknown) {
  const raw = String(baseUrl || OPENAI_CODEX_DEFAULT_BASE_URL).trim();
  try {
    const url = new URL(raw);
    const path = url.pathname.replace(/\/+$/, "");
    if (path.endsWith("/codex/models")) url.pathname = path;
    else if (path.endsWith("/codex/responses")) url.pathname = path.replace(/\/responses$/, "/models");
    else if (path.endsWith("/codex")) url.pathname = `${path}/models`;
    else url.pathname = `${path}/codex/models`.replace(/\/{2,}/g, "/");
    return withCodexClientVersion(url.href);
  } catch(_e) {
    const endpoint = String(raw || OPENAI_CODEX_DEFAULT_BASE_URL).replace(/\/+$/, "");
    if (endpoint.endsWith("/codex/models")) return withCodexClientVersion(endpoint);
    if (endpoint.endsWith("/codex/responses")) return withCodexClientVersion(`${endpoint.replace(/\/responses$/, "")}/models`);
    if (endpoint.endsWith("/codex")) return withCodexClientVersion(`${endpoint}/models`);
    return withCodexClientVersion(`${endpoint}/codex/models`);
  }
}

function withCodexClientVersion(endpoint: string) {
  try {
    const url = new URL(endpoint);
    if (!url.searchParams.has("client_version")) {
      url.searchParams.set("client_version", OPENAI_CODEX_CLIENT_VERSION);
    }
    return url.href;
  } catch(_e) {
    const separator = String(endpoint || "").includes("?") ? "&" : "?";
    return `${endpoint}${separator}client_version=${encodeURIComponent(OPENAI_CODEX_CLIENT_VERSION)}`;
  }
}

