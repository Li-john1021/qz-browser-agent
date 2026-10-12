import { modelT } from "./model-messages.js";
import {
  getDocumentSkillToolName,
  QINGZHOU_DOCUMENT_TOOL_SPECS,
  QINGZHOU_DOCUMENTS_SKILL_ID,
} from "./skill-contract.js";
import { createSkillHostResources } from "#sdk/shared/skill-definition";

export const BUILTIN_QINGZHOU_DOCUMENTS_SKILL_NAME = "qingzhou-documents";
export const getBuiltinQingzhouDocumentsDisplayName = () => (modelT("documentsDisplayName"));
export const getBuiltinQingzhouDocumentsDescription = () => (modelT("documentsDescription"));

const FETCH = getDocumentSkillToolName("document_fetch");
const PARSE = getDocumentSkillToolName("document_parse");
const READ_CHUNK = getDocumentSkillToolName("document_read_chunk");
const CREATE = getDocumentSkillToolName("document_create");
const DOWNLOAD = getDocumentSkillToolName("document_download");
const LIST_ARTIFACTS = getDocumentSkillToolName("document_list_artifacts");
const getCreateFormatValues = () => (QINGZHOU_DOCUMENT_TOOL_SPECS.document_create.parameters.properties.format.enum
  .map(format => `\`${format}\``)
  .join(modelT("formatSeparator")));

export const getBuiltinQingzhouDocumentsContent = () => (modelT("builtinContent", { FETCH, PARSE, CREATE, READ_CHUNK, CREATE_FORMAT_VALUES: getCreateFormatValues(), LIST_ARTIFACTS, DOWNLOAD }));

export const getBuiltinQingzhouDocumentsResources = () => (createSkillHostResources({
  id: QINGZHOU_DOCUMENTS_SKILL_ID,
  get displayName() { return getBuiltinQingzhouDocumentsDisplayName(); },
  version: "0.2.3",
  get description() { return getBuiltinQingzhouDocumentsDescription(); },
  category: { id: "documents", get label() { return modelT("documentsCategory"); } },
  tools: QINGZHOU_DOCUMENT_TOOL_SPECS,
  get manifestTitle() { return modelT("documentsManifestTitle"); },
  get manifestDescription() { return modelT("documentsManifestDescription"); },
  get scriptDescription() { return modelT("documentsScriptDescription"); },
}));

export default {
  aliases: ["文档处理", "Document processing"],
  name: BUILTIN_QINGZHOU_DOCUMENTS_SKILL_NAME, get displayName() { return getBuiltinQingzhouDocumentsDisplayName(); },
  get description() { return getBuiltinQingzhouDocumentsDescription(); }, get content() { return getBuiltinQingzhouDocumentsContent(); },
  get resources() { return getBuiltinQingzhouDocumentsResources(); }, order: 3,
};
