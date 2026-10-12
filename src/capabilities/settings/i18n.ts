import { createTranslator } from "#sdk/shared/i18n";
import messages from "./messages.js";

export const t = createTranslator(messages);
export { getLocale, getLanguage } from "#sdk/shared/i18n";
