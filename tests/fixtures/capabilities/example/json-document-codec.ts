import type { DocumentCodec } from "#sdk/shared/documents";
import { t } from "./i18n.js";

/** A minimal parser-only format. The host still enforces file size and Session ownership. */
export const createJsonDocumentCodec = (decodeUtf8: (bytes: Uint8Array) => string): DocumentCodec => ({
  id: "json-note",
  mimeType: "application/vnd.qingzhou.note+json",
  priority: 100,
  matches: input => input.extension === "qznote" || input.mimeType === "application/vnd.qingzhou.note+json",
  parse(bytes) {
    const input: unknown = JSON.parse(decodeUtf8(bytes));
    if (!input || typeof input !== "object" || !("text" in input) || typeof input.text !== "string") throw new Error(t("invalidDocument"));
    return { type: "txt", title: t("documentTitle"), blocks: [{ type: "paragraph", text: input.text }],
      sheets: [], chunks: [], outline: [], warnings: [] };
  },
});
