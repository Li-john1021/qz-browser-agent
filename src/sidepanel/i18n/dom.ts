import contributions from "#capabilities/translations";
import { translateMessage } from "../../shared/i18n/index.js";
import type { TranslationCatalog } from "../../shared/i18n/definition.js";
import messages from "./messages.js";

const catalogs = new Map<string, TranslationCatalog>();
for (const catalog of [messages, ...contributions]) {
  if (catalogs.has(catalog.namespace)) throw new Error(`Duplicate translation namespace: ${catalog.namespace}`);
  catalogs.set(catalog.namespace, catalog);
}

const attributes = ["title", "placeholder", "aria-label", "aria-description", "alt", "label", "value", "data-tooltip"] as const;

function translate(key: string): string | undefined {
  const separator = key.indexOf(".");
  const catalog = catalogs.get(key.slice(0, separator));
  const message = catalog?.messages[key.slice(separator + 1)];
  return message && catalog ? translateMessage(catalog, key.slice(separator + 1)) : undefined;
}

/** Only authored markers are translated. User text, model output and input values are never scanned. */
export function localizeDocument(root: Document | DocumentFragment | Element): void {
  const elements = [...root.querySelectorAll("*")];
  if (root instanceof Element) elements.unshift(root);
  for (const element of elements) {
    const textKey = element.getAttribute("data-i18n");
    if (textKey) {
      const text = translate(textKey);
      if (text !== undefined) element.textContent = text;
    }
    for (const attribute of attributes) {
      const key = element.getAttribute(`data-i18n-${attribute}`);
      if (!key) continue;
      const text = translate(key);
      if (text !== undefined) element.setAttribute(attribute, text);
    }
    if (element instanceof HTMLTemplateElement) localizeDocument(element.content);
  }
}
