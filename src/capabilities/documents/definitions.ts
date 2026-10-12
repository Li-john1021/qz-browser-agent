import { isTextDocumentExtension, isTextDocumentMime } from "#sdk/shared/documents";
import type { DocumentCodec } from "#sdk/shared/documents";

type Algorithm = keyof typeof import("./document-utils.js");
type BuiltinDefinition = Omit<DocumentCodec, "parse" | "encode"> & { parse?: Algorithm; encode?: Algorithm | "printPdf" };

/** Pure built-in declarations; handler names are private to the static runtime assembly. */
export const BUILTIN_DOCUMENT_CODEC_DEFINITIONS = Object.freeze([
  { id: "docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", priority: 60,
    matches: input => input.extension === "docx" || input.mimeType.includes("wordprocessingml"),
    parse: "parseDocxToModel", encode: "createDocxBytes" },
  { id: "xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", priority: 50,
    matches: input => input.extension === "xlsx" || input.mimeType.includes("spreadsheetml"),
    parse: "parseXlsxToModel", encode: "createWorkbookBytes" },
  { id: "pdf", mimeType: "application/pdf", priority: 40,
    matches: input => input.extension === "pdf" || input.mimeType.includes("pdf"),
    parse: "parsePdfToModel", encode: "printPdf" },
  { id: "html", mimeType: "text/html", priority: 30,
    matches: input => ["html", "htm"].includes(input.extension) || input.mimeType.includes("html"),
    parse: "parseHtmlToModel", encode: "createHtmlBytes" },
  { id: "txt", mimeType: "text/plain",
    matches: input => isTextDocumentExtension(input.extension, input.filename) || isTextDocumentMime(input.mimeType),
    parse: "parseTextToModel", encode: "createTextBytes" },
  { id: "csv", mimeType: "text/csv", priority: 20,
    matches: input => input.extension === "csv" || input.mimeType.includes("csv"),
    parse: "parseCsvToModel", encode: "createCsvBytes" },
] as const satisfies readonly BuiltinDefinition[]);

export const DOCUMENT_OUTPUT_FORMATS: readonly string[] = Object.freeze(BUILTIN_DOCUMENT_CODEC_DEFINITIONS
  .filter(codec => "encode" in codec).map(codec => codec.id));
