import type { ProviderDefinition, ProviderPreset, ProviderPresetOverride } from "./provider-types.js";

/** Resolve definitions before explicit patches; import order never decides provider policy. */
export function resolveProviderPresets(
  records: readonly (Readonly<Record<string, ProviderPreset>> | undefined)[],
): Readonly<Record<string, ProviderDefinition>> {
  const providers: Record<string, ProviderDefinition> = Object.create(null);
  const overrides = new Map<string, ProviderPresetOverride>();
  for (const entries of records) for (const [id, preset] of Object.entries(entries || {})) {
    if (!id.trim()) throw new Error(`Empty provider identity: ${id}`);
    if (isProviderOverride(preset)) {
      if (overrides.has(id)) throw new Error(`Duplicate provider override: ${id}`);
      overrides.set(id, preset);
    } else {
      if (Object.hasOwn(providers, id)) throw new Error(`Duplicate provider identity: ${id}`);
      providers[id] = preset;
    }
  }
  for (const [id, patch] of overrides) {
    if (!Object.hasOwn(providers, id)) throw new Error(`Cannot override missing provider: ${id}`);
    const base = providers[id]!;
    const descriptors: PropertyDescriptorMap = Object.getOwnPropertyDescriptors(patch);
    delete descriptors.override;
    // Preserve live translation getters and handler identity, including frozen declarations.
    providers[id] = Object.defineProperties(Object.create(Object.getPrototypeOf(base)), {
      ...Object.getOwnPropertyDescriptors(base), ...descriptors,
    });
  }
  return Object.freeze(providers);
}

function isProviderOverride(preset: ProviderPreset): preset is ProviderPresetOverride {
  return "override" in preset && preset.override === true;
}
