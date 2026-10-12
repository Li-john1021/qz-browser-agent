import { t } from "../i18n/index.js";
export function escapeHtml(value: unknown) {
  const div = document.createElement("div");
  div.textContent = value == null ? "" : String(value);
  return div.innerHTML;
}

/** Escape text for a double-quoted HTML attribute assembled as a string. */
export function escapeHtmlAttribute(value: unknown) {
  return escapeHtml(value).replace(/"/g, "&quot;");
}

export function safeFilename(value: unknown) {
  return String(value || "session")
    .replace(/[\\/:*?"<>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80) || "session";
}

export function hashText(value: unknown = "") {
  let hash = 5381;
  const source = String(value || "");
  for (let index = 0; index < source.length; index += 1) {
    hash = ((hash << 5) + hash) ^ source.charCodeAt(index);
  }
  return (hash >>> 0).toString(36);
}

export async function copyPlainText(text: unknown) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(String(text ?? ""));
    return;
  }
  fallbackCopyText(text);
}

export function fallbackCopyText(text: unknown) {
  const textarea = document.createElement("textarea");
  textarea.value = String(text ?? "");
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.top = "-1000px";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  const ok = document.execCommand("copy");
  textarea.remove();
  if (!ok) throw new Error("copy failed");
}

export function rowsToTsv(rows: unknown[] = [], columns?: unknown[]) {
  const normalizedRows = (Array.isArray(rows) ? rows : [])
    .map(row => (row && typeof row === "object" && !Array.isArray(row)) ? row as Record<string, unknown> : { value: row });
  const tableColumns = Array.isArray(columns) && columns.length
    ? columns.map(column => String(column ?? ""))
    : inferTsvColumns(normalizedRows);
  if (!tableColumns.length) return "";
  const lines = [
    tableColumns.map(formatTsvCell).join("\t"),
    ...normalizedRows.map(row => tableColumns.map(column => formatTsvCell(row?.[column])).join("\t")),
  ];
  return lines.join("\n");
}

function inferTsvColumns(rows: Record<string, unknown>[] = []) {
  const columns: string[] = [];
  const seen = new Set();
  for (const row of rows) {
    for (const key of Object.keys(row || {})) {
      if (seen.has(key)) continue;
      seen.add(key);
      columns.push(key);
    }
  }
  return columns;
}

function formatTsvCell(value: unknown) {
  if (value == null) return "";
  let text;
  if (typeof value === "string") text = value;
  else if (typeof value === "number" || typeof value === "boolean") text = String(value);
  else {
    try { text = JSON.stringify(value); }
    catch(_err) { text = String(value); }
  }
  return String(text)
    .replace(/\r\n|\r|\n/g, " ")
    .replace(/\t/g, " ")
    .trim();
}

/** Shared native-DOM section construction. The caller owns escaping dynamic template values. */
export function appendHtmlSection(parent: HTMLElement, className: string, html: string) {
  const section = document.createElement("div");
  section.className = className;
  section.innerHTML = html;
  parent.appendChild(section);
  return section;
}

export function createCodeCopyButton(label = t("copyCode")) {
  const button = document.createElement("button");
  button.className = "qz-icon-btn qz-icon-btn--xs code-copy-btn";
  button.type = "button";
  button.title = label;
  button.setAttribute("aria-label", label);
  button.innerHTML = `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="8" y="8" width="10" height="12" rx="2"/><path d="M6 16H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
  return button;
}

export function readFileAsDataUrl(file: File, errorMessage = "Failed to read file") {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error(errorMessage));
    reader.readAsDataURL(file);
  });
}

export function formatFileSize(value: unknown) {
  const size = Math.max(0, Number(value) || 0);
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(size < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

export function formatTokenCount(value: unknown) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n >= 1000000) return `${Math.round(n / 100000) / 10}M`;
  if (n >= 1000) return `${Math.round(n / 100) / 10}k`;
  return String(Math.round(n));
}

export function formatContextUsageText(inputTokensEstimate: unknown, contextWindow: unknown): string {
  if (!inputTokensEstimate) return "";
  const windowText = contextWindow ? `/${formatTokenCount(contextWindow)}` : "";
  return `ctx ${formatTokenCount(inputTokensEstimate)}${windowText}`;
}
