import { promptT } from "./i18n/guardrail-prompts.js";
import { t } from "./i18n/backend.js";
import { getEffectiveTabUrl, type TabReference } from "./tab-utils.js";


export interface GuardrailTarget { type: "domain" | "pattern"; value: string }
export interface GuardrailRule extends GuardrailTarget { id: string; action: "block" | "allow"; createdAt: string }
export interface SiteOpenRateLimit extends GuardrailTarget {
  id: string; minOpenIntervalMs: number; enabled: boolean; createdAt: string; updatedAt: string;
}
type GuardrailEntry = (GuardrailRule & { kind: "access" }) | (SiteOpenRateLimit & { kind: "rate_limit" });
export type SecurityGuardrails = ReturnType<typeof normalizeSecurityGuardrails>;
const objectInput = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};

export const SECURITY_GUARDRAILS_KEY = "securityGuardrails";
const MAX_GUARDRAIL_PATTERN_LENGTH = 2048;
const GUARDRAIL_ACTIONS = new Set(["block", "allow"]);
const GUARDRAIL_TYPES = new Set(["domain", "pattern"]);
const SITE_OPEN_RATE_LIMIT_MAX_MS = 24 * 60 * 60 * 1000;

export function normalizeGuardrailDomainInput(value: unknown = "") {
  const raw = String(value || "").trim();
  if (!raw) return { domain: "", error: t("security.domainRequired") };

  let text = raw
    .replace(/^@+/, "")
    .replace(/^\*\./, "")
    .trim();

  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    text = `https://${text}`;
  }

  let host = "";
  try {
    host = new URL(text).hostname;
  } catch (_err) {
    return { domain: "", error: t("security.invalidDomain") };
  }

  const domain = host
    .toLowerCase()
    .replace(/^\*\./, "")
    .replace(/^\.+|\.+$/g, "");

  if (!domain) return { domain: "", error: t("security.invalidDomain") };
  if (!/^[a-z0-9.-]+$/.test(domain)) return { domain: "", error: t("security.domainCharacters") };
  if (domain.includes("..")) return { domain: "", error: t("security.invalidDomain") };
  return { domain, error: "" };
}

export function normalizeGuardrailPatternInput(value: unknown = "") {
  const raw = String(value || "").trim();
  if (!raw) return { pattern: "", error: t("security.patternRequired") };
  if (raw.length > MAX_GUARDRAIL_PATTERN_LENGTH) return { pattern: "", error: t("security.patternTooLong") };
  if (/[\u0000-\u001f\u007f\s]/.test(raw)) return { pattern: "", error: t("security.patternWhitespace") };

  let pattern = raw;
  if (!/^(?:https?|\*):\/\//i.test(pattern)) {
    pattern = `*://${pattern.replace(/^\/+/, "")}`;
  }
  if (!/^(?:https?|\*):\/\/[^/]+(?:\/.*)?$/i.test(pattern)) {
    return { pattern: "", error: t("security.patternDomainRequired") };
  }

  const schemeMatch = pattern.match(/^([^:]+):\/\/(.*)$/);
  const scheme = schemeMatch?.[1] || "";
  const rest = schemeMatch?.[2] || "";
  const slashIndex = rest.indexOf("/");
  const hostPattern = slashIndex >= 0 ? rest.slice(0, slashIndex) : rest;
  const pathPattern = slashIndex >= 0 ? rest.slice(slashIndex) : "/*";
  const normalizedScheme = scheme === "*" ? "*" : scheme.toLowerCase();
  const normalizedHost = hostPattern.toLowerCase().replace(/^\.+|\.+$/g, "");
  if (!/^[a-z0-9.*-]+$/.test(normalizedHost) || normalizedHost.includes("..")) {
    return { pattern: "", error: t("security.patternInvalidDomain") };
  }
  const normalizedPattern = `${normalizedScheme}://${normalizedHost}${pathPattern}`;
  if (normalizedPattern.length > MAX_GUARDRAIL_PATTERN_LENGTH) {
    return { pattern: "", error: t("security.patternTooLong") };
  }
  return { pattern: normalizedPattern, error: "" };
}

export function normalizeSecurityGuardrails(input: unknown = {}) {
  const value = objectInput(input);
  const rawOrderedRules = Array.isArray(value?.rules) ? value.rules : [];
  const rawRules = Array.isArray(value?.blockedDomains) ? value.blockedDomains : [];
  const rawPatterns = Array.isArray(value?.blockedPatterns) ? value.blockedPatterns : [];
  const rawSiteOpenRateLimits = Array.isArray(value?.siteOpenRateLimits)
    ? value.siteOpenRateLimits
    : (Array.isArray(value?.navigationRateLimits) ? value.navigationRateLimits : []);
  const seenRules = new Set();
  const rules: GuardrailRule[] = [];
  const seenSiteOpenRateLimits = new Set();
  const siteOpenRateLimits: SiteOpenRateLimit[] = [];

  const pushRule = (source: unknown) => {
    const normalized = normalizeGuardrailRuleInput(source);
    if (!normalized.rule) return;
    const key = `${normalized.rule.action}:${normalized.rule.type}:${normalized.rule.value}`;
    if (seenRules.has(key)) return;
    seenRules.add(key);
    rules.push(normalized.rule);
  };

  rawOrderedRules.forEach(pushRule);

  rawRules.forEach((item) => {
    const source: Record<string, unknown> = typeof item === "string" ? { domain: item } : objectInput(item);
    pushRule({ ...source, action: "block", type: "domain", value: source.domain || source.host || source.value || "" });
  });

  rawPatterns.forEach((item) => {
    const source: Record<string, unknown> = typeof item === "string" ? { pattern: item } : objectInput(item);
    pushRule({ ...source, action: "block", type: "pattern", value: source.pattern || source.value || "" });
  });

  rawSiteOpenRateLimits.forEach((item) => {
    const normalized = normalizeSiteOpenRateLimitInput(item);
    if (!normalized.rateLimit) return;
    const key = `${normalized.rateLimit.type}:${normalized.rateLimit.value}`;
    if (seenSiteOpenRateLimits.has(key)) return;
    seenSiteOpenRateLimits.add(key);
    siteOpenRateLimits.push(normalized.rateLimit);
  });

  const inputOrder = normalizeSecurityGuardrailOrderInput(value?.order || value?.ruleOrder);
  applySecurityGuardrailOrder(rules, inputOrder);
  applySecurityGuardrailOrder(siteOpenRateLimits, inputOrder);
  const knownIds = new Set([
    ...rules.map(item => item.id),
    ...siteOpenRateLimits.map(item => item.id),
  ]);
  const order = [
    ...inputOrder.filter((id, index) => knownIds.has(id) && inputOrder.indexOf(id) === index),
    ...rules.map(item => item.id).filter(id => !inputOrder.includes(id)),
    ...siteOpenRateLimits.map(item => item.id).filter(id => !inputOrder.includes(id)),
  ];

  const blockedDomains = rules
    .filter(rule => rule.action === "block" && rule.type === "domain")
    .map(rule => ({ domain: rule.value, createdAt: rule.createdAt, id: rule.id }));
  const blockedPatterns = rules
    .filter(rule => rule.action === "block" && rule.type === "pattern")
    .map(rule => ({ pattern: rule.value, createdAt: rule.createdAt, id: rule.id }));
  const allowedDomains = rules
    .filter(rule => rule.action === "allow" && rule.type === "domain")
    .map(rule => ({ domain: rule.value, createdAt: rule.createdAt, id: rule.id }));
  const allowedPatterns = rules
    .filter(rule => rule.action === "allow" && rule.type === "pattern")
    .map(rule => ({ pattern: rule.value, createdAt: rule.createdAt, id: rule.id }));

  return { rules, blockedDomains, blockedPatterns, allowedDomains, allowedPatterns, siteOpenRateLimits, order };
}

export async function getSecurityGuardrails() {
  const { [SECURITY_GUARDRAILS_KEY]: stored = {} } = await chrome.storage.local.get(SECURITY_GUARDRAILS_KEY);
  return normalizeSecurityGuardrails(stored);
}

export async function saveSecurityGuardrails(value: unknown = {}) {
  const guardrails = normalizeSecurityGuardrails(value);
  await chrome.storage.local.set({ [SECURITY_GUARDRAILS_KEY]: guardrails });
  return guardrails;
}

export function normalizeGuardrailRuleInput(input: unknown = {}): { rule: GuardrailRule | null; error: string } {
  const source: Record<string, unknown> = typeof input === "string" ? { action: "block", type: "domain", value: input } : objectInput(input);
  const action = String(source.action || "").trim() === "allow" ? "allow" : "block";
  const requestedType = String(source.type || "").trim();
  const type = requestedType === "pattern" || requestedType === "domain" ? requestedType : inferGuardrailRuleType(source);
  const rawValue = source.value || source.domain || source.host || source.pattern || "";
  const normalized = type === "pattern"
    ? normalizeGuardrailPatternInput(rawValue)
    : normalizeGuardrailDomainInput(rawValue);
  if (normalized.error) return { rule: null, error: normalized.error };
  const value = "pattern" in normalized ? normalized.pattern : normalized.domain;
  return {
    rule: {
      id: normalizeGuardrailRuleId(source.id, { action, type, value }),
      action,
      type,
      value,
      createdAt: String(source.createdAt || new Date().toISOString()),
    },
    error: "",
  };
}

export function normalizeSiteOpenRateLimitInput(input: unknown = {}): { rateLimit: SiteOpenRateLimit | null; error: string } {
  const source: Record<string, unknown> = typeof input === "string" ? { type: "domain", value: input } : objectInput(input);
  const requestedType = String(source.type || "").trim();
  const type = requestedType === "pattern" || requestedType === "domain" ? requestedType : inferGuardrailRuleType(source);
  const rawValue = source.value || source.domain || source.host || source.pattern || "";
  const normalizedTarget = type === "pattern"
    ? normalizeGuardrailPatternInput(rawValue)
    : normalizeGuardrailDomainInput(rawValue);
  if (normalizedTarget.error) return { rateLimit: null, error: normalizedTarget.error };

  const minOpenIntervalMs = normalizeSiteOpenRateLimitIntervalMs(
    source.minOpenIntervalMs
      ?? source.minIntervalMs
      ?? source.intervalMs
      ?? source.openIntervalMs
      ?? source.waitMs,
  );
  if (minOpenIntervalMs.error) return { rateLimit: null, error: minOpenIntervalMs.error };

  const value = "pattern" in normalizedTarget ? normalizedTarget.pattern : normalizedTarget.domain;
  return {
    rateLimit: {
      id: normalizeSiteOpenRateLimitId(source.id, { type, value }),
      type,
      value,
      minOpenIntervalMs: minOpenIntervalMs.value,
      enabled: source.enabled !== false,
      createdAt: String(source.createdAt || new Date().toISOString()),
      updatedAt: String(source.updatedAt || source.createdAt || new Date().toISOString()),
    },
    error: "",
  };
}

export async function addSecurityGuardrailRule(input: unknown = {}) {
  const normalized = normalizeGuardrailRuleInput(input);
  if (!normalized.rule) return { ok: false, error: normalized.error, rule: null, guardrails: await getSecurityGuardrails() };

  const guardrails = await getSecurityGuardrails();
  const target = normalized.rule;
  const exists = guardrails.rules.some(rule => (
    rule.action === target.action
    && rule.type === target.type
    && rule.value === target.value
  ));
  if (exists) return { ok: true, existed: true, rule: normalized.rule, guardrails };

  const next = await saveSecurityGuardrails({
    rules: [
      ...guardrails.rules,
      normalized.rule,
    ],
    siteOpenRateLimits: guardrails.siteOpenRateLimits,
    order: [...guardrails.order, normalized.rule.id],
  });
  return { ok: true, existed: false, rule: normalized.rule, guardrails: next };
}

export async function removeSecurityGuardrailRule(idOrRule: unknown = "") {
  const guardrails = await getSecurityGuardrails();
  const id = typeof idOrRule === "string" ? idOrRule : String(objectInput(idOrRule).id || "");
  const normalized = !id && idOrRule && typeof idOrRule === "object"
    ? normalizeGuardrailRuleInput(idOrRule)
    : null;
  const nextRules = guardrails.rules.filter((rule) => {
    if (id && rule.id === id) return false;
    if (!normalized?.rule) return true;
    return !(rule.action === normalized.rule.action && rule.type === normalized.rule.type && rule.value === normalized.rule.value);
  });
  const next = await saveSecurityGuardrails({
    rules: nextRules,
    siteOpenRateLimits: guardrails.siteOpenRateLimits,
    order: guardrails.order.filter(ruleId => nextRules.some(rule => rule.id === ruleId) || guardrails.siteOpenRateLimits.some(item => item.id === ruleId)),
  });
  return { ok: true, id, guardrails: next };
}

export async function reorderSecurityGuardrailRules(ruleIds: unknown = []) {
  const ids = Array.isArray(ruleIds) ? ruleIds.map(id => String(id || "")).filter(Boolean) : [];
  const guardrails = await getSecurityGuardrails();
  const byId = new Map(guardrails.rules.map(rule => [rule.id, rule]));
  const ordered: GuardrailRule[] = [];
  ids.forEach((id) => {
    const rule = byId.get(id);
    if (!rule) return;
    ordered.push(rule);
    byId.delete(id);
  });
  const nextRules = [...ordered, ...byId.values()];
  const rateLimitIds = new Set(guardrails.siteOpenRateLimits.map(item => item.id));
  const next = await saveSecurityGuardrails({
    rules: nextRules,
    siteOpenRateLimits: guardrails.siteOpenRateLimits,
    order: [
      ...nextRules.map(rule => rule.id),
      ...guardrails.order.filter(id => rateLimitIds.has(id)),
    ],
  });
  return { ok: true, guardrails: next };
}

export async function addSecurityGuardrailDomain(value: unknown = "") {
  const result = await addSecurityGuardrailRule({ action: "block", type: "domain", value });
  return { ...result, domain: result.rule?.value || "" };
}

export async function addSecurityGuardrailPattern(value: unknown = "") {
  const result = await addSecurityGuardrailRule({ action: "block", type: "pattern", value });
  return { ...result, pattern: result.rule?.value || "" };
}

export async function removeSecurityGuardrailDomain(value: unknown = "") {
  const normalized = normalizeGuardrailDomainInput(value);
  const domain = normalized.domain || String(value || "").trim().toLowerCase();
  const result = await removeSecurityGuardrailRule({ action: "block", type: "domain", value: domain });
  return { ...result, domain };
}

export async function removeSecurityGuardrailPattern(value: unknown = "") {
  const normalized = normalizeGuardrailPatternInput(value);
  const pattern = normalized.pattern || String(value || "").trim();
  const result = await removeSecurityGuardrailRule({ action: "block", type: "pattern", value: pattern });
  return { ...result, pattern };
}

export interface GuardrailDecision {
  blocked: boolean; allowed: boolean; action: "block" | "allow";
  type: "domain" | "pattern"; matchType: "domain" | "pattern";
  domain?: string; pattern?: string; value: string; ruleId: string; host: string; url: string;
}

export function matchSecurityGuardrailUrl(url: unknown = "", guardrails: unknown = {}): GuardrailDecision | null {
  const target = parseGuardrailUrl(url);
  if (!target) return null;
  const { parsed, host, normalizedUrl } = target;
  const normalized = normalizeSecurityGuardrails(guardrails);
  const matchingRules = normalized.rules.filter(item => securityGuardrailRuleMatches(item, host, normalizedUrl));
  const rule = matchingRules[0] || null;
  if (rule) {
    return {
      blocked: rule.action === "block",
      allowed: rule.action === "allow",
      action: rule.action,
      type: rule.type,
      matchType: rule.type,
      domain: rule.type === "domain" ? rule.value : undefined,
      pattern: rule.type === "pattern" ? rule.value : undefined,
      value: rule.value,
      ruleId: rule.id,
      host,
      url: parsed.href,
    };
  }
  return null;
}

export function matchBlockedUrl(url: unknown = "", guardrails: unknown = {}) {
  const decision = matchSecurityGuardrailUrl(url, guardrails);
  return decision?.blocked ? decision : null;
}

export function matchSiteOpenRateLimitUrl(url: unknown = "", guardrails: unknown = {}) {
  const target = parseGuardrailUrl(url);
  if (!target) return null;
  const { parsed, host, normalizedUrl } = target;
  const normalized = normalizeSecurityGuardrails(guardrails);
  const matches = normalized.siteOpenRateLimits.filter(item => (
    item?.enabled !== false
    && securityGuardrailTargetMatches(item, host, normalizedUrl)
  ));
  if (!matches.length) return null;

  const rateLimit = matches[0];
  return {
    type: rateLimit.type,
    matchType: rateLimit.type,
    domain: rateLimit.type === "domain" ? rateLimit.value : undefined,
    pattern: rateLimit.type === "pattern" ? rateLimit.value : undefined,
    value: rateLimit.value,
    ruleId: rateLimit.id,
    host,
    url: parsed.href,
    minOpenIntervalMs: Number(rateLimit.minOpenIntervalMs || 0),
  };
}

export function filterAllowedTabs<T extends TabReference>(tabs: readonly T[] = [], guardrails: unknown = {}): T[] {
  return (Array.isArray(tabs) ? tabs : []).filter((tab) => {
    const url = getEffectiveTabUrl(tab);
    return !matchBlockedUrl(url, guardrails);
  });
}

export function annotateSecurityGuardrailTab<T extends TabReference>(tab: T, guardrails: unknown = {}): T & {
  securityGuardrailBlocked?: boolean; contentAccess?: string;
  securityGuardrail?: Pick<NonNullable<ReturnType<typeof matchBlockedUrl>>, "action" | "type" | "value" | "domain" | "pattern" | "ruleId">;
} {
  const match = matchBlockedUrl(getEffectiveTabUrl(tab), guardrails);
  if (!match) return { ...tab };
  return {
    ...tab,
    securityGuardrailBlocked: true,
    contentAccess: "blocked",
    securityGuardrail: {
      action: "block",
      type: match.type,
      value: match.value,
      domain: match.domain,
      pattern: match.pattern,
      ruleId: match.ruleId,
    },
  };
}

export function annotateSecurityGuardrailTabs<T extends TabReference>(tabs: readonly T[] = [], guardrails: unknown = {}) {
  return (Array.isArray(tabs) ? tabs : []).map(tab => annotateSecurityGuardrailTab(tab, guardrails));
}

export function buildSecurityGuardrailPromptSection(guardrails: unknown = {}, { limit = 30 } = {}) {
  const normalized = normalizeSecurityGuardrails(guardrails);
  const byId = buildSecurityGuardrailEntryMap(normalized);
  const entries = normalized.order
    .map(id => byId.get(id))
    .filter((item): item is GuardrailEntry => Boolean(item && (item.kind !== "rate_limit" || item.enabled !== false)));
  const listed = entries.slice(0, limit);
  const remaining = Math.max(0, entries.length - listed.length);
  if (!listed.length) return "";

  const lines = ["", promptT("heading"), promptT("policy")];
  for (const entry of listed) {
    const type = entry.type === "pattern" ? promptT("pattern") : promptT("domain");
    const suffix = entry.type === "domain" ? promptT("subdomains") : "";
    if (entry.kind === "rate_limit") {
      lines.push(promptT("rateLimit", { type, value: entry.value, suffix, interval: formatDurationMsForPrompt(entry.minOpenIntervalMs) }));
      continue;
    }
    const action = entry.action === "allow" ? promptT("allow") : promptT("block");
    lines.push(`- ${action} / ${type}: ${entry.value}${suffix}`);
  }
  if (remaining > 0) lines.push(promptT("remaining", { count: remaining }));
  return `${lines.join("\n")}\n`;
}

function buildSecurityGuardrailEntryMap(guardrails: SecurityGuardrails) {
  return new Map<string, GuardrailEntry>([
    ...guardrails.rules.map(rule => [rule.id, { ...rule, kind: "access" } as const] as const),
    ...guardrails.siteOpenRateLimits.map(item => [item.id, { ...item, kind: "rate_limit" } as const] as const),
  ]);
}

function inferGuardrailRuleType(source: Record<string, unknown> = {}) {
  if (source.pattern != null) return "pattern";
  return "domain";
}

function normalizeSecurityGuardrailOrderInput(value: unknown = []) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const order = [];
  for (const item of value) {
    const id = String(item || "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    order.push(id);
  }
  return order;
}

function applySecurityGuardrailOrder(items: { id: string }[], order: string[] = []) {
  if (!Array.isArray(items) || !items.length || !order.length) return;
  const indexById = new Map(order.map((id, index) => [id, index]));
  items.sort((a, b) => {
    const left = indexById.get(a.id) ?? Number.POSITIVE_INFINITY;
    const right = indexById.get(b.id) ?? Number.POSITIVE_INFINITY;
    return left - right;
  });
}

function normalizeGuardrailRuleId(id: unknown, { action, type, value }: Pick<GuardrailRule, "action" | "type" | "value">) {
  const raw = String(id || "").trim();
  if (raw) return raw;
  return `guard_${action}_${type}_${hashGuardrailRuleValue(value)}`;
}

function normalizeSiteOpenRateLimitId(id: unknown, { type, value }: GuardrailTarget) {
  const raw = String(id || "").trim();
  if (raw) return raw;
  return `guard_open_rate_${type}_${hashGuardrailRuleValue(value)}`;
}

function normalizeSiteOpenRateLimitIntervalMs(value: unknown) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return { value: 0, error: t("security.intervalPositive") };
  const rounded = Math.round(number);
  if (rounded > SITE_OPEN_RATE_LIMIT_MAX_MS) return { value: 0, error: t("security.intervalTooLong") };
  return { value: rounded, error: "" };
}

function hashGuardrailRuleValue(value: unknown = "") {
  const text = String(value || "");
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function securityGuardrailRuleMatches(rule: GuardrailRule, host: string, normalizedUrl: string) {
  if (!rule || !GUARDRAIL_ACTIONS.has(rule.action) || !GUARDRAIL_TYPES.has(rule.type)) return false;
  return securityGuardrailTargetMatches(rule, host, normalizedUrl);
}

function securityGuardrailTargetMatches(target: GuardrailTarget, host: string, normalizedUrl: string) {
  if (!target || !GUARDRAIL_TYPES.has(target.type)) return false;
  if (target.type === "domain") return host === target.value || host.endsWith(`.${target.value}`);
  try {
    const pattern = target.value.match(/^(\*|https?):\/\/([^/]+)(\/.*)$/);
    if (!pattern) return false;
    const url = new URL(normalizedUrl);
    return (pattern[1] === "*" || `${pattern[1]}:` === url.protocol)
      && matchesWildcard(url.host, pattern[2])
      && matchesWildcard(`${url.pathname}${url.search}${url.hash}`, pattern[3]);
  } catch (_err) {
    return false;
  }
}

function parseGuardrailUrl(url: unknown) {
  try {
    const parsed = new URL(String(url || ""));
    if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname) return null;
    return { parsed, host: parsed.hostname.toLowerCase(), normalizedUrl: normalizeUrlForPatternMatch(parsed) };
  } catch { return null; }
}

function normalizeUrlForPatternMatch(parsed: URL) {
  const protocol = parsed.protocol.toLowerCase();
  const host = parsed.host.toLowerCase();
  return `${protocol}//${host}${parsed.pathname}${parsed.search}${parsed.hash}`;
}

function matchesWildcard(value: string, pattern: string) {
  const parts = pattern.split("*");
  if (parts.length === 1) return value === pattern;
  if (!value.startsWith(parts[0])) return false;
  let offset = parts[0].length;
  for (const part of parts.slice(1, -1)) {
    const index = value.indexOf(part, offset);
    if (index < 0) return false;
    offset = index + part.length;
  }
  const last = parts[parts.length - 1];
  return value.endsWith(last) && value.length - last.length >= offset;
}

function formatDurationMsForPrompt(ms: unknown = 0) {
  const value = Number(ms) || 0;
  if (value >= 60 * 1000 && value % (60 * 1000) === 0) return promptT("minutes", { value: value / (60 * 1000) });
  if (value >= 1000 && value % 1000 === 0) return promptT("seconds", { value: value / 1000 });
  return `${value} ms`;
}
