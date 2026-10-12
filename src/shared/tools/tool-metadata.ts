import { t } from "../i18n/backend.js";
import contributions from "#capabilities/metadata";
import { materializeContribution, mergeCapabilityRecords } from "../capabilities.js";
import { getLanguage, withLanguage } from "../i18n/index.js";
import { languageRuntime } from "../i18n/runtime.js";
import type { ToolMetadata } from "./tool-metadata-contract.js";
export type { ToolMetadata } from "./tool-metadata-contract.js";
export { defineToolMetadata } from "./tool-metadata-contract.js";
import type { ToolIdentity } from "./tool-identity.js";
type ToolIdentityInput = Partial<ToolIdentity> & { labelerId?: string };
function materializeCatalog() {
  return materializeContribution({
    tools: mergeCapabilityRecords<ToolMetadata>(contributions.map(item => item.tools)),
    families: mergeCapabilityRecords(contributions.map(item => item.families)),
    actionLabels: mergeCapabilityRecords(contributions.map(item => item.actionLabels)),
  });
}
const catalogs = new Map<string, ReturnType<typeof materializeCatalog>>();

/** Resolve package getters once per language; previously returned run metadata stays unchanged. */
export function getToolMetadataCatalog(language = getLanguage()) {
  let catalog = catalogs.get(language);
  if (!catalog) {
    catalog = withLanguage(language, materializeCatalog);
    catalogs.set(language, catalog);
  }
  return catalog;
}

export function getCoreToolMetadata(name = "") {
  const tools = getToolMetadataCatalog().tools;
  const key = String(name || "").trim();
  return Object.hasOwn(tools, key) ? tools[key] : null;
}

/** Reproject recognized catalog titles; custom titles and the stored run snapshot stay untouched. */
export function getToolPresentationTitle(capabilityId: string, snapshotTitle = ""): string {
  const metadata = getCoreToolMetadata(capabilityId);
  if (!metadata) return snapshotTitle;
  const displayTitle = metadata.shortTitle || metadata.title;
  if (!snapshotTitle || snapshotTitle === metadata.title || snapshotTitle === displayTitle) return displayTitle;
  // Both authored fallback languages are available without loading other language packs.
  const englishTitle = getToolMetadataCatalog("en").tools[capabilityId]?.title;
  if (englishTitle && languageRuntime.isHistoricalLabel(snapshotTitle, englishTitle)) return displayTitle;
  getToolMetadataCatalog("zh-CN");
  for (const catalog of catalogs.values()) {
    if (catalog.tools[capabilityId]?.title === snapshotTitle) return displayTitle;
  }
  return snapshotTitle;
}

export function getToolFamilyMetadata(familyId = "") {
  const families = getToolMetadataCatalog().families;
  const key = String(familyId || "").trim();
  return (Object.hasOwn(families, key) ? families[key] : null) || families.other || { id: "other", title: t("common.otherTools"), shortTitle: t("common.otherTools") };
}

export function toolIdentity(definition: ToolIdentityInput = {}): Readonly<ToolIdentity> {
  const name = String(definition.name || "").trim();
  const capabilityId = String(definition.capabilityId || name).trim() || name;
  const core = getCoreToolMetadata(capabilityId);
  const title = String(definition.title || core?.title || name || t("common.tool")).trim() || t("common.tool");
  const familyId = String(definition.familyId || core?.familyId || "other").trim() || "other";
  const family = getToolFamilyMetadata(familyId);
  const rendererId = String(definition.rendererId || "").trim();
  return Object.freeze({
    name,
    ...(rendererId ? { rendererId } : {}),
    capabilityId,
    title,
    familyId,
    familyTitle: String(definition.familyTitle || family.title || t("common.otherTools")).trim() || t("common.otherTools"),
  });
}

export function formatToolActionTitle(toolOrName: string | ToolIdentityInput, args: Record<string, unknown> = {}) {
  const definition = toolOrName && typeof toolOrName === "object"
    ? toolOrName
    : { name: String(toolOrName || "").trim() };
  const identity = toolIdentity(definition);
  const metadata = getCoreToolMetadata(identity.capabilityId);
  const baseTitle = getToolPresentationTitle(identity.capabilityId, identity.title);
  const rule = metadata?.titleRule;
  if (!rule) return baseTitle;
  const value = args?.[rule.field];
  const canMatch = typeof value === "string" || Boolean(rule.normalize);
  let key = canMatch ? String(value ?? "") : "";
  if (rule.normalize) key = key.trim();
  if (rule.normalize === "lowercase") key = key.toLowerCase();
  const title = canMatch && Object.hasOwn(rule.values, key) ? rule.values[key] : "";
  return title || (rule.fallback === "action" ? formatActionLabel(key, identity) : "") || rule.defaultTitle || baseTitle;
}

export function formatActionLabel(action: unknown = "", toolOrName: string | ToolIdentityInput = "") {
  const key = String(action || "").trim();
  const capabilityId = typeof toolOrName === "object" && toolOrName
    ? String(toolOrName.capabilityId || toolOrName.name || "").trim()
    : String(toolOrName || "").trim();
  const labels = getCoreToolMetadata(capabilityId)?.actionLabels;
  const scoped = labels && Object.hasOwn(labels, key) ? labels[key] : "";
  if (scoped) return scoped;
  const actionLabels = getToolMetadataCatalog().actionLabels;
  return Object.hasOwn(actionLabels, key) ? actionLabels[key] : "";
}
