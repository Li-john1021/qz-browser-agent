import { t } from "../../shared/i18n/backend.js";
import { skillToSkillMarkdown } from "../../shared/skills/skill-package.js";
import { isBase64SkillResource, isValidAgentSkillName, normalizeModernSkill, normalizeSkillResourcePath, skillResourceByteSize } from "../../shared/skills/skill-utils.js";
const MAX_PUBLISH_FILES = 200;
const MAX_PUBLISH_FILE_BYTES = 2 * 1024 * 1024;
const MAX_PUBLISH_TOTAL_BYTES = 12 * 1024 * 1024;
const UTF8 = new TextEncoder();

export class GitSkillPublishError extends Error {
  constructor(readonly code: string, message: string, readonly details: Record<string, unknown> = {}) {
    super(message);
    this.name = "GitSkillPublishError";
  }
}

interface PublishFile { path: string; content: string; encoding?: "base64"; size?: number }

export function buildGitSkillPublishFiles(skillValue: object = {}, basePath = ""): PublishFile[] {
  const skill = normalizeModernSkill(skillValue);
  if (!skill.name || !isValidAgentSkillName(skill.name)) {
    throw new GitSkillPublishError("GIT_PUBLISH_SKILL_INVALID", t("skill.invalidNameForGit"));
  }
  const root = joinGitPath(normalizeGitPath(basePath), skill.name);
  const rows: PublishFile[] = [{ path: `${root}/SKILL.md`, content: skillToSkillMarkdown(skill) }];
  const seen = new Set([`${root}/skill.md`.toLowerCase()]);
  for (const resource of skill.resources || []) {
    const resourcePath = normalizeGitPath(normalizeSkillResourcePath(resource?.path));
    if (!resourcePath) throw new GitSkillPublishError("GIT_PUBLISH_RESOURCE_PATH_INVALID", t("skill.invalidResourcePath"));
    const path = joinGitPath(root, resourcePath);
    const lookup = path.toLowerCase();
    if (seen.has(lookup)) throw new GitSkillPublishError("GIT_PUBLISH_RESOURCE_DUPLICATE", t("skill.duplicateResourcePath", { path: String(resourcePath) }));
    seen.add(lookup);
    rows.push({
      path,
      content: typeof resource.content === "string" ? resource.content : String(resource.content ?? ""),
      ...(isBase64SkillResource(resource) ? { encoding: "base64" } : {}),
      size: publishResourceByteSize(resource, resourcePath),
    });
  }
  if (rows.length > MAX_PUBLISH_FILES) {
    throw new GitSkillPublishError("GIT_PUBLISH_TOO_MANY_FILES", t("skill.publishTooManyFiles", { count: String(rows.length), maximum: String(MAX_PUBLISH_FILES) }));
  }
  let totalBytes = 0;
  for (const file of rows) {
    const bytes = typeof file.size === "number" && Number.isFinite(file.size) ? file.size : UTF8.encode(file.content).byteLength;
    const fileLimit = file.encoding === "base64" ? MAX_PUBLISH_TOTAL_BYTES : MAX_PUBLISH_FILE_BYTES;
    if (bytes > fileLimit) throw new GitSkillPublishError("GIT_PUBLISH_FILE_TOO_LARGE", t("skill.publishFileTooLarge", { path: String(file.path) }));
    totalBytes += bytes;
  }
  if (totalBytes > MAX_PUBLISH_TOTAL_BYTES) throw new GitSkillPublishError("GIT_PUBLISH_TOO_LARGE", t("skill.resourceTooLargeForGit"));
  return rows;
}

function publishResourceByteSize(resource: Parameters<typeof skillResourceByteSize>[0], path: string) {
  try { return skillResourceByteSize(resource); }
  catch (error) {
    throw new GitSkillPublishError(
      "GIT_PUBLISH_RESOURCE_BINARY_INVALID",
      t("skill.publishInvalidBinary", { path: String(path) }),
      { path, cause: String(error instanceof Error ? error.message : error) },
    );
  }
}

function normalizeGitPath(value = "") {
  const parts = String(value || "").replace(/\\/gu, "/").split("/").filter(Boolean);
  if (parts.some(part => part === "." || part === ".." || /[\u0000-\u001f]/u.test(part))) return "";
  return parts.join("/");
}

export function joinGitPath(...parts: string[]) {
  return parts.map(normalizeGitPath).filter(Boolean).join("/");
}
