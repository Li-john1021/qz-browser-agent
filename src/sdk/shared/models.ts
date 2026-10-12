/** Public models contracts and operations, independent of extension implementation paths. */
export type { ModelCapability, ModelCapabilityMatch, ModelCapabilityContribution, ProviderModelCapabilities } from "../../shared/contracts/model-capabilities.js";
export type { ModelMessage, ModelToolCall } from "../../shared/contracts/model-message.js";
export { completeCustomProviderEndpoint, normalizeCustomProtocol, suggestCustomProviderEndpoint } from "../../shared/models/custom-provider-endpoint.js";
export { MODEL_PARAMETER_SUGGESTIONS, formatModelParameterValue, normalizeModelParameters, parseModelParameterEntries, serializeModelParameters } from "../../shared/models/model-parameters.js";
export { normalizeProviderModelOptions } from "../../shared/models/provider-options.js";
