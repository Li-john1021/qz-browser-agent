import { t } from "./i18n.js";
import { positiveArtifactNumber as positive, resolveArtifactUpdatedAt, type ToolArtifactAdapter } from "#sdk/shared/artifacts";
const normalize: ToolArtifactAdapter["normalize"] = artifact => {
  if (!artifact.table || artifact.type !== "data") return artifact;
  // These tools authored the count caption; keep user titles and regenerate the caption from rowCount.
  return { ...artifact, kind: "image_collection", kindLabel: t("imageCollection"), meta: undefined };
};
const adapter: ToolArtifactAdapter = { normalize, project(args, result, consumer) {
  // Old UI timelines only showed collections with an explicit envelope; authoritative context also inferred them.
  if (consumer === "display") return [];
  const table = String(result.table || args.table || "").trim();
  if (!table) return [];
  const totalRows = positive(result.totalRows ?? result.collected ?? result.inserted ?? result.updated);
  return [{
    type: "data", kind: "image_collection", sourceTool: "collect_images", id: table, table, title: table, totalRows, score: 3,
    ...(consumer === "resource" ? {
      kindLabel: t("imageCollection"), rowCount: totalRows,
      ...(Array.isArray(result.assetIds) ? { assetCount: result.assetIds.length } : {}),
    } : { action: "collect_images", updatedAt: resolveArtifactUpdatedAt(result) }),
  }];
} };
export default { collect_images: adapter, screenshot: { normalize } };
