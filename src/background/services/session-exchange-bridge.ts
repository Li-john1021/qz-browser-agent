import { t } from "../../shared/i18n/backend.js";
import { isAllowedSessionExchangeLocation } from "../../shared/session/session-exchange-source.js";
import { normalizeSessionExchangePayload } from "../../shared/session/session-exchange.js";

type Fields = Record<string, unknown>;
interface SessionExchangeBridgeOptions {
  sidePanel?: Pick<typeof chrome.sidePanel, "open">;
  importSessionExchange(payload: ReturnType<typeof normalizeSessionExchangePayload>, options: { sourceWindowId?: number }): Promise<{ session?: Fields | null; ownedTabsRestore?: unknown; [key: string]: unknown }>;
  channel: { hasPorts(): boolean; broadcast(event: Fields): unknown; remember(key: string, event: Fields): unknown };
  logger?: Pick<Console, "debug">;
}
const errorMessage = (error: unknown) => error instanceof Error ? error.message : error;

export function createSessionExchangeBridge({
  sidePanel = globalThis.chrome?.sidePanel,
  importSessionExchange,
  channel,
  logger = console,
}: SessionExchangeBridgeOptions) {
  async function importFromPage(message: Fields = {}, sender: chrome.runtime.MessageSender = {}) {
    if (!isAllowedSessionExportSource(sender?.tab?.url)) {
      const error = Object.assign(new Error(t("exchange.sourceDenied")), { code: "SESSION_EXPORT_SOURCE_NOT_ALLOWED" });
      throw error;
    }
    const payload = normalizeSessionExchangePayload(message.payload);
    openSidePanel(sender?.tab?.windowId).catch(error => {
      logger.debug?.("[轻舟] open side panel for exported session failed:", errorMessage(error));
    });
    const result = await importSessionExchange(payload, {
      sourceWindowId: sender?.tab?.windowId,
    });
    const event = {
      type: "session_imported_from_export",
      sessionId: String(result.session?.id || ""),
      session: result.session,
      ownedTabsRestore: result.ownedTabsRestore || null,
      sourceTabId: Number(sender?.tab?.id) || null,
    };
    if (channel.hasPorts()) channel.broadcast(event);
    else channel.remember("session_export_import", event);
    return result;
  }

  async function openSidePanel(windowId: unknown) {
    const id = Number(windowId);
    if (!Number.isInteger(id) || id < 0 || !sidePanel?.open) return false;
    await sidePanel.open({ windowId: id });
    return true;
  }

  return Object.freeze({
    importFromPage,
    openSidePanel,
  });
}

export function isAllowedSessionExportSource(value: unknown) {
  let url;
  try {
    url = new URL(String(value || ""));
  } catch (_error) {
    return false;
  }
  return isAllowedSessionExchangeLocation(url);
}
