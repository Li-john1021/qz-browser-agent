import { modelT } from "./model-messages.js";
import { createSkillHostResources } from "#sdk/shared/skill-definition";
import { MODEL_PARAMETER_SUGGESTIONS } from "#sdk/shared/models";

const MODEL_PARAMETER_SUGGESTION_GUIDE = MODEL_PARAMETER_SUGGESTIONS
  .map(({ key, values }) => `- \`${key}\`: ${values.map(value => `\`${value}\``).join(", ")}`)
  .join("\n");

export const BUILTIN_QINGZHOU_MANAGEMENT_SKILL_NAME = "qingzhou-management";
export const getBuiltinQingzhouManagementDisplayName = () => (modelT("managementDisplayName"));
export const getBuiltinQingzhouManagementDescription = () => (modelT("managementDescription"));

export const getQingzhouManageSettingsToolDescription = () => (modelT("manageSettings"));

export const QINGZHOU_MANAGE_SETTINGS_TOOL_PARAMETERS = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["get", "list_models", "update_config", "apply_preset", "delete_preset"],
      get description() { return modelT("settingsAction"); },
    },
    provider: { type: "string", get description() { return modelT("settingsProvider"); } },
    model: { type: "string", get description() { return modelT("settingsModel"); } },
    modelParameters: {
      type: "object",
      get description() { return modelT("settingsModelParameters"); },
      additionalProperties: true,
    },
    apiKey: { type: "string", get description() { return modelT("settingsApiKey"); } },
    presetId: { type: "string", get description() { return modelT("settingsPresetId"); } },
    codexReasoningEffort: {
      type: "string",
      enum: ["low", "medium", "high", "xhigh", "max"],
      get description() { return modelT("settingsReasoningEffort"); },
    },
    customProtocol: { type: "string", enum: ["openai", "anthropic"], get description() { return modelT("settingsCustomProtocol"); } },
    customEndpoint: { type: "string", get description() { return modelT("settingsCustomEndpoint"); } },
    customPresetName: { type: "string", get description() { return modelT("settingsCustomPresetName"); } },
    endpoint: { type: "string", get description() { return modelT("settingsEndpointAlias"); } },
    contextWindow: { type: "number", minimum: 1, get description() { return modelT("settingsContextWindow"); } },
    trimOldToolResults: { type: "boolean", get description() { return modelT("settingsTrimResults"); } },
    vision: { type: "boolean", get description() { return modelT("settingsVision"); } },
    requestRateLimit: { type: "boolean", get description() { return modelT("settingsRateLimit"); } },
    debugMode: { type: "boolean", get description() { return modelT("settingsDebugMode"); } },
    includeProviders: { type: "boolean", get description() { return modelT("settingsIncludeProviders"); } },
    limit: { type: "number", get description() { return modelT("settingsModelLimit"); } },
  },
  required: ["action"],
} as const;

export const getQingzhouManageGuardrailsToolDescription = () => (modelT("manageGuardrails"));

export const QINGZHOU_MANAGE_GUARDRAILS_TOOL_PARAMETERS = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["get", "add_rule", "remove_rule", "add_rate_limit", "remove_rate_limit", "reorder"],
      get description() { return modelT("guardrailAction"); },
    },
    id: { type: "string", get description() { return modelT("guardrailId"); } },
    ruleAction: { type: "string", enum: ["block", "allow"], get description() { return modelT("guardrailRuleAction"); } },
    targetType: { type: "string", enum: ["domain", "pattern"], get description() { return modelT("guardrailTargetType"); } },
    target: { type: "string", get description() { return modelT("guardrailTarget"); } },
    minOpenIntervalSeconds: { type: "number", get description() { return modelT("guardrailInterval"); } },
    enabled: { type: "boolean", get description() { return modelT("guardrailEnabled"); } },
    order: { type: "array", items: { type: "string" }, get description() { return modelT("guardrailOrder"); } },
  },
  required: ["action"],
} as const;

export const getQingzhouManageSkillSettingsToolDescription = () => (modelT("manageSkillSettings"));

export const QINGZHOU_MANAGE_SKILL_SETTINGS_TOOL_PARAMETERS = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["list", "get", "update"],
      get description() { return modelT("skillSettingsAction"); },
    },
    settingId: {
      type: "string",
      get description() { return modelT("skillSettingId"); },
    },
    values: {
      type: "object",
      get description() { return modelT("skillSettingValues"); },
    },
  },
  required: ["action"],
} as const;

export const getBuiltinQingzhouManagementContent = () => (modelT("builtinContent", { MODEL_PARAMETER_SUGGESTION_GUIDE }));

export const getBuiltinQingzhouManagementResources = () => (createSkillHostResources({
  id: "qingzhou-management",
  get displayName() { return getBuiltinQingzhouManagementDisplayName(); },
  version: "0.2.0",
  get description() { return getBuiltinQingzhouManagementDescription(); },
  category: { id: "meta", get label() { return modelT("managementCategory"); } },
  tools: {
    manage_settings: { get description() { return getQingzhouManageSettingsToolDescription(); }, parameters: QINGZHOU_MANAGE_SETTINGS_TOOL_PARAMETERS },
    manage_guardrails: { get description() { return getQingzhouManageGuardrailsToolDescription(); }, parameters: QINGZHOU_MANAGE_GUARDRAILS_TOOL_PARAMETERS },
    manage_skill_settings: { get description() { return getQingzhouManageSkillSettingsToolDescription(); }, parameters: QINGZHOU_MANAGE_SKILL_SETTINGS_TOOL_PARAMETERS },
  },
  get manifestTitle() { return modelT("managementManifestTitle"); },
  get manifestDescription() { return modelT("managementManifestDescription"); },
  get scriptDescription() { return modelT("managementScriptDescription"); },
}));

export default {
  aliases: ["轻舟管理", "Qingzhou settings", "qz settings"],
  name: BUILTIN_QINGZHOU_MANAGEMENT_SKILL_NAME, get displayName() { return getBuiltinQingzhouManagementDisplayName(); },
  get description() { return getBuiltinQingzhouManagementDescription(); }, get content() { return getBuiltinQingzhouManagementContent(); },
  get resources() { return getBuiltinQingzhouManagementResources(); }, order: 2,
};
