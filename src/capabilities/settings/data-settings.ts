import { t } from "./i18n.js";
import { formatDurationMsForUi } from "#sdk/sidepanel/components";
import * as settingsPresentation from "./presentation.js";
import * as presentation from "#sdk/sidepanel/presentation";
import { appendHtmlSection } from "#sdk/sidepanel/dom";
import { record } from "#sdk/sidepanel/presentation";
import type { ToolView } from "#sdk/sidepanel";
import type { createDataTableRenderer } from "#sdk/sidepanel/components";

type Data = Record<string, unknown>;
type TableRenderer = ReturnType<typeof createDataTableRenderer>["appendRowsTable"];
type TableOptions = NonNullable<Parameters<TableRenderer>[3]>;

import { escapeHtml } from "#sdk/sidepanel/dom";

export function createSettingsProfiles(appendDataRowsTable: TableRenderer) {
function appendPreparingSettingsProfile(parent: HTMLElement, tool: ToolView, status: ToolView["status"]) {
  const args = tool.args && typeof tool.args === "object" ? tool.args : {};
  presentation.appendCompactLine(parent, {
    title: `${status.title} · ${settingsPresentation.settingsActionLabel(args.action, tool)}`,
    subtitle: settingsPresentation.settingsTargetSummary(args, tool.name) || t("qingzhouSettings"),
    meta: [
      args.provider ? t("providerWithName", { provider: String(args.provider) }) : "",
      args.model ? t("modelWithName", { model: String(args.model) }) : "",
      args.targetType ? t("rule", { rule: String(settingsPresentation.settingsGuardrailTypeLabel(args.targetType)) }) : "",
      tool.rawArgsText ? t("characters", { count: String(tool.rawArgsText.length) }) : "",
    ].filter(Boolean),
  });
  presentation.appendCompactParams(parent, tool.name, args);
  return true;
}

function appendSettingsProfile(parent: HTMLElement, tool: ToolView, value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const result = record(value);
  const args = tool?.args && typeof tool.args === "object" ? tool.args : {};
  const action = String(result.action || args.action || "").trim().toLowerCase();
  presentation.appendCompactLine(parent, {
    title: settingsPresentation.settingsActionLabel(action, tool),
    subtitle: settingsResultSubtitle(args, result),
    meta: settingsResultMeta(args, result),
  });

  if (result.config && typeof result.config === "object" && !Array.isArray(result.config)) {
    presentation.appendKeyValueSection(parent, t("currentModelSettings"), settingsConfigDisplay(record(result.config)), { compact: false });
  }

  if (Array.isArray(result.settings)) {
    if (result.settings.length) {
      presentation.appendSlimList(parent, t("skillConfiguration"), result.settings.map(record), setting => ({
        title: setting?.title || setting?.skillDisplayName || setting?.skillName || "Skill",
        subtitle: setting?.skillDisplayName || setting?.skillName || setting?.id || "",
        meta: [
          setting?.configured === true ? t("configured") : t("needsSetup"),
          Array.isArray(setting?.missing) && setting.missing.length ? t("missingFields", { count: String(setting.missing.length) }) : "",
          setting?.updatedAt || "",
        ].filter(Boolean),
      }));
    } else {
      presentation.appendNoteSection(parent, t("skillConfiguration"), t("noSkillsNeedConfiguration"));
    }
  }

  if (result.setting && typeof result.setting === "object" && !Array.isArray(result.setting)) {
    appendSkillSetting(parent, record(result.setting));
  }

  if (Array.isArray(result.models) && result.models.length) {
    presentation.appendSlimList(parent, t("modelList"), result.models.map(record), item => ({
      title: item.label || item.name || item.id || t("model"),
      subtitle: item.ownedBy || item.owned_by || item.meta || "",
      meta: [item.contextWindow ? `${item.contextWindow} context` : "", item.releaseDate || item.release_date].filter(Boolean),
    }));
  }

  const guardrails = result.securityGuardrails;
  if (guardrails && typeof guardrails === "object" && !Array.isArray(guardrails)) {
    appendSettingsGuardrails(parent, record(guardrails));
  }

  return true;
}

function settingsConfigDisplay(config: Data = {}) {
  return {
    provider: config.providerLabel
      ? `${config.providerLabel}${config.provider ? ` (${config.provider})` : ""}`
      : config.provider,
    model: config.modelLabel || config.model,
    modelParameters: config.modelParameters,
    endpoint: config.endpoint,
    apiKey: config.apiKey,
    providerApiKeys: config.providerApiKeys,
    contextWindow: config.contextWindow,
    vision: config.vision === true ? t("imageSupport") : t("text"),
    trimOldToolResults: config.trimOldToolResults === false ? t("off") : t("on"),
    requestRateLimit: config.requestRateLimit === true ? t("on") : t("off"),
    debugMode: config.debugMode === true ? t("on") : t("off"),
    hasApiKey: config.hasApiKey === true ? t("saved") : t("notSaved"),
    activePresetId: config.activePresetId,
  };
}

function settingsResultSubtitle(args: Data = {}, result: Data = {}) {
  if (result.setting) {
    const setting = record(result.setting);
    return setting.title || setting.skillDisplayName || setting.skillName || setting.id || t("skillConfiguration");
  }
  if (Array.isArray(result.settings)) return t("skillCount", { count: String(result.count ?? result.settings.length) });
  if (result.config) {
    const config = record(result.config);
    return [
      config.providerLabel || config.provider,
      config.modelLabel || config.model,
    ].filter(Boolean).join(" · ") || t("modelSettings");
  }
  if (Array.isArray(result.models)) {
    return [result.providerLabel || result.provider, t("models", { count: String(result.count ?? result.models.length) })].filter(Boolean).join(" · ");
  }
  if (result.rule) return settingsGuardrailRuleTitle(record(result.rule));
  if (result.rateLimit) return settingsSiteOpenRateLimitTitle(record(result.rateLimit));
  if (result.target) return [settingsPresentation.settingsGuardrailTypeLabel(record(result.target).type), record(result.target).value].filter(Boolean).join(" · ");
  if (result.securityGuardrails) return t("securityPolicies");
  return settingsPresentation.settingsTargetSummary(args) || result.message || t("qingzhouSettings");
}

function settingsResultMeta(args: Data = {}, result: Data = {}) {
  const guardrails = result.securityGuardrails && typeof result.securityGuardrails === "object" && !Array.isArray(result.securityGuardrails)
    ? record(result.securityGuardrails)
    : null;
  return [
    result.saved === true ? t("saved") : "",
    result.existed === true ? t("alreadyExists") : "",
    result.removed != null ? t("removed", { count: String(result.removed) }) : "",
    result.truncated ? t("showingFirst", { count: String(result.limit) }) : "",
    record(result.config).hasApiKey === true ? t("apiKeySaved") : "",
    Array.isArray(result.changedFields) && result.changedFields.length ? t("updatedFields", { count: String(result.changedFields.length) }) : "",
    Array.isArray(result.order) ? t("orderedPolicies", { count: String(result.order.length) }) : "",
    guardrails ? t("accessRules", { count: String((Array.isArray(guardrails.rules) ? guardrails.rules.length : 0)) }) : "",
    guardrails ? t("rateLimits", { count: String((Array.isArray(guardrails.siteOpenRateLimits) ? guardrails.siteOpenRateLimits.length : 0)) }) : "",
    args.requestRateLimit === true ? t("requestRateLimitingOn") : "",
    args.requestRateLimit === false ? t("requestRateLimitingOff") : "",
    args.debugMode === true || record(result.config).debugMode === true ? t("debuggingOn") : "",
  ].filter(Boolean);
}

function appendSkillSetting(parent: HTMLElement, setting: Data = {}) {
  const fields = Array.isArray(setting.fields) ? setting.fields : [];
  const display: Data = {};
  for (const value of fields) {
    const field = record(value);
    const label = String(field.label || field.key || t("field"));
    if (field?.type === "secret") {
      display[label] = field.hasValue === true ? t("configured") : t("notConfigured");
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(field || {}, "value")) {
      display[label] = skillSettingDisplayValue(field.value, field);
    }
  }
  if (Object.keys(display).length) {
    presentation.appendKeyValueSection(parent, setting.title || t("skillConfiguration"), display, { compact: false });
  } else {
    presentation.appendNoteSection(parent, setting.title || t("skillConfiguration"), setting.description || t("thisSkillHasNoCurrentValuesToDisplay"));
  }
}

function skillSettingDisplayValue(value: unknown, field: Data = {}) {
  if (field.type === "boolean") return value === true ? t("on") : t("off");
  if (field.type === "select") {
    const option = (Array.isArray(field.options) ? field.options : []).map(record).find(item => item.value === value);
    return option?.label || value;
  }
  return value;
}

function appendSettingsGuardrails(parent: HTMLElement, guardrails: Data = {}) {
  const rules = Array.isArray(guardrails.rules) ? guardrails.rules.map(record) : [];
  const siteOpenRateLimits = Array.isArray(guardrails.siteOpenRateLimits) ? guardrails.siteOpenRateLimits.map(record) : [];
  if (rules.length) {
    presentation.appendSlimList(parent, t("securityGuardrails"), rules, rule => ({
      title: settingsGuardrailRuleTitle(rule),
      subtitle: rule.value || rule.domain || rule.pattern || "",
      meta: [settingsPresentation.settingsGuardrailActionLabel(rule.action), settingsPresentation.settingsGuardrailTypeLabel(rule.type), rule.createdAt].filter(Boolean),
    }));
  }
  if (siteOpenRateLimits.length) {
    presentation.appendSlimList(parent, t("pageNavigationRateLimits"), siteOpenRateLimits, item => ({
      title: settingsSiteOpenRateLimitTitle(item),
      subtitle: item.value || item.domain || item.pattern || "",
      meta: [settingsPresentation.settingsGuardrailTypeLabel(item.type), item.enabled === false ? t("disabled") : t("enabled"), item.updatedAt || item.createdAt].filter(Boolean),
    }));
  }
  if (!rules.length && !siteOpenRateLimits.length) presentation.appendNoteSection(parent, t("securityGuardrails"), t("noSecurityGuardrailRules"));
}

function settingsGuardrailRuleTitle(rule: Data = {}) {
  const action = settingsPresentation.settingsGuardrailActionLabel(rule.action);
  const type = settingsPresentation.settingsGuardrailTypeLabel(rule.type);
  const value = rule.value || rule.domain || rule.pattern || "";
  return [action, type, value].filter(Boolean).join(" · ");
}

function settingsSiteOpenRateLimitTitle(item: Data = {}) {
  const type = settingsPresentation.settingsGuardrailTypeLabel(item.type);
  const value = item.value || item.domain || item.pattern || "";
  const interval = Number(item.minOpenIntervalMs || 0);
  return [t("pageNavigationRateLimits"), type, value, interval ? formatDurationMsForUi(interval) : ""].filter(Boolean).join(" · ");
}

  return { renderPreparingSettings: appendPreparingSettingsProfile, renderSettings: appendSettingsProfile, formatDuration: formatDurationMsForUi };
}
