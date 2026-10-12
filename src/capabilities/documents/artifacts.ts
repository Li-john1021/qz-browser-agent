import {
  artifactFilenameFromUrl, artifactFileExtension, fileArtifactDownloadId, fileArtifactUrl, resolveArtifactUpdatedAt,
  type ToolArtifactAdapter,
} from "#sdk/shared/artifacts";
type Fields = Record<string, unknown>;
const record = (value: unknown): Fields => value && typeof value === "object" && !Array.isArray(value) ? value as Fields : {};

function legacyFile(name: string): ToolArtifactAdapter {
  return { project(args, result, consumer) {
    const create = name === "document_create";
    const urlDownload = name === "download_url";
    const filename = String(result.filename || args.filename || (urlDownload ? artifactFilenameFromUrl(result.url || args.url) : "") || "").trim();
    if (!filename) return [];
    const source: Fields = {
      type: "file", filename,
      size: name === "save_file" || create ? result.size : undefined,
      format: create ? result.format : undefined,
      artifactId: create ? result.artifactId : name === "document_download" ? args.artifactId : undefined,
      downloadId: create ? record(result.downloaded).downloadId : result.downloadId,
      url: urlDownload ? result.url || args.url : undefined,
      sourceTool: name,
    };
    if (consumer === "display") {
      source.downloadId = fileArtifactDownloadId(result);
      source.url = name === "save_file" ? "" : fileArtifactUrl(result) || source.url;
      source.updatedAt = resolveArtifactUpdatedAt(result);
    }
    if (consumer !== "resource") return [{ ...source, score: create ? 3 : 2 }];
    const prefix = urlDownload ? "download-url" : name === "document_download" ? "document-download" : "file";
    return [Object.fromEntries(Object.entries({
      ...source,
      id: source.artifactId ? `artifact:${source.artifactId}` : create ? `document:${filename}`
        : source.downloadId ? `download:${source.downloadId}` : `${prefix}:${filename}`,
      title: filename, format: source.format || artifactFileExtension(filename),
    }).filter(([, value]) => value !== undefined && value !== null && value !== ""))];
  } };
}

export default {
  save_file: legacyFile("save_file"), download_url: legacyFile("download_url"),
  document_create: legacyFile("document_create"), document_download: legacyFile("document_download"),
  document_fetch: { intermediate: true },
} satisfies Readonly<Record<string, ToolArtifactAdapter>>;
