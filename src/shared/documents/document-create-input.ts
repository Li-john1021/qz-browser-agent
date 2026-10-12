import { t } from "./input-messages.js";
interface ContentInput { title?: unknown; blocks?: unknown; sheets?: unknown }
export interface DocumentInputIssue { path: string; keyword: string; message: string; [detail: string]: unknown }
type IssueCollector = ReturnType<typeof createIssueCollector>;
interface TabularName { name: unknown; path: string; fallback: string }
export { DOCUMENT_OUTPUT_FORMATS } from "./document-codec-definitions.js";

export const DOCUMENT_BLOCK_TYPES = Object.freeze([
  "paragraph",
  "heading",
  "list",
  "table",
  "link",
  "image",
  "code",
]);

const DOCUMENT_BLOCK_TYPE_SET = new Set(DOCUMENT_BLOCK_TYPES);
const DOCUMENT_LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:", "tel:"]);
const DOCUMENT_IMAGE_PROTOCOLS = new Set(["http:", "https:"]);
const MAX_REPORTED_ISSUES = 16;
const MAX_LIST_DEPTH = 8;

const LIST_ITEM_SCHEMA = Object.freeze({
  get description() { return t("listItem"); },
});

const TABLE_ROW_SCHEMA = Object.freeze({
  get description() { return t("tableRow"); },
});

export const DOCUMENT_BLOCK_INPUT_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["type"],
  properties: Object.freeze({
    type: {
      type: "string",
      enum: DOCUMENT_BLOCK_TYPES,
      get description() { return t("blockType"); },
    },
    text: { type: "string", get description() { return t("blockText"); } },
    level: { type: "integer", minimum: 1, maximum: 6, get description() { return t("headingLevel"); } },
    ordered: { type: "boolean", get description() { return t("orderedList"); } },
    items: { type: "array", minItems: 1, items: LIST_ITEM_SCHEMA, get description() { return t("listItems"); } },
    name: { type: "string", minLength: 1, maxLength: 31, get description() { return t("tableName"); } },
    columns: { type: "array", uniqueItems: true, items: { type: "string", minLength: 1 }, get description() { return t("tableColumns"); } },
    rows: { type: "array", items: TABLE_ROW_SCHEMA, get description() { return TABLE_ROW_SCHEMA.description; } },
    header: { type: "boolean", get description() { return t("header"); } },
    url: { type: "string", minLength: 1, get description() { return t("url"); } },
    alt: { type: "string", get description() { return t("imageAlt"); } },
    caption: { type: "string", get description() { return t("imageCaption"); } },
    language: { type: "string", get description() { return t("codeLanguage"); } },
    startLine: { type: "integer", minimum: 1, get description() { return t("codeStart"); } },
    endLine: { type: "integer", minimum: 1, get description() { return t("codeEnd"); } },
  } as const),
} as const);

export const DOCUMENT_SHEET_INPUT_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  properties: Object.freeze({
    name: { type: "string", minLength: 1, maxLength: 31, get description() { return t("sheetName"); } },
    columns: { type: "array", uniqueItems: true, items: { type: "string", minLength: 1 }, get description() { return t("columns"); } },
    rows: { type: "array", items: TABLE_ROW_SCHEMA, get description() { return TABLE_ROW_SCHEMA.description; } },
    header: { type: "boolean", get description() { return t("header"); } },
  } as const),
} as const);

export const DOCUMENT_CREATE_CONTENT_INPUT_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  properties: Object.freeze({
    blocks: Object.freeze({ type: "array", items: DOCUMENT_BLOCK_INPUT_SCHEMA } as const),
    sheets: Object.freeze({ type: "array", items: DOCUMENT_SHEET_INPUT_SCHEMA } as const),
  } as const),
} as const);

export const DOCUMENT_BLOCK_EXAMPLES = Object.freeze({
  paragraph: Object.freeze({ type: "paragraph", text: t("bodyExample") }),
  heading: Object.freeze({ type: "heading", text: t("headingExample"), level: 1 }),
  list: Object.freeze({ type: "list", ordered: false, items: [t("itemOne"), t("itemTwo")] }),
  table: Object.freeze({
    type: "table",
    name: t("people"),
    columns: [t("personName"), t("jobTitle")],
    rows: [[t("person"), t("director")]],
    header: false,
  }),
  link: Object.freeze({ type: "link", text: t("reference"), url: "https://example.com" }),
  image: Object.freeze({ type: "image", url: "https://example.com/image.png", alt: t("illustration") }),
  code: Object.freeze({ type: "code", language: "javascript", text: "const answer = 42;" }),
});

const BLOCK_ALLOWED_KEYS = Object.freeze({
  paragraph: new Set(["type", "text"]),
  heading: new Set(["type", "text", "level"]),
  list: new Set(["type", "ordered", "items"]),
  table: new Set(["type", "name", "columns", "rows", "header"]),
  link: new Set(["type", "text", "url"]),
  image: new Set(["type", "url", "alt", "caption"]),
  code: new Set(["type", "text", "language", "startLine", "endLine"]),
});

/** Validates only direct document_create payloads. Parsed docModels keep their tolerant internal contract. */
export function validateDirectDocumentCreateInput({ blocks = [], sheets = [] }: ContentInput = {}) {
  const collector = createIssueCollector();

  if (!Array.isArray(blocks)) {
    collector.add("blocks", "type", t("blocksArray"), { receivedType: valueType(blocks) });
  } else {
    blocks.forEach((block, index) => validateBlock(block, `blocks[${index}]`, collector));
    validateUniqueTableNames(blocks, collector);
  }

  if (!Array.isArray(sheets)) {
    collector.add("sheets", "type", t("sheetsArray"), { receivedType: valueType(sheets) });
  } else {
    sheets.forEach((sheet, index) => validateSheet(sheet, `sheets[${index}]`, collector));
    validateUniqueSheetNames(sheets, collector);
  }

  return collector.result();
}

export function summarizeDocumentContent({ title = "", blocks = [], sheets = [] }: ContentInput = {}) {
  const summary = {
    titleChars: String(title || "").trim().length,
    blocks: Array.isArray(blocks) ? blocks.length : 0,
    paragraphs: 0,
    headings: 0,
    lists: 0,
    listItems: 0,
    tables: 0,
    tableRows: 0,
    links: 0,
    images: 0,
    codeBlocks: 0,
    sheets: Array.isArray(sheets) ? sheets.length : 0,
    sheetRows: 0,
    textChars: 0,
    tabularSources: 0,
    meaningful: false,
  };

  for (const block of Array.isArray(blocks) ? blocks : []) {
    if (!isPlainObject(block)) continue;
    if (block.type === "paragraph") summary.paragraphs += 1;
    else if (block.type === "heading") summary.headings += 1;
    else if (block.type === "list") {
      summary.lists += 1;
      const listSummary = summarizeListItems(block.items);
      summary.listItems += listSummary.count;
      summary.textChars += listSummary.textChars;
    } else if (block.type === "table") {
      summary.tables += 1;
      summary.tabularSources += 1;
      summary.tableRows += Array.isArray(block.rows) ? block.rows.length : 0;
      summary.textChars += tabularTextChars(block.columns, block.rows);
    } else if (block.type === "link") summary.links += 1;
    else if (block.type === "image") summary.images += 1;
    else if (block.type === "code") summary.codeBlocks += 1;

    if (!["list", "table"].includes(String(block.type))) {
      summary.textChars += String(block.text || block.caption || block.alt || block.url || "").trim().length;
    }
  }

  for (const sheet of Array.isArray(sheets) ? sheets : []) {
    if (!isPlainObject(sheet)) continue;
    summary.tabularSources += 1;
    summary.sheetRows += Array.isArray(sheet.rows) ? sheet.rows.length : 0;
    summary.textChars += tabularTextChars(sheet.columns, sheet.rows);
  }

  summary.meaningful = summary.textChars > 0
    || summary.tables > 0
    || summary.sheets > 0;
  return summary;
}

function validateBlock(block: unknown, path: string, collector: IssueCollector) {
  if (!isPlainObject(block)) {
    collector.add(path, "type", t("blockObject"), { receivedType: valueType(block) });
    return;
  }

  const type = typeof block.type === "string" ? block.type.trim() : "";
  if (!type) {
    const suggestedType = inferLegacyBlockType(block);
    collector.add(path, "required", t("blockTypeRequired"), {
      missing: ["type"],
      receivedKeys: Object.keys(block).slice(0, 20),
      ...(suggestedType ? { suggestedType, suggestedBlock: DOCUMENT_BLOCK_EXAMPLES[suggestedType] } : {}),
    });
    return;
  }
  if (!DOCUMENT_BLOCK_TYPE_SET.has(type)) {
    collector.add(`${path}.type`, "enum", t("unsupportedBlock", { type }), {
      received: type,
      expected: DOCUMENT_BLOCK_TYPES,
    });
    return;
  }

  const unknownKeys = Object.keys(block).filter(key => !BLOCK_ALLOWED_KEYS[type as keyof typeof BLOCK_ALLOWED_KEYS].has(key));
  if (unknownKeys.length) {
    collector.add(path, "additionalProperties", t("unknownBlockFields", { type, fields: unknownKeys.join(", ") }), {
      unexpectedKeys: unknownKeys.slice(0, 20),
      allowedKeys: [...BLOCK_ALLOWED_KEYS[type as keyof typeof BLOCK_ALLOWED_KEYS]],
    });
  }

  if (["paragraph", "heading", "code"].includes(type)) validateRequiredText(block.text, `${path}.text`, collector);
  if (type === "heading" && block.level != null && (typeof block.level !== "number" || !Number.isInteger(block.level) || block.level < 1 || block.level > 6)) {
    collector.add(`${path}.level`, "range", t("headingRange"), { received: block.level });
  }
  if (type === "list") validateListBlock(block, path, collector);
  if (type === "table") {
    if (block.name != null) validateSheetName(block.name, `${path}.name`, collector);
    validateTabularValue(block, path, collector);
  }
  if (type === "link") {
    validateDocumentUrl(block.url, `${path}.url`, collector, "link");
    validateOptionalString(block.text, `${path}.text`, collector);
  }
  if (type === "image") {
    validateDocumentUrl(block.url, `${path}.url`, collector, "image");
    validateOptionalString(block.alt, `${path}.alt`, collector);
    validateOptionalString(block.caption, `${path}.caption`, collector);
  }
  if (type === "code") {
    validateOptionalString(block.language, `${path}.language`, collector);
    validateOptionalPositiveInteger(block.startLine, `${path}.startLine`, collector);
    validateOptionalPositiveInteger(block.endLine, `${path}.endLine`, collector);
    if (typeof block.startLine === "number" && typeof block.endLine === "number" && Number.isInteger(block.startLine) && Number.isInteger(block.endLine) && block.endLine < block.startLine) {
      collector.add(`${path}.endLine`, "range", t("codeLineOrder"), {
        startLine: block.startLine,
        endLine: block.endLine,
      });
    }
  }
}

function validateListBlock(block: Record<string, unknown>, path: string, collector: IssueCollector) {
  if (block.ordered != null && typeof block.ordered !== "boolean") {
    collector.add(`${path}.ordered`, "type", t("orderedBoolean"), { receivedType: valueType(block.ordered) });
  }
  if (!Array.isArray(block.items) || block.items.length === 0) {
    collector.add(`${path}.items`, "minItems", t("itemsArray"), { receivedType: valueType(block.items) });
    return;
  }
  block.items.forEach((item, index) => validateListItem(item, `${path}.items[${index}]`, collector, 0));
}

function validateListItem(item: unknown, path: string, collector: IssueCollector, depth: number) {
  if (depth > MAX_LIST_DEPTH) {
    collector.add(path, "maxDepth", t("listDepth", { depth: MAX_LIST_DEPTH }), { maxDepth: MAX_LIST_DEPTH });
    return;
  }
  if (typeof item === "string") {
    if (!item.trim()) collector.add(path, "minLength", t("itemEmpty"), {});
    return;
  }
  if (!isPlainObject(item)) {
    collector.add(path, "type", t("itemShape"), { receivedType: valueType(item) });
    return;
  }
  const unknownKeys = Object.keys(item).filter(key => !["text", "children"].includes(key));
  if (unknownKeys.length) {
    collector.add(path, "additionalProperties", t("unknownItemFields", { fields: unknownKeys.join(", ") }), {
      unexpectedKeys: unknownKeys.slice(0, 20),
      allowedKeys: ["text", "children"],
    });
  }
  validateRequiredText(item.text, `${path}.text`, collector);
  if (item.children == null) return;
  if (!Array.isArray(item.children)) {
    collector.add(`${path}.children`, "type", t("childrenArray"), { receivedType: valueType(item.children) });
    return;
  }
  item.children.forEach((child, index) => validateListItem(child, `${path}.children[${index}]`, collector, depth + 1));
}

function validateSheet(sheet: unknown, path: string, collector: IssueCollector) {
  if (!isPlainObject(sheet)) {
    collector.add(path, "type", t("sheetObject"), { receivedType: valueType(sheet) });
    return;
  }
  const unknownKeys = Object.keys(sheet).filter(key => !["name", "columns", "rows", "header"].includes(key));
  if (unknownKeys.length) {
    collector.add(path, "additionalProperties", t("unknownSheetFields", { fields: unknownKeys.join(", ") }), {
      unexpectedKeys: unknownKeys.slice(0, 20),
      allowedKeys: ["name", "columns", "rows", "header"],
    });
  }
  if (sheet.name != null) validateSheetName(sheet.name, `${path}.name`, collector);
  validateTabularValue(sheet, path, collector);
}

function validateTabularValue(value: Record<string, unknown>, path: string, collector: IssueCollector) {
  if (value.header != null && typeof value.header !== "boolean") {
    collector.add(`${path}.header`, "type", t("headerBoolean"), { receivedType: valueType(value.header) });
  }

  const columns = value.columns;
  if (columns != null && !Array.isArray(columns)) {
    collector.add(`${path}.columns`, "type", t("columnsArray"), { receivedType: valueType(columns) });
  } else if (Array.isArray(columns)) {
    const seen = new Set();
    columns.forEach((column, index) => {
      if (typeof column !== "string" || !column.trim()) {
        collector.add(`${path}.columns[${index}]`, "type", t("columnNonempty"), { receivedType: valueType(column) });
        return;
      }
      const key = column.trim();
      if (seen.has(key)) collector.add(`${path}.columns[${index}]`, "unique", t("duplicateColumn", { column: key }), { column: key });
      seen.add(key);
    });
  }

  const rows = value.rows;
  if (rows != null && !Array.isArray(rows)) {
    collector.add(`${path}.rows`, "type", t("rowsArray"), { receivedType: valueType(rows) });
    return;
  }
  const safeRows: unknown[] = Array.isArray(rows) ? rows : [];
  const safeColumns = Array.isArray(columns) ? columns : [];
  if (!safeColumns.length && !safeRows.length) {
    collector.add(path, "content", t("tableContent"), {});
    return;
  }
  if (!safeRows.length) return;

  const rowKinds = new Set(safeRows.map(row => Array.isArray(row) ? "array" : isPlainObject(row) ? "object" : valueType(row)));
  if ([...rowKinds].some(kind => !["array", "object"].includes(kind))) {
    safeRows.forEach((row, index) => {
      if (!Array.isArray(row) && !isPlainObject(row)) {
        collector.add(`${path}.rows[${index}]`, "type", t("rowShape"), { receivedType: valueType(row) });
      }
    });
    return;
  }
  if (rowKinds.size > 1) {
    collector.add(`${path}.rows`, "rowShape", t("mixedRows"), { rowKinds: [...rowKinds] });
    return;
  }

  if (rowKinds.has("array")) {
    const arrayRows = safeRows as unknown[][]; // Row shape was checked above.
    const expectedWidth = safeColumns.length || arrayRows[0].length;
    if (!expectedWidth) {
      collector.add(`${path}.rows`, "content", t("emptyArrayRow"), {});
      return;
    }
    arrayRows.forEach((row, rowIndex) => {
      if (row.length !== expectedWidth) {
        collector.add(`${path}.rows[${rowIndex}]`, "rowWidth", t("rowWidth", { width: expectedWidth }), {
          expectedWidth,
          receivedWidth: row.length,
        });
      }
      row.forEach((cell, columnIndex) => validateCell(cell, `${path}.rows[${rowIndex}][${columnIndex}]`, collector));
    });
    return;
  }

  const objectRows = safeRows as Record<string, unknown>[]; // The remaining homogeneous row shape is object.
  const inferredColumns = safeColumns.length
    ? safeColumns
    : [...new Set(objectRows.flatMap(row => Object.keys(row)))];
  if (!inferredColumns.length) collector.add(`${path}.rows`, "content", t("emptyObjectRow"), {});
  const knownColumns = new Set(inferredColumns);
  objectRows.forEach((row, rowIndex) => {
    const unexpectedKeys = Object.keys(row).filter(key => !knownColumns.has(key));
    if (safeColumns.length && unexpectedKeys.length) {
      collector.add(`${path}.rows[${rowIndex}]`, "additionalProperties", t("unknownRowFields", { fields: unexpectedKeys.join(", ") }), {
        unexpectedKeys: unexpectedKeys.slice(0, 20),
      });
    }
    Object.entries(row).forEach(([key, cell]) => validateCell(cell, `${path}.rows[${rowIndex}].${key}`, collector));
  });
}

function validateCell(cell: unknown, path: string, collector: IssueCollector) {
  if (cell === null || ["string", "boolean"].includes(typeof cell)) return;
  if (typeof cell === "number" && Number.isFinite(cell)) return;
  collector.add(path, "type", t("cellType"), { receivedType: valueType(cell) });
}

function validateUniqueSheetNames(sheets: unknown[], collector: IssueCollector) {
  validateUniqueTabularNames(sheets.map((sheet, index) => ({
    name: isPlainObject(sheet) ? sheet.name : "",
    path: `sheets[${index}].name`,
    fallback: `Sheet${index + 1}`,
  })), collector);
}

function validateUniqueTableNames(blocks: unknown[], collector: IssueCollector) {
  let tableIndex = 0;
  const entries: TabularName[] = [];
  blocks.forEach((block, blockIndex) => {
    if (!isPlainObject(block) || block.type !== "table") return;
    tableIndex += 1;
    entries.push({
      name: block.name,
      path: `blocks[${blockIndex}].name`,
      fallback: `Table${tableIndex}`,
    });
  });
  validateUniqueTabularNames(entries, collector);
}

function validateUniqueTabularNames(entries: TabularName[], collector: IssueCollector) {
  const used = new Map();
  entries.forEach(({ name: inputName, path, fallback }) => {
    const name = String(inputName || fallback).trim().toLowerCase();
    if (!name) return;
    if (used.has(name)) {
      collector.add(path, "unique", t("duplicateSheet", { path: used.get(name) }), {
        duplicateOf: used.get(name),
      });
    } else {
      used.set(name, path);
    }
  });
}

function validateSheetName(value: unknown, path: string, collector: IssueCollector) {
  if (typeof value !== "string" || !value.trim()) {
    collector.add(path, "type", t("sheetNameRequired"), { receivedType: valueType(value) });
    return;
  }
  if (value.length > 31) collector.add(path, "maxLength", t("sheetNameLength"), { length: value.length });
  if (/[:\\/?*\[\]]/.test(value) || value.startsWith("'") || value.endsWith("'")) {
    collector.add(path, "pattern", t("sheetNameCharacters"), {});
  }
}

function validateRequiredText(value: unknown, path: string, collector: IssueCollector) {
  if (typeof value !== "string" || !value.trim()) {
    collector.add(path, "minLength", t("textRequired"), { receivedType: valueType(value) });
  }
}

function validateDocumentUrl(value: unknown, path: string, collector: IssueCollector, kind: "image" | "link") {
  if (typeof value !== "string" || !value.trim()) {
    collector.add(path, "minLength", t("urlRequired"), { receivedType: valueType(value) });
    return;
  }
  const url = value.trim();
  if (kind === "link" && url.startsWith("#")) return;
  if (kind === "image" && /^data:image\/(?:png|jpe?g|gif|webp);base64,[a-z0-9+/]+={0,2}$/i.test(url)) return;
  let protocol = "";
  try {
    protocol = new URL(url).protocol.toLowerCase();
  } catch (_error) {
    // Report the stable URL contract below.
  }
  const supported = kind === "image" ? DOCUMENT_IMAGE_PROTOCOLS : DOCUMENT_LINK_PROTOCOLS;
  if (!supported.has(protocol)) {
    collector.add(path, "format", kind === "image"
      ? t("imageUrl")
      : t("linkUrl"), {
      receivedProtocol: protocol || "invalid",
    });
  }
}

function validateOptionalString(value: unknown, path: string, collector: IssueCollector) {
  if (value != null && typeof value !== "string") {
    collector.add(path, "type", t("stringRequired"), { receivedType: valueType(value) });
  }
}

function validateOptionalPositiveInteger(value: unknown, path: string, collector: IssueCollector) {
  if (value != null && (typeof value !== "number" || !Number.isInteger(value) || value < 1)) {
    collector.add(path, "range", t("positiveInteger"), { received: value });
  }
}

function inferLegacyBlockType(block: Record<string, unknown>) {
  if (typeof block.heading === "string") return "heading";
  if (block.table === true || Array.isArray(block.columns) || Array.isArray(block.rows)) return "table";
  if (Array.isArray(block.list)) return "list";
  if (typeof block.code === "string") return "code";
  return "";
}

function createIssueCollector() {
  let issueCount = 0;
  const issues: DocumentInputIssue[] = [];
  const invalidFields = new Set<string>();
  return {
    add(path: string, keyword: string, message: string, details: Record<string, unknown> = {}) {
      issueCount += 1;
      const field = String(path || "").match(/^[^.[\]]+/)?.[0] || "";
      if (field) invalidFields.add(field);
      if (issues.length >= MAX_REPORTED_ISSUES) return;
      issues.push({ path, keyword, message, ...details });
    },
    result() {
      return {
        valid: issueCount === 0,
        issueCount,
        issues,
        omittedIssueCount: Math.max(0, issueCount - issues.length),
        invalidFields: [...invalidFields],
      };
    },
  };
}

function summarizeListItems(items: unknown = []) {
  let count = 0;
  let textChars = 0;
  const visit = (item: unknown) => {
    count += 1;
    if (typeof item === "string") {
      textChars += item.trim().length;
      return;
    }
    if (!isPlainObject(item)) return;
    textChars += String(item.text || "").trim().length;
    if (Array.isArray(item.children)) item.children.forEach(visit);
  };
  if (Array.isArray(items)) items.forEach(visit);
  return { count, textChars };
}

function tabularTextChars(columns: unknown = [], rows: unknown = []) {
  let chars = Array.isArray(columns) ? columns.reduce((sum, column) => sum + String(column || "").trim().length, 0) : 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    const values = Array.isArray(row) ? row : isPlainObject(row) ? Object.values(row) : [];
    chars += values.reduce((sum, value) => sum + String(value ?? "").trim().length, 0);
  }
  return chars;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function valueType(value: unknown) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}
