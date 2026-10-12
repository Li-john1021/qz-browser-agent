import { positiveArtifactNumber as positive, resolveArtifactUpdatedAt, type ToolArtifactAdapter } from "#sdk/shared/artifacts";

const adapter: ToolArtifactAdapter = { project(args, result, consumer) {
  const action = String(args.action || result.action || "").trim();
  const table = String(result.table || args.table || "").trim();
  if (action === "tables" || !table) return [];
  const inputRows = Array.isArray(args.rows) ? args.rows.length : args.row ? 1 : 0;
  const inserted = positive(result.inserted || (consumer === "resource" ? result.changed : 0));
  const updated = positive(result.updated);
  const changed = consumer === "display" ? positive(result.changed) || inserted + updated + positive(result.replaced) + positive(result.deleted) : inserted + updated;
  const totalRows = positive(result.totalRows ?? result.totalMatched ?? (consumer === "display" ? 0 : result.rowCount)) || (consumer === "display" ? Math.max(changed, inputRows) : changed || inputRows);
  const columns = Array.isArray(result.columns) ? result.columns : consumer !== "display" && Array.isArray(args.columns) ? args.columns : [];
  const score = (consumer === "display" ? ["insert", "upsert", "update", "replace", "delete"] : ["insert", "upsert", "update"]).includes(action) ? 3 : 1;
  if (!totalRows && !columns.length && (consumer !== "display" || score !== 3)) return [];
  if (consumer === "resource") return [{
    type: "data", sourceTool: "data_store", id: table, table, title: table, action, totalRows,
    ...(columns.length ? { columnCount: columns.length, columns: columns.slice(0, 50).map(column => String(column && typeof column === "object" ? column.name || column : column)) } : {}),
    inserted, updated,
  }];
  return [{
    type: "data", id: table, title: table, table, totalRows, columns, action, score, sourceTool: "data_store",
    kind: consumer === "display" ? String(result.kind || result.assetKind || "") : "",
    updatedAt: resolveArtifactUpdatedAt(result),
  }];
} };
export default { data_store: adapter };
