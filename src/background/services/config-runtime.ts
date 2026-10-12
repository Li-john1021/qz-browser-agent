import type { RuntimeConfig } from "../../sdk/background/providers.js";
import type { CustomProviderProtocol } from "../../shared/contracts/settings.js";
interface ConfigRuntimeOptions {
  listCustomProtocols?(): readonly CustomProviderProtocol[];
  getConfig(): Promise<RuntimeConfig>;
  saveConfig(config: Record<string, unknown>): Promise<RuntimeConfig>;
  saveModelPreset(preset: Record<string, unknown>): Promise<RuntimeConfig>;
  applyModelPreset(presetId: string): Promise<RuntimeConfig>;
  deleteModelPreset(presetId: string): Promise<RuntimeConfig>;
  clearProviderAuth(provider: string): Promise<unknown>;
  getSecurityGuardrails: typeof import("../../shared/security-guardrails.js").getSecurityGuardrails;
  saveSecurityGuardrails: typeof import("../../shared/security-guardrails.js").saveSecurityGuardrails;
  getCurrentRuntimeConfig(): Promise<RuntimeConfig>;
  setCurrentRuntimeConfig(config: RuntimeConfig): unknown;
  clearContextUsage?(): Promise<unknown>;
}
/** Keeps persisted model settings and the in-memory run snapshot in lockstep. */
export function createConfigRuntime({
  listCustomProtocols,
  getConfig,
  saveConfig,
  saveModelPreset,
  applyModelPreset,
  deleteModelPreset,
  clearProviderAuth,
  getSecurityGuardrails,
  saveSecurityGuardrails,
  getCurrentRuntimeConfig,
  setCurrentRuntimeConfig,
  clearContextUsage = async () => {},
}: ConfigRuntimeOptions) {
  async function get() {
    const [config, securityGuardrails] = await Promise.all([
      getConfig(),
      getSecurityGuardrails(),
    ]);
    return updateRuntimeConfig({ ...config, securityGuardrails });
  }

  async function save(inputConfig: Record<string, unknown> = {}) {
    const writesGuardrails = Object.prototype.hasOwnProperty.call(inputConfig, "securityGuardrails");
    const config = await saveConfig(inputConfig);
    config.securityGuardrails = writesGuardrails
      ? await saveSecurityGuardrails(inputConfig.securityGuardrails)
      : await getSecurityGuardrails();
    return updateRuntimeConfig(config, { clearUsage: true });
  }

  function setRuntime(config: RuntimeConfig = {}) {
    setCurrentRuntimeConfig(config);
    return getCurrentRuntimeConfig();
  }

  async function savePreset(preset: Record<string, unknown> = {}) {
    return updateRuntimeConfig(await saveModelPreset(preset), { clearUsage: true });
  }

  async function applyPreset(presetId: string) {
    return updateRuntimeConfig(await applyModelPreset(presetId), { clearUsage: true });
  }

  async function deletePreset(presetId: string) {
    return updateRuntimeConfig(await deleteModelPreset(presetId));
  }

  async function logoutProvider(provider: string) {
    const authStatus = await clearProviderAuth(provider);
    return { authStatus, config: await refresh() };
  }

  async function refresh() {
    return updateRuntimeConfig(await getConfig(), { clearUsage: true });
  }

  async function updateRuntimeConfig(config: RuntimeConfig, { clearUsage = false } = {}) {
    const complete = listCustomProtocols ? { ...config, customProtocols: listCustomProtocols() } : config;
    setCurrentRuntimeConfig(complete);
    if (clearUsage) await clearContextUsage();
    return complete;
  }

  return Object.freeze({
    get,
    save,
    getRuntime: getCurrentRuntimeConfig,
    setRuntime,
    savePreset,
    applyPreset,
    deletePreset,
    logoutProvider,
    refresh,
  });
}
