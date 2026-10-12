import type { ProviderPreset } from "#sdk/background/providers";

/** Runtime policies augment the SDK directory without copying its URLs or model lists. */
export default {
  fireworks: {
    override: true,
    sessionAffinityHeader: true,
  },
  deepseek: {
    override: true,
    requestDefaults: { thinking: { type: "enabled" }, reasoning_effort: "high" },
  },
  opencodego: {
    override: true,
    requestHeaders: { "User-Agent": "qz-agent/1.0.0" },
    sessionAffinityHeader: "x-opencode-session",
    contentThinkTags: true,
  },
  opencodezen: {
    override: true,
    contentThinkTags: true,
  },
  kimicode: {
    override: true,
    // Keep the existing Anthropic conversation/thinking protocol; the SDK defaults to OpenAI.
    api: "anthropic-messages",
    protocol: "anthropic",
    endpoint: "https://api.kimi.com/coding/v1/messages",
    anthropicVersion: "2023-06-01",
    modelsAuthHeader: "x-api-key",
    requestHeaders: { "User-Agent": "qz-agent/1.0.0" },
    anthropicRequestDefaults: { thinking: { type: "enabled", budget_tokens: 1024 } },
  },
} satisfies Readonly<Record<string, ProviderPreset>>;
