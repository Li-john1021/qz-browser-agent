import { t } from "../../shared/i18n/backend.js";
import { listDataTables } from "../../shared/data-store.js";
import { isWebTab } from "../../shared/tab-utils.js";

interface PlatformCommandsOptions<Context> {
  sessionSupervisor: { size(): number };
  getBridgeConfig(): Promise<unknown>;
  tabs?: Pick<typeof chrome.tabs, "get">;
  sendToContent(tabId: number, action: string): Promise<unknown>;
  ensureSkillToolRegistryReady?(reason: string): Promise<unknown>;
  listSkillContributions(context: Context): unknown;
  buildSkillUiContext(sessionId: string): Context | Promise<Context>;
  commitSkillRegistryChange(reason: string, change: { skillName: string; previousSkillName: string }): Promise<unknown>;
}

export function createPlatformCommands<Context>({
  sessionSupervisor,
  getBridgeConfig,
  tabs = globalThis.chrome?.tabs,
  sendToContent,
  ensureSkillToolRegistryReady = async () => {},
  listSkillContributions,
  buildSkillUiContext,
  commitSkillRegistryChange,
}: PlatformCommandsOptions<Context>) {
  async function ping() {
    return {
      ok: true,
      pong: true,
      at: Date.now(),
      sessions: sessionSupervisor.size(),
      bridge: await getBridgeConfig(),
    };
  }

  async function runElementPicker(action: string, tabId: unknown) {
    const tab = await resolveElementPickerTab(tabId);
    const result = await sendToContent(tab.id!, action);
    return {
      tabId: tab.id,
      ...(result && typeof result === "object" ? result : { result }),
    };
  }

  function startElementPicker(tabId: unknown) {
    return runElementPicker("startElementPicker", tabId);
  }

  function confirmElementPicker(tabId: unknown) {
    return runElementPicker("confirmElementPicker", tabId);
  }

  function cancelElementPicker(tabId: unknown) {
    return runElementPicker("cancelElementPicker", tabId);
  }

  async function listTables() {
    return { tables: await listDataTables() };
  }

  async function contributions(sessionId = "") {
    try {
      await ensureSkillToolRegistryReady("platform_contributions");
    } catch (_error) {
      // Core UI remains available while optional Skill discovery retries later.
    }
    return listSkillContributions(await buildSkillUiContext(sessionId));
  }

  async function refreshSkills(params: Record<string, unknown> = {}) {
    const reason = String(params.reason || "background_api");
    const skillToolRegistry = await commitSkillRegistryChange(reason, {
      skillName: String(params.skillName || ""),
      previousSkillName: String(params.previousSkillName || ""),
    });
    return { skillToolRegistry };
  }

  async function resolveElementPickerTab(tabId: unknown) {
    const id = Number(tabId);
    if (!Number.isInteger(id) || id <= 0) throw new Error(t("browser.selectPage"));
    const tab = await tabs?.get(id);
    if (!tab?.id || !isWebTab(tab)) throw new Error(t("browser.cannotSelectElement"));
    return tab;
  }

  return Object.freeze({
    ping,
    startElementPicker,
    confirmElementPicker,
    cancelElementPicker,
    listTables,
    contributions,
    refreshSkills,
  });
}
