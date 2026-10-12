import { t } from "../i18n/index.js";
import { record } from "./renderer-input.js";
import type { ToolEvent } from "./renderer-input.js";

type SkillToolUiEntry = {
  plugin: ReturnType<typeof normalizeSkillUiMeta>;
  tool: ReturnType<typeof normalizeSkillToolUiMeta>;
  renderer: unknown;
};
const skillToolUiCatalog = new Map<string, SkillToolUiEntry>();
const skillToolUiCatalogByScript = new Map<string, SkillToolUiEntry>();

export function setSkillToolUiCatalog(contributions: unknown = {}) {
  skillToolUiCatalog.clear();
  skillToolUiCatalogByScript.clear();
  const input = record(contributions);
  const plugins: unknown[] = Array.isArray(input.plugins) ? input.plugins : [];
  for (const item of plugins) {
    const plugin = record(item);
    const tools: unknown[] = Array.isArray(plugin.tools) ? plugin.tools : [];
    for (const item of tools) {
      const tool = record(item);
      const name = String(tool?.name || "").trim();
      if (!name) continue;
      const entry = {
        plugin: normalizeSkillUiMeta(plugin),
        tool: normalizeSkillToolUiMeta(tool),
        renderer: resolveContributionToolRenderer(plugin, tool),
      };
      skillToolUiCatalog.set(name, entry);
      const scriptKey = skillScriptCatalogKey(plugin?.skillName, tool?.script);
      if (scriptKey) skillToolUiCatalogByScript.set(scriptKey, entry);
    }
  }
}

export function getSkillToolUiMeta(toolName = "") {
  return skillToolUiCatalog.get(String(toolName || "").trim()) || null;
}

export function getSkillToolUiMetaBySkillScript(skillName = "", scriptPath = "") {
  const key = skillScriptCatalogKey(skillName, scriptPath);
  return key ? (skillToolUiCatalogByScript.get(key) || null) : null;
}

export function enrichSkillToolIdentity<T extends ToolEvent>(tool: T): T & ToolEvent {
  if (!tool || typeof tool !== "object" || Array.isArray(tool)) return tool;
  const entry = getSkillToolUiMeta(tool.name);
  const resultMeta = skillResultMeta(tool.result);
  const meta = { ...(entry?.tool || {}), ...(resultMeta || {}) };
  if (!Object.keys(meta).length) return tool;
  return {
    ...tool,
    capabilityId: String(tool.capabilityId || meta.capabilityId || tool.name || ""),
    rendererId: String(tool.rendererId || meta.rendererId || ""),
    title: String(tool.title || meta.title || ""),
    familyId: String(tool.familyId || meta.familyId || ""),
    familyTitle: String(tool.familyTitle || meta.familyTitle || ""),
    profileFamily: String(tool.profileFamily || meta.profileFamily || ""),
    resultFamily: String(tool.resultFamily || meta.resultFamily || "generic"),
    labelerId: String(tool.labelerId || meta.labelerId || "static"),
    pageContext: typeof tool.pageContext === "boolean" ? tool.pageContext : typeof meta.pageContext === "boolean" ? meta.pageContext : undefined,
    detailLayout: String(tool.detailLayout || meta.detailLayout || "detail"),
    mediaPresentation: String(tool.mediaPresentation || meta.mediaPresentation || ""),
  };
}

// Historical results keep the same envelope after the internal Skill naming change.
function skillResultMeta(value: unknown) {
  const result = record(value);
  if (result._plugin && typeof result._plugin === "object") return record(result._plugin);
  const nested = record(result.result)._plugin;
  return nested && typeof nested === "object" ? record(nested) : null;
}

function normalizeSkillUiMeta(plugin: Record<string, unknown> = {}) {
  return {
    id: String(plugin.id || ""),
    name: String(plugin.name || plugin.displayName || ""),
    displayName: String(plugin.displayName || plugin.name || ""),
    category: normalizeLabelGroup(plugin.category, "extension", t("extension")),
    skillName: String(plugin.skillName || ""),
    version: String(plugin.version || ""),
    description: String(plugin.description || ""),
  };
}

function normalizeSkillToolUiMeta(tool: Record<string, unknown> = {}) {
  return {
    name: String(tool.name || ""),
    capabilityId: String(tool.capabilityId || tool.name || ""),
    rendererId: String(tool.rendererId || ""),
    localName: String(tool.localName || ""),
    title: String(tool.title || ""),
    description: String(tool.description || ""),
    familyId: String(tool.familyId || ""),
    familyTitle: String(tool.familyTitle || ""),
    profileFamily: String(tool.profileFamily || ""),
    resultFamily: String(tool.resultFamily || "generic"),
    labelerId: String(tool.labelerId || "static"),
    pageContext: Boolean(tool.pageContext),
    detailLayout: String(tool.detailLayout || "detail"),
    mediaPresentation: String(tool.mediaPresentation || ""),
    script: String(tool.script || ""),
    runtime: String(tool.runtime || "page"),
  };
}

function skillScriptCatalogKey(skillName: unknown = "", scriptPath: unknown = "") {
  const skill = String(skillName || "").trim();
  const script = normalizeSkillUiScriptPath(scriptPath);
  return skill && script ? `${skill}\u0000${script}` : "";
}

function normalizeSkillUiScriptPath(value: unknown = "") {
  return String(value || "").trim().replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+/g, "/");
}

function normalizeLabelGroup(value: unknown = {}, fallbackId = "extension", fallbackTitle = t("extension")) {
  const input = record(value);
  const id = String(input.id || input.name || fallbackId || "extension").trim() || "extension";
  const rawTitle = String(input.title || input.label || input.displayName || input.name || fallbackTitle || t("extension")).trim() || t("extension");
  const label = String(input.label || input.title || input.displayName || input.name || fallbackTitle || t("extension")).trim() || t("extension");
  return {
    id,
    title: String(id === "extension" && rawTitle === "extension" ? t("extension") : rawTitle),
    label: id === "extension" && label === "extension" ? t("extension") : label,
  };
}

function resolveContributionToolRenderer(plugin: Record<string, unknown> = {}, tool: Record<string, unknown> = {}) {
  const tools = record(record(plugin.renderers).tools);
  return tool.renderer || tools[String(tool.name || "")] || tools[String(tool.localName || "")] || tools[String(tool.rawName || "")] || null;
}
