import { t } from "../i18n.js";
import { loadExcel } from "./data-excel.js";
export type ImportedRow = Record<string, unknown>;
export async function parseImportFile(file: File) {
  const ext = fileExtension(file.name);
  if (ext === "xlsx" || ext === "xls") return parseExcelImport(await file.arrayBuffer(), file.name);
  const text = await file.text();
  return parseImportText(text, file.name);
}

export function parseImportText(text: string, sourceName = "pasted") {
  const clean = stripBom(String(text || "")).trim();
  if (!clean) throw new Error(t("nothingToImport"));
  const ext = fileExtension(sourceName);
  if (ext === "json" || clean.startsWith("[") || clean.startsWith("{")) {
    return parseJsonImport(clean, sourceName);
  }
  return parseDelimitedImport(clean, sourceName);
}

async function parseExcelImport(buffer: ArrayBuffer, sourceName: string) {
  const xlsx = await loadExcel();
  const workbook = xlsx.read(buffer, { type: "array", cellDates: true });
  const rows = [];
  for (const sheetName of workbook.SheetNames || []) {
    const sheet = workbook.Sheets[sheetName];
    const matrix = xlsx.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: false, defval: "" });
    rows.push(...rowsFromMatrix(matrix, sourceName, sheetName));
  }
  return normalizeImportRows(rows, sourceName);
}

function parseJsonImport(text: string, sourceName: string) {
  let value;
  try { value = JSON.parse(text); }
  catch (err) { throw new Error(t("couldNotParseJson", { reason: String(err instanceof Error ? err.message : String(err)) })); }
  const rows = Array.isArray(value) ? value : (Array.isArray(value?.rows) ? value.rows : [value]);
  return normalizeImportRows(rows, sourceName);
}

function parseDelimitedImport(text: string, sourceName: string) {
  const delimiter = fileExtension(sourceName) === "tsv"
    ? "\t"
    : (countDelimiter(text, "\t") > countDelimiter(text, ",") ? "\t" : ",");
  const matrix = parseDelimitedRows(text, delimiter);
  return normalizeImportRows(rowsFromMatrix(matrix, sourceName, ""), sourceName);
}

function rowsFromMatrix(matrix: unknown[][], sourceName: string, sheetName: string) {
  const rows = (Array.isArray(matrix) ? matrix : [])
    .filter(row => Array.isArray(row) && row.some(cell => String(cell ?? "").trim() !== ""));
  if (!rows.length) return [];
  const headers = rows[0].map((cell, index) => normalizeImportHeader(cell, index));
  return rows.slice(1)
    .filter(row => row.some(cell => String(cell ?? "").trim() !== ""))
    .map((row, rowIndex) => {
      const item: ImportedRow = {};
      headers.forEach((header, index) => {
        item[header] = row[index] ?? "";
      });
      item._sourceRow = rowIndex + 2;
      if (sourceName) item._sourceFile = sourceName;
      if (sheetName) item._sourceSheet = sheetName;
      return item;
    });
}

export function parseDelimitedRows(text: string, delimiter: string) {
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;
  const value = String(text || "");
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (ch === '"') {
      if (inQuotes && value[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === delimiter && !inQuotes) {
      row.push(cell);
      cell = "";
    } else if ((ch === "\n" || ch === "\r") && !inQuotes) {
      if (ch === "\r" && value[i + 1] === "\n") i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += ch;
    }
  }
  row.push(cell);
  rows.push(row);
  return rows;
}

function normalizeImportRows(rows: unknown, sourceName = ""): ImportedRow[] {
  const list = Array.isArray(rows) ? rows : [rows];
  return list
    .map((row) => {
      if (!row || typeof row !== "object" || Array.isArray(row)) return null;
      const out: ImportedRow = {};
      for (const [key, value] of Object.entries(row)) {
        const cleanKey = String(key || "").trim();
        if (!cleanKey) continue;
        out[cleanKey] = value == null ? "" : value;
      }
      if (sourceName && !out._sourceFile) out._sourceFile = sourceName;
      return Object.keys(out).length ? out : null;
    })
    .filter((row): row is ImportedRow => Boolean(row));
}

function normalizeImportHeader(value: unknown, index: number) {
  const text = String(value ?? "").trim();
  return text || `field_${index + 1}`;
}


export function tableNameFromFilename(filename = "") {
  const base = String(filename || "")
    .split(/[\\/]/)
    .pop()!
    .replace(/\.[^.]+$/, "")
    .trim();
  return base || "";
}


function stripBom(text: string) {
  return String(text || "").replace(/^\uFEFF/, "");
}

export function countDelimiter(text: string, delimiter: string) {
  const firstLines = text.split(/\r?\n/).slice(0, 5).join("\n");
  return firstLines.split(delimiter).length - 1;
}

function fileExtension(filename = "") {
  return String(filename).split("?")[0].split("#")[0].split(".").pop()?.toLowerCase() || "";
}

export function isImportableFilename(filename = "") {
  return ["csv", "tsv", "json", "xlsx", "xls"].includes(fileExtension(filename));
}

export function inferImportMime(filename = "") {
  const ext = fileExtension(filename);
  if (ext === "json") return "application/json";
  if (ext === "csv") return "text/csv";
  if (ext === "tsv") return "text/tab-separated-values";
  return "application/octet-stream";
}

export function downloadDisplayName(item: { filename?: string; url?: string }) {
  return String(item?.filename || item?.url || "download")
    .split(/[\\/]/)
    .pop()!
    .split("?")[0]
    .split("#")[0] || "download";
}
