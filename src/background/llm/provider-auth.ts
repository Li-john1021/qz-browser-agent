import { withDeadline } from "../internal/abortable.js";
import { PROVIDERS } from './provider-catalog.js';
import type { ProviderDefinition } from './provider-types.js';
import type { ProviderAuthStatus } from '../../shared/contracts/settings.js';

/** Authentication is available only on trusted build-time presets, never user-supplied config. */
export function createProviderAuthRuntime(providers: Readonly<Record<string, ProviderDefinition>>) {
  function auth(provider: string) {
    const value = Object.hasOwn(providers, provider) ? providers[provider]?.auth : undefined;
    if (!value) throw new Error(`Provider does not support managed authentication: ${provider}`);
    return value;
  }
  const getProviderAuthStatus = (provider: string) => withDeadline(signal => auth(provider).status(signal), { timeoutMs: 3000 });
  return Object.freeze({
    getProviderAuthStatus,
    async startProviderLogin(provider: string, signal?: AbortSignal) {
      signal?.throwIfAborted();
      const result = await auth(provider).start(signal);
      signal?.throwIfAborted();
      return result;
    },
    async pollProviderLogin(provider: string, loginId: string, signal?: AbortSignal) {
      signal?.throwIfAborted();
      const result = await auth(provider).poll(loginId, signal);
      signal?.throwIfAborted();
      return result;
    },
    clearProviderAuth: (provider: string) => auth(provider).clear(),
    async getProviderAuthState() {
      const providerAuth: Record<string, ProviderAuthStatus> = Object.create(null);
      const legacy: Record<string, ProviderAuthStatus> = Object.create(null);
      await Promise.all(Object.entries(providers).map(async ([id, definition]) => {
        if (!definition.auth) return;
        let status: ProviderAuthStatus;
        try { status = await getProviderAuthStatus(id); }
        catch (error) { status = { loggedIn: false, refreshError: error instanceof Error ? error.message : String(error) }; }
        providerAuth[id] = status;
        if (definition.auth.legacyStatusKey) legacy[definition.auth.legacyStatusKey] = status;
      }));
      return { ...legacy, providerAuth };
    },
  });
}
export const { getProviderAuthStatus, startProviderLogin, pollProviderLogin, clearProviderAuth, getProviderAuthState } = createProviderAuthRuntime(PROVIDERS);
