import type { ModelCapabilityContribution } from '#sdk/shared/models';
import { t } from './i18n.js';
export default { official: {
  'example-local': { providerId: 'example-local', get providerLabel() { return t('providerLabel'); }, source: 'example-package', models: [
    { id: 'local-fixture', contextWindow: 64000, maxOutputTokens: 2000, vision: false },
  ] },
} } satisfies ModelCapabilityContribution;
