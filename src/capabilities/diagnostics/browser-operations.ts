import { t } from "./i18n.js";
import * as presentation from "#sdk/sidepanel/presentation";
import { appendHtmlSection, escapeHtml } from "#sdk/sidepanel/dom";
import { record } from "#sdk/sidepanel/presentation";
import type { ProfileHelpers } from "#sdk/sidepanel/components";
type Data = Record<string, unknown>;

export function createDiagnosticProfiles(helpers: ProfileHelpers) {
  const { pageDisplayTarget, appendJsonCodeBlock } = helpers;

function appendConsoleProfile(parent: HTMLElement, args: Data, result: unknown) {
  const data = record(result);
  const rows = consoleRowsFromResult(data);
  presentation.appendCompactLine(parent, {
    title: data.watching ? t("consoleRecording") : t("consoleEntries"),
    subtitle: consoleFilterText(args),
    meta: [
      pageDisplayTarget(args, data, { maxLength: 36, fallbackToTabId: false }),
      data.records != null ? t("entries", { count: String(data.records) }) : (rows.length ? t("entries", { count: String(rows.length) }) : ""),
      data.totalBuffered != null ? t("buffer", { count: String(data.totalBuffered) }) : "",
      args.reset ? t("reset") : "",
    ].filter(Boolean),
  });
  if (rows.length) appendConsoleRows(parent, rows);
  else if (data.error || data.note) presentation.appendNoteSection(parent, data.error ? t("error") : t("notice"), presentation.summarizeValue(data.error || data.note, 260));
  return true;
}

function appendNetworkProfile(parent: HTMLElement, toolName: string, args: Data, result: unknown) {
  const data = record(result);
  if (toolName === "network_body") return appendNetworkBodyProfile(parent, args, result);
  const items = Array.isArray(result)
    ? result
    : Array.isArray(data.requests) ? data.requests
      : Array.isArray(data.results) ? data.results
        : Array.isArray(data.items) ? data.items : [];
  if (!items.length) return false;
  presentation.appendSlimList(parent, t("network"), items.map(record), item => ({
    title: item.method ? `${item.method} ${item.url || item.name || ""}` : item.url || item.name || t("request"),
    subtitle: item.type || item.mimeType || "",
    meta: [
      item.status,
      item.hasRequestBody ? t("hasRequestBody") : "",
      item.duration ? `${item.duration}ms` : "",
      item.durationMs ? `${item.durationMs}ms` : "",
      item.size ? presentation.formatBytes(item.size) : "",
      item.encodedDataLength ? presentation.formatBytes(item.encodedDataLength) : "",
    ].filter(Boolean),
  }));
  return true;
}

function appendNetworkBodyProfile(parent: HTMLElement, args: Data, result: unknown) {
  const data = record(result);
  const url = data.url || args.url || "";
  const bodyType = data.bodyType === "request" || args.bodyType === "request" ? "request" : "response";
  const bodyLabel = bodyType === "request" ? t("requestBody") : t("responseBody");
  const contentType = bodyType === "request" ? data.requestContentType : data.mimeType;
  presentation.appendCompactLine(parent, {
    title: `${data.method || ""} ${url ? summarizeUrlPath(url) : (args.requestId || bodyLabel)} ${data.status != null ? `· ${data.status}` : ""}`.trim(),
    subtitle: [contentType, data.size ? presentation.formatBytes(data.size) : "", data.truncated ? t("truncated") : data.body ? t("complete") : ""].filter(Boolean).join(" · "),
    meta: [
      data.requestId || args.requestId ? `request ${data.requestId || args.requestId}` : "",
      data.durationMs ? `${data.durationMs}ms` : "",
      data.encodedDataLength ? presentation.formatBytes(data.encodedDataLength) : "",
      data.base64Encoded ? "base64" : "",
    ].filter(Boolean),
  });
  if (data.body != null) appendJsonCodeBlock(parent, bodyLabel, data.body);
  else presentation.appendCompactParams(parent, "network_body", presentation.pickReadableFields(data, ["body", "bodyType", "requestContentType", "headers", "requests", "results", "items"]));
  return true;
}

function consoleRowsFromResult(data: Data = {}): unknown[] {
  if (Array.isArray(data.results)) return data.results;
  if (Array.isArray(data.records)) return data.records;
  if (Array.isArray(data.messages)) return data.messages;
  if (Array.isArray(data.items)) return data.items;
  return [];
}

function appendConsoleRows(parent: HTMLElement, rows: unknown[]) {
  const visibleRows = rows.slice(0, 12);
  appendHtmlSection(parent, "tool-console-list", `
    <div class="tool-slim-title">${escapeHtml(t("logs"))}${rows.length > visibleRows.length ? `<span>${escapeHtml(t("first"))} ${visibleRows.length} / ${rows.length}</span>` : ""}</div>
    <div class="tool-console-rows" data-tool-scroll-surface="console">
      ${visibleRows.map(item => renderConsoleRow(record(item))).join("")}
    </div>
  `);
}

function renderConsoleRow(item: Data = {}) {
  const level = consoleLevel(item);
  const message = consoleMessage(item);
  const source = consoleSource(item);
  const time = consoleTime(item);
  return `
    <div class="tool-console-row tool-console-row-${consoleLevelClass(level)}">
      <div class="tool-console-meta">
        <span class="tool-console-level">${escapeHtml(level)}</span>
        ${item.type && item.type !== level ? `<span>${escapeHtml(String(item.type))}</span>` : ""}
        ${time ? `<span>${escapeHtml(time)}</span>` : ""}
      </div>
      <div class="tool-console-message">${presentation.linkifyText(presentation.summarizeValue(message || item, 520))}</div>
      ${source ? `<div class="tool-console-source">${presentation.linkifyText(presentation.summarizeValue(source, 220))}</div>` : ""}
    </div>
  `;
}

function consoleLevel(item: Data = {}) {
  return String(item.level || item.severity || item.type || "log").toLowerCase();
}

function consoleLevelClass(level: unknown) {
  return String(level || "log").toLowerCase().replace(/[^a-z0-9_-]+/g, "-") || "log";
}

function consoleMessage(item: Data = {}) {
  if (item.text != null) return item.text;
  if (item.message != null) return item.message;
  if (item.value != null) return item.value;
  if (Array.isArray(item.args)) return item.args.map(arg => presentation.summarizeValue(arg, 120)).join(" ");
  return "";
}

function consoleSource(item: Data = {}) {
  const url = item.url || item.sourceUrl || record(item.location).url || "";
  const line = item.lineNumber ?? item.line ?? record(item.location).lineNumber;
  const column = item.columnNumber ?? item.column ?? record(item.location).columnNumber;
  if (!url) return "";
  if (line == null) return url;
  return `${url}:${line}${column != null ? `:${column}` : ""}`;
}

function consoleTime(item: Data = {}) {
  const value = item.timestamp || item.time || item.createdAt || "";
  if (!value) return "";
  return presentation.formatDateLike(value) || presentation.summarizeValue(value, 40);
}

function consoleFilterText(args: Data = {}) {
  const filters = [
    args.level ? `level=${args.level}` : "",
    args.type ? `type=${args.type}` : "",
    args.textPattern ? `text~/${args.textPattern}/` : "",
    args.urlPattern ? `url~/${args.urlPattern}/` : "",
  ].filter(Boolean);
  return filters.length ? filters.join(" · ") : "";
}

function summarizeUrlPath(url: unknown) {
  try {
    const parsed = new URL(String(url));
    return `${parsed.pathname}${parsed.search ? parsed.search.slice(0, 80) : ""}`;
  } catch (_err) {
    return presentation.summarizeValue(url, 100);
  }
}

  return { renderConsole: appendConsoleProfile, renderNetwork: appendNetworkProfile };
}
