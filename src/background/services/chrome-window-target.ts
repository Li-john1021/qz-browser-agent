import { t } from "../../shared/i18n/backend.js";
interface WindowTargetOptions {
  tabs?: Pick<typeof chrome.tabs, "get">;
  windows?: Pick<typeof chrome.windows, "get" | "getLastFocused">;
}
export interface NewTabTarget { anchorTabId?: number | null; sourceWindowId?: number | null }
export function createChromeWindowTarget({
  tabs = globalThis.chrome?.tabs,
  windows = globalThis.chrome?.windows,
}: WindowTargetOptions = {}) {
  async function resolveForNewTab({ anchorTabId = null, sourceWindowId = null }: NewTabTarget = {}) {
    const anchorWindowId = await windowIdForTab(anchorTabId);
    if (anchorWindowId !== null && await isNormalWindow(anchorWindowId)) return anchorWindowId;

    const sourceId = normalizeWindowId(sourceWindowId);
    if (sourceId !== null && await isNormalWindow(sourceId)) return sourceId;

    const lastFocused = await getLastFocusedNormalWindow();
    const lastFocusedId = normalizeWindowId(lastFocused?.id);
    if (lastFocusedId !== null && isNormalWindowRecord(lastFocused)) return lastFocusedId;

    const error = Object.assign(new Error(t("browser.noWindow")), { code: "NO_NORMAL_BROWSER_WINDOW" });
    throw error;
  }

  async function windowIdForTab(tabId: unknown) {
    const id = Number(tabId);
    if (!Number.isInteger(id) || id <= 0 || typeof tabs?.get !== "function") return null;
    try {
      return normalizeWindowId((await tabs.get(id))?.windowId);
    } catch (_error) {
      return null;
    }
  }

  async function isNormalWindow(windowId: number) {
    if (typeof windows?.get !== "function") return false;
    try {
      return isNormalWindowRecord(await windows.get(windowId));
    } catch (_error) {
      return false;
    }
  }

  async function getLastFocusedNormalWindow() {
    if (typeof windows?.getLastFocused !== "function") return null;
    try {
      return await windows.getLastFocused({ windowTypes: ["normal"] });
    } catch (_error) {
      return null;
    }
  }

  return Object.freeze({ resolveForNewTab });
}

function normalizeWindowId(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const id = Number(value);
  return Number.isInteger(id) && id >= 0 ? id : null;
}

function isNormalWindowRecord(window: chrome.windows.Window | null) {
  return normalizeWindowId(window?.id) !== null && window?.type === "normal";
}
