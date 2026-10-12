export interface ModelCapability { id: string; contextWindow: number | null; maxOutputTokens: number | null; vision: boolean | null }
export interface ProviderModelCapabilities { providerId: string; providerLabel: string; source: string; models: ModelCapability[] }
export interface ModelCapabilityMatch {
  matched: boolean; model: string; matchedId: string; contextWindow: number | null; maxOutputTokens: number | null;
  vision: boolean | null; source: string; providerId: string; providerLabel: string;
}

/** Pure model metadata contributed independently of protocol or browser context. */
export interface ModelCapabilityContribution {
  official?: Readonly<Record<string, ProviderModelCapabilities>>;
  modelsDev?: Readonly<Record<string, string>>;
}
