/** Public documents contracts and operations, independent of extension implementation paths. */
export { DocumentCodecError } from "../../shared/documents/document-codec-registry.js";
export type { DocumentBlock, DocumentCodec, DocumentContent, DocumentModel, DocumentOptions, DocumentSheet, DocumentSignal } from "../../shared/documents/document-codec-registry.js";
export { DocumentReadProjectionError, buildDocumentContentChunks, projectDocumentRead } from "../../shared/documents/document-read-projection.js";
export { getDocumentArtifact, getDocumentFile, getDocumentModel, listDocumentArtifacts, saveDocumentArtifact, saveDocumentFile, saveDocumentModel } from "../../shared/documents/document-store.js";
export type { DocumentArtifact, SavedDocumentModel } from "../../shared/documents/document-store.js";
export { CODE_FILENAMES, isCodeDocumentExtension, isCodeDocumentMime, isTextDocumentExtension, isTextDocumentMime } from "../../shared/documents/document-text-formats.js";
