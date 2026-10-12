import { t } from "./i18n.js";
import { defineToolMetadata as toolMeta } from "#sdk/shared/metadata";
import type { CapabilityMetadata } from "#sdk/shared/metadata";

const tools = () => Object.freeze({
  manage_settings: toolMeta(t("manageModelSettings"), ["settings"], { shortTitle: t("manageModelSettingsShort"), profileFamily: "settings", resultFamily: "settings", familyId: "settings", labelerId: "settings", titleRule: { field: "action", normalize: "lowercase", values: { reorder: t("reorderSecurityPoliciesShort"), get: t("readSettingsShort") }, fallback: "action" } }),
  manage_guardrails: toolMeta(t("manageSecurityGuardrails"), ["settings"], { shortTitle: t("manageSecurityGuardrailsShort"), profileFamily: "settings", resultFamily: "settings", familyId: "settings", labelerId: "settings", titleRule: { field: "action", normalize: "lowercase", values: { reorder: t("reorderSecurityPoliciesShort"), get: t("readSecurityPoliciesShort") }, fallback: "action" } }),
});

const actionLabels = () => Object.freeze({
  list_models: t("listModels"),
  apply_preset: t("applyModelPresetShort"),
  delete_preset: t("deleteModelPresetShort"),
  add_rule: t("addAccessRuleShort"),
  remove_rule: t("removeAccessRuleShort"),
  add_rate_limit: t("addSiteRateLimitShort"),
  remove_rate_limit: t("removeSiteRateLimitShort"),
  reorder: t("reorder"),
  update_config: t("updateModelSettingsShort"),
});

export default { get actionLabels() { return actionLabels(); }, get tools() { return tools(); } } satisfies CapabilityMetadata;


