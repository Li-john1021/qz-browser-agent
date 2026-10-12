import { t } from "../i18n/backend.js";
export interface ToolIdentity {
  name: string;
  capabilityId: string;
  title: string;
  familyId: string;
  familyTitle: string;
  rendererId?: string;
}

export function normalizeToolIdentitySnapshot(value: unknown = {}, fallback: unknown = {}): ToolIdentity {
  const primary = objectValue(value);
  const secondary = objectValue(fallback);
  const name = firstText(
    primary.name,
    primary.toolName,
    secondary.name,
    secondary.toolName,
  );
  return {
    name,
    ...(firstText(primary.rendererId, primary.toolRendererId, secondary.rendererId, secondary.toolRendererId)
      ? { rendererId: firstText(primary.rendererId, primary.toolRendererId, secondary.rendererId, secondary.toolRendererId) } : {}),
    capabilityId: firstText(
      primary.capabilityId,
      primary.toolCapabilityId,
      secondary.capabilityId,
      secondary.toolCapabilityId,
      name,
    ),
    title: firstText(
      primary.title,
      primary.toolTitle,
      primary.displayName,
      secondary.title,
      secondary.toolTitle,
      secondary.displayName,
    ),
    familyId: firstText(
      primary.familyId,
      primary.toolFamilyId,
      secondary.familyId,
      secondary.toolFamilyId,
    ),
    familyTitle: firstText(
      primary.familyTitle,
      primary.toolFamilyTitle,
      secondary.familyTitle,
      secondary.toolFamilyTitle,
    ),
  };
}

export function toolIdentityEventFields(value: unknown = {}) {
  const identity = normalizeToolIdentitySnapshot(value);
  return {
    ...(identity.rendererId ? { toolRendererId: identity.rendererId } : {}),
    toolCapabilityId: identity.capabilityId || identity.name,
    toolTitle: identity.title || identity.name || t("common.tool"),
    toolFamilyId: identity.familyId || "other",
    toolFamilyTitle: identity.familyTitle || t("common.otherTools"),
  };
}

export function toolIdentityMetaFromEvent(event: unknown = {}): Partial<ToolIdentity> {
  const source = objectValue(event);
  const capabilityId = firstText(source.toolCapabilityId, source.capabilityId);
  const title = firstText(source.toolTitle, source.title, source.displayName);
  const familyId = firstText(source.toolFamilyId, source.familyId);
  const familyTitle = firstText(source.toolFamilyTitle, source.familyTitle);
  const rendererId = firstText(source.toolRendererId, source.rendererId);
  return {
    ...(rendererId ? { rendererId } : {}),
    ...(capabilityId ? { capabilityId } : {}),
    ...(title ? { title } : {}),
    ...(familyId ? { familyId } : {}),
    ...(familyTitle ? { familyTitle } : {}),
  };
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function firstText(...values: unknown[]) {
  for (const value of values) {
    const text = String(value || "").trim();
    if (text) return text;
  }
  return "";
}
