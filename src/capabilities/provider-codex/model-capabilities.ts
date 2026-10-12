import type { ModelCapabilityContribution } from "#sdk/shared/models";
const K = 1024;
const makeModels = (ids: string[], contextWindow: number, maxOutputTokens: number, vision: boolean) => ids.map(id => ({ id, contextWindow, maxOutputTokens, vision }));

function makeOpenAiCodexProviderConfig() {
  return {
    providerId: "openaicodex",
    providerLabel: "OpenAI Codex",
    source: "qz-openai-codex-provider-metadata",
    models: [
      ...makeModels(["gpt-6-astra"], 272000, 128000, true),
      ...makeModels([
        "gpt-5.6-sol",
        "gpt-5.6-terra",
        "gpt-5.6-luna",
      ], 272000, 128 * K, true),
      ...makeModels([
        "gpt-5.5",
        "gpt-5.4",
        "gpt-5.4-mini",
      ], 272000, 128 * K, true),
      ...makeModels(["gpt-5.3-codex-spark"], 128000, 128 * K, false),
    ],
  };
}

export default { official: { openaicodex: makeOpenAiCodexProviderConfig() } } satisfies ModelCapabilityContribution;
