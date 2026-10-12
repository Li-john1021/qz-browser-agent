import { t } from "../i18n/backend.js";
import {
  decodeSkillResourceBytes,
  encodeSkillResourceBytes,
  inferSkillResourceMimeType,
  isBase64SkillResource,
  isSkillDocumentResource,
  normalizeSkill,
  SKILL_SCOPE_GLOBAL,
  SKILL_SCOPE_RESIDENT,
  SKILL_SCOPE_SITE,
} from "./skill-utils.js";
import { createZipBytes, openZip } from "../zip-bytes.js";
import { load as loadYaml } from "js-yaml";

import type { SkillRecord, SkillResource, SkillMetadata } from "./skill-utils.js";
import type { ZipSignal } from "../zip-bytes.js";

type Data = Record<string, unknown>;
interface SkillFile { path: string; data?: Uint8Array; text?: string }
export interface ImportFile {
  name?: string; path?: string; webkitRelativePath?: string; size?: number;
  arrayBuffer?: () => Promise<ArrayBuffer>; text?: string | (() => Promise<string>);
}
interface ImportOptions { signal?: ZipSignal; subpath?: string }
const UTF8 = new TextEncoder();
const UTF8_DECODER = new TextDecoder("utf-8");
const DIRECTORY_IMPORT_MAX_FILES = 500;
const DIRECTORY_IMPORT_MAX_FILE_BYTES = 2 * 1024 * 1024;
const DIRECTORY_IMPORT_MAX_BINARY_FILE_BYTES = 12 * 1024 * 1024;
const DIRECTORY_IMPORT_MAX_TOTAL_BYTES = 12 * 1024 * 1024;
const ZIP_IMPORT_MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;
const ZIP_IMPORT_MAX_ENTRIES = 10_000;
const DIRECTORY_IMPORT_TEXT_EXTENSIONS = new Set([
  ".css",
  ".html",
  ".js",
  ".json",
  ".md",
  ".mjs",
  ".txt",
  ".yaml",
  ".yml",
]);

export async function exportSkillsZip(skills: readonly unknown[] = []) {
  const entries = [];
  for (const skill of (Array.isArray(skills) ? skills : []).map(normalizeSkill).filter(item => item.name)) {
    const root = safeSkillDirectoryName(skill.name);
    entries.push({
      path: `${root}/SKILL.md`,
      content: skillToSkillMarkdown(skill),
    });
    for (const resource of skill.resources || []) {
      if (!resource?.path) continue;
      entries.push({
        path: `${root}/${sanitizeResourcePath(resource.path)}`,
        content: isBase64SkillResource(resource)
          ? decodeSkillResourceBytes(resource)
          : (typeof resource.content === "string" ? resource.content : ""),
      });
    }
  }
  return createZip(entries);
}

export async function importSkillsZip(arrayBuffer: ArrayBuffer | Uint8Array, options: ImportOptions = {}) {
  const files = await readZip(arrayBuffer, options);
  return skillsFromFiles(files);
}

export async function importSkillsFromFileList(fileList: ArrayLike<ImportFile> | Iterable<ImportFile>) {
  const candidates = Array.from(fileList || [])
    .map(file => ({
      file,
      path: normalizeZipPath(file.webkitRelativePath || file.path || file.name || ""),
      size: Number(file.size || 0),
    }))
    .filter(item => item.path && !item.path.endsWith("/") && isPotentialSkillDirectoryFile(item.path));

  const roots = findSkillRoots(candidates.map(item => item.path));
  if (!roots.length) {
    throw new Error(t("skill.directoryNoManifest"));
  }

  const selected = candidates.filter(item => isWithinAnySkillRoot(item.path, roots));
  if (selected.length > DIRECTORY_IMPORT_MAX_FILES) {
    throw new Error(t("skill.directoryFileLimit", { count: String(selected.length) }));
  }

  const files = [];
  let declaredTotalBytes = 0;
  let actualTotalBytes = 0;
  for (const item of selected) {
    const fileLimit = importFileSizeLimit(item.path);
    if (item.size > fileLimit) {
      throw new Error(t("skill.importFileTooLarge", { path: String(item.path) }));
    }
    declaredTotalBytes += Math.max(0, item.size);
    if (declaredTotalBytes > DIRECTORY_IMPORT_MAX_TOTAL_BYTES) {
      throw new Error(t("skill.directoryTooLarge"));
    }
    let file;
    let actualSize;
    if (isSkillDocumentResource(item.path)) {
      if (typeof item.file.arrayBuffer !== "function") {
        throw new Error(t("skill.readBinaryFailed", { path: String(item.path) }));
      }
      const data = new Uint8Array(await item.file.arrayBuffer());
      file = { path: item.path, data };
      actualSize = data.byteLength;
    } else {
      const text = typeof item.file.text === "function"
        ? await item.file.text()
        : String(item.file.text || "");
      file = { path: item.path, text };
      actualSize = UTF8.encode(text).byteLength;
    }
    if (actualSize > fileLimit) {
      throw new Error(t("skill.importFileTooLarge", { path: String(item.path) }));
    }
    actualTotalBytes += actualSize;
    if (actualTotalBytes > DIRECTORY_IMPORT_MAX_TOTAL_BYTES) {
      throw new Error(t("skill.directoryTooLarge"));
    }
    files.push(file);
  }
  return skillsFromFiles(files);
}

export function skillToSkillMarkdown(skill: unknown) {
  const normalized = normalizeSkill(skill);
  return [
    "---",
    `name: ${yamlScalar(normalized.name)}`,
    `description: ${yamlScalar(normalized.description)}`,
    ...optionalScalar("license", normalized.license),
    ...optionalScalar("compatibility", normalized.compatibility),
    ...optionalScalar("allowed-tools", normalized["allowed-tools"]),
    ...renderMetadata(normalized),
    "---",
    "",
    String(normalized.content || "").replace(/^\n+/, ""),
  ].join("\n");
}

export function skillFromSkillMarkdown(source: unknown, fallbackName = "") {
  const parsed = parseSkillMarkdownFrontmatter(source);
  if (!parsed) {
    return normalizeSkill({
      name: fallbackName,
      description: "",
      content: String(source || "").replace(/\r\n?/g, "\n"),
    });
  }

  const { frontmatter } = parsed;
  validateSkillFrontmatterFields(frontmatter);
  const metadata = frontmatter.metadata && isPlainObject(frontmatter.metadata)
    ? frontmatter.metadata
    : {};

  const skill = normalizeSkill({
    ...frontmatter,
    name: String(frontmatter.name || fallbackName || "").trim(),
    description: String(frontmatter.description || "").trim(),
    content: parsed.content.replace(/^\n+/, ""),
    scope: metadata.scope ?? frontmatter.scope,
    status: metadata.status ?? frontmatter.status,
    domains: metadata.domains ?? frontmatter.domains,
    urlPatterns: metadata.urlPatterns ?? frontmatter.urlPatterns,
    excludePatterns: metadata.excludePatterns ?? frontmatter.excludePatterns,
    resources: [],
  });
  return skill;
}

export function parseSkillMarkdownFrontmatter(source: unknown) {
  const text = String(source || "").replace(/\r\n?/g, "\n");
  const parsed = splitSkillFrontmatter(text);
  if (!parsed) {
    const firstLine = (text.replace(/^\uFEFF/, "").split("\n")[0] || "").trim();
    if (firstLine === "---") throw new Error(t("skill.frontmatterUnterminated"));
    return null;
  }
  const frontmatter = parseStrictYamlObject(parsed.frontmatter);
  return {
    frontmatter,
    content: parsed.content.replace(/^\n+/, ""),
  };
}

async function skillsFromFiles(files: SkillFile[]) {
  const byPath = new Map(files.map(file => [normalizeZipPath(file.path), file]));
  const skills = [];

  for (const file of files) {
    const path = normalizeZipPath(file.path);
    if (path !== "SKILL.md" && !path.endsWith("/SKILL.md")) continue;
    const root = path === "SKILL.md" ? "" : path.slice(0, -"/SKILL.md".length);
    const fallbackName = root.split("/").pop() || "";
    const skill = skillFromSkillMarkdown(file.text, fallbackName);
    const resourcePrefix = root ? `${root}/` : "";
    const resources = [];
    for (const [resourcePath, resourceFile] of byPath.entries()) {
      if (resourcePath === path) continue;
      if (resourcePrefix && !resourcePath.startsWith(resourcePrefix)) continue;
      const rel = resourcePrefix ? resourcePath.slice(resourcePrefix.length) : resourcePath;
      if (!rel || rel.endsWith("/")) continue;
      const binary = isSkillDocumentResource(rel);
      const data = resourceFile.data instanceof Uint8Array
        ? resourceFile.data
        : new Uint8Array(resourceFile.data || []);
      const resource: SkillResource = {
        path: rel,
        type: inferResourceType(rel),
        title: rel.split("/").pop() || rel,
        description: "",
        content: binary ? encodeSkillResourceBytes(data) : String(resourceFile.text || ""),
      };
      if (binary) {
        resource.encoding = "base64";
        resource.mimeType = inferSkillResourceMimeType(rel);
        resource.size = data.byteLength;
      }
      resources.push(resource);
    }
    skill.resources = resources.sort((a, b) => a.path.localeCompare(b.path));
    skills.push(normalizeSkill(skill));
  }

  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

function renderMetadata(skill: SkillRecord) {
  const rawMetadata = clonePlainObject(skill.metadata) as SkillMetadata;
  delete rawMetadata["gaoshou-browser-agent"];
  delete rawMetadata.summary;
  delete rawMetadata.priority;
  if (rawMetadata.qingzhou?.displayName) {
    delete rawMetadata.qingzhou.displayName;
    if (!Object.keys(rawMetadata.qingzhou).length) delete rawMetadata.qingzhou;
  }

  const metadata: Data = {};
  const displayName = String(skill.displayName || rawMetadata.displayName || "").trim();
  delete rawMetadata.displayName;
  for (const key of ["scope", "status", "domains", "urlPatterns", "excludePatterns"]) {
    delete rawMetadata[key];
  }
  if (displayName && displayName !== skill.name) metadata.displayName = displayName;
  Object.assign(metadata, rawMetadata);
  metadata.scope = skill.scope;
  metadata.status = skill.status;
  metadata.domains = skill.domains || [];
  metadata.urlPatterns = skill.urlPatterns || [];
  metadata.excludePatterns = skill.excludePatterns || [];
  return ["metadata:", ...yamlObject(metadata, 1)];
}

function optionalScalar(key: string, value: unknown) {
  const text = String(value || "").trim();
  return text ? [`${key}: ${yamlScalar(text)}`] : [];
}

function yamlObject(value: unknown, depth: number): string[] {
  const indent = "  ".repeat(depth);
  const lines = [];
  const object = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  for (const [key, item] of Object.entries(object)) {
    if (item == null || item === "") continue;
    if (Array.isArray(item)) {
      if (!item.length) {
        lines.push(`${indent}${key}: []`);
      } else {
        lines.push(`${indent}${key}:`);
        for (const entry of item) lines.push(`${indent}  - ${yamlScalar(entry)}`);
      }
    } else if (typeof item === "object") {
      lines.push(`${indent}${key}:`);
      lines.push(...yamlObject(item, depth + 1));
    } else {
      lines.push(`${indent}${key}: ${yamlScalar(item)}`);
    }
  }
  return lines;
}

function yamlScalar(value: unknown) {
  return JSON.stringify(String(value ?? ""));
}

function splitSkillFrontmatter(text: unknown) {
  const lines = String(text || "").replace(/^\uFEFF/, "").split("\n");
  if ((lines[0] || "").trim() !== "---") return null;
  for (let i = 1; i < lines.length; i += 1) {
    const marker = lines[i].trim();
    if (marker === "---" || marker === "...") {
      return {
        frontmatter: lines.slice(1, i).join("\n"),
        content: lines.slice(i + 1).join("\n"),
      };
    }
  }
  return null;
}

function parseStrictYamlObject(source: unknown) {
  const parsed = loadYaml(String(source || "")) || {};
  if (!isPlainObject(parsed)) {
    throw new Error(t("skill.frontmatterObject"));
  }
  return parsed;
}

function validateSkillFrontmatterFields(frontmatter: Data = {}) {
  const errors: string[] = [];
  readSkillYamlString("name", frontmatter.name, errors);
  readSkillYamlString("description", frontmatter.description, errors);
  readSkillYamlString("license", frontmatter.license, errors);
  readSkillYamlString("compatibility", frontmatter.compatibility, errors);
  readSkillYamlString("allowed-tools", frontmatter["allowed-tools"], errors);
  validateOptionalEnum("scope", frontmatter.scope, errors, [SKILL_SCOPE_GLOBAL, SKILL_SCOPE_SITE, SKILL_SCOPE_RESIDENT], t("skill.scopeValues"));
  validateOptionalEnum("status", frontmatter.status, errors, ["active", "disabled"], t("skill.statusValues"));
  readSkillYamlStringList("domains", frontmatter.domains, errors);
  readSkillYamlStringList("urlPatterns", frontmatter.urlPatterns, errors);
  readSkillYamlStringList("excludePatterns", frontmatter.excludePatterns, errors);

  if (frontmatter.metadata !== undefined) {
    if (!isPlainObject(frontmatter.metadata)) {
      errors.push(t("skill.metadataObject"));
    } else {
      const metadata = frontmatter.metadata;
      readSkillYamlString("metadata.displayName", metadata.displayName, errors);
      validateOptionalEnum("metadata.scope", metadata.scope, errors, [SKILL_SCOPE_GLOBAL, SKILL_SCOPE_SITE, SKILL_SCOPE_RESIDENT], t("skill.scopeValues"));
      validateOptionalEnum("metadata.status", metadata.status, errors, ["active", "disabled"], t("skill.statusValues"));
      readSkillYamlStringList("metadata.domains", metadata.domains, errors);
      readSkillYamlStringList("metadata.urlPatterns", metadata.urlPatterns, errors);
      readSkillYamlStringList("metadata.excludePatterns", metadata.excludePatterns, errors);
    }
  }

  if (errors.length) throw new Error(errors[0]);
}

export function readSkillYamlString(key: string, value: unknown, errors: string[], { required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) errors.push(t("skill.yamlRequired", { key: String(key) }));
    return "";
  }
  if (typeof value !== "string") {
    errors.push(t("skill.yamlString", { key: String(key) }));
    return "";
  }
  return value.trim();
}

function validateOptionalEnum(key: string, value: unknown, errors: string[], choices: string[], message: string) {
  const text = readSkillYamlString(key, value, errors);
  if (typeof value === "string" && !choices.includes(text.toLowerCase())) {
    errors.push(t("skill.yamlAllowed", { key: String(key), values: String(message) }));
  }
}

export function readSkillYamlStringList(key: string, value: unknown, errors: string[], { required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) errors.push(t("skill.yamlRequired", { key: String(key) }));
    return [];
  }
  if (!Array.isArray(value)) {
    errors.push(t("skill.yamlStringArray", { key: String(key) }));
    return [];
  }
  const list: string[] = [];
  value.forEach((item, index) => {
    if (typeof item !== "string") errors.push(t("skill.yamlItemString", { key: String(key), index: String(index + 1) }));
    else if (item.trim()) list.push(item.trim());
  });
  return list;
}

function clonePlainObject(value: unknown): Data {
  if (!isPlainObject(value)) return {};
  try { return JSON.parse(JSON.stringify(value)); }
  catch(_e) { return {}; }
}

function isPlainObject(value: unknown): value is Data {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function safeSkillDirectoryName(name: unknown) {
  return String(name || "skill")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64) || "skill";
}

function sanitizeResourcePath(path: unknown) {
  return String(path || "")
    .replace(/\\/g, "/")
    .split("/")
    .filter(part => part && part !== "." && part !== "..")
    .join("/");
}

function normalizeZipPath(path: unknown) {
  return String(path || "").replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+/g, "/");
}

function inferResourceType(path: unknown = "") {
  const lower = String(path).toLowerCase();
  if (lower.endsWith(".js") || lower.endsWith(".mjs")) return "script";
  if (lower.endsWith(".json")) return "json";
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "markdown";
  return "asset";
}

function isPotentialSkillDirectoryFile(path: string) {
  const clean = normalizeZipPath(path);
  if (!clean || clean.endsWith("/")) return false;
  if (clean.split("/").some(part => shouldSkipDirectoryImportPart(part))) return false;
  if (clean === "SKILL.md" || clean.endsWith("/SKILL.md")) return true;
  const lower = clean.toLowerCase();
  const dot = lower.lastIndexOf(".");
  return (dot >= 0 && DIRECTORY_IMPORT_TEXT_EXTENSIONS.has(lower.slice(dot)))
    || isSkillDocumentResource(clean);
}

function importFileSizeLimit(path: string) {
  return isSkillDocumentResource(path)
    ? DIRECTORY_IMPORT_MAX_BINARY_FILE_BYTES
    : DIRECTORY_IMPORT_MAX_FILE_BYTES;
}

function shouldSkipDirectoryImportPart(part: string) {
  const name = String(part || "").trim();
  if (!name) return true;
  if (name === "." || name === "..") return true;
  if (name === ".DS_Store") return true;
  return [
    ".git",
    ".hg",
    ".svn",
    "node_modules",
    "dist",
    "build",
    "coverage",
    ".next",
    ".cache",
  ].includes(name);
}

function findSkillRoots(paths: string[]) {
  const roots = [];
  const seen = new Set();
  for (const path of paths.map(normalizeZipPath)) {
    if (path !== "SKILL.md" && !path.endsWith("/SKILL.md")) continue;
    const root = path === "SKILL.md" ? "" : path.slice(0, -"/SKILL.md".length);
    if (seen.has(root)) continue;
    seen.add(root);
    roots.push(root);
  }
  return roots.sort((a, b) => a.length - b.length);
}

function isWithinAnySkillRoot(path: string, roots: string[]) {
  const clean = normalizeZipPath(path);
  return roots.some(root => {
    if (!root) return true;
    return clean === `${root}/SKILL.md` || clean.startsWith(`${root}/`);
  });
}

export async function createZip(entries: { path: string; content: string | Uint8Array | ArrayBuffer }[]) {
  const files = entries.map(entry => ({
    name: normalizeZipPath(entry.path),
    data: typeof entry.content === "string" ? entry.content : new Uint8Array(entry.content || []),
  })).filter(entry => entry.name && !entry.name.endsWith("/"));
  return new Blob([createZipBytes(files, text => UTF8.encode(text), new Date())], { type: "application/zip" });
}

async function readZip(arrayBuffer: ArrayBuffer | Uint8Array, options: ImportOptions = {}) {
  const zip = openZip(new Uint8Array(arrayBuffer), {
    decode: bytes => UTF8_DECODER.decode(bytes),
    inflate: typeof DecompressionStream === "function"
      ? bytes => new Blob([Uint8Array.from(bytes)]).stream().pipeThrough(new DecompressionStream("deflate-raw")).getReader() : undefined,
    maxArchiveBytes: ZIP_IMPORT_MAX_ARCHIVE_BYTES, maxEntries: ZIP_IMPORT_MAX_ENTRIES,
    signal: options.signal,
  });
  const entries = zip.entries.filter(entry => entry.name && !entry.name.endsWith("/"))
    .map(entry => ({ path: normalizeZipPath(entry.name), uncompressedSize: entry.uncompressedSize, entry }));

  const candidatePaths = entries.filter(entry => isPotentialSkillDirectoryFile(entry.path)).map(entry => entry.path);
  let roots = findSkillRoots(candidatePaths);
  const requestedSubpath = String(options?.subpath || "").trim();
  const subpath = normalizeRepositorySelectionPath(requestedSubpath);
  if (requestedSubpath && !subpath) throw new Error(t("skill.invalidRepositoryPath"));
  if (subpath) {
    const archiveRoot = inferArchiveRoot(candidatePaths);
    roots = roots.filter(root => skillRootMatchesRepositorySubpath(root, subpath, archiveRoot));
  }
  if (!roots.length) return [];
  const selected = entries.filter(entry => (
    isPotentialSkillDirectoryFile(entry.path)
    && isWithinAnySkillRoot(entry.path, roots)
  ));
  if (selected.length > DIRECTORY_IMPORT_MAX_FILES) {
    throw new Error(t("skill.zipFileLimit", { count: String(selected.length) }));
  }

  let totalBytes = 0;
  for (const entry of selected) {
    const fileLimit = importFileSizeLimit(entry.path);
    if (entry.uncompressedSize > fileLimit) {
      throw new Error(t("skill.importFileTooLarge", { path: String(entry.path) }));
    }
    totalBytes += entry.uncompressedSize;
    if (totalBytes > DIRECTORY_IMPORT_MAX_TOTAL_BYTES) {
      throw new Error(t("skill.zipResourcesTooLarge"));
    }
  }

  const files = [];
  let actualTotalBytes = 0;
  for (const entry of selected) {
    const data = await zip.read(entry.entry, importFileSizeLimit(entry.path));
    actualTotalBytes += data.byteLength;
    if (actualTotalBytes > DIRECTORY_IMPORT_MAX_TOTAL_BYTES) throw new Error(t("skill.zipResourcesTooLarge"));
    files.push(isSkillDocumentResource(entry.path)
      ? { path: entry.path, data }
      : { path: entry.path, text: UTF8_DECODER.decode(data) });
  }
  return files;
}

function normalizeRepositorySelectionPath(value = "") {
  const parts = String(value || "")
    .replace(/\\/gu, "/")
    .split("/")
    .map(part => part.trim())
    .filter(Boolean);
  if (parts.some(part => part === "." || part === "..")) return "";
  return parts.join("/");
}

function inferArchiveRoot(paths: string[] = []) {
  const rows = paths.map(normalizeZipPath).filter(Boolean);
  if (!rows.length || rows.some(path => !path.includes("/"))) return "";
  const first = rows[0].split("/")[0];
  return first && rows.every(path => path.startsWith(`${first}/`)) ? first : "";
}

function skillRootMatchesRepositorySubpath(root: string, subpath: string, archiveRoot: string) {
  const matches = (value: string) => value === subpath || value.startsWith(`${subpath}/`);
  const clean = normalizeZipPath(root);
  if (matches(clean)) return true;
  if (!archiveRoot || !clean.startsWith(`${archiveRoot}/`)) return false;
  return matches(clean.slice(archiveRoot.length + 1));
}
