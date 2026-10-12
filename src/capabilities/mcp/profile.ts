import { t } from "./i18n.js";
import type { RendererServices } from "#sdk/sidepanel";
import { formatMcpHeadersMeta } from "#sdk/sidepanel/components";
import * as presentation from "#sdk/sidepanel/presentation";
import { record, type ToolEvent } from "#sdk/sidepanel/presentation";

type Data = Record<string, unknown>;
type McpHelpers = Pick<RendererServices["generic"],
  "appendJsonCodeBlock"
> & {
  renderStructured?: (parent: HTMLElement, renderer: Data, data: Data, plugin: Data | null) => unknown;
  normalizeRendererData?: (value: Data) => unknown;
  stripSkillMetadata?: (value: Data) => unknown;
};

import { toolKey } from "#sdk/sidepanel/presentation";

export function createMcpProfile(helpers: McpHelpers) {
  const { appendJsonCodeBlock, renderStructured = () => false, normalizeRendererData = value => value, stripSkillMetadata = value => value } = helpers;

function appendMcpProfile(parent: HTMLElement, tool: ToolEvent = {}, result: unknown, originalResult: unknown) {
  const data = record(result);
  const name = toolKey(tool.name);
  if (name === "mcp_list_tools" || name === "mcp_search_tools") {
    return appendMcpToolsProfile(parent, name, record(tool.args), data);
  }
  if (name === "mcp_inspect_server") {
    return appendMcpInspectProfile(parent, record(tool.args), data);
  }
  if (name === "mcp_call_tool") {
    return appendMcpCallProfile(parent, name, record(tool.args), data || originalResult);
  }
  return false;
}

function appendMcpToolsProfile(parent: HTMLElement, toolName = "", args: Data = {}, data: Data = {}) {
  const tools = Array.isArray(data.tools) ? data.tools : [];
  const servers = Array.isArray(data.servers) ? data.servers : [];
  const query = data.query || args.query || "";
  presentation.appendCompactLine(parent, {
    title: toolName === "mcp_search_tools" ? t("mcpSearch", { query: String(query ? ` · ${query}` : "") }) : t("mcpTools"),
    subtitle: data.registry || "",
    meta: [
      tools.length ? t("tools", { count: String(tools.length) }) : "",
      servers.length ? t("mcpServers", { count: String(servers.length) }) : "",
      data.count != null ? `count ${data.count}` : "",
    ].filter(Boolean),
  });
  appendMcpServerList(parent, servers);
  appendMcpToolList(parent, tools);
  appendMcpErrors(parent, data.errors);
  return true;
}

function appendMcpInspectProfile(parent: HTMLElement, args: Data = {}, data: Data = {}) {
  const server = record(data.server);
  const tools = Array.isArray(data.tools) ? data.tools : [];
  presentation.appendCompactLine(parent, {
    title: server.name || args.name || "MCP Server",
    subtitle: server.url || args.url || "",
    meta: [
      t("tools", { count: String(tools.length || data.toolCount || 0) }),
      server.transport || server.type || "",
      data.cachedAt ? t("cached", { count: String(presentation.formatDateLike(data.cachedAt) || data.cachedAt) }) : "",
    ].filter(Boolean),
  });
  if (data.serverInfo && typeof data.serverInfo === "object" && Object.keys(data.serverInfo).length) {
    presentation.appendKeyValueSection(parent, "Server", presentation.pickReadableFields(data.serverInfo), { compact: true });
  }
  appendMcpToolList(parent, tools);
  appendMcpMetadataList(parent, t("resources"), record(data.resources).resources || []);
  appendMcpMetadataList(parent, t("resourceTemplates"), record(data.resources).resourceTemplates || []);
  appendMcpMetadataList(parent, "Prompts", record(data.prompts).prompts || []);
  appendMcpErrors(parent, data.errors);
  return true;
}

function appendMcpCallProfile(parent: HTMLElement, _toolName = "", args: Data = {}, data: unknown = {}) {
  const result = record(data);
  presentation.appendCompactLine(parent, {
    title: result.tool || args.tool || t("mcpCall"),
    subtitle: [
      result.server || args.name || args.url || "",
      result.pluginName || "",
    ].filter(Boolean).join(" · "),
    meta: [
      result.isError ? "isError" : (result.ok === false ? t("incomplete") : t("completed")),
      Array.isArray(result.content) ? t("contentBlocks", { count: String(result.content.length) }) : "",
      result.structuredContent !== undefined ? "structuredContent" : "",
      result.text ? presentation.formatTextSize(result.text) : "",
    ].filter(Boolean),
  });
  if (!appendMcpRendererFallback(parent, result)) {
    appendJsonCodeBlock(parent, "MCP result", stripSkillMetadata(result));
  }
  return true;
}

function appendMcpRendererFallback(parent: HTMLElement, result: Data = {}) {
  const data = record(normalizeRendererData(result));
  if (data?.structuredContent !== undefined) {
    const renderer = inferMcpStructuredRenderer(data.structuredContent);
    if (renderStructured(parent, renderer, data, result._plugin ? record(result._plugin) : null)) return true;
  }
  if (data?.text) {
    const renderer = looksLikeMarkdown(data.text)
      ? { type: "markdown", title: t("mcpText"), valuePath: "text" }
      : { type: "text", title: t("mcpText"), valuePath: "text" };
    if (renderStructured(parent, renderer, data, result._plugin ? record(result._plugin) : null)) return true;
  }
  if (Array.isArray(result?.content) && result.content.length) {
    appendMcpContentList(parent, result.content);
    return true;
  }
  return false;
}

function inferMcpStructuredRenderer(input: unknown = undefined): Data {
  if (Array.isArray(input)) {
    return inferMcpArrayRenderer(input, "items");
  }
  if (!input || typeof input !== "object") {
    return { type: "fields", title: t("structuredContent") };
  }

  const structured = record(input);
  if (typeof structured.markdown === "string") {
    return { type: "markdown", title: t("structuredContent"), valuePath: "markdown" };
  }
  if (typeof structured.code === "string") {
    return { type: "code", title: t("structuredContent"), valuePath: "code", languagePath: "language", filenamePath: "filename" };
  }
  if (Array.isArray(structured.images)) {
    return { type: "image_grid", title: t("structuredContent"), itemsPath: "images" };
  }
  if (Array.isArray(structured.nodes) || Array.isArray(structured.lines)) {
    return { type: "tree", title: t("structuredContent") };
  }
  if (structured.patch != null || structured.diff != null || Array.isArray(structured.changes)) {
    return { type: "diff", title: t("structuredContent") };
  }
  if (structured.body != null && (structured.title != null || Array.isArray(structured.comments))) {
    return { type: "article", title: t("structuredContent") };
  }

  for (const path of ["rows", "items", "records"]) {
    if (Array.isArray(structured[path])) return inferMcpArrayRenderer(structured[path], path);
  }
  const arrayFields = Object.entries(structured).filter(([, value]) => Array.isArray(value));
  if (arrayFields.length === 1) {
    return inferMcpArrayRenderer(arrayFields[0][1], arrayFields[0][0]);
  }
  return { type: "fields", title: t("structuredContent") };
}

function inferMcpArrayRenderer(value: unknown = [], path = "items"): Data {
  const items: unknown[] = Array.isArray(value) ? value : [];
  const title = t("structuredContent");
  if (items.length && items.every(item => item == null || ["string", "number", "boolean"].includes(typeof item))) {
    return { type: "chips", title, itemsPath: path };
  }
  if (items.length && items.every(isMcpImageRecord)) {
    return { type: "image_grid", title, itemsPath: path };
  }
  if (items.length && items.every(isMcpTreeRecord)) {
    return { type: "tree", title, valuePath: path };
  }
  if (items.length && items.every(isMcpListRecord)) {
    return { type: "list", title, itemsPath: path };
  }
  if (items.length && items.every(isMcpFlatRecord)) {
    return { type: "table", title, itemsPath: path };
  }
  return { type: "records", title, itemsPath: path };
}

function isMcpImageRecord(value: unknown) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && [record(value).url, record(value).src, record(value).imageUrl, record(value).thumbnail].some(item => typeof item === "string" && item.trim()));
}

function isMcpTreeRecord(value: unknown) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && (Number.isFinite(Number(record(value).depth)) || record(value).selector)
    && (record(value).name || record(value).text || record(value).title));
}

function isMcpListRecord(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const hasTitle = [record(value).title, record(value).name, record(value).label].some(item => typeof item === "string" && item.trim());
  const hasDescription = [record(value).url, record(value).href, record(value).description, record(value).subtitle].some(item => typeof item === "string" && item.trim());
  return hasTitle && hasDescription;
}

function isMcpFlatRecord(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  return entries.length > 0 && entries.length <= 16 && entries.every(([, item]) => (
    item == null || ["string", "number", "boolean"].includes(typeof item)
  ));
}

function appendMcpServerList(parent: HTMLElement, servers: unknown = []) {
  const rows = Array.isArray(servers) ? servers.map(record) : [];
  if (!rows.length) return false;
  presentation.appendSlimList(parent, "MCP", rows, server => ({
    title: [server.enabled === false ? t("disabled") : "MCP HTTP", server.name || server.id || "default"].filter(Boolean).join(" · "),
    subtitle: [server.ref, server.url].filter(Boolean).join(" · "),
    meta: [
      server.active === false ? t("inactive") : "",
      Array.isArray(server.boundTools) ? t("boundTools", { count: String(server.boundTools.length) }) : "",
      formatMcpHeadersMeta(server),
    ].filter(Boolean),
  }));
  return true;
}


function appendMcpToolList(parent: HTMLElement, tools: unknown = []) {
  const rows = Array.isArray(tools) ? tools.map(record) : [];
  if (!rows.length) return false;
  presentation.appendSlimList(parent, t("toolsLabel"), rows, tool => {
    const properties = record(tool.inputSchema).properties && typeof record(tool.inputSchema).properties === "object"
      ? Object.keys(record(record(tool.inputSchema).properties))
      : [];
    return {
      title: tool.title || tool.name || "tool",
      subtitle: [tool.name, tool.description, tool.server].filter(Boolean).join(" · "),
      meta: [
        record(tool.pluginTool).title || record(tool.pluginTool).localName || "",
        record(tool.renderer).type ? `UI: ${record(tool.renderer).type}` : "",
        properties.length ? t("parameters", { count: String(properties.length) }) : "",
      ].filter(Boolean),
    };
  });
  return true;
}

function appendMcpMetadataList(parent: HTMLElement, title = "", items: unknown = []) {
  const rows = Array.isArray(items) ? items.map(record) : [];
  if (!rows.length) return false;
  presentation.appendSlimList(parent, title, rows, item => ({
    title: item.name || item.uri || item.uriTemplate || "item",
    subtitle: item.description || item.uri || item.uriTemplate || "",
    meta: [item.mimeType].filter(Boolean),
  }));
  return true;
}

function appendMcpContentList(parent: HTMLElement, content: unknown = []) {
  presentation.appendSlimList(parent, t("mcpContent"), Array.isArray(content) ? content : [], (item: unknown, index) => ({
    title: record(item).type || `content ${index + 1}`,
    subtitle: record(item).text || record(item).uri || record(item).mimeType || presentation.summarizeValue(item, 180),
    meta: [record(item).mimeType].filter(Boolean),
  }));
}

function appendMcpErrors(parent: HTMLElement, errors: unknown = []) {
  const rows = Array.isArray(errors) ? errors.filter(Boolean).map(record) : [];
  if (!rows.length) return false;
  presentation.appendSlimList(parent, t("error"), rows, item => ({
    title: item.code || item.section || item.server || "MCP error",
    subtitle: item.message || "",
    meta: [item.server, item.pluginId, item.skillName].filter(Boolean),
  }));
  return true;
}

function looksLikeMarkdown(text: unknown = "") {
  const value = String(text || "");
  return /(^|\n)\s{0,3}(#{1,6}\s|\*\s+|-\s+|\d+\.\s+|```|\|.+\|)/.test(value);
}

  return {
    render: appendMcpProfile,
    renderCall: appendMcpCallProfile,
  };
}
