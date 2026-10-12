export interface WorkspaceView { v: number; page: string; state: unknown }
interface StorageArea { get(key: string): Promise<Record<string, unknown>>; set(value: Record<string, unknown>): Promise<unknown> }
interface BootstrapOptions { windowsApi?: { getCurrent(): Promise<{ id?: number }> }; storageArea?: StorageArea; timeoutMs?: number }

export const WORKSPACE_VIEW_VERSION = 2;

const WORKSPACE_VIEW_KEY_PREFIX = "qingzhou:workspace-view:";

export function defaultWorkspaceView(): WorkspaceView {
  return { v: WORKSPACE_VIEW_VERSION, page: "chat", state: { sessionId: null } };
}

/** The envelope is generic; each registered page validates and restores its own state. */
export function normalizeWorkspaceView(input: unknown): WorkspaceView {
  const value = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
  const page = typeof value.page === "string" ? value.page.trim() : "";
  const version = Number(value.v);
  if (![1, WORKSPACE_VIEW_VERSION].includes(version) || !page || page.length > 128) return defaultWorkspaceView();
  // Existing v1 records put page-owned fields beside the envelope. Preserve them losslessly.
  const { v: _version, page: _page, ...legacyState } = value;
  const state = version === 1 ? legacyState : value.state;
  try {
    return { v: WORKSPACE_VIEW_VERSION, page, state: state === undefined ? null : JSON.parse(JSON.stringify(state)) };
  } catch { return defaultWorkspaceView(); }
}

export async function loadWorkspaceView(storageArea: StorageArea | undefined, windowId: unknown) {
  const key = workspaceViewStorageKey(windowId);
  if (!key || !storageArea?.get) return defaultWorkspaceView();
  try {
    const stored = await storageArea.get(key);
    return normalizeWorkspaceView(stored?.[key]);
  } catch (_error) {
    return defaultWorkspaceView();
  }
}

export async function saveWorkspaceView(storageArea: StorageArea | undefined, windowId: unknown, view: unknown) {
  const key = workspaceViewStorageKey(windowId);
  if (!key || !storageArea?.set) return false;
  try {
    await storageArea.set({ [key]: normalizeWorkspaceView(view) });
    return true;
  } catch (_error) {
    return false;
  }
}

export async function loadWorkspaceBootstrap({
  windowsApi = globalThis.chrome?.windows,
  storageArea = globalThis.chrome?.storage?.session,
  timeoutMs = 300,
}: BootstrapOptions = {}) {
  const fallback = { windowId: null, view: defaultWorkspaceView() };
  if (!windowsApi?.getCurrent) return fallback;
  let currentWindow;
  try {
    currentWindow = await windowsApi.getCurrent();
  } catch (_error) {
    return fallback;
  }
  const windowId = normalizeWindowId(currentWindow?.id);
  if (windowId === null) return fallback;
  return {
    windowId,
    view: await settleBeforeTimeout(loadWorkspaceView(storageArea, windowId), defaultWorkspaceView(), timeoutMs),
  };
}

export function workspaceViewStorageKey(windowId: unknown) {
  const id = normalizeWindowId(windowId);
  return id === null ? "" : `${WORKSPACE_VIEW_KEY_PREFIX}${id}`;
}

function normalizeWindowId(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const id = Number(value);
  return Number.isInteger(id) && id >= 0 ? id : null;
}

function settleBeforeTimeout<T>(promise: Promise<T>, fallback: T, timeoutMs: number): Promise<T> {
  const delay = Math.max(0, Number(timeoutMs) || 0);
  if (!delay) return promise.catch(() => fallback);
  return new Promise<T>(resolve => {
    let settled = false;
    const finish = (value: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(fallback), delay);
    promise.then(finish, () => finish(fallback));
  });
}
