import { t } from "./i18n.js";
import { defineToolMetadata as toolMeta } from "#sdk/shared/metadata";
import type { CapabilityMetadata } from "#sdk/shared/metadata";

const tools = () => Object.freeze({
  save_file: toolMeta(t("saveFile"), ["download"], { shortTitle: t("saveFileShort"), profileFamily: "download", resultFamily: "downloads", familyId: "artifact" }),
  list_downloads: toolMeta(t("viewDownloads"), ["download"], { shortTitle: t("viewDownloadsShort"), profileFamily: "download", resultFamily: "downloads", familyId: "artifact" }),
  download_url: toolMeta(t("downloadUrl"), ["download"], { shortTitle: t("downloadUrlShort"), profileFamily: "download", resultFamily: "downloads", familyId: "artifact" }),
  document_fetch: documentTool(t("fetchDocument"), "document", t("fetchDocumentShort")),
  document_parse: documentTool(t("parseDocument"), "document"),
  document_read_chunk: documentTool(t("readDocumentChunk"), "document", t("readDocumentChunkShort")),
  document_create: documentTool(t("createDocument"), "artifact"),
  document_download: documentTool(t("downloadDocument"), "artifact", t("downloadDocumentShort")),
  document_list_artifacts: documentTool(t("viewDocumentArtifacts"), "artifact", t("viewDocumentArtifactsShort")),
});

import { BUILTIN_DOCUMENT_CODEC_DEFINITIONS } from "./definitions.js";
export default { get tools() { return tools(); }, documentFormats: BUILTIN_DOCUMENT_CODEC_DEFINITIONS.map(codec => ({
  id: codec.id, mimeType: codec.mimeType, output: "encode" in codec,
})) } satisfies CapabilityMetadata;

function documentTool(title: string, familyId: string, shortTitle?: string) {
  return toolMeta(title, [], { shortTitle, profileFamily: "document", familyId });
}
