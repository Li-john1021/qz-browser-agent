import { chatCodex, chatStreamCodex } from "./adapter.js";
import type { ProviderAdapter } from "#sdk/background/providers";
export default { "openai-codex": { customProvider: false, chat: chatCodex, chatStream: chatStreamCodex } } satisfies Readonly<Record<string, ProviderAdapter>>;
