import { t } from "./i18n.js";
import type { RendererServices } from "#sdk/sidepanel";
import { formatMcpHeadersMeta } from "#sdk/sidepanel/components";
import { appendChanges, changePreview } from "#sdk/sidepanel/components";
import {
  normalizeSkillProfileData, resourceDisplaySize, skillResourcesForDisplay, skillMcpSummaryForDisplay,
  mcpDisplayHost, skillContentText, collectSkillChangeItems,
} from "./presentation.js";
import * as presentation from "#sdk/sidepanel/presentation";
import { appendHtmlSection } from "#sdk/sidepanel/dom";
import { record } from "#sdk/sidepanel/presentation";
import type { ToolView } from "#sdk/sidepanel";
import type { createDataTableRenderer } from "#sdk/sidepanel/components";

type Data = Record<string, unknown>;
type SkillHelpers = Pick<RendererServices["generic"], "describeToolRun" | "appendMarkdownSection"> & {
  appendDataRowsTable: ReturnType<typeof createDataTableRenderer>["appendRowsTable"];
};
interface ResourcePreview { content?: string; path?: unknown; language?: string; type?: unknown; truncated?: boolean }

import { escapeHtml } from "#sdk/sidepanel/dom";
import { highlightCode } from "#sdk/sidepanel/dom";
import { getToolDisplayName } from "#sdk/sidepanel/presentation";


export function createSkillProfiles(helpers: SkillHelpers) {
  const { appendDataRowsTable, appendMarkdownSection, describeToolRun } = helpers;

function appendSkillProfile(parent: HTMLElement, toolName: string, args: Data, result: unknown, options: { state?: Data } = {}) {
  if (toolName === "delete_skill") return appendDeleteSkillProfile(parent, args, result);
  if (toolName === "load_skill_resource" || toolName === "edit_skill_resource") return appendSkillResourceProfile(parent, args, result, { toolName });
  const skill = normalizeSkillProfileData(args, result);
  const changes = toolName === "update_skill" ? collectSkillChangeItems(args, result) : [];
  const content = toolName === "create_skill" ? skillContentText(args) : null;
  const resources = skillResourcesForDisplay(args, skill);
  const mcpSummary = skillMcpSummaryForDisplay(args, skill);
  const stateTitle = String(options.state?.title || "").trim();
  presentation.appendCompactLine(parent, {
    title: stateTitle && (skill.name || args.name)
      ? `${stateTitle} · ${skill.name || args.name}`
      : (skill.name || args.name || stateTitle || describeToolRun(toolName, args, result, true)),
    subtitle: skill.description || "",
    meta: [
      skill.scope,
      content ? t("characters", { count: String(content.length) }) : "",
      changes.length ? t("changeCount", { count: String(changes.length) }) : "",
      resources.length ? t("resourceCount", { count: String(resources.length) }) : "",
      mcpSummary.serverCount ? t("mcpServers", { count: String(mcpSummary.serverCount) }) : "",
    ].filter(Boolean),
  });
  if (toolName === "create_skill") appendSkillContentPreview(parent, content);
  if (["load_skill", "create_skill"].includes(toolName)) appendSkillResources(parent, resources);
  if (["load_skill", "create_skill", "update_skill"].includes(toolName)) appendSkillMcpSummary(parent, mcpSummary);
  if (toolName === "update_skill") appendChanges(parent, changes);
  return true;
}

function appendSkillResourceProfile(parent: HTMLElement, args: Data, result: unknown, options: { toolName?: string; preparing?: boolean } = {}) {
  const data = record(result);
  const content = typeof args.content === "string"
    ? args.content
    : (typeof data.content === "string" ? data.content : "");
  const path = data.path || args.path || "";
  const skillName = data.name || args.name || "";
  const resourceType = args.type || data.type || "";
  const documentInfo = data.document && typeof data.document === "object" ? record(data.document) : null;
  const language = presentation.codeLanguageForFilename(path) || codeLanguageForResourceType(resourceType);
  const range = resourceSliceRange(data);
  const isEdit = options.toolName === "edit_skill_resource";
  const previewChanges = isEdit
    ? collectSkillChangeItems(args, data).filter(change => changePreview(change).trim())
    : [];
  if (options.preparing && isEdit && !content && !previewChanges.length) return false;
  presentation.appendCompactLine(parent, {
    title: path || data.title || t("resourceFile"),
    subtitle: args.description || data.description || (skillName ? t("from", { source: String(skillName) }) : ""),
    meta: [
      resourceType,
      data.format || documentInfo?.format || "",
      documentInfo?.docModelId ? t("documentModel") : "",
      resourceDisplaySize(data.size, content),
      range,
      data.truncated ? t("truncated") : "",
    ].filter(Boolean),
  });
  if (documentInfo && Array.isArray(data.rows)) {
    appendDataRowsTable(parent, String(data.sheetName || t("tablePreview")), data.rows);
  } else if (documentInfo && content) {
    if (data.contentFormat === "markdown") appendMarkdownSection(parent, t("documentPreview"), content);
    else presentation.appendTextSection(parent, t("documentPreview"), content);
  } else if (content || !isEdit) {
    appendSkillResourceContent(parent, {
      content,
      path,
      language,
      type: resourceType,
      truncated: Boolean(data.truncated),
    });
  } else if (previewChanges.length) {
    appendChanges(parent, previewChanges);
  } else {
    appendSkillResourceEditSummary(parent, args, data);
  }
  if (documentInfo) {
    presentation.appendNoteSection(
      parent,
      data.truncated ? t("continueReading") : t("documentParsed"),
      data.truncated
        ? t("docmodelidLoadQingzhouDocumentsThenUseDocumentReadChunkTo", { id: String(documentInfo.docModelId) })
        : t("parsedAsByTheDocumentPipeline", { format: String(data.format || documentInfo.format || documentInfo.type || "document") }),
    );
  }
  return true;
}

function appendPreparingSkillProfile(parent: HTMLElement, tool: ToolView, status: ToolView["status"], state: Data = {}) {
  const args = tool.args && typeof tool.args === "object" && !Array.isArray(tool.args) ? tool.args : {};
  const content = tool.name === "create_skill" ? skillContentText(args) : null;
  const resources = skillResourcesForDisplay(args);
  const mcpSummary = skillMcpSummaryForDisplay(args);
  const changes = tool.name === "update_skill" ? collectSkillChangeItems(args, {}) : [];
  const resourceChanges = tool.name === "edit_skill_resource"
    ? collectSkillChangeItems(args, {}).filter(change => changePreview(change).trim())
    : [];
  const hasReadableDetails = Boolean(content || resources.length || mcpSummary.serverCount || changes.length || resourceChanges.length);
  const stateTitle = String(state.title || "").trim();
  const stateSubtitle = String(state.subtitle || "").trim();
  presentation.appendCompactLine(parent, {
    title: stateTitle || `${status.title} · ${getToolDisplayName(tool.name)}`,
    subtitle: args.name ? String(args.name) : (stateSubtitle || t("preparingToolArguments")),
    meta: [
      content ? t("characters", { count: String(content.length) }) : "",
      changes.length ? t("changeCount", { count: String(changes.length) }) : "",
      resourceChanges.length ? t("changeCount", { count: String(resourceChanges.length) }) : "",
      resources.length ? t("resourceCount", { count: String(resources.length) }) : "",
      mcpSummary.serverCount ? t("mcpServers", { count: String(mcpSummary.serverCount) }) : "",
      !content && tool.rawArgsText ? t("characters", { count: String(tool.rawArgsText.length) }) : "",
    ].filter(Boolean),
  });
  if (tool.name === "create_skill") {
    appendSkillContentPreview(parent, content, { streaming: true });
    appendSkillResources(parent, resources);
    appendSkillMcpSummary(parent, mcpSummary);
  } else if (tool.name === "edit_skill_resource") {
    appendSkillResourceProfile(parent, args, {}, { toolName: tool.name, preparing: true });
  } else if (changes.length) {
    appendChanges(parent, changes, { title: t("pendingChanges") });
  }
  if (!hasReadableDetails) {
    presentation.appendCompactParams(parent, tool.name, args);
    if (tool.rawArgsText && presentation.isEmptyJsonObject(args)) {
      presentation.appendTextSection(parent, t("argumentFragment"), presentation.summarizeValue(tool.rawArgsText, 1200));
    }
  }
  return true;
}

  return {
    render: appendSkillProfile,
    renderPreparing: appendPreparingSkillProfile,
  };
}

function appendSkillResourceEditSummary(parent: HTMLElement, args: Data = {}, data: Data = {}) {
  const changes = Array.isArray(data.changes) ? data.changes.map(record) : [];
  if (changes.length) {
    presentation.appendSlimList(parent, t("changes"), changes, change => ({
      title: [
        presentation.fieldLabel(change.action || change.kind || "edit"),
        change.path || change.resource || change.file || change.field || "",
      ].filter(Boolean).join(" · "),
      subtitle: [
        change.count != null ? t("changeLocationCount", { count: String(change.count) }) : "",
        change.applied != null ? `applied ${change.applied}` : "",
        change.alreadyApplied != null ? `already ${change.alreadyApplied}` : "",
      ].filter(Boolean).join(" · "),
      meta: [change.lineEnding, change.firstChangedLine ? `L${change.firstChangedLine}` : ""].filter(Boolean),
    }));
    return true;
  }
  const path = data.path || args.path || "";
  const action = presentation.fieldLabel(args.action || data.action || "edit");
  presentation.appendNoteSection(parent, t("resourceUpdated"), t("completed", { path: String(path || t("resourceFile")), action: String(action ? ` ${action}` : "") }));
  return true;
}

function appendSkillResourceContent(parent: HTMLElement, { content = "", path = "", language = "", type = "", truncated = false }: ResourcePreview = {}) {
  const section = document.createElement("div");
  section.className = "tool-friendly-section tool-skill-resource-section";

  const head = document.createElement("div");
  head.className = "tool-skill-resource-head";

  const title = document.createElement("div");
  title.className = "tool-skill-resource-title";
  title.textContent = t("resourceContent");

  const meta = document.createElement("div");
  meta.className = "tool-skill-resource-meta";
  meta.textContent = [language || type || "", path ? presentation.basename(path) : "", truncated ? t("truncatedFragment") : ""]
    .filter(Boolean)
    .join(" · ");

  head.append(title, meta);

  const pre = document.createElement("pre");
  const highlighted = highlightCode(content, language, { autoDetect: !language && content.length <= 20000 });
  pre.className = "code-block tool-skill-resource-code hljs";
  pre.dataset.toolScrollSurface = "resource-code";
  pre.dataset.toolStreamSurface = "40";
  if (highlighted.language) pre.classList.add(`language-${highlighted.language}`);
  pre.innerHTML = highlighted.html || "";

  section.append(head, presentation.createCopyableCodeBlock(pre, content));
  if (!content) {
    const empty = document.createElement("div");
    empty.className = "tool-more-hint";
    empty.textContent = t("resourceContentIsEmpty");
    section.appendChild(empty);
  } else if (truncated) {
    const hint = document.createElement("div");
    hint.className = "tool-more-hint";
    hint.textContent = t("onlyTheCurrentFragmentIsShownUseStartMaxcharsTo");
    section.appendChild(hint);
  }
  parent.appendChild(section);
}

function appendSkillResources(parent: HTMLElement, resources: unknown[]) {
  const items = Array.isArray(resources) ? resources : [];
  if (!items.length) return;
  presentation.appendSlimList(parent, t("resources"), items, (item: unknown) => {
    const resource = typeof item === "string" ? { path: item } : record(item);
    const size = resource.size ?? (typeof resource.content === "string" ? resource.content.length : null);
    return {
      title: resource.path || resource.title || t("resources"),
      subtitle: [resource.type, size != null ? presentation.formatBytes(size) || t("characters", { count: String(size) }) : "", resource.description || resource.title].filter(Boolean).join(" · "),
    };
  });
}

export function appendSkillMcpSummary(parent: HTMLElement, summary: Data = {}) {
  const servers = Array.isArray(summary.servers) ? summary.servers.map(record) : [];
  if (!servers.length) return false;
  presentation.appendSlimList(parent, "MCP", servers, server => {
    const tools = Array.isArray(server.tools) ? server.tools.map(record) : [];
    const toolCount = Number(server.toolCount) || tools.length;
    const host = server.host || mcpDisplayHost(server.url) || "";
    const toolNames = tools.map(tool => tool.title || tool.localName || tool.name || tool.mcpTool).filter(Boolean);
    return {
      title: [server.enabled === false ? t("disabled") : "MCP HTTP", server.name || server.id || "default"].filter(Boolean).join(" · "),
      subtitle: [host, toolCount ? t("boundTools", { count: String(toolCount) }) : "", server.ref].filter(Boolean).join(" · "),
      meta: [
        formatMcpHeadersMeta(server),
        toolNames.length ? `tools: ${toolNames.slice(0, 4).join(", ")}${toolNames.length > 4 ? "…" : ""}` : "",
      ].filter(Boolean),
    };
  });
  return true;
}

function resourceSliceRange(data: Data = {}) {
  const start = Number(data.start);
  const end = Number(data.end);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return "";
  if (start <= 0 && end >= Number(data.size || end)) return "";
  return `${Math.max(0, start)}-${Math.max(0, end)}`;
}

function codeLanguageForResourceType(type: unknown = "") {
  const value = String(type || "").toLowerCase();
  const map: Record<string, string> = {
    bash: "bash",
    css: "css",
    html: "html",
    javascript: "javascript",
    json: "json",
    markdown: "markdown",
    md: "markdown",
    script: "javascript",
    shell: "bash",
    text: "plaintext",
    typescript: "typescript",
    xml: "xml",
    yaml: "yaml",
    yml: "yaml",
  };
  return map[value] || "";
}


function appendSkillContentPreview(parent: HTMLElement, content: unknown, { streaming = false } = {}) {
  if (content == null || content === "") return false;
  appendHtmlSection(parent, "tool-friendly-section tool-skill-content-section", `
    <div class="tool-section-title">${escapeHtml(streaming ? t("generatingSkillContent") : t("skillContentPreview"))}</div>
    <div class="tool-text-preview tool-skill-content-preview" data-tool-scroll-surface="skill-content" data-tool-stream-surface="20">${escapeHtml(content)}</div>
  `);
  return true;
}

export function appendDeleteSkillProfile(parent: HTMLElement, args: Data, result: unknown) {
  const data = record(result);
  const name = data.name || record(data.deleted).name || args.name || "skill";
  const deleted = data.deleted === true || Boolean(record(data.deleted).name) || data.ok === true;
  appendHtmlSection(parent, `tool-danger-result ${deleted ? "" : "tool-danger-result-muted"}`, `
    <div class="tool-danger-title">${escapeHtml(deleted ? t("skillDeleted") : t("skillNotDeleted"))}</div>
    <div class="tool-danger-subtitle">${escapeHtml(name)}</div>
    <div class="tool-compact-meta">
      ${[data.scope || record(data.deleted).scope, Array.isArray(data.resources) ? `${data.resources.length} resources` : "", data.updatedAt ? `updated ${presentation.formatDateLike(data.updatedAt)}` : ""]
        .filter(Boolean)
        .map(item => `<span>${escapeHtml(presentation.summarizeValue(item, 80))}</span>`)
        .join("")}
    </div>
  `);
  if (data.error || data.code) presentation.appendErrorSection(parent, data);
  return true;
}

