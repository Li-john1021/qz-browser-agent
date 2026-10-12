import { defineMessages } from "#sdk/shared/i18n-definition";
import { createTranslator } from "#sdk/shared/i18n";

/** Model documentation is separate from the eager UI translation catalog. */
const messages = defineMessages("data-model", {
  dataStore: {
    "zh-CN": "读写浏览器本地 Data 表。适合文本、链接、商品、文章等结构化采集；图片或视觉素材先用 list_images 选择候选，再把选中候选的 target 或 URL 交给 collect_images 建图集，不要只把图片 URL 写进普通 Data 表。图集也是一种特殊 Data 表：collect_images 会创建 kind=image_collection / assetKind=image 的表；action=tables 可列出全部普通表和图集，过滤该 metadata 可获取图集列表；读取图集行仍使用 action=list，行内 assetId 可交给 read_image_asset 做单图视觉分析。每个 table 是逻辑表；row/data 是行内容，columns 是字段结构和导出顺序。需要先建空表头时，用 create_table + table + columns；写数据时再用 insert/upsert，且 rows/row 必须包含真实行。改单个字段用 update，整行替换用 replace，改字段结构用 add_column/rename_column/delete_column。内部行句柄 rowId 永远由系统自动分配，insert/upsert 时不要传 rowId；row.id 只是普通业务字段，可以保存，也可以作为 dedupField。rowId 是不透明值，只能原样使用最近一次 list/get 返回的 rowId；不要拼接、解析、URL 编解码或从 table/业务 id 推导。list/get 返回的是行对象，形如 {rowId, order, data, createdAt, updatedAt, revision}，业务字段在 data 内（如 row.data[\"标题\"]），不要用 row[\"标题\"] 取业务字段，写入 row/rows/data 时只传业务字段对象；table 在外层返回，不重复放进行对象。update 修改单个字段时传 rowId、field、value、expectedValue；expectedValue 是读取时看到的旧值，若旧字段不存在才省略。replace 整行替换时传 rowId、revision、data；revision 来自 list/get，当前 revision 不匹配会拒绝写入。delete 只支持按单条 rowId 删除，可同时传 table 做防误删校验，不支持按条件批量删或清空表。系统时间列 createdAt/updatedAt 统一使用北京时间 yyyy-mm-dd HH:MM:SS；业务时间字段也应使用同一格式。列顺序会按 create_table 的 columns 或 rows 字段首次出现顺序保存，用户可在 Data tab 导出 Excel。直接调用 data_store 只适合少量 rows（约 20 行以内）；大批量结构化采集必须在 run_script 内部 await tools.data_store(...) 分批落库，避免 LLM 输出巨大 tool arguments。采集任务应优先使用 action=upsert + rows + dedupField 批量落库，不要只 insert 单条样例。",
    en: "Read and write local Data tables in the browser for structured collections such as text, links, products, and articles. For images or visual assets, use list_images to select candidates, then pass their target or URL to collect_images to create an image collection; do not merely store image URLs in a regular Data table. Image collections are specialized Data tables: collect_images creates tables with kind=image_collection / assetKind=image. action=tables lists both regular tables and collections; filter this metadata to find collections. Use action=list to read collection rows and pass a row's assetId to read_image_asset for visual analysis. Each table is a logical table; row/data contains business fields, and columns defines the schema and export order. To create empty headers, use create_table + table + columns; then use insert/upsert with actual rows/row. Use update for one field, replace for a whole row, and add_column/rename_column/delete_column for schema changes. The system always assigns the internal rowId; do not provide it for insert/upsert. row.id is an ordinary business field and may also be used as dedupField. rowId is opaque: copy it exactly from the latest list/get result. Never construct, parse, URL-encode/decode, or derive it from a table or business ID. list/get returns row objects shaped as {rowId, order, data, createdAt, updatedAt, revision}; business fields are inside data (for example, row.data[\"title\"], not row[\"title\"]). Pass only business fields in row/rows/data. table appears in the outer result, not each row. For update, provide rowId, field, value, and expectedValue. expectedValue is the value you read; omit it only when the field did not exist. For replace, provide rowId, revision, and data; use revision from list/get. A revision mismatch rejects the write. delete removes exactly one rowId; optionally provide table to verify ownership. Conditional bulk deletion and clearing tables are unsupported. System timestamps createdAt/updatedAt use Beijing time in yyyy-mm-dd HH:MM:SS format; use the same format for business timestamps. Column order follows create_table columns or the order in which fields first appear in rows. Users can export Excel from the Data tab. Call data_store directly only for small batches (about 20 rows or fewer). For large collections, call await tools.data_store(...) in batches inside run_script to avoid huge model-generated tool arguments. Prefer action=upsert + rows + dedupField for collection tasks; do not insert only a single sample row.",
  },
  dataAction: {
    "zh-CN": "操作类型。分支必填：create_table 需 table + columns；insert/upsert 需 table + rows/row；list/schema 需 table；get/delete 需 rowId；update 需 rowId + field + value；replace 需 rowId + revision + data；add_column/delete_column 需 table + column；rename_column 需 table + column + newColumn；tables 无需 table。schema 只返回当前字段顺序。delete 只删除一条 rowId 指定的数据，不支持 clear 或条件批量删除。",
    en: "Operation. Required by action: create_table needs table + columns; insert/upsert needs table + rows/row; list/schema needs table; get/delete needs rowId; update needs rowId + field + value; replace needs rowId + revision + data; add_column/delete_column needs table + column; rename_column needs table + column + newColumn. tables needs no table. schema returns only the current column order. delete removes one rowId; clear and conditional bulk deletion are unsupported.",
  },
  dataTable: {
    "zh-CN": "逻辑表名。create_table/insert/upsert/list/schema/add_column/rename_column/delete_column 需要，必须在 row/rows/data 之前确定；delete 时可选，用于校验目标 rowId 是否属于该表。",
    en: "Logical table name. Required for create_table/insert/upsert/list/schema/add_column/rename_column/delete_column; determine it before row/rows/data. Optional for delete, to verify that the rowId belongs to this table.",
  },
  dataRowId: {
    "zh-CN": "不透明的内部行句柄。get/update/replace/delete 时，原样复制最近一次 list/get 返回的 rowId；禁止拼接、解析、URL 编解码或从 table/业务 id 推导。insert/upsert 不传 rowId，也不要写入 row/rows 或作为 dedupField。",
    en: "Opaque internal row handle. For get/update/replace/delete, copy rowId exactly from the latest list/get result. Never construct, parse, URL-encode/decode, or derive it from table/business IDs. Do not provide rowId for insert/upsert, put it in row/rows, or use it as dedupField.",
  },
  dataField: {
    "zh-CN": "update 的字段名。update 一次只改一个字段；批量字段清洗请在 run_script 内多次调用 update，或在确认完整行数据时用 replace。",
    en: "Field to update. update changes one field at a time. For bulk cleanup, call update repeatedly inside run_script, or use replace when you have verified the complete row.",
  },
  dataValue: {
    "zh-CN": "update 写入的新字段值。可以是 string/number/boolean/null/object/array；若要清空字段可传 null。该字段可能较长，填写 action/rowId/field/expectedValue 后最后填写。",
    en: "New field value for update. Accepts string, number, boolean, null, object, or array; use null to clear a value. This field may be long; provide it last, after action/rowId/field/expectedValue.",
  },
  dataExpectedValue: {
    "zh-CN": "update 的字段级并发保护：填写读取时看到的旧值。只有 row.data[field] 仍等于 expectedValue 时才写入；若旧字段不存在才省略 expectedValue。",
    en: "Field-level concurrency check for update: provide the old value you read. The write succeeds only if row.data[field] still equals expectedValue. Omit expectedValue only when the field did not exist.",
  },
  dataRevision: {
    "zh-CN": "replace 的整行并发保护。来自 list/get 返回的 row.revision；只有当前 revision 仍匹配时才整行替换。",
    en: "Whole-row concurrency check for replace. Use row.revision from list/get; the row is replaced only if its current revision still matches.",
  },
  dataColumn: {
    "zh-CN": "字段名。add_column/delete_column 使用该字段；rename_column 中表示旧字段名。",
    en: "Column name for add_column/delete_column, or the old column name for rename_column.",
  },
  dataNewColumn: {
    "zh-CN": "rename_column 的新字段名。字段重命名会保持原字段位置不变。",
    en: "New column name for rename_column. Renaming preserves the column's position.",
  },
  dataDedupField: {
    "zh-CN": "upsert 去重字段。采集网页数据通常用 url；若业务唯一键叫 id，也可以用 dedupField:\"id\"；禁止使用 rowId。去重只在当前 table 内生效；不传 dedupField 时 upsert 会插入新行。",
    en: "Deduplication field for upsert. Usually url for web collection; if the business key is id, dedupField:\"id\" is also valid. Never use rowId. Deduplication is scoped to this table; omitting dedupField causes upsert to insert new rows.",
  },
  dataColumns: {
    "zh-CN": "字段顺序。create_table 必填且必须非空；insert/upsert 可选，若来自网页表头或 Excel/CSV 表头，请按原始顺序传入；不传则按 rows 字段首次出现顺序追加。",
    en: "Column order. Required and nonempty for create_table; optional for insert/upsert. Preserve the source order for web, Excel, or CSV headers. If omitted, new columns are appended in the order their fields first appear in rows.",
  },
  dataFilter: {
    "zh-CN": "list 的精确匹配过滤，如 {\"name\":\"x\"}。",
    en: "Exact-match filter for list, for example {\"name\":\"x\"}.",
  },
  dataLimit: {
    "zh-CN": "list 返回条数，默认 100，最大 1000。",
    en: "Maximum rows returned by list. Default: 100; maximum: 1000.",
  },
  dataOffset: {
    "zh-CN": "list offset，默认 0。",
    en: "Row offset for list. Default: 0.",
  },
  dataRow: {
    "zh-CN": "单条待写入 JSON object。只适合确实只有一条记录的场景；采集任务不要用 row 写样例；其中 id 字段只是业务字段，不是主键。该字段可能较长，最后填写。",
    en: "One JSON object to write. Use only when there is genuinely one record; do not write a sample row for a collection task. Its id is a business field, not the internal primary key. This field may be long; provide it last.",
  },
  dataRows: {
    "zh-CN": "多条待写入 JSON object。采集任务必须优先用 rows 批量写入；每条记录的 rowId 由系统生成，rows[].id 只是业务字段。insert/upsert 不接受空 rows；建空表头请用 create_table。该字段可能很长，填写 action/table/dedupField/columns 后最后填写。",
    en: "JSON objects to write in a batch. Prefer rows for collection tasks. The system generates each rowId; rows[].id is a business field. insert/upsert rejects empty rows; use create_table for empty headers. This field may be long; provide it last, after action/table/dedupField/columns.",
  },
  dataReplacement: {
    "zh-CN": "replace 的完整行 JSON object。会替换整行业务 data，不是 patch；不要包含 rowId/revision/createdAt/updatedAt。该字段可能较长，填写 action/rowId/revision 后最后填写。",
    en: "Complete row JSON object for replace. Replaces all business data, rather than applying a patch. Exclude rowId/revision/createdAt/updatedAt. This field may be long; provide it last, after action/rowId/revision.",
  },
  tableSchemaCreated: {
    "zh-CN": "表结构已创建或更新。后续写入数据请使用 upsert + rows + dedupField，或 insert + rows。",
    en: "Table schema created or updated. Write data with upsert + rows + dedupField, or insert + rows.",
  },
  upsertCompleted: {
    "zh-CN": "批量 upsert 完成。rowId 由系统自动分配；只有非 rowId 的 dedupField 命中记录才会更新，用 totalRows 和 list/schema 验证结果。",
    en: "Batch upsert completed. The system assigned rowId values. Only matches on a non-rowId dedupField update existing rows. Verify the result with totalRows and list/schema.",
  },
  rowDeleted: {
    "zh-CN": "已删除 1 条记录。图集行同样按 rowId 删除；若该图片没有其他图集引用，本地图片文件仍由图集管理界面清理。",
    en: "Deleted 1 record. Collection rows also use rowId for deletion. If no other collection references the image, its local file is still cleaned up through the collection management interface.",
  },
});

export const modelT = createTranslator(messages);
