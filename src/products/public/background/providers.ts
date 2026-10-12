import type { ProviderContribution } from '../../../background/llm/provider-types.js';

export const PRODUCT_DEFAULT_PROVIDER = 'custom';
export const PRODUCT_PROVIDERS: Readonly<Record<string, ProviderContribution>> = Object.freeze({});
export async function getProductProviderAuthStatus(): Promise<Record<string, unknown>> { return {}; }

export const isRetiredProductCredential = (_value: string): boolean => false;
