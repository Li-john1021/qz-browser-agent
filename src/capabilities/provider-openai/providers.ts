import { chatOpenAi, chatStreamOpenAi } from "./adapter.js";
import { providerRecoveryHint } from "#sdk/background/providers";
import type { ProviderAdapter } from "#sdk/background/providers";
export default { "openai": { label: "OpenAI", chat: chatOpenAi, chatStream: chatStreamOpenAi, recovery: providerRecoveryHint } } satisfies Readonly<Record<string, ProviderAdapter>>;
