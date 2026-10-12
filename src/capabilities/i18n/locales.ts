import type { LanguagePack } from "#sdk/shared/i18n-definition";

/** Only descriptors enter JavaScript; Chrome owns the compiled language catalogs. */
export default [
  { language: "en", chromeLocale: "en", name: "English" },
  { language: "zh-CN", chromeLocale: "zh_CN", name: "简体中文", aliases: ["zh", "zh-Hans", "zh-SG"] },
  { language: "zh-TW", chromeLocale: "zh_TW", name: "繁體中文", aliases: ["zh-Hant", "zh-HK", "zh-MO"], catalog: "./locales/zh-TW" },
  { language: "ja", chromeLocale: "ja", name: "日本語", catalog: "./locales/ja" },
  { language: "ko", chromeLocale: "ko", name: "한국어", catalog: "./locales/ko" },
  { language: "es", chromeLocale: "es", name: "Español", catalog: "./locales/es" },
  { language: "fr", chromeLocale: "fr", name: "Français", catalog: "./locales/fr" },
  { language: "de", chromeLocale: "de", name: "Deutsch", catalog: "./locales/de" },
  { language: "pt-BR", chromeLocale: "pt_BR", name: "Português (Brasil)", catalog: "./locales/pt-BR" },
  { language: "ru", chromeLocale: "ru", name: "Русский", catalog: "./locales/ru" },
  { language: "ar", chromeLocale: "ar", name: "العربية", direction: "rtl", catalog: "./locales/ar" },
  { language: "hi", chromeLocale: "hi", name: "हिन्दी", catalog: "./locales/hi" },
] satisfies readonly LanguagePack[];
