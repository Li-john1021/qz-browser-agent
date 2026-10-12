import { t } from "../shared/i18n.js";
import type { SettingsProduct, SettingsProductHost } from '../../../sdk/sidepanel/settings.js';
export function createProductSettings(_host: SettingsProductHost): SettingsProduct {
  return {
    welcomeLabel: t("configureModelEndpoint"), connectHint: t("connectingToGpt"),
    setupIntent: focus => ({ focusSetup: true, provider: focus ? '' : 'custom', focusTarget: focus || 'customEndpoint' }),
    presentation: () => ({}), populate: () => {}, onboarding: () => null, sync: () => {},
    focus: () => false, connect: async () => false, modelError: () => '', handleEvent: () => false,
  };
}
