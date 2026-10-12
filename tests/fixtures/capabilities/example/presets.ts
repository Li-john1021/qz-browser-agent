import type { ProviderDefinition } from '#sdk/background/providers';
import { t } from './i18n.js';

let loggedIn = false;
let loginSequence = 0;
export default {
  'example-local': {
    get label() { return t('providerLabel'); }, api: 'example', protocol: 'example', endpoint: 'https://example.invalid/local',
    defaultContextWindow: 64000, requiresApiKey: false,
    get modelOptions() { return [{ key: 'exampleMode', label: t('modeLabel'), defaultValue: 'brief', options: [{ value: 'brief', label: t('briefMode') }, { value: 'full', label: t('fullMode') }] }]; },
    async listModels({ signal }) { signal?.throwIfAborted(); return [{ id: 'local-fixture', label: t('modelLabel') }]; },
    auth: {
      get label() { return t('authLabel'); }, legacyStatusKey: 'exampleAuthStatus',
      async status() { return { loggedIn }; },
      async start(signal) { signal?.throwIfAborted(); return { loginId: String(++loginSequence), userCode: 'LOCAL-ONLY', verificationUri: 'https://example.invalid/login', intervalSeconds: 1, expiresAt: Date.now() + 60000 }; },
      async poll(loginId, signal) { signal?.throwIfAborted(); if (loginId !== String(loginSequence)) return { status: 'expired' }; loggedIn = true; return { status: 'complete', authStatus: { loggedIn } }; },
      async clear() { loggedIn = false; loginSequence += 1; return { loggedIn }; },
    },
  },
} satisfies Readonly<Record<string, ProviderDefinition>>;
