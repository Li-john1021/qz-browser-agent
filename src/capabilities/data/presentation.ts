import { t } from "./i18n.js";
import type { ToolPresentationDefinition } from "#sdk/sidepanel";
import { formatActionLabel } from "#sdk/shared/catalog";
import { fieldLabel, firstNonEmpty } from "#sdk/sidepanel/presentation";
export const presentations: readonly ToolPresentationDefinition[] = ["data_store", "data"].map(id => ({
  id,
  timelineGroupTitle: () => ({ label: t("collectAndWriteData"), order: 10 }),
  timelineBadge: ({ result }) => {
    const value = result && typeof result === "object" ? result as Record<string, unknown> : {};
    const rows = value.totalRows ?? value.inserted ?? value.updated ?? (Array.isArray(value.rows) ? value.rows.length : undefined);
    return { label: rows ? t("rowCount", { count: String(rows) }) : t("dataTable"), key: "data", order: 10 };
  },
  describeRun: ({ args, name, result, surface }) => {
    if (surface === "timeline") {
      const value = result && typeof result === "object" ? result as Record<string, unknown> : {};
      const count = value.totalRows ?? value.inserted ?? value.updated ?? (Array.isArray(value.rows) ? value.rows.length : undefined);
      return count != null && count !== "" ? t("rowCount", { count: String(count) }) : undefined;
    }
    const action = args.action ? `${formatActionLabel(args.action, name) || fieldLabel(args.action)} · ` : "";
    const target = firstNonEmpty([args.table && t("table", { name: String(args.table) }), args.query && t("query", { query: String(args.query) }),
      args.pattern && t("match", { match: String(args.pattern) }), args.selector && t("selector", { selector: String(args.selector) }), args.url, args.filename,
      args.skill && args.script ? `${args.skill}/${args.script}` : "", args.skill, args.sessionId && t("task", { sessionId: String(args.sessionId) }), args.tabId && t("tab", { tabId: String(args.tabId) })]);
    return `${action}${target || t("dataTableName")}`;
  },
}));
