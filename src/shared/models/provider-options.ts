import type { ProviderModelOption } from "../contracts/settings.js";

/** Preserve declared wire keys, including options saved by older releases. */
export function normalizeProviderModelOptions(config: Record<string, unknown>, options: readonly ProviderModelOption[] = []) {
  return Object.fromEntries(options.map(option => {
    const value = String(config[option.key] ?? "").trim();
    const choice = option.options.find(choice => choice.value.toLowerCase() === value.toLowerCase());
    return [option.key, choice?.value ?? option.defaultValue];
  }));
}
