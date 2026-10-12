import { t } from "../../shared/i18n/backend.js";
import { PRODUCT_PROVIDERS } from '../product/providers.js';

/** Adapter policy supplies bounded hints; the Agent alone owns attempts and replay. */
export type ProviderRecovery =
  | { strategy: 'capacity'; reason: string; message: string }
  | { strategy: 'same_protocol'; reason: string; message: string; delayMs: number };

export function providerRecoveryHint(failure: { kind?: string; code?: string }, config: { provider?: string }): ProviderRecovery | null {
  const code = String(failure.code || '').toLowerCase();
  const productHint = PRODUCT_PROVIDERS[String(config.provider || '').toLowerCase()]?.recovery?.(failure);
  if (productHint) return productHint;
  if (failure.kind === 'quota' && code === 'throttling.allocationquota') {
    return { strategy: 'same_protocol', reason: 'allocation_quota', message: t("provider.retryOnce"), delayMs: 2000 };
  }
  return null;
}

export function attachProviderRecovery<T extends Error>(failure: T, recovery: ProviderRecovery | null | undefined): T & { recovery?: ProviderRecovery } {
  if (recovery) Object.defineProperty(failure, 'recovery', { value: Object.freeze(recovery), configurable: true });
  return failure;
}
