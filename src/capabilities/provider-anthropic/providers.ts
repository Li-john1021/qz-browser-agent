import { chatAnthropic, chatStreamAnthropic } from "./adapter.js";
import type { ProviderAdapter } from "#sdk/background/providers";
export default { "anthropic": { label: "Anthropic", chat: chatAnthropic, chatStream: chatStreamAnthropic } } satisfies Readonly<Record<string, ProviderAdapter>>;
