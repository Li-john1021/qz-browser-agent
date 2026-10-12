import { t } from "./i18n.js";
import * as presentation from "#sdk/sidepanel/presentation";
import { record, type ToolEvent } from "#sdk/sidepanel/presentation";
import type { ToolPresentationDefinition } from "#sdk/sidepanel";
type Data = Record<string, unknown>;

import { formatToolActionTitle } from "#sdk/shared/catalog";
import { toolKey } from "#sdk/sidepanel/presentation";
export function settingsActionLabel(action: unknown = "", toolOrName: ToolEvent | string = "manage_settings") {
  return formatToolActionTitle(toolOrName, { action: String(action || "").trim().toLowerCase() });
}

export function settingsTargetSummary(args: Data = {}, toolName: unknown = "") {
  const action = String(args.action || "").trim().toLowerCase();
  if (toolKey(toolName) === "manage_skill_settings") {
    if (action === "list") return t("skillConfiguration");
    if (action === "get" || action === "update") return args.settingId || t("skillConfiguration");
  }
  if (action === "update_config") {
    return [
      args.provider,
      args.model,
      args.requestRateLimit === true ? t("requestRateLimitingOn") : "",
      args.requestRateLimit === false ? t("requestRateLimitingOff") : "",
      args.debugMode === true ? t("debuggingOn") : "",
      args.debugMode === false ? t("debuggingOff") : "",
    ].filter(Boolean).join(" · ");
  }
  if (action === "list_models") return args.provider ? t("providerWithName", { provider: String(args.provider) }) : t("modelList");
  if (action === "apply_preset" || action === "delete_preset") return args.presetId || args.activePresetId || args.id || t("modelPreset");
  if (action === "add_rule" || action === "remove_rule") {
    return [
      settingsGuardrailActionLabel(args.ruleAction || (action === "add_rule" ? "block" : "")),
      settingsGuardrailTypeLabel(args.targetType),
      args.target || args.id,
    ].filter(Boolean).join(" · ");
  }
  if (action === "add_rate_limit" || action === "remove_rate_limit") {
    return [
      settingsGuardrailTypeLabel(args.targetType),
      args.target || args.id,
      args.minOpenIntervalSeconds != null ? `${args.minOpenIntervalSeconds}s` : "",
    ].filter(Boolean).join(" · ");
  }
  if (action === "reorder") {
    const count = Array.isArray(args.order) ? args.order.length : 0;
    return count ? t("policies", { count: String(count) }) : t("securityPolicies");
  }
  if (action === "get") return toolKey(toolName) === "manage_guardrails" ? t("securityPolicies") : t("currentSettings");
  return "";
}

export function settingsGuardrailTypeLabel(type: unknown = "") {
  const key = String(type || "").trim().toLowerCase();
  if (key === "domain") return t("domain");
  if (key === "pattern") return t("urlPattern");
  return key;
}

export function settingsGuardrailActionLabel(action: unknown = "") {
  const key = String(action || "block").trim().toLowerCase();
  if (key === "block") return t("block");
  if (key === "allow") return t("allow");
  return key;
}

export function formatSettingsArgsPreview(args: Record<string, unknown> = {}, rawText = "", toolName: ToolEvent | string = "manage_settings") {
  const coreToolName = toolKey(toolName) || "manage_settings";
  const action = settingsActionLabel(args.action, toolName);
  const target = settingsTargetSummary(args, coreToolName);
  if (target) return `(${action} · ${presentation.summarizeValue(target, 72)})`;
  return rawText ? t("argumentCharacters", { action: String(action), count: String(rawText.length) }) : `(${action})`;
}

export const presentations: readonly ToolPresentationDefinition[] = [{ id: "settings", argsSummary: ({ name, args, rawArgsText }) => formatSettingsArgsPreview(args, rawArgsText, name) }];
