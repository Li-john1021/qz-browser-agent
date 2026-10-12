import { modelT } from "./model-messages.js";
import {
  DOCUMENT_BLOCK_INPUT_SCHEMA,
  DOCUMENT_OUTPUT_FORMATS,
  DOCUMENT_SHEET_INPUT_SCHEMA,
} from "#sdk/shared/document-input";

export const QINGZHOU_DOCUMENTS_SKILL_ID = "qingzhou-documents";
export const QINGZHOU_DOCUMENTS_RUNTIME_PREFIX = "qingzhou_documents";

export const DOCUMENT_TOOL_CORE_NAMES = Object.freeze([
  "document_fetch",
  "document_parse",
  "document_read_chunk",
  "document_create",
  "document_download",
  "document_list_artifacts",
]);

const DOCUMENT_TOOL_CORE_NAME_SET = new Set(DOCUMENT_TOOL_CORE_NAMES);
const getDocumentOutputFormatLiterals = () => (DOCUMENT_OUTPUT_FORMATS
  .map(format => `"${format}"`)
  .join(modelT("formatSeparator")));

export function getDocumentSkillToolName(coreName = "") {
  const name = String(coreName || "").trim();
  if (!DOCUMENT_TOOL_CORE_NAME_SET.has(name)) return "";
  return name ? `${QINGZHOU_DOCUMENTS_RUNTIME_PREFIX}__${name}` : "";
}

export const QINGZHOU_DOCUMENT_TOOL_SPECS = Object.freeze({
  document_fetch: Object.freeze({
    get description() { return modelT("documentFetch"); },
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", get description() { return modelT("documentUrl"); } },
        filename: { type: "string", get description() { return modelT("documentFilename"); } },
        mimeType: { type: "string", get description() { return modelT("documentMimeType"); } },
      },
      required: ["url"],
    },
  } as const),
  document_parse: Object.freeze({
    get description() { return modelT("documentParse"); },
    parameters: {
      type: "object",
      properties: {
        fileId: { type: "string", get description() { return modelT("documentFileId"); } },
        chunkSize: { type: "number", get description() { return modelT("documentChunkSize"); } },
      },
      required: ["fileId"],
    },
  } as const),
  document_read_chunk: Object.freeze({
    get description() { return modelT("documentReadChunk"); },
    parameters: {
      type: "object",
      properties: {
        docModelId: { type: "string", get description() { return modelT("documentModelId"); } },
        chunkIndex: { type: "number", get description() { return modelT("documentChunkIndex"); } },
        tableId: { type: "string", get description() { return modelT("documentTableId"); } },
        sheetName: { type: "string", get description() { return modelT("documentSheetName"); } },
        offset: { type: "number", get description() { return modelT("documentOffset"); } },
        limit: { type: "number", get description() { return modelT("documentLimit"); } },
      },
      required: ["docModelId"],
    },
  } as const),
  document_create: Object.freeze({
    get description() { return modelT("documentCreate", { DOCUMENT_OUTPUT_FORMAT_LITERALS: getDocumentOutputFormatLiterals() }); },
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        format: { type: "string", enum: DOCUMENT_OUTPUT_FORMATS, get description() { return modelT("documentFormat", { DOCUMENT_OUTPUT_FORMAT_LITERALS: getDocumentOutputFormatLiterals() }); } },
        filename: { type: "string", get description() { return modelT("documentOutputFilename"); } },
        get title() { return { type: "string", description: modelT("documentTitle") } as const; },
        docModelId: { type: "string", get description() { return modelT("documentSourceModel"); } },
        download: { type: "boolean", get description() { return modelT("documentAutoDownload"); } },
        saveAs: { type: "boolean", get description() { return modelT("documentSaveAs"); } },
        blocks: { type: "array", items: DOCUMENT_BLOCK_INPUT_SCHEMA, get description() { return modelT("documentBlocks"); } },
        sheets: { type: "array", items: DOCUMENT_SHEET_INPUT_SCHEMA, get description() { return modelT("documentSheets"); } },
      },
      required: ["format"],
    },
  } as const),
  document_download: Object.freeze({
    get description() { return modelT("documentDownload"); },
    parameters: {
      type: "object",
      properties: {
        artifactId: { type: "string", get description() { return modelT("documentArtifactId"); } },
        filename: { type: "string", get description() { return modelT("documentDownloadFilename"); } },
        saveAs: { type: "boolean", get description() { return modelT("documentDownloadSaveAs"); } },
      },
      required: ["artifactId"],
    },
  } as const),
  document_list_artifacts: Object.freeze({
    get description() { return modelT("documentListArtifacts"); },
    parameters: {
      type: "object",
      properties: {
        limit: { type: "number", get description() { return modelT("documentArtifactLimit"); } },
      },
    },
  } as const),
});

