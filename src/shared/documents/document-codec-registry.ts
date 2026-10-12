import { t } from "../i18n/backend.js";
import { normalizeDocumentChunkSize } from "./document-read-projection.js";

export interface DocumentBlock { type: string; [field: string]: unknown }
export interface DocumentSheet { name: string; columns: string[]; rows: Record<string, unknown>[] }
export interface DocumentContent { title?: string; blocks?: readonly DocumentBlock[]; sheets?: readonly DocumentSheet[] }
export interface DocumentModel extends DocumentContent {
  type: string;
  title: string;
  blocks: DocumentBlock[];
  sheets: DocumentSheet[];
  chunks: unknown[];
  outline: unknown[];
  warnings: string[];
  chunkSize?: number;
  [field: string]: unknown;
}
/** Structural Web API type; shared contracts do not grant DOM or Chrome globals. */
export interface DocumentSignal {
  readonly aborted: boolean;
  addEventListener(type: "abort", listener: () => void, options: { once: boolean }): void;
  removeEventListener(type: "abort", listener: () => void): void;
}
export interface DocumentOptions {
  filename?: string;
  mimeType?: string;
  chunkSize?: number;
  signal?: DocumentSignal;
  maxBytes?: number;
}
export interface DocumentEncodeServices {
  signal?: DocumentSignal;
  /** The host owns temporary tabs, CDP, permissions and cleanup. */
  printPdf?: (content: DocumentContent, signal?: DocumentSignal) => Promise<Uint8Array>;
}
export interface DocumentCodec {
  readonly id: string;
  readonly mimeType: string;
  readonly priority?: number;
  readonly replaces?: string;
  matches(input: Readonly<{ extension: string; filename: string; mimeType: string }>): boolean;
  parse?(bytes: Uint8Array, options: DocumentOptions): unknown | Promise<unknown>;
  encode?(content: DocumentContent, services: DocumentEncodeServices): Uint8Array | Promise<Uint8Array>;
}

export class DocumentCodecError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "DocumentCodecError"; }
}

export function createDocumentCodecs(definitions: readonly DocumentCodec[]) {
  const codecs = new Map<string, DocumentCodec>();
  for (const definition of definitions) {
    if (!/^[a-z][a-z\d-]*$/.test(definition.id) || !definition.mimeType || (!definition.parse && !definition.encode)) throw new Error(`Invalid document codec: ${definition.id}`);
    if (definition.replaces !== undefined && (definition.replaces !== definition.id || !codecs.has(definition.replaces))) throw new Error(`Invalid codec replacement: ${definition.id}`);
    if (codecs.has(definition.id) && definition.replaces !== definition.id) throw new Error(`Duplicate document codec: ${definition.id}`);
    codecs.set(definition.id, Object.freeze({ ...definition }));
  }
  const readers = [...codecs.values()].filter(codec => codec.parse).sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  const detect = ({ filename = "", mimeType = "" }: DocumentOptions = {}) => {
    const name = filename.split(/[?#]/)[0].split(/[\\/]/).pop()?.toLowerCase() || "";
    const input = Object.freeze({ filename: name, extension: name.split(".").pop() || name, mimeType: mimeType.toLowerCase() });
    return readers.find(codec => codec.matches(input));
  };
  return Object.freeze({
    outputFormats: Object.freeze([...codecs.values()].filter(codec => codec.encode).map(codec => codec.id)),
    inferFormat: (input: DocumentOptions = {}) => detect(input)?.id || "",
    mimeType: (format: string) => codecs.get(String(format || "").toLowerCase())?.mimeType || "text/plain",
    async parse(input: Uint8Array | ArrayBuffer, options: DocumentOptions = {}): Promise<DocumentModel> {
      const codec = detect(options);
      if (!codec?.parse) throw new DocumentCodecError("DOCUMENT_FORMAT_UNSUPPORTED", `Unsupported document format: ${options.mimeType || options.filename || "unknown"}`);
      if (!(input instanceof Uint8Array || input instanceof ArrayBuffer)) throw new DocumentCodecError("DOCUMENT_BYTES_INVALID", t("document.bytesRequired"));
      const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
      if (options.maxBytes !== undefined && (!Number.isFinite(options.maxBytes) || options.maxBytes < 1 || bytes.byteLength > options.maxBytes)) throw new DocumentCodecError("DOCUMENT_SIZE_LIMIT", t("document.parseTooLarge"));
      const chunkSize = normalizeDocumentChunkSize(options.chunkSize ?? 6000);
      const model = await cancellable(() => codec.parse!(bytes, { ...options, chunkSize }), options.signal);
      if (!isDocumentModel(model)) throw new DocumentCodecError("DOCUMENT_CODEC_INVALID_RESULT", t("document.invalidParserOutput", { codec: String(codec.id) }));
      return { ...model, chunkSize };
    },
    async encode({ format, ...content }: DocumentContent & { format: string }, services: DocumentEncodeServices = {}) {
      const codec = codecs.get(String(format || "").toLowerCase());
      if (!codec?.encode) throw new DocumentCodecError("DOCUMENT_FORMAT_UNSUPPORTED", `Unsupported output format for direct bytes: ${format}`);
      const bytes = await cancellable(() => codec.encode!(content, services), services.signal);
      if (!(bytes instanceof Uint8Array)) throw new DocumentCodecError("DOCUMENT_CODEC_INVALID_RESULT", t("document.invalidEncoderOutput", { codec: String(codec.id) }));
      return bytes;
    },
  });
}

function isDocumentModel(value: unknown): value is DocumentModel {
  if (!value || typeof value !== "object") return false;
  const model = value as Record<string, unknown>;
  return typeof model.type === "string" && typeof model.title === "string"
    && Array.isArray(model.blocks) && model.blocks.every(block => block && typeof block === "object" && typeof block.type === "string")
    && Array.isArray(model.sheets) && model.sheets.every(sheet => sheet && typeof sheet.name === "string" && Array.isArray(sheet.columns) && sheet.columns.every((column: unknown) => typeof column === "string") && Array.isArray(sheet.rows) && sheet.rows.every((row: unknown) => row && typeof row === "object" && !Array.isArray(row)))
    && Array.isArray(model.chunks) && Array.isArray(model.outline)
    && Array.isArray(model.warnings) && model.warnings.every(warning => typeof warning === "string");
}

async function cancellable<T>(operation: () => T | PromiseLike<T>, signal?: DocumentSignal): Promise<T> {
  // Racing abort only rejects the caller: codecs and injected services must release their own resources.
  const cancelled = () => Object.assign(new Error("Document operation cancelled"), { name: "AbortError", code: "ABORT_ERR" });
  if (signal?.aborted) throw cancelled();
  if (!signal) return operation();
  let onAbort = () => {};
  try {
    return await Promise.race([
      Promise.resolve().then(() => { if (signal.aborted) throw cancelled(); return operation(); }),
      new Promise<never>((_, reject) => { onAbort = () => reject(cancelled()); signal.addEventListener("abort", onAbort, { once: true }); }),
    ]);
  } finally { signal.removeEventListener("abort", onAbort); }
}
