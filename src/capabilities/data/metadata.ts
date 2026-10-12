import { t } from "./i18n.js";
import { defineToolMetadata as toolMeta } from "#sdk/shared/metadata";
import type { CapabilityMetadata } from "#sdk/shared/metadata";

const tools = () => Object.freeze({
  data_store: toolMeta(t("manageDataTable"), [], { profileFamily: "data", resultFamily: "data", familyId: "process", labelerId: "dataStore", titleRule: { field: "action", defaultTitle: t("manageDataTable"), normalize: "lowercase", values: { create_table: t("createDataTable"), delete: t("deleteDataRows"), add_column: t("addColumn"), rename_column: t("renameColumnShort"), delete_column: t("deleteColumn"), upsert: t("writeDataTableShort"), insert: t("writeDataTableShort"), update: t("writeDataTableShort"), replace: t("writeDataTableShort"), set: t("writeDataTableShort"), clear: t("writeDataTableShort"), query: t("readDataTable"), list: t("readDataTable"), get: t("readDataTable"), read: t("readDataTable") } }, detailLayout: "wide" }),
});

const actionLabels = () => Object.freeze({
  add_column: t("addColumn"),
  rename_column: t("renameColumnShort"),
  delete_column: t("deleteColumn"),
  schema: t("columns"),
  tables: t("tables"),
});

export default { get actionLabels() { return actionLabels(); }, get tools() { return tools(); } } satisfies CapabilityMetadata;


