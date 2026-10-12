import { t } from "./i18n.js";
import type { DataTable } from "#sdk/shared/data";
import type { UiReferenceSource } from "#sdk/sidepanel";

export function createDataReferences(list: () => Promise<DataTable[]>, formatDate: (value: unknown) => string): UiReferenceSource {
  return {
    id: "data_store", label: t("dataTable"), menuLabel: "Data", filterLabel: "data", className: "data", order: 10,
    emptyText: t("noMatchingTables"),
    async list(signal) {
      const tables = await list();
      signal.throwIfAborted();
      return tables.map(table => ({
        kind: "data_store", name: table.name, label: table.name, title: table.name,
        subtitle: t("rows", { count: String(Number(table.count || 0)), date: String(formatDate(table.createdAt)) }),
        meta: t("dataTable"), priority: 1,
        search: [table.name, table.count, table.createdAt].join(" ").toLowerCase(),
      }));
    },
  };
}
