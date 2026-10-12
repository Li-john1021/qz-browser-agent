import type { ProviderDefinition } from "./provider-types.js";

/** Endpoint resolution uses the supplied definition; adapters do not read the preset catalog. */
export function getProviderEndpoint(providerDef: Partial<ProviderDefinition> = {}) {
  if (providerDef.resolveEndpoint) return providerDef.resolveEndpoint(providerDef);
  if (providerDef.endpoint) return providerDef.endpoint;
  if ((providerDef.api === "anthropic-messages" || providerDef.protocol === "anthropic") && providerDef.baseUrl) {
    return `${String(providerDef.baseUrl).replace(/\/+$/, "")}/v1/messages`;
  }
  return "";
}

