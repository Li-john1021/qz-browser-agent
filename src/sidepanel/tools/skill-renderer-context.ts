import { record } from "./renderer-input.js";
import { getSkillToolUiMeta, getSkillToolUiMetaBySkillScript } from "./skill-tool-ui-registry.js";
type Data = Record<string, unknown>;

/** Resolve declarative presentation metadata independently of concrete DOM renderers. */
export function isSkillResourceRenderer(renderer: unknown = {}) {
  const type = String(record(renderer).type || "");
  return type === "skill";
}

export function skillMetaFromResult(...values: unknown[]): Data | null {
  for (const value of values) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const source = record(value);
    if (source._plugin && typeof source._plugin === "object" && !Array.isArray(source._plugin)) return record(source._plugin);
    const nested = record(source.result)._plugin;
    if (nested && typeof nested === "object" && !Array.isArray(nested)) return record(nested);
  }
  return null;
}

export function resolveSkillToolRenderContext(toolName = "", ...values: unknown[]) {
  const resultMeta = skillMetaFromResult(...values);
  const catalog = getSkillToolUiMeta(toolName) || skillCatalogFromSkillScript(...values);
  const plugin = resultMeta || catalog
    ? {
        ...(catalog?.plugin || {}),
        ...(resultMeta || {}),
        title: resultMeta?.title || catalog?.tool?.title || "",
        localName: resultMeta?.localName || catalog?.tool?.localName || "",
        script: resultMeta?.script || catalog?.tool?.script || "",
        runtime: resultMeta?.runtime || catalog?.tool?.runtime || "",
      }
    : null;
  return {
    plugin,
    renderer: resultMeta?.renderer || catalog?.renderer ? record(resultMeta?.renderer || catalog?.renderer) : null,
    catalog,
  };
}

function skillCatalogFromSkillScript(...values: unknown[]) {
  for (const value of values) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const source = record(value);
    const skill = String(source.skill || record(source.args).skill || "").trim();
    const script = String(source.script || record(source.args).script || "").trim();
    if (!skill || !script) continue;
    const catalog = getSkillToolUiMetaBySkillScript(skill, script);
    if (catalog) return catalog;
  }
  return null;
}
