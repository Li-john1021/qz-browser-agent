import { PRODUCT_GIT_PLATFORMS } from "../product/git-platforms.js";
import {
  normalizeModernSkill,
  normalizeSkillMetadata,
  QINGZHOU_SKILL_METADATA_KEY,
} from "./skill-utils.js";

export const GIT_SKILL_SOURCE_STATE_KEY = "_gitSkillSources";
export const GIT_SKILL_SOURCE_SCHEMA_VERSION = 1;
export const GIT_SKILL_ORIGIN_TYPE = "git";

type Data = Record<string, unknown>;
export interface GitSelector { ref?: unknown; subpath?: unknown }
export type GitSkillSource = NonNullable<ReturnType<typeof normalizeGitSkillSource>>;
const objectInput = (value: unknown): Data => value && typeof value === "object" ? value as Data : {};

const MAX_SOURCE_SKILLS = 500;
const ARCHIVE_QUERY_KEYS = new Set(["format", "path", "ref", "sha"]);
const LEGACY_GITLAB_ACTIONS = new Set(["archive", "blob", "branches", "commit", "commits", "raw", "tags", "tree"]);
const GITHUB_ACTIONS = new Set(["actions", "archive", "blob", "branches", "commit", "commits", "issues", "pull", "pulls", "releases", "tags", "tree"]);

export const GIT_REPOSITORY_PROVIDER_GITLAB = "gitlab";
export const GIT_REPOSITORY_PROVIDER_GITHUB = "github";
export const GIT_REPOSITORY_PROVIDER_LOCAL = "local";

export function normalizeGitRepositoryUrl(value: unknown = "") {
  const url = parseGitUrl(value);
  if (!url) return "";
  if (/^\/api\//u.test(url.pathname)) return "";

  url.hash = "";
  url.search = "";
  let path = url.pathname.replace(/\/{2,}/gu, "/");
  const gitLabAction = path.indexOf("/-/");
  if (gitLabAction >= 0) path = path.slice(0, gitLabAction);
  path = path.replace(/\.git\/?$/iu, "").replace(/\/+$/u, "");
  let segments = path.split("/").filter(Boolean);
  if (url.hostname.toLowerCase() === "github.com" && segments.length >= 3 && GITHUB_ACTIONS.has(segments[2].toLowerCase())) {
    segments = segments.slice(0, 2);
  } else if (gitLabAction < 0 && (isLegacyGitLabHost(url.hostname) || isLoopbackGitHost(url.hostname))) {
    const actionIndex = segments.findIndex((segment, index) => (
      index >= 2 && LEGACY_GITLAB_ACTIONS.has(segment.toLowerCase())
    ));
    if (actionIndex >= 2) segments = segments.slice(0, actionIndex);
  }
  if (segments.length < 2) return "";
  url.pathname = `/${segments.join("/")}`;
  return url.href.replace(/\/$/u, "");
}

export function gitRepositoryLocator(value: unknown = "") {
  const url = parseGitUrl(value);
  const repositoryUrl = normalizeGitRepositoryUrl(value);
  if (!url || !repositoryUrl) return null;
  const provider = gitRepositoryProvider(repositoryUrl);
  const segments = url.pathname.split("/").filter(Boolean).map(segment => decodeURIComponentSafe(segment));
  let ref = "";
  let subpath = "";

  if (provider === GIT_REPOSITORY_PROVIDER_GITHUB) {
    if (segments[2]?.toLowerCase() === "tree" && segments[3]) {
      ref = normalizeGitRef(segments[3]);
      subpath = normalizeGitRepositorySubpath(segments.slice(4).join("/"));
    }
  } else if (Boolean(provider)) {
    const modernTreeIndex = segments.findIndex((segment, index) => segment === "-" && segments[index + 1]?.toLowerCase() === "tree");
    const legacyTreeIndex = segments.findIndex((segment, index) => index >= 2 && segment.toLowerCase() === "tree");
    const treeIndex = modernTreeIndex >= 0 ? modernTreeIndex + 1 : legacyTreeIndex;
    if (treeIndex >= 0 && segments[treeIndex + 1]) {
      ref = normalizeGitRef(segments[treeIndex + 1]);
      subpath = normalizeGitRepositorySubpath(segments.slice(treeIndex + 2).join("/"));
    }
  }

  url.hash = "";
  url.search = "";
  const browseUrl = ref && subpath ? url.href.replace(/\/$/u, "") : repositoryUrl;
  return { repositoryUrl, browseUrl, provider, ref, subpath };
}

export function normalizeGitRepositorySubpath(value: unknown = "") {
  const parts = String(value || "")
    .replace(/\\/gu, "/")
    .split("/")
    .map(part => part.trim())
    .filter(Boolean);
  if (parts.some(part => part === "." || part === "..")) return "";
  return parts.join("/").slice(0, 1_200);
}

export function gitRepositoryProvider(value: unknown = "") {
  const repositoryUrl = normalizeGitRepositoryUrl(value);
  if (!repositoryUrl) return "";
  const hostname = new URL(repositoryUrl).hostname.toLowerCase();
  const contributed = PRODUCT_GIT_PLATFORMS.find(platform => platform.hosts.some(host => host === hostname));
  if (contributed) return contributed.id;
  if (hostname === "gitlab.com" || hostname.includes("gitlab.")) return GIT_REPOSITORY_PROVIDER_GITLAB;
  if (hostname === "github.com") return GIT_REPOSITORY_PROVIDER_GITHUB;
  if (isLoopbackGitHost(hostname)) return GIT_REPOSITORY_PROVIDER_LOCAL;
  return "";
}

export function gitRepositoryBrowseUrl(repositoryUrl: unknown = "", selector: GitSelector = {}) {
  const normalized = normalizeGitRepositoryUrl(repositoryUrl);
  const provider = gitRepositoryProvider(normalized);
  const ref = normalizeGitRef(selector?.ref);
  const subpath = normalizeGitRepositorySubpath(selector?.subpath);
  if (!normalized || !ref || !subpath) return normalized;
  const encodedRef = encodeURIComponent(ref);
  const encodedPath = subpath.split("/").map(segment => encodeURIComponent(segment)).join("/");
  if (provider === GIT_REPOSITORY_PROVIDER_GITHUB) return `${normalized}/tree/${encodedRef}/${encodedPath}`;
  if (Boolean(provider)) {
    return `${normalized}/tree/${encodedRef}/${encodedPath}`;
  }
  return normalized;
}

export function gitRepositoryIdentity(value: unknown = "") {
  const repositoryUrl = normalizeGitRepositoryUrl(value);
  if (!repositoryUrl) return null;
  const url = new URL(repositoryUrl);
  const segments = url.pathname.split("/").filter(Boolean).map(segment => decodeURIComponentSafe(segment));
  const name = segments.at(-1) || "repository";
  return {
    repositoryUrl,
    host: url.host,
    namespace: segments.slice(0, -1).join("/"),
    name,
    label: name,
  };
}

export function gitSkillSourceId(repositoryUrl: unknown = "", selector: GitSelector = {}) {
  const normalized = normalizeGitRepositoryUrl(repositoryUrl);
  if (!normalized) return "";
  const ref = normalizeGitRef(selector?.ref);
  const subpath = normalizeGitRepositorySubpath(selector?.subpath);
  const sourceKey = ref || subpath ? `${normalized}\n${ref}\n${subpath}` : normalized;
  let hash = 0x811c9dc5;
  for (let index = 0; index < sourceKey.length; index += 1) {
    hash ^= sourceKey.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `git-${hash.toString(16).padStart(8, "0")}`;
}

export function sanitizeGitArchiveUrl(value: unknown = "", repositoryUrl: unknown = "") {
  let url;
  try {
    url = new URL(String(value || "").trim());
  } catch (_error) {
    return "";
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return "";
  const repository = normalizeGitRepositoryUrl(repositoryUrl);
  if (repository && new URL(repository).origin !== url.origin) return "";
  url.hash = "";
  for (const key of Array.from(url.searchParams.keys())) {
    if (!ARCHIVE_QUERY_KEYS.has(key.toLowerCase())) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  return url.href;
}

export function normalizeGitSkillSources(value: unknown = {}) {
  const record = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const next: Record<string, GitSkillSource> = {};
  for (const [key, raw] of Object.entries(record)) {
    const source = normalizeGitSkillSource(raw, key);
    if (source) next[source.id] = source;
  }
  return next;
}

export function normalizeGitSkillSource(input: unknown = {}, fallbackId = "") {
  const value = objectInput(input);
  const locator = gitRepositoryLocator(value?.browseUrl || value?.repositoryUrl);
  const identity = gitRepositoryIdentity(locator?.repositoryUrl || value?.repositoryUrl);
  if (!identity) return null;
  const ref = normalizeGitRef(value?.ref || locator?.ref);
  const subpath = normalizeGitRepositorySubpath(value?.subpath || locator?.subpath);
  const parsedBrowse = gitRepositoryLocator(value?.browseUrl);
  const browseUrl = parsedBrowse
    && parsedBrowse.repositoryUrl === identity.repositoryUrl
    && parsedBrowse.ref === ref
    && parsedBrowse.subpath === subpath
    ? parsedBrowse.browseUrl
    : gitRepositoryBrowseUrl(identity.repositoryUrl, { ref, subpath });
  const id = String(value?.id || fallbackId || gitSkillSourceId(identity.repositoryUrl, { ref, subpath })).trim();
  if (!id) return null;
  const skillNames = normalizeTextList(value?.skillNames, MAX_SOURCE_SKILLS);
  const rawDigests = value?.skillDigests && typeof value.skillDigests === "object" && !Array.isArray(value.skillDigests)
    ? objectInput(value.skillDigests)
    : {};
  const skillDigests: Record<string, string> = {};
  for (const name of skillNames) {
    const digest = normalizeDigest(rawDigests[name]);
    if (digest) skillDigests[name] = digest;
  }
  return {
    id,
    schemaVersion: GIT_SKILL_SOURCE_SCHEMA_VERSION,
    repositoryUrl: identity.repositoryUrl,
    browseUrl,
    host: identity.host,
    namespace: identity.namespace,
    name: identity.name,
    ref,
    subpath,
    branch: String(value?.branch || "").trim().slice(0, 240),
    revision: String(value?.revision || "").trim().slice(0, 160),
    archiveUrl: sanitizeGitArchiveUrl(value?.archiveUrl, identity.repositoryUrl),
    archiveDigest: normalizeDigest(value?.archiveDigest),
    skillNames,
    skillDigests,
    createdAt: String(value?.createdAt || "").trim(),
    importedAt: String(value?.importedAt || "").trim(),
    checkedAt: String(value?.checkedAt || "").trim(),
    updatedAt: String(value?.updatedAt || "").trim(),
  };
}

export function withGitSkillOrigin(skill: unknown = {}, source: Partial<GitSkillSource> = {}, options: { skillName?: string; importedAt?: string } = {}) {
  const normalized = normalizeModernSkill(skill);
  const metadata = normalizeSkillMetadata(normalized.metadata);
  const qingzhou = {
    ...(metadata[QINGZHOU_SKILL_METADATA_KEY] || {}),
  };
  qingzhou.origin = {
    type: GIT_SKILL_ORIGIN_TYPE,
    sourceId: String(source?.id || "").trim(),
    repositoryUrl: normalizeGitRepositoryUrl(source?.repositoryUrl),
    ref: normalizeGitRef(source?.ref),
    subpath: normalizeGitRepositorySubpath(source?.subpath),
    branch: String(source?.branch || "").trim(),
    revision: String(source?.revision || "").trim(),
    archiveDigest: normalizeDigest(source?.archiveDigest),
    skillName: String(options.skillName || normalized.name).trim(),
    importedAt: String(options.importedAt || source?.importedAt || "").trim(),
  };
  metadata[QINGZHOU_SKILL_METADATA_KEY] = qingzhou;
  return normalizeModernSkill({ ...normalized, metadata });
}

export function getGitSkillOrigin(input: unknown = {}) {
  const skill = objectInput(input);
  const metadata = normalizeSkillMetadata(skill?.metadata);
  const origin = objectInput(metadata[QINGZHOU_SKILL_METADATA_KEY]?.origin);
  if (!origin || typeof origin !== "object" || String(origin.type || "").trim() !== GIT_SKILL_ORIGIN_TYPE) return null;
  const sourceId = String(origin.sourceId || "").trim();
  const repositoryUrl = normalizeGitRepositoryUrl(origin.repositoryUrl);
  if (!sourceId || !repositoryUrl) return null;
  return {
    type: GIT_SKILL_ORIGIN_TYPE,
    sourceId,
    repositoryUrl,
    ref: normalizeGitRef(origin.ref),
    subpath: normalizeGitRepositorySubpath(origin.subpath),
    branch: String(origin.branch || "").trim(),
    revision: String(origin.revision || "").trim(),
    archiveDigest: normalizeDigest(origin.archiveDigest),
    skillName: String(origin.skillName || skill?.name || "").trim(),
    importedAt: String(origin.importedAt || "").trim(),
  };
}

export function withoutGitSkillOrigin(skill: unknown = {}, sourceId = "") {
  const normalized = normalizeModernSkill(skill);
  const metadata = normalizeSkillMetadata(normalized.metadata);
  const qingzhou = { ...(metadata[QINGZHOU_SKILL_METADATA_KEY] || {}) };
  const origin = getGitSkillOrigin(normalized);
  if (!origin || (sourceId && origin.sourceId !== String(sourceId).trim())) return normalized;
  delete qingzhou.origin;
  if (Object.keys(qingzhou).length) metadata[QINGZHOU_SKILL_METADATA_KEY] = qingzhou;
  else delete metadata[QINGZHOU_SKILL_METADATA_KEY];
  return normalizeModernSkill({ ...normalized, metadata });
}

export function gitSkillBelongsToSource(skill: unknown = {}, sourceId = "") {
  const id = String(sourceId || "").trim();
  return Boolean(id && getGitSkillOrigin(skill)?.sourceId === id);
}

function normalizeTextList(value: unknown, limit: number) {
  const rows = Array.isArray(value) ? value : [];
  return Array.from(new Set(rows.map(item => String(item || "").trim()).filter(Boolean))).slice(0, limit);
}

function normalizeDigest(value: unknown = "") {
  const digest = String(value || "").trim().toLowerCase();
  return /^[a-f\d]{64}$/u.test(digest) ? digest : "";
}

function decodeURIComponentSafe(value = "") {
  try {
    return decodeURIComponent(value);
  } catch (_error) {
    return value;
  }
}

function normalizeGitRef(value: unknown = "") {
  return String(value || "").trim().replace(/^\/+|\/+$/gu, "").slice(0, 240);
}

function parseGitUrl(value: unknown = "") {
  let raw = String(value || "").trim();
  const scpMatch = raw.match(/^git@([^:]+):(.+)$/u);
  if (scpMatch) raw = `https://${scpMatch[1]}/${scpMatch[2]}`;
  if (!/^[a-z][a-z\d+.-]*:\/\//iu.test(raw)) raw = `https://${raw}`;
  let url;
  try {
    url = new URL(raw);
  } catch (_error) {
    return null;
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
  const contributed = PRODUCT_GIT_PLATFORMS.find(platform => platform.hosts.some(host => host === url.hostname.toLowerCase()));
  if (contributed) {
    url.hostname = contributed.canonicalHost;
    if (contributed.forceHttps) { url.protocol = "https:"; url.port = ""; }
  } else if (url.hostname.toLowerCase() === "www.github.com") {
    url.hostname = "github.com";
  }
  return url;
}

function isLegacyGitLabHost(hostname = "") {
  const host = String(hostname || "").toLowerCase();
  return host === "gitlab.com" || host.includes("gitlab.") || PRODUCT_GIT_PLATFORMS.some(platform => platform.hosts.some(candidate => candidate === host));
}

function isLoopbackGitHost(hostname = "") {
  const host = String(hostname || "").toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}
