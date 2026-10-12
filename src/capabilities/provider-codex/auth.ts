import { t } from "./i18n.js";
import type { CodexAuthStatus, CodexDeviceLogin, CodexLoginPoll } from "#sdk/shared/settings";
import { normalizeHeaderToken } from "#sdk/background/providers";
export { normalizeHeaderToken } from "#sdk/background/providers";
export { OPENAI_CODEX_DEFAULT_BASE_URL, resolveCodexEndpoint, resolveCodexModelsEndpoint } from "./endpoints.js";
import { nowBeijingDateTime } from "#sdk/shared/format";

interface CodexToken { access: string; refresh: string; expires: number }
interface CodexStoredAuth extends CodexToken { accountId: string; updatedAt?: string }
interface DeviceLogin { deviceAuthId: string; userCode: string; intervalSeconds: number; expiresAt: number }
interface ResolvedAuth { token: string; accountId: string }
interface HeaderOptions { headers?: Record<string, string>; sessionId?: string }

const OPENAI_CODEX_AUTH_STORAGE_KEY = "openaiCodexAuth";
const OPENAI_CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const OPENAI_CODEX_AUTH_BASE_URL = "https://auth.openai.com";
const OPENAI_CODEX_TOKEN_URL = `${OPENAI_CODEX_AUTH_BASE_URL}/oauth/token`;
const OPENAI_CODEX_DEVICE_USER_CODE_URL = `${OPENAI_CODEX_AUTH_BASE_URL}/api/accounts/deviceauth/usercode`;
const OPENAI_CODEX_DEVICE_TOKEN_URL = `${OPENAI_CODEX_AUTH_BASE_URL}/api/accounts/deviceauth/token`;
const OPENAI_CODEX_DEVICE_VERIFICATION_URI = `${OPENAI_CODEX_AUTH_BASE_URL}/codex/device`;
const OPENAI_CODEX_DEVICE_REDIRECT_URI = `${OPENAI_CODEX_AUTH_BASE_URL}/deviceauth/callback`;
const OPENAI_CODEX_JWT_CLAIM_PATH = "https://api.openai.com/auth";
const OPENAI_CODEX_TOKEN_REFRESH_SKEW_MS = 10 * 60 * 1000;
const OPENAI_CODEX_DEVICE_CODE_TIMEOUT_MS = 15 * 60 * 1000;
const OPENAI_CODEX_ORIGINATOR = "qingzhou";
const PROVIDER_BASE_HEADERS = { "x-app": "cli" };
const pendingCodexDeviceLogins = new Map<string, DeviceLogin>();
let authEpoch = 0;

export async function getCodexAuthStatus(signal?: AbortSignal): Promise<CodexAuthStatus> {
  const epoch = authEpoch;
  let auth = await readCodexAuth();
  if (epoch !== authEpoch) return { loggedIn: false };
  if (!auth?.access && !auth?.refresh) {
    return { loggedIn: false, accountId: "", expiresAt: 0, expired: false };
  }
  let refreshError = "";
  try {
    auth = await refreshCodexAuthIfNeeded(auth, signal, epoch);
  } catch (err) {
    if (epoch !== authEpoch) return { loggedIn: false };
    refreshError = err instanceof Error ? err.message : String(err);
  }
  const expiresAt = Number(auth.expires || 0);
  return {
    loggedIn: Boolean(auth.access || auth.refresh),
    accountId: maskCodexAccountId(auth.accountId || ""),
    expiresAt,
    expired: expiresAt > 0 && expiresAt <= Date.now(),
    hasRefreshToken: Boolean(auth.refresh),
    refreshError,
  };
}

export async function clearCodexAuth() {
  authEpoch += 1;
  pendingCodexDeviceLogins.clear();
  await chrome.storage.local.remove(OPENAI_CODEX_AUTH_STORAGE_KEY);
  return getCodexAuthStatus();
}

export async function startCodexDeviceLogin(signal?: AbortSignal): Promise<CodexDeviceLogin> {
  signal?.throwIfAborted();
  const epoch = ++authEpoch;
  pendingCodexDeviceLogins.clear();
  const response = await fetch(OPENAI_CODEX_DEVICE_USER_CODE_URL, {
    method: "POST", signal,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: OPENAI_CODEX_CLIENT_ID }),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`OpenAI Codex device login failed (${response.status}): ${text.slice(0, 300)}`);
  }

  let data: Record<string, unknown>;
  try {
    data = record(JSON.parse(text));
  } catch (_err) {
    throw new Error("OpenAI Codex device login returned non-JSON response");
  }

  const deviceAuthId = String(data.device_auth_id || "").trim();
  const userCode = String(data.user_code || "").trim();
  const intervalSeconds = Math.max(1, Number(data.interval || 5));
  if (!deviceAuthId || !userCode || !Number.isFinite(intervalSeconds)) {
    throw new Error(`Invalid OpenAI Codex device login response: ${text.slice(0, 300)}`);
  }

  assertCurrentAuth(epoch, signal);
  const loginId = createCodexLoginId();
  const expiresAt = Date.now() + OPENAI_CODEX_DEVICE_CODE_TIMEOUT_MS;
  pendingCodexDeviceLogins.set(loginId, {
    deviceAuthId,
    userCode,
    intervalSeconds,
    expiresAt,
  });

  return {
    loginId,
    userCode,
    verificationUri: OPENAI_CODEX_DEVICE_VERIFICATION_URI,
    intervalSeconds,
    expiresAt,
  };
}

export async function pollCodexDeviceLogin(loginId: unknown, signal?: AbortSignal): Promise<CodexLoginPoll> {
  const epoch = authEpoch;
  const id = String(loginId || "").trim();
  const pending = pendingCodexDeviceLogins.get(id);
  if (!pending) return { status: "expired", message: t("theLoginSessionExpiredStartCodexLoginAgain") };
  if (Date.now() > pending.expiresAt) {
    pendingCodexDeviceLogins.delete(id);
    return { status: "expired", message: t("theCodexLoginCodeExpiredStartLoginAgain") };
  }

  try {
    signal?.throwIfAborted();
    const response = await fetch(OPENAI_CODEX_DEVICE_TOKEN_URL, {
      method: "POST", signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        device_auth_id: pending.deviceAuthId,
        user_code: pending.userCode,
      }),
    });
    const text = await response.text();

    if (response.ok) {
      let data: Record<string, unknown>;
      try {
        data = record(JSON.parse(text));
      } catch (_err) {
        throw new Error("OpenAI Codex device token response was non-JSON");
      }
      const authorizationCode = String(data.authorization_code || "").trim();
      const codeVerifier = String(data.code_verifier || "").trim();
      if (!authorizationCode || !codeVerifier) {
        throw new Error(`Invalid OpenAI Codex device token response: ${text.slice(0, 300)}`);
      }
      const token = await exchangeCodexAuthorizationCode(authorizationCode, codeVerifier, OPENAI_CODEX_DEVICE_REDIRECT_URI, signal);
      const auth = await saveCodexToken(token, epoch, signal);
      pendingCodexDeviceLogins.delete(id);
      return { status: "complete", authStatus: await getCodexAuthStatus(), accountId: maskCodexAccountId(auth.accountId) };
    }

    assertCurrentAuth(epoch, signal);
    const errorCode = parseCodexDeviceErrorCode(text);
    if (response.status === 403 || response.status === 404 || errorCode === "deviceauth_authorization_pending") {
      return { status: "pending", intervalSeconds: pending.intervalSeconds };
    }
    if (errorCode === "slow_down") {
      pending.intervalSeconds = Math.min(30, pending.intervalSeconds + 5);
      return { status: "slow_down", intervalSeconds: pending.intervalSeconds };
    }

    throw new Error(`OpenAI Codex device login failed (${response.status}): ${text.slice(0, 300)}`);
  } catch (error) {
    pendingCodexDeviceLogins.delete(id);
    throw error;
  }
}

export async function resolveCodexAuth(signal?: AbortSignal) {
  const epoch = authEpoch;
  signal?.throwIfAborted();
  let auth = await readCodexAuth();
  assertCurrentAuth(epoch, signal);
  if (!auth?.access && !auth?.refresh) {
    throw new Error(t("signInToOpenaiCodexInSettingsFirst"));
  }

  auth = await refreshCodexAuthIfNeeded(auth, signal, epoch);

  assertCurrentAuth(epoch, signal);
  if (!auth?.access) throw new Error(t("openaiCodexLoginIsMissingAnAccessTokenSign"));
  const accountId = auth.accountId || extractCodexAccountId(auth.access);
  if (!auth.accountId && accountId) {
    await chrome.storage.local.set({ [OPENAI_CODEX_AUTH_STORAGE_KEY]: { ...auth, accountId } });
  }
  return { token: auth.access, accountId, source: "stored" };
}

export function buildCodexHeaders(auth: ResolvedAuth, options: HeaderOptions = {}) {
  const headers: Record<string, string> = {
    ...PROVIDER_BASE_HEADERS,
    ...(options.headers || {}),
    "Authorization": `Bearer ${auth.token}`,
    "chatgpt-account-id": auth.accountId,
    "originator": OPENAI_CODEX_ORIGINATOR,
    "OpenAI-Beta": "responses=experimental",
    "accept": "text/event-stream",
    "content-type": "application/json",
  };
  const sessionId = normalizeHeaderToken(options.sessionId);
  if (sessionId) {
    headers["session-id"] = sessionId;
    headers["x-client-request-id"] = sessionId;
  }
  return headers;
}

export function buildCodexModelListHeaders(auth: ResolvedAuth, options: HeaderOptions = {}) {
  return {
    ...PROVIDER_BASE_HEADERS,
    ...(options.headers || {}),
    "Authorization": `Bearer ${auth.token}`,
    "chatgpt-account-id": auth.accountId,
    "originator": OPENAI_CODEX_ORIGINATOR,
    "OpenAI-Beta": "responses=experimental",
    "accept": "application/json",
  };
}

export function formatCodexHttpError(status: number, text = "") {
  const body = String(text || "").slice(0, 500);
  if (status === 401 || status === 403) {
    return t("openaiCodexLoginExpiredOrLacksPermissionSignIn", { status: String(status), detail: String(body ? ` ${body}` : "") });
  }
  return `OpenAI Codex API ${status}: ${body}`;
}

async function refreshCodexAuthIfNeeded(auth: CodexStoredAuth, signal?: AbortSignal, epoch = authEpoch) {
  assertCurrentAuth(epoch, signal);
  const expires = Number(auth?.expires || 0);
  const shouldRefresh = (!auth?.access || (expires && expires <= Date.now() + OPENAI_CODEX_TOKEN_REFRESH_SKEW_MS)) && auth?.refresh;
  if (!shouldRefresh) return auth;
  return saveCodexToken(await refreshCodexAccessToken(auth.refresh, signal), epoch, signal);
}

async function readCodexAuth() {
  const { [OPENAI_CODEX_AUTH_STORAGE_KEY]: auth = null } = await chrome.storage.local.get(OPENAI_CODEX_AUTH_STORAGE_KEY);
  if (!auth || typeof auth !== 'object' || Array.isArray(auth)) return null;
  const stored = record(auth);
  return {
    access: typeof stored.access === 'string' ? stored.access : '',
    refresh: typeof stored.refresh === 'string' ? stored.refresh : '',
    expires: Number(stored.expires) || 0,
    accountId: typeof stored.accountId === 'string' ? stored.accountId : '',
  };
}

async function saveCodexToken(token: CodexToken, epoch: number, signal?: AbortSignal) {
  assertCurrentAuth(epoch, signal);
  const accountId = extractCodexAccountId(token.access);
  const auth = {
    access: token.access,
    refresh: token.refresh,
    expires: token.expires,
    accountId,
    updatedAt: nowBeijingDateTime(),
  };
  await chrome.storage.local.set({ [OPENAI_CODEX_AUTH_STORAGE_KEY]: auth });
  return auth;
}

async function exchangeCodexAuthorizationCode(code: string, verifier: string, redirectUri: string, signal?: AbortSignal) {
  const response = await fetch(OPENAI_CODEX_TOKEN_URL, {
    method: "POST", signal,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: OPENAI_CODEX_CLIENT_ID,
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
    }),
  });
  return readCodexTokenResponse(response, "exchange");
}

async function refreshCodexAccessToken(refreshToken: string, signal?: AbortSignal) {
  const response = await fetch(OPENAI_CODEX_TOKEN_URL, {
    method: "POST", signal,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: OPENAI_CODEX_CLIENT_ID,
    }),
  });
  return readCodexTokenResponse(response, "refresh");
}

async function readCodexTokenResponse(response: Response, operation: string): Promise<CodexToken> {
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`OpenAI Codex token ${operation} failed (${response.status}): ${text.slice(0, 300)}`);
  }
  let data: Record<string, unknown>;
  try {
    data = record(JSON.parse(text));
  } catch (_err) {
    throw new Error(`OpenAI Codex token ${operation} returned non-JSON response`);
  }
  const access = String(data.access_token || "").trim();
  const refresh = String(data.refresh_token || "").trim();
  const expiresIn = Number(data.expires_in);
  if (!access || !refresh || !Number.isFinite(expiresIn)) {
    throw new Error(`OpenAI Codex token ${operation} response missing fields: ${text.slice(0, 300)}`);
  }
  return {
    access,
    refresh,
    expires: Date.now() + expiresIn * 1000,
  };
}

function extractCodexAccountId(token: string) {
  const payload = decodeJwtPayload(token);
  const accountId = record(payload?.[OPENAI_CODEX_JWT_CLAIM_PATH]).chatgpt_account_id;
  if (!accountId) throw new Error(t("couldNotReadTheChatgptAccountIdFromThe"));
  return String(accountId);
}

function decodeJwtPayload(token: unknown) {
  try {
    const [, payload] = String(token || "").split(".");
    if (!payload) return null;
    const json = base64UrlDecode(payload);
    return record(JSON.parse(json));
  } catch (_err) {
    return null;
  }
}

function base64UrlDecode(value: unknown) {
  const raw = String(value || "");
  const padded = raw.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(raw.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function parseCodexDeviceErrorCode(text: string) {
  try {
    const data = record(JSON.parse(String(text || "{}")));
    const error = data?.error;
    if (typeof error === "string") return error;
    if (error && typeof error === "object") return String(record(error).code || record(error).type || "");
  } catch (_err) {}
  return "";
}

function createCodexLoginId() {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  return `codex_login_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function maskCodexAccountId(accountId: unknown) {
  const value = String(accountId || "");
  if (value.length <= 10) return value;
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function assertCurrentAuth(epoch: number, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (epoch !== authEpoch) throw new DOMException(t("loginCanceledStartAgain"), "AbortError");
}
