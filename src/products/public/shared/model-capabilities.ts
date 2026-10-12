import type { ModelCapabilityMatch, ProviderModelCapabilities } from '../../../shared/contracts/model-capabilities.js';

export const PRODUCT_MODEL_CONFIGS: Readonly<Record<string, ProviderModelCapabilities>> = Object.freeze({});
export function matchProductModelCapabilities(_input: { model: string; provider: string }): ModelCapabilityMatch | null { return null; }
