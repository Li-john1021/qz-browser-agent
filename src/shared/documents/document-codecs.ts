import contributions from "#capabilities/codecs";
import { DOCUMENT_OUTPUT_FORMATS } from "./document-codec-definitions.js";
import { createDocumentCodecs, DocumentCodecError } from "./document-codec-registry.js";
import type { DocumentCodec } from "./document-codec-registry.js";
export { DOCUMENT_OUTPUT_FORMATS } from "./document-codec-definitions.js";
export { createDocumentCodecs, DocumentCodecError } from "./document-codec-registry.js";
export type { DocumentCodec, DocumentContent, DocumentModel, DocumentOptions, DocumentEncodeServices, DocumentSignal } from "./document-codec-registry.js";

export const BUILTIN_DOCUMENT_CODECS: readonly DocumentCodec[] = Object.freeze(contributions.flat());

export const documentCodecs = createDocumentCodecs(BUILTIN_DOCUMENT_CODECS);
export const DOCUMENT_FORMATS = new Set(DOCUMENT_OUTPUT_FORMATS);
export const inferDocumentFormat = documentCodecs.inferFormat;
export const mimeTypeForFormat = documentCodecs.mimeType;
export const parseDocumentBytes = documentCodecs.parse;
export const createDocumentBytes = documentCodecs.encode;
