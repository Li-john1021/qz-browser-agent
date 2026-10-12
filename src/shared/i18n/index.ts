import { type Message, type TranslationCatalog } from "./definition.js";
import { getAvailableLanguages, languageRuntime, resolveLanguage } from "./runtime.js";

export type { Language, Message, TranslationCatalog } from "./definition.js";
export type MessageParameters = Readonly<Record<string, string | number>>;
export { getAvailableLanguages, resolveLanguage };
export const { getLocale, getLanguage, getLanguagePreference, initializeLanguage, whenLanguageReady,
  readLanguagePreference, saveLanguagePreference, withLanguage } = languageRuntime;

export function getTextDirection(): "ltr" | "rtl" {
  return getAvailableLanguages().find(pack => pack.language === getLanguage())?.direction || "ltr";
}

export function interpolate(message: string, parameters: MessageParameters = {}): string {
  return message.replace(/\{([a-zA-Z][\w]*)\}/g, (placeholder, name: string) =>
    Object.hasOwn(parameters, name) ? String(parameters[name]) : placeholder);
}

/** Resolve only declared messages. Values supplied by users are interpolated once, as plain text. */
export function translateMessage(catalog: TranslationCatalog, key: string, parameters?: MessageParameters): string {
  const message: Message | undefined = catalog.messages[key];
  if (!message) return key;
  const language = getLanguage();
  const qualifiedKey = `${catalog.namespace}.${key}`;
  const text = languageRuntime.lookupMessage(qualifiedKey);
  return interpolate(text ?? message[language] ?? message.en, parameters);
}

/** Package catalogs keep typed keys and source text; installed language packs supply translations. */
export function createTranslator<const T extends TranslationCatalog>(catalog: T) {
  return (key: keyof T["messages"] & string, parameters?: MessageParameters): string =>
    translateMessage(catalog, key, parameters);
}

export function formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat(getLocale(), options).format(value);
}

export function formatDateTime(value: Date | number, options?: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat(getLocale(), options).format(value);
}
