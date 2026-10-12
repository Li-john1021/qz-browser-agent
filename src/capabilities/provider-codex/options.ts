import type { ProviderModelOption } from "#sdk/shared/settings";
import { normalizeProviderModelOptions } from "#sdk/shared/models";
export const modelOptions = [{
  key: "codexReasoningEffort", label: "Reasoning", defaultValue: "medium",
  options: Object.entries({
    low: "Low", medium: "Medium",
    high: "High", xhigh: "Extra High", max: "Max",
  }).map(([value, label]) => ({ value, label })),
}] satisfies readonly ProviderModelOption[];
export const normalizeCodexReasoningEffort = (value: unknown) => normalizeProviderModelOptions({ codexReasoningEffort: value }, modelOptions).codexReasoningEffort;
