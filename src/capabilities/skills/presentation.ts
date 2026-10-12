import { t } from "./i18n.js";
import { changePreview } from "#sdk/sidepanel/components";
import * as presentation from "#sdk/sidepanel/presentation";
import { record, type ToolEvent } from "#sdk/sidepanel/presentation";
import type { ToolPresentationDefinition } from "#sdk/sidepanel";
type Data = Record<string, unknown>;

import { parseSkillManifest, findSkillManifestResource } from "#sdk/shared/skills";
export function formatSkillArgsPreview(args: Record<string, unknown>, result: unknown, rawText = "", toolName = "") {
  const skill = normalizeSkillProfileData(args, result);
  const name = args.name || skill.name;
  const resources = skillResourcesForDisplay(args, skill);
  const mcpSummary = skillMcpSummaryForDisplay(args, skill);
  const content = toolName === "create_skill" ? skillContentText(args) : null;
  const changes = toolName === "update_skill" ? collectSkillChangeItems(args, result) : [];
  const parts = [
    name,
    content ? t("characters", { count: String(content.length) }) : "",
    changes.length ? t("changeCount", { count: String(changes.length) }) : "",
    resources.length ? t("resourceCount", { count: String(resources.length) }) : "",
    mcpSummary.serverCount ? t("mcpServers", { count: String(mcpSummary.serverCount) }) : "",
  ].filter(Boolean);
  if (parts.length) return `(${parts.map(item => presentation.summarizeValue(item, 48)).join(" · ")})`;
  return rawText ? t("argumentCharacters", { count: String(rawText.length) }) : "";
}

export function formatSkillResourceArgsPreview(args: Record<string, unknown>, result: unknown, rawText = "") {
  const data = record(result);
  const path = data.path || args.path;
  const size = resourceDisplaySize(data.size, data.content);
  const parts = [
    data.name || args.name,
    path,
    data.format || data.type,
    size,
    data.truncated ? t("truncated") : "",
  ].filter(Boolean);
  if (parts.length) return `(${parts.map(item => presentation.summarizeValue(item, 48)).join(" · ")})`;
  return rawText ? t("argumentCharacters", { count: String(rawText.length) }) : "";
}

export function normalizeSkillProfileData(args: Data = {}, result: unknown = {}): Data {
  const data = record(result);
  if (data.skill && typeof data.skill === "object") return record(data.skill);
  if (data.saved && typeof data.saved === "object") return record(data.saved);
  if (data.deleted && typeof data.deleted === "object") return record(data.deleted);
  if (result && typeof result === "object" && !Array.isArray(result)) return data;
  return { name: args.name };
}

export function resourceDisplaySize(size: unknown, content: unknown = "") {
  if (size === 0) return "0 B";
  const formatted = presentation.formatBytes(size);
  if (formatted) return formatted;
  if (typeof content === "string" && content.length) return presentation.formatTextSize(content);
  return "";
}

export function skillResourcesForDisplay(args: Data = {}, skill: Data = {}): unknown[] {
  if (Array.isArray(args.resources) && args.resources.length) return args.resources;
  if (Array.isArray(skill.resources) && skill.resources.length) return skill.resources;
  return [];
}

export function skillMcpSummaryForDisplay(args: Data = {}, skill: Data = {}) {
  const mcp = record(skill.mcp);
  const directServers: unknown[] = Array.isArray(skill.mcpServers)
    ? skill.mcpServers
    : (Array.isArray(mcp.servers) ? mcp.servers : []);
  if (directServers.length || Number(skill.mcpServerCount) > 0) {
    const servers = normalizeSkillMcpServersForDisplay(directServers);
    return {
      servers,
      serverCount: Number(skill.mcpServerCount) || servers.length,
      toolCount: Number(skill.mcpToolCount) || servers.reduce((sum, server) => sum + (Number(server.toolCount) || 0), 0),
    };
  }

  const resources = skillResourcesForDisplay(args, skill);
  const manifestResource = findSkillManifestResource(resources.map(record));
  if (!manifestResource || typeof manifestResource.content !== "string") {
    return { servers: [], serverCount: 0, toolCount: 0 };
  }
  const parsed = parseSkillManifest(manifestResource.content, skill);
  const plugin = parsed.plugin ? record(parsed.plugin) : null;
  if (!plugin) return { servers: [], serverCount: 0, toolCount: 0 };
  const servers = normalizeSkillMcpServersForDisplay((Array.isArray(plugin.mcpServers) ? plugin.mcpServers : []).map(record).map(server => ({
    ...server,
    ref: `${plugin.id || "plugin"}:${server.id || server.rawId || "default"}`,
    tools: skillMcpBoundToolsForDisplay(plugin, server),
  })));
  return {
    servers,
    serverCount: servers.length,
    toolCount: servers.reduce((sum, server) => sum + (Number(server.toolCount) || 0), 0),
  };
}

export function normalizeSkillMcpServersForDisplay(servers: unknown = []) {
  return (Array.isArray(servers) ? servers : []).map(record).map(server => {
    const tools = Array.isArray(server.tools)
      ? server.tools
      : (Array.isArray(server.boundTools) ? server.boundTools : []);
    const headerNames = Array.isArray(server.headerNames)
      ? server.headerNames
      : Object.keys(server.headers && typeof server.headers === "object" && !Array.isArray(server.headers) ? server.headers : {});
    return {
      id: server.id || server.rawId || server.name || "default",
      name: server.name || server.rawId || server.id || "default",
      ref: server.ref || "",
      enabled: server.enabled !== false,
      url: server.url || "",
      host: server.host || mcpDisplayHost(server.url),
      headers: { ...(server.headers && typeof server.headers === "object" && !Array.isArray(server.headers) ? server.headers : {}) },
      headerNames,
      toolCount: Number(server.toolCount) || tools.length,
      tools,
    };
  }).filter(server => server.id || server.name || server.url);
}

export function skillMcpBoundToolsForDisplay(plugin: Data = {}, server: Data = {}) {
  const serverIds = new Set([server.id, server.rawId, server.name].map(item => String(item || "").trim()).filter(Boolean));
  return (Array.isArray(plugin.tools) ? plugin.tools : []).map(record)
    .filter(tool => tool.runtime === "mcp" && tool.mcp && serverIds.has(String(record(tool.mcp).server || "").trim()))
    .filter(tool => !tool.hidden)
    .map(tool => ({
      name: tool.name,
      localName: tool.localName,
      title: tool.title,
      mcpTool: record(tool.mcp).tool,
    }));
}

export function mcpDisplayHost(value: unknown = "") {
  try {
    return new URL(String(value || "")).hostname.toLowerCase();
  } catch(_e) {
    return "";
  }
}

export function skillContentText(args: Data = {}) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return null;
  if (!Object.prototype.hasOwnProperty.call(args, "content")) return null;
  if (typeof args.content === "string") return args.content;
  if (args.content == null) return null;
  return presentation.summarizeValue(args.content, 1000000);
}

export function collectSkillChangeItems(args: Data = {}, result: unknown = {}) {
  const out: Data[] = [];
  const data = record(result);
  const resultChanges = Array.isArray(data.changes) ? data.changes.map(record) : [];
  for (const change of resultChanges) {
    if (!change || typeof change !== "object") continue;
    out.push({ kind: change.action || change.kind || "diff", ...change });
  }
  const resultHasRenderableChanges = out.some(change => changePreview(change).trim());
  if (resultHasRenderableChanges) return dedupeSkillChanges(out);

  const path = args.path || args.file || args.resource || "content";
  addSkillContentChange(out, "append", args.appendContent ?? args.append ?? args.contentToAppend ?? args.addContent, { path });
  addSkillContentChange(out, "prepend", args.prependContent ?? args.prepend, { path });
  addSkillContentChange(out, "replace", args.replaceContent ?? args.newContent, { path });
  addSkillPatchChange(out, args.patchPreview ?? args.patch ?? args.diff, { path });
  addSkillEditChange(out, { oldText: args.oldText, newText: args.newText, kind: "edit" }, { path });

  const edits = [
    ...(Array.isArray(args.edits) ? args.edits : []),
    ...(Array.isArray(args.replacements) ? args.replacements : []),
    ...(Array.isArray(args.contentEdits) ? args.contentEdits : []),
    ...(args.edit ? [args.edit] : []),
    ...(args.replacement ? [args.replacement] : []),
  ];
  for (const edit of edits) addSkillEditChange(out, edit, { path });
  for (const edit of Array.isArray(args.resourceEdits) ? args.resourceEdits : []) {
    addSkillResourceChange(out, edit);
  }
  return dedupeSkillChanges(out);
}

export function addSkillContentChange(out: Data[], kind: unknown, content: unknown, base: Data = {}) {
  if (content == null || content === "") return;
  out.push({
    kind,
    ...base,
    content: typeof content === "string" ? content : presentation.summarizeValue(content, 1200),
  });
}

export function addSkillPatchChange(out: Data[], patchPreview: unknown, base: Data = {}) {
  if (typeof patchPreview !== "string" || !patchPreview.trim()) return;
  out.push({ kind: "diff", ...base, patchPreview });
}

export function addSkillEditChange(out: Data[], value: unknown, base: Data = {}) {
  if (value == null || value === "") return;
  if (typeof value === "string") {
    out.push({ kind: "edit", ...base, content: value });
    return;
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    out.push({ kind: "edit", ...base, content: presentation.summarizeValue(value, 1200) });
    return;
  }
  const edit = record(value);
  out.push({
    kind: edit.kind || edit.action || "edit",
    ...base,
    ...value,
    path: edit.path || edit.file || edit.resource || base.path,
  });
}

export function addSkillResourceChange(out: Data[], value: unknown) {
  if (value == null || value === "") return;
  if (typeof value === "string") {
    addSkillEditChange(out, value, { path: "resource" });
    return;
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    addSkillEditChange(out, value, { path: "resource" });
    return;
  }
  const edit = record(value);
  const path = edit.path || edit.file || edit.resource || edit.name || "resource";
  const kind = edit.kind || edit.action || (edit.content != null ? "upsert" : "edit");
  addSkillPatchChange(out, edit.patchPreview ?? edit.patch ?? edit.diff, { path });
  if (edit.oldText != null || edit.newText != null || edit.before != null || edit.after != null || edit.find != null || edit.replace != null) {
    addSkillEditChange(out, { ...value, kind }, { path });
  } else if (edit.content != null || edit.text != null) {
    addSkillContentChange(out, kind, edit.content ?? edit.text, { path });
  }
  const nestedEdits = Array.isArray(edit.edits) ? edit.edits : [];
  for (const nested of nestedEdits) addSkillEditChange(out, nested, { path });
}

export function dedupeSkillChanges(changes: Data[]) {
  const seen = new Set();
  return changes.filter(change => {
    const key = JSON.stringify({
      path: change.path || change.file || change.resource || "",
      preview: changePreview(change),
    });
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const summaryDefinitions: readonly ToolPresentationDefinition[] = [
 ...["load_skill_resource", "edit_skill_resource"].map(id => ({ id, argsSummary: ({ args, result, rawArgsText }) => formatSkillResourceArgsPreview(args, result, rawArgsText) } satisfies ToolPresentationDefinition)),
 ...["create_skill", "update_skill"].map(id => ({ id, argsSummary: ({ args, result, rawArgsText }) => formatSkillArgsPreview(args, result, rawArgsText, id) } satisfies ToolPresentationDefinition)),
 { id: "run_skill_script", describeRun: ({ args, surface }) => surface === "timeline" ? t("runSkillScript") : args.skill && args.script ? t("runningSkillScript", { skill: String(args.skill), script: String(args.script) }) : undefined },
];

const hiddenParams: Readonly<Record<string, readonly string[]>> = {
  create_skill: ["content", "resources"], edit_skill_resource: ["content"],
  update_skill: ["appendContent", "prependContent", "replaceContent", "newContent", "oldText", "newText", "patchPreview", "patch", "diff", "edit", "edits", "replacement", "replacements", "contentEdits", "resourceEdits"],
};
export const presentations: readonly ToolPresentationDefinition[] = summaryDefinitions.map(definition => ({
  ...definition,
  compactParams: ({ name, args }) => hiddenParams[name]
    ? Object.fromEntries(Object.entries(args).filter(([key]) => !hiddenParams[name]?.includes(key)))
    : undefined,
}));
