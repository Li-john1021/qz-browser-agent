/** Public data contracts and operations, independent of extension implementation paths. */
export { deleteImageAsset, getImageAsset, getImageAssetDataUrl, saveImageAsset } from "../../shared/asset-store.js";
export type { ImageAssetRecord } from "../../shared/asset-store.js";
export { addDataTableColumn, clearDataTable, deleteDataRows, deleteDataTableColumn, getDataRow, getDataTableColumns, inferColumns, insertDataRows, listDataTables, queryDataRows, renameDataTableColumn, replaceDataRow, setDataTableColumns, updateDataRow, updateDataTableMetadata, upsertDataRows } from "../../shared/data-store.js";
export type { DataColumnMeta, DataRow, DataTable } from "../../shared/data-store.js";
