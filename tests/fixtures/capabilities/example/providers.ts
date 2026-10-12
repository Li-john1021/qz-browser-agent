import type { ProviderAdapter } from "#sdk/background/providers";
import { deterministicProvider } from "./deterministic-provider.js";

export default { example: deterministicProvider } satisfies Readonly<Record<string, ProviderAdapter>>;
