/** Pure catalog contract: importing messages never loads a UI or a capability registry. */
export type Language = string;
export type Message = Readonly<Record<"zh-CN" | "en", string> & Partial<Record<Language, string>>>;
/** A build-time language pack. Catalog paths are confined to the contributing capability. */
export interface LanguagePack {
  readonly language: string;
  readonly chromeLocale: string;
  readonly name: string;
  readonly aliases?: readonly string[];
  readonly direction?: "ltr" | "rtl";
  readonly catalog?: string;
}

/** Chrome message names are case-insensitive; escaping uppercase and separators keeps IDs injective. */
export function chromeMessageId(qualifiedKey: string): string {
  return `qz_${qualifiedKey.replace(/[^a-z0-9]/g, character => `_${character.charCodeAt(0).toString(16).padStart(4, "0")}`)}`;
}

export interface ChromeMessage {
  readonly message: string;
  readonly placeholders?: { readonly qz_literal: { readonly content: string } };
}

/** Chrome resolves named placeholders at install, then dollar runs when getMessage is called. */
export function encodeChromeMessage(text: string, { substitutions = true }: { substitutions?: boolean } = {}): ChromeMessage {
  if (!text.includes("$")) return { message: text };
  // A single literal placeholder prevents source text such as $HOME$ from becoming a variable.
  // getMessage removes one dollar per run; manifest substitution does not perform that second pass.
  const content = substitutions ? text.replace(/\$+/g, dollars => `$${dollars}`) : text;
  return { message: "$QZ_LITERAL$", placeholders: { qz_literal: { content } } };
}

/** Read our generated runtime messages as plain text, without a general Chrome-template interpreter. */
export function decodeChromeMessage(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entry = value as Partial<ChromeMessage>;
  if (typeof entry.message !== "string") return undefined;
  if (entry.message !== "$QZ_LITERAL$") return entry.placeholders === undefined ? entry.message : undefined;
  const content = entry.placeholders?.qz_literal?.content;
  return typeof content === "string" ? content.replace(/\${2,}/g, dollars => dollars.slice(1)) : undefined;
}

export interface TranslationCatalog {
  readonly namespace: string;
  readonly messages: Readonly<Record<string, Message>>;
  readonly historicalLabels?: readonly string[];
}

export const HISTORICAL_LABELS_MESSAGE_ID = "qz_historical_labels";

function placeholders(text: string): string {
  return [...new Set([...text.matchAll(/\{([a-zA-Z][\w]*)\}/g)].map(match => match[1]))].sort().join(",");
}

/** Every authored language carries the same named parameters; translations are always plain text. */
export function defineMessages<const T extends Readonly<Record<string, Message>>>(namespace: string, messages: T,
  options: { historicalLabels?: readonly (keyof T & string)[] } = {}) {
  if (!/^[a-z][a-z0-9-]*$/.test(namespace)) throw new Error(`Invalid translation namespace: ${namespace}`);
  for (const [key, value] of Object.entries(messages)) {
    if (!key || typeof value.en !== "string" || typeof value["zh-CN"] !== "string"
      || Object.values(value).some(text => text !== undefined
        && (typeof text !== "string" || placeholders(value.en) !== placeholders(text)))) {
      throw new Error(`Translation parameters differ: ${namespace}.${key}`);
    }
    Object.freeze(value);
  }
  const historicalLabels = options.historicalLabels;
  if (historicalLabels && (!Array.isArray(historicalLabels) || historicalLabels.some(key =>
    typeof key !== "string" || !Object.hasOwn(messages, key) || Object.values(messages[key]!).some(text =>
      typeof text !== "string" || !text.trim() || placeholders(text))))) {
    throw new Error(`Historical labels must reference fixed messages: ${namespace}`);
  }
  return Object.freeze({ namespace, messages: Object.freeze(messages),
    ...(historicalLabels ? { historicalLabels: Object.freeze([...historicalLabels]) } : {}) });
}
