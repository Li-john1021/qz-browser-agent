import { createTranslator } from "../../shared/i18n/index.js";
import messages from "./messages.js";

export const t = createTranslator(messages);

/** Translated text embedded in authored markup must remain text, including in attributes. */
export function tHtml(...args: Parameters<typeof t>): string {
  return t(...args).replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}
