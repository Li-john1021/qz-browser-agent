import { defineMessages } from "./definition.js";
import { createTranslator, getLocale } from "./index.js";

// Content scripts are injected into every page; keep their catalog independent of the tool host.
export const contentMessages = defineMessages("content", {
  brand: { "zh-CN": "轻舟", en: "qz" },
  noStableSelector: { "zh-CN": "无法为该元素生成稳定 selector", en: "Could not generate a stable selector for this element" },
  importFailed: { "zh-CN": "会话导入失败", en: "Could not import the chat" },
});

export interface ContentLanguageSnapshot {
  readonly v: 1;
  readonly locale: string;
  readonly messages: Readonly<Record<keyof typeof contentMessages.messages, string>>;
}

/** Only the three page-facing labels cross the isolated-world boundary. */
export function createContentLanguageSnapshot(): ContentLanguageSnapshot {
  const t = createTranslator(contentMessages);
  return { v: 1, locale: getLocale(), messages: {
    brand: t("brand"), noStableSelector: t("noStableSelector"), importFailed: t("importFailed"),
  } };
}

export function parseContentLanguageSnapshot(value: unknown): ContentLanguageSnapshot | null {
  if (!value || typeof value !== "object" || !("v" in value) || value.v !== 1
    || !("locale" in value) || typeof value.locale !== "string" || value.locale.length > 100
    || !("messages" in value) || !value.messages || typeof value.messages !== "object") return null;
  const messages = value.messages as Record<string, unknown>;
  for (const key of Object.keys(contentMessages.messages)) {
    if (typeof messages[key] !== "string" || messages[key].length > 4096) return null;
  }
  return { v: 1, locale: value.locale, messages: {
    brand: messages.brand as string, noStableSelector: messages.noStableSelector as string, importFailed: messages.importFailed as string,
  } };
}
