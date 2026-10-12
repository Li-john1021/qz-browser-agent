import { createHash } from "node:crypto";

import { analyzeMarkdown } from "./markdown-quality.mjs";

export const SUPPORTED_OUTPUT_FORMATS = Object.freeze([
  "json_array",
  "json_object",
  "nested_json",
  "csv",
  "markdown",
  "plain_text",
]);

export const ANSWER_MODES = Object.freeze([
  "verbatim",
  "structured_verbatim",
  "derived_summary",
  "aggregate",
  "negative",
]);

export const CLAIM_MAPPING_FIELDS = Object.freeze(["path", "value", "evidenceIndexes"]);
export const NEGATIVE_PROOF_FIELDS = Object.freeze(["kind", "source", "needle", "sourceSha256"]);

const ROOT_FIELDS = new Set(["schema", "sampleId", "variations"]);
const VARIATION_FIELDS = new Set([
  "slot",
  "capability",
  "taskType",
  "outputFormat",
  "instruction",
  "scope",
  "output",
  "answerMode",
  "negative",
  "evidenceQuotes",
  "evidenceUrls",
  "derivation",
  "claimMappings",
  "negativeProof",
]);
const EVIDENCE_FIELDS = new Set(["source", "quote"]);
const CLAIM_FIELDS = new Set(CLAIM_MAPPING_FIELDS);
const NEGATIVE_FIELDS = new Set(NEGATIVE_PROOF_FIELDS);
const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const SAFE_PROTOCOLS = new Set(["http:", "https:", "mailto:", "tel:"]);
const FORMAT_WORDS = new Set([
  "json", "json_array", "json_object", "nested_json", "csv", "markdown", "md", "纯文本", "文本",
]);

function unique(values) {
  return [...new Set(values)];
}

function isPlainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function ownKeys(value) {
  return isPlainRecord(value) ? Object.keys(value) : [];
}

function exactObjectErrors(value, allowed, label) {
  if (!isPlainRecord(value)) return [`${label} must be a plain object`];
  const errors = [];
  for (const key of ownKeys(value)) {
    if (DANGEROUS_KEYS.has(key)) errors.push(`${label} contains a forbidden key: ${key}`);
    else if (!allowed.has(key)) errors.push(`${label} contains an unexpected field: ${key}`);
  }
  return errors;
}

function dangerousKeyErrors(value, path = "$", seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const errors = [];
  for (const key of Object.keys(value)) {
    if (DANGEROUS_KEYS.has(key)) errors.push(`${path} contains a forbidden key: ${key}`);
    errors.push(...dangerousKeyErrors(value[key], `${path}.${key}`, seen));
  }
  return errors;
}

function decodeBasicHtmlEntities(value) {
  return String(value ?? "")
    .replace(/&#(\d+);?/g, (_match, digits) => {
      const codePoint = Number(digits);
      return Number.isInteger(codePoint) && codePoint > 0 && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : _match;
    })
    .replace(/&#x([\da-f]+);?/gi, (_match, digits) => {
      const codePoint = Number.parseInt(digits, 16);
      return Number.isInteger(codePoint) && codePoint > 0 && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : _match;
    })
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/gi, (_match, name) => ({
      amp: "&",
      lt: "<",
      gt: ">",
      quot: '"',
      apos: "'",
      nbsp: " ",
    })[name.toLowerCase()]);
}

/**
 * Evidence matching deliberately removes punctuation and spacing, but never
 * letters or numbers. Thus P3-5 matches P3 - 5 while P4-5 cannot match it.
 */
export function canonicalEvidenceText(value) {
  return decodeBasicHtmlEntities(value)
    .normalize("NFKC")
    .toLocaleLowerCase("und")
    .replace(/[\u200b-\u200f\u2060\ufeff]/g, "")
    .replace(/[\p{P}\p{Z}\s]+/gu, "");
}

function canonicalContains(haystackValue, needleValue) {
  const rawHaystack = decodeBasicHtmlEntities(haystackValue).normalize("NFKC").toLocaleLowerCase("und");
  const rawNeedle = decodeBasicHtmlEntities(needleValue).normalize("NFKC").toLocaleLowerCase("und");
  if (rawNeedle && rawHaystack.includes(rawNeedle)) return true;
  const haystack = canonicalEvidenceText(haystackValue);
  const needle = canonicalEvidenceText(needleValue);
  if (!needle || !haystack) return false;
  let offset = haystack.indexOf(needle);
  while (offset >= 0) {
    const before = haystack[offset - 1] || "";
    const after = haystack[offset + needle.length] || "";
    const startsAscii = /^[a-z0-9]/i.test(needle);
    const endsAscii = /[a-z0-9]$/i.test(needle);
    if ((!startsAscii || !/[a-z0-9]/i.test(before)) && (!endsAscii || !/[a-z0-9]/i.test(after))) return true;
    offset = haystack.indexOf(needle, offset + 1);
  }
  return false;
}

export function evidenceTextContains(haystackValue, needleValue) {
  return canonicalContains(haystackValue, needleValue);
}

function stripHtml(value) {
  return decodeBasicHtmlEntities(String(value ?? "")
    .replace(/<(?:script|style|noscript)\b[^>]*>[\s\S]*?<\/\s*(?:script|style|noscript)\s*>/gi, " ")
    .replace(/<!--[^]*?-->/g, " ")
    .replace(/<[^>]+>/g, " "));
}

function sourceValues(raw) {
  if (Array.isArray(raw)) return raw.flatMap(sourceValues);
  if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") return [String(raw)];
  if (!isPlainRecord(raw)) return [];
  if (Array.isArray(raw.values)) return raw.values.flatMap(sourceValues);
  if (Object.hasOwn(raw, "value")) return sourceValues(raw.value);
  if (Object.hasOwn(raw, "text")) return sourceValues(raw.text);
  return [];
}

function sourceIsComplete(name, context) {
  const declared = context?.completeSources;
  if (declared instanceof Set && declared.has(name)) return true;
  if (Array.isArray(declared) && declared.includes(name)) return true;
  const raw = context?.sources?.[name];
  return isPlainRecord(raw) && raw.complete === true;
}

export function sourceDigest(value) {
  const joined = sourceValues(value).join("\u001e");
  return createHash("sha256").update(joined).digest("hex");
}

function sourceContains(raw, quote, { html = false } = {}) {
  return sourceValues(raw).some(value => canonicalContains(value, quote) || (html && canonicalContains(stripHtml(value), quote)));
}

export function parseCsv(value) {
  const input = String(value ?? "").replace(/^\ufeff/, "");
  if (!input) return [];
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  let closedQuote = false;
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (quoted) {
      if (character === '"' && input[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
        closedQuote = true;
      } else {
        field += character;
      }
      continue;
    }
    if (closedQuote && ![",", "\r", "\n"].includes(character)) {
      throw new Error("CSV contains characters after a closing quote");
    }
    if (character === '"') {
      if (field) throw new Error("CSV quote must start at the beginning of a field");
      quoted = true;
      closedQuote = false;
    } else if (character === ",") {
      row.push(field);
      field = "";
      closedQuote = false;
    } else if (character === "\r" || character === "\n") {
      if (character === "\r" && input[index + 1] === "\n") index += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      closedQuote = false;
    } else {
      field += character;
    }
  }
  if (quoted) throw new Error("CSV has an unclosed quoted field");
  if (field || row.length || !rows.length) {
    row.push(field);
    rows.push(row);
  }
  if (rows.length > 1 && rows.at(-1)?.length === 1 && rows.at(-1)[0] === "") rows.pop();
  const width = rows[0]?.length || 0;
  if (!width || rows.some(next => next.length !== width)) throw new Error("CSV rows have inconsistent widths");
  return rows;
}

function nestedValuePresent(value) {
  return (isPlainRecord(value) || Array.isArray(value))
    && Object.values(value).some(child => child && typeof child === "object");
}

function isEmptyForFormat(format, output) {
  const text = String(output ?? "").trim();
  if (["plain_text", "markdown", "csv"].includes(format)) return text === "";
  try {
    const parsed = JSON.parse(text);
    if (format === "json_array") return Array.isArray(parsed) && parsed.length === 0;
    return isPlainRecord(parsed) && Object.keys(parsed).length === 0;
  } catch (_error) {
    return false;
  }
}

export function validateOutputFormat(format, output, { negative = false } = {}) {
  const errors = [];
  const text = String(output ?? "");
  try {
    if (format === "json_array") {
      const parsed = JSON.parse(text);
      if (!Array.isArray(parsed)) errors.push("output must be a JSON array");
      else if (!negative && parsed.length === 0) errors.push("non-negative JSON array must not be empty");
      else if (!negative && jsonScalarUnits(parsed).length === 0) errors.push("non-negative JSON array must contain a scalar value");
      errors.push(...dangerousKeyErrors(parsed, "output"));
    } else if (format === "json_object" || format === "nested_json") {
      const parsed = JSON.parse(text);
      const validContainer = format === "nested_json"
        ? isPlainRecord(parsed) || Array.isArray(parsed)
        : isPlainRecord(parsed);
      if (!validContainer) errors.push(format === "nested_json" ? "output must be a JSON object or array" : "output must be a JSON object");
      else if (!negative && Object.keys(parsed).length === 0) errors.push(`non-negative ${format} must not be empty`);
      else if (!negative && jsonScalarUnits(parsed).length === 0) errors.push(`non-negative ${format} must contain a scalar value`);
      if (format === "nested_json" && !negative && !nestedValuePresent(parsed)) {
        errors.push("nested_json must contain a nested object or array");
      }
      errors.push(...dangerousKeyErrors(parsed, "output"));
    } else if (format === "csv") {
      const rows = parseCsv(text);
      if (!negative && rows.length < 2) errors.push("non-negative CSV must contain a header and at least one data row");
      if (!negative && !rows.slice(1).flat().some(cell => canonicalEvidenceText(cell))) errors.push("non-negative CSV must contain a data value");
      if (rows.length && rows[0].some(cell => !String(cell).trim())) errors.push("CSV header cells must not be empty");
    } else if (format === "markdown") {
      const quality = analyzeMarkdown(text);
      if (quality.parser.errors || quality.syntax.total) errors.push("Markdown parser/syntax validation failed");
      if (/^```(?:json|markdown)?\s*[\[{]/i.test(text.trim())) errors.push("Markdown must not wrap the whole answer in a fence");
      if (!negative && !text.trim()) errors.push("non-negative Markdown must not be empty");
      else if (!negative && !canonicalEvidenceText(text)) errors.push("non-negative Markdown must contain visible content");
    } else if (format === "plain_text") {
      if (/^```[\s\S]*```$/m.test(text.trim())) errors.push("plain_text must not be fenced");
      if (/^\s{0,3}(?:#{1,6}\s|[-*+]\s|>\s|\|.*\|\s*$)/m.test(text)) errors.push("plain_text must not contain Markdown block syntax");
      if (!negative && !text.trim()) errors.push("non-negative plain_text must not be empty");
      else if (!negative && !canonicalEvidenceText(text)) errors.push("non-negative plain_text must contain visible content");
    } else {
      errors.push(`unsupported output format: ${format}`);
    }
  } catch (error) {
    errors.push(`${format} parse failed: ${error.message}`);
  }
  if (negative && !isEmptyForFormat(format, text)) errors.push("negative output is not the format-specific empty value");
  return unique(errors);
}

function jsonPointerSegment(value) {
  return String(value).replace(/~/g, "~0").replace(/\//g, "~1");
}

function jsonScalarUnits(value, path = "$", result = [], field = "") {
  if (Array.isArray(value)) {
    value.forEach((child, index) => jsonScalarUnits(child, `${path}/${index}`, result, field));
  } else if (isPlainRecord(value)) {
    for (const [key, child] of Object.entries(value)) jsonScalarUnits(child, `${path}/${jsonPointerSegment(key)}`, result, key);
  } else if (value !== null) {
    result.push({ path, value: String(value), field });
  }
  return result;
}

function replaceInlineMarkdownLinks(value) {
  const input = String(value);
  const matcher = /!?\[([^\]]*)\]\(/g;
  let result = "";
  let cursor = 0;
  for (let match = matcher.exec(input); match; match = matcher.exec(input)) {
    let depth = 1;
    let escaped = false;
    let end = matcher.lastIndex;
    for (; end < input.length; end += 1) {
      const character = input[end];
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === "(") depth += 1;
      else if (character === ")" && --depth === 0) break;
    }
    if (depth !== 0) continue;
    result += input.slice(cursor, match.index) + match[1];
    cursor = end + 1;
    matcher.lastIndex = cursor;
  }
  return result + input.slice(cursor);
}

function replaceMarkdownLinks(value) {
  return replaceInlineMarkdownLinks(value)
    .replace(/!\[([^\]]*)\]\[[^\]]*\]/g, "$1")
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1")
    .replace(/<((?:https?:\/\/|mailto:|tel:)[^>]+)>/gi, "$1");
}

function splitMarkdownRow(line) {
  const text = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells = [];
  let cell = "";
  let escaped = false;
  let code = false;
  for (const character of text) {
    if (escaped) {
      cell += character;
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
      cell += character;
    } else if (character === "`") {
      code = !code;
      cell += character;
    } else if (character === "|" && !code) {
      cells.push(cell);
      cell = "";
    } else {
      cell += character;
    }
  }
  cells.push(cell);
  return cells;
}

function markdownVisibleUnit(value, { stripLabel = true } = {}) {
  let text = replaceMarkdownLinks(value)
    .replace(/<[^>]+>/g, " ")
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s*|(?:[-*+] |\d+[.)] ))/, "")
    .replace(/^\s*\[[ xX]\]\s*/, "")
    .replace(/(`+)(.*?)\1/g, "$2")
    .replace(/(?:\*\*|__|~~|[*_])/g, "")
    .replace(/\\([\\`*_[\]{}()#+.!|>-])/g, "$1")
    .trim();
  const labelled = stripLabel ? text.match(/^[^：:\n|\d]{1,30}[：:]\s*(.+)$/u) : null;
  if (labelled) text = labelled[1].trim();
  return text;
}

function markdownScalarUnits(output) {
  const lines = String(output ?? "").split(/\r?\n/);
  const result = [];
  let fenced = false;
  let tableActive = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\s{0,3}(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (!fenced && /^\s*\[[^\]]+\]:\s*/.test(line)) continue;
    const next = lines[index + 1] || "";
    const tableHeader = line.includes("|") && /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(next);
    const tableSeparator = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
    if (tableHeader) continue;
    if (tableSeparator) {
      tableActive = true;
      continue;
    }
    if (tableActive && line.includes("|")) {
      splitMarkdownRow(line).forEach((cell, column) => {
        const value = markdownVisibleUnit(cell, { stripLabel: false });
        if (canonicalEvidenceText(value)) result.push({ path: `line[${index + 1}].cell[${column}]`, value });
      });
      continue;
    }
    if (tableActive) tableActive = false;
    const listContent = line.replace(/^\s{0,3}(?:[-*+] |\d+[.)] )/, "");
    if (listContent.includes("|")) {
      splitMarkdownRow(listContent).forEach((cell, column) => {
        const value = markdownVisibleUnit(cell, { stripLabel: false });
        if (canonicalEvidenceText(value)) result.push({ path: `line[${index + 1}].part[${column}]`, value });
      });
      continue;
    }
    const value = markdownVisibleUnit(line);
    if (canonicalEvidenceText(value)) result.push({ path: `line[${index + 1}]`, value });
  }
  return result;
}

function isUrlOnly(value) {
  const text = String(value ?? "").trim();
  return /^(?:[a-z][a-z\d+.-]*:|\/\/|\.{0,2}\/|[?#]|www\.|[^\s@]+@[^\s@]+\.[^\s@]+)[^\s]*$/i.test(text);
}

export function extractGroundingUnits(format, output) {
  try {
    if (["json_array", "json_object", "nested_json"].includes(format)) {
      return jsonScalarUnits(JSON.parse(String(output ?? ""))).map(({ field, ...unit }) => ({
        ...unit,
        url: isUrlOnly(unit.value) || (
          /(?:^|_)(?:url|uri|href|link|src|path)(?:$|_)/i.test(field)
          && !/\s/.test(unit.value)
          && unit.value.includes("/")
        ),
      }));
    }
    if (format === "csv") {
      const rows = parseCsv(output);
      return rows.slice(1).flatMap((row, rowOffset) => row.map((value, column) => ({
        path: `row[${rowOffset + 1}].col[${column}]`,
        value,
        url: isUrlOnly(value),
      }))).filter(unit => canonicalEvidenceText(unit.value));
    }
    if (format === "markdown") return markdownScalarUnits(output).map(unit => ({ ...unit, url: isUrlOnly(unit.value) }));
    if (format === "plain_text") {
      return String(output ?? "").split(/\r?\n/).map((value, index) => ({
        path: `line[${index + 1}]`,
        value: markdownVisibleUnit(value),
        url: isUrlOnly(value),
      })).filter(unit => canonicalEvidenceText(unit.value));
    }
  } catch (_error) {
    return [];
  }
  return [];
}

function trimUrlPunctuation(value) {
  return decodeBasicHtmlEntities(String(value ?? "").trim())
    .replace(/^[<'"`]+/, "")
    .replace(/[>'"`,.;:!?，。；：！？]+$/, "");
}

export function canonicalUrl(value, baseUrl = "") {
  let candidate = trimUrlPunctuation(value);
  if (!candidate) return "";
  if (/^www\./i.test(candidate)) candidate = `https://${candidate}`;
  if (/^[^\s/@]+@[^\s/@]+\.[^\s/@]+$/.test(candidate)) candidate = `mailto:${candidate}`;
  try {
    const parsed = new URL(candidate, baseUrl || undefined);
    return SAFE_PROTOCOLS.has(parsed.protocol) ? parsed.href : "";
  } catch (_error) {
    return "";
  }
}

function balancedRawUrl(value) {
  let text = String(value ?? "").replace(/[.,;:!?，。；：！？]+$/, "");
  for (const [opening, closing] of [["(", ")"], ["[", "]"], ["{", "}"]]) {
    const openings = [...text].filter(character => character === opening).length;
    let closings = [...text].filter(character => character === closing).length;
    while (closings > openings && text.endsWith(closing)) {
      text = text.slice(0, -1);
      closings -= 1;
    }
  }
  return text;
}

function rawUrlCandidates(value) {
  return [...String(value ?? "").matchAll(/(?:https?:\/\/|mailto:|tel:|www\.)[^\s<>"'`]+/gi)]
    .map(match => balancedRawUrl(match[0]))
    .filter(Boolean);
}

function markdownDestinations(markdown) {
  const input = String(markdown ?? "");
  const destinations = [];
  let marker = input.indexOf("](");
  while (marker >= 0) {
    let index = marker + 2;
    while (/\s/.test(input[index] || "")) index += 1;
    let destination = "";
    if (input[index] === "<") {
      const end = input.indexOf(">", index + 1);
      if (end >= 0) destination = input.slice(index + 1, end);
    } else {
      let depth = 1;
      let escaped = false;
      for (; index < input.length; index += 1) {
        const character = input[index];
        if (escaped) {
          destination += character;
          escaped = false;
        } else if (character === "\\") {
          escaped = true;
        } else if (character === "(") {
          depth += 1;
          destination += character;
        } else if (character === ")") {
          depth -= 1;
          if (depth === 0) break;
          destination += character;
        } else if (/\s/.test(character) && depth === 1) {
          break;
        } else {
          destination += character;
        }
      }
    }
    if (destination) destinations.push(destination);
    marker = input.indexOf("](", marker + 2);
  }
  for (const match of input.matchAll(/^\s*\[[^\]]+\]:\s*(?:<([^>]+)>|(\S+))/gm)) destinations.push(match[1] || match[2]);
  for (const match of input.matchAll(/<((?:https?:\/\/|mailto:|tel:)[^>]+)>/gi)) destinations.push(match[1]);
  for (const match of input.matchAll(/\b(?:href|src|poster|action)\s*=\s*["']([^"']+)["']/gi)) destinations.push(match[1]);
  destinations.push(...rawUrlCandidates(input));
  return unique(destinations);
}

function stringUrlCandidates(value, { relative = true, bareRelative = false } = {}) {
  const text = String(value ?? "").trim();
  if (relative && (isUrlOnly(text) || (bareRelative && !/\s/.test(text) && text.includes("/")))) return [text];
  const values = rawUrlCandidates(text);
  if (/^[a-z][a-z\d+.-]*:/i.test(text) && !values.includes(text)) values.push(text);
  return unique(values);
}

function jsonStringValues(value, result = [], field = "") {
  if (Array.isArray(value)) value.forEach(child => jsonStringValues(child, result, field));
  else if (isPlainRecord(value)) Object.entries(value).forEach(([key, child]) => jsonStringValues(child, result, key));
  else if (typeof value === "string") result.push({ value, field });
  return result;
}

export function extractOutputUrls(format, output, baseUrl = "") {
  let candidates = [];
  try {
    if (["json_array", "json_object", "nested_json"].includes(format)) {
      candidates = jsonStringValues(JSON.parse(String(output ?? ""))).flatMap(({ value, field }) => stringUrlCandidates(value, {
        bareRelative: /(?:^|_)(?:url|uri|href|link|src|path)(?:$|_)/i.test(field),
      }));
    } else if (format === "csv") {
      const rows = parseCsv(output);
      candidates = rows.slice(1).flatMap(row => row.flatMap((value, column) => stringUrlCandidates(value, {
        bareRelative: /(?:^|_)(?:url|uri|href|link|src|path)(?:$|_)/i.test(rows[0]?.[column] || ""),
      })));
    } else if (format === "markdown") {
      candidates = markdownDestinations(output);
    } else if (format === "plain_text") {
      candidates = String(output ?? "").split(/\r?\n/).flatMap(value => stringUrlCandidates(value));
    }
  } catch (_error) {
    return [];
  }
  return unique(candidates).map(raw => ({ raw, url: canonicalUrl(raw, baseUrl) }));
}

function sourceUrls(context) {
  const values = new Set();
  const add = raw => {
    const url = canonicalUrl(raw, context?.finalUrl || "");
    if (url) values.add(url);
  };
  add(context?.finalUrl || "");
  for (const raw of context?.allowedUrls || []) add(raw);
  for (const [name, raw] of Object.entries(context?.sources || {})) {
    for (const text of sourceValues(raw)) {
      rawUrlCandidates(text).forEach(add);
      if (/markdown/i.test(name)) markdownDestinations(text).forEach(add);
      if (/html/i.test(name)) {
        for (const match of text.matchAll(/\b(?:href|src|poster|action)\s*=\s*["']([^"']+)["']/gi)) add(match[1]);
        for (const match of text.matchAll(/\bsrcset\s*=\s*["']([^"']+)["']/gi)) {
          match[1].split(",").forEach(item => add(item.trim().split(/\s+/)[0]));
        }
      }
    }
  }
  return values;
}

export function extractQuotedConditions(instruction) {
  const values = [];
  const text = String(instruction ?? "");
  for (const expression of [/[“”]([^“”]{2,120})[“”]/g, /"([^"]{2,120})"/g, /'([^']{2,120})'/g]) {
    for (const match of text.matchAll(expression)) {
      const before = text.slice(Math.max(0, text.lastIndexOf("。", match.index) + 1), match.index);
      const after = text.slice(match.index + match[0].length, match.index + match[0].length + 80);
      if (/(?:每个(?:对象|项目|元素|条目)[^。；\n]{0,100}(?:包含|包括)|(?:字段|键)(?:名)?(?:为|包括|包含))[^。；\n]*$/i.test(before)) continue;
      if (/(?:输出|形式)[^。；\n]{0,80}(?:包含|包括)[^。；\n]*$/i.test(before) && /(?:字段|列|键)/.test(after)) continue;
      values.push(match[1]);
    }
  }
  return unique(values.map(value => value.trim()).filter(value => {
    const canonical = canonicalEvidenceText(value);
    if (!canonical || FORMAT_WORDS.has(value.toLocaleLowerCase("und"))) return false;
    if (/(?:\.{3}|…)/.test(value)) return false;
    if (/^(?:(?:字段(?:名)?|标签|键)\s*[：:]\s*(?:值|内容)|key\s*[：:]\s*value)$/i.test(value)) return false;
    return true;
  }));
}

function instructionInjectionErrors(instruction) {
  const text = String(instruction ?? "");
  const patterns = [
    /<\/?(?:think|system|assistant|developer|script)\b/i,
    /(?:^|\n)\s*(?:system|assistant|developer)\s*:/i,
    /\[\/?INST\]/i,
    /ignore\s+(?:all\s+|any\s+|the\s+|previous\s+)*(?:instructions?|prompts?)/i,
    /忽略.{0,12}(?:之前|以上|此前|所有).{0,12}(?:指令|要求|提示)/,
  ];
  return patterns.some(pattern => pattern.test(text)) ? ["instruction contains prompt-control content"] : [];
}

function evidenceErrors(evidence, context, prefix) {
  const errors = [];
  if (!Array.isArray(evidence)) return [`${prefix} evidenceQuotes must be an array`];
  for (const [index, entry] of evidence.entries()) {
    const label = `${prefix} evidenceQuotes[${index}]`;
    errors.push(...exactObjectErrors(entry, EVIDENCE_FIELDS, label));
    if (!isPlainRecord(entry)) continue;
    const source = String(entry.source || "");
    const quote = String(entry.quote ?? "");
    if (!Object.hasOwn(context?.sources || {}, source)) errors.push(`${label} source is invalid: ${source}`);
    else if (quote.length > 8_000 || canonicalEvidenceText(quote).length < 2) errors.push(`${label} quote length is invalid`);
    else if (/^[\s\d.,:%+-]+$/.test(quote)) errors.push(`${label} numeric-only quote lacks identifying context`);
    else if (!sourceContains(context.sources[source], quote, { html: /html/i.test(source) })) {
      errors.push(`${label} quote is not found in ${source}`);
    }
  }
  return errors;
}

export function buildClaimMappings(format, output, evidenceQuotes) {
  return extractGroundingUnits(format, output).filter(unit => !unit.url).map(unit => ({
    path: unit.path,
    value: unit.value,
    evidenceIndexes: evidenceQuotes.flatMap((entry, index) => canonicalContains(entry?.quote, unit.value) ? [index] : []),
  }));
}

export function validateClaimMappings(variation, context, prefix = "variation") {
  const errors = [];
  const evidence = Array.isArray(variation?.evidenceQuotes) ? variation.evidenceQuotes : [];
  const mappings = variation?.claimMappings;
  if (!Array.isArray(mappings)) return [`${prefix} claimMappings must be an array`];
  const expected = extractGroundingUnits(variation.outputFormat, variation.output).filter(unit => !unit.url);
  const expectedByPath = new Map(expected.map(unit => [unit.path, unit]));
  const seen = new Set();
  for (const [index, mapping] of mappings.entries()) {
    const label = `${prefix} claimMappings[${index}]`;
    errors.push(...exactObjectErrors(mapping, CLAIM_FIELDS, label));
    if (!isPlainRecord(mapping)) continue;
    const path = String(mapping.path || "");
    if (seen.has(path)) errors.push(`${label} duplicates path ${path}`);
    seen.add(path);
    const unit = expectedByPath.get(path);
    if (!unit) {
      errors.push(`${label} path does not identify a groundable output scalar: ${path}`);
      continue;
    }
    if (String(mapping.value ?? "") !== unit.value) errors.push(`${label} value does not exactly match output scalar ${path}`);
    if (!Array.isArray(mapping.evidenceIndexes) || !mapping.evidenceIndexes.length) {
      errors.push(`${label} evidenceIndexes must be a non-empty array`);
      continue;
    }
    const indexes = unique(mapping.evidenceIndexes);
    if (indexes.length !== mapping.evidenceIndexes.length) errors.push(`${label} evidenceIndexes contain duplicates`);
    for (const evidenceIndex of indexes) {
      if (!Number.isInteger(evidenceIndex) || evidenceIndex < 0 || evidenceIndex >= evidence.length) {
        errors.push(`${label} evidence index is invalid: ${evidenceIndex}`);
      } else if (!canonicalContains(evidence[evidenceIndex]?.quote, unit.value)) {
        errors.push(`${label} value is not present in evidenceQuotes[${evidenceIndex}]`);
      }
    }
    const inAnySource = Object.values(context?.sources || {}).some(source => sourceContains(source, unit.value, { html: true }));
    if (!inAnySource) errors.push(`${label} value is not present in any source`);
    if (context?.finalInputHtml != null
      && !canonicalContains(context.finalInputHtml, unit.value)
      && !sourceContains(context.finalInputHtml, unit.value, { html: true })) {
      errors.push(`${label} value is not present in the final training HTML`);
    }
  }
  for (const unit of expected) {
    if (!seen.has(unit.path)) errors.push(`${prefix} claimMappings do not cover output scalar ${unit.path}`);
  }
  return unique(errors);
}

function quotedLiteralMatchesInstruction(needle, instruction) {
  const quoted = [];
  for (const expression of [/[“"]([^”"]{1,256})[”"]/g, /'([^']{1,256})'/g]) {
    for (const match of String(instruction ?? "").matchAll(expression)) quoted.push(match[1]);
  }
  return quoted.some(value => canonicalEvidenceText(value) === canonicalEvidenceText(needle));
}

/** Validate the only deterministic negative proof accepted by this module. */
export function validateNegativeMachineFacts(proof, context, instruction = "") {
  const errors = exactObjectErrors(proof, NEGATIVE_FIELDS, "negativeProof");
  if (!isPlainRecord(proof)) return errors;
  if (proof.kind !== "literal_absence") errors.push("negativeProof kind must be literal_absence");
  const source = String(proof.source || "");
  if (!Object.hasOwn(context?.sources || {}, source)) return [...errors, `negativeProof source is invalid: ${source}`];
  if (!sourceIsComplete(source, context)) errors.push(`negativeProof source is not declared complete: ${source}`);
  const needle = String(proof.needle ?? "");
  if (canonicalEvidenceText(needle).length < 2 || needle.length > 256) errors.push("negativeProof needle length is invalid");
  if (!quotedLiteralMatchesInstruction(needle, instruction)) errors.push("negativeProof needle must be an exact quoted literal in instruction");
  const expectedDigest = sourceDigest(context.sources[source]);
  if (!/^[a-f\d]{64}$/i.test(String(proof.sourceSha256 || "")) || proof.sourceSha256 !== expectedDigest) {
    errors.push("negativeProof sourceSha256 mismatch");
  }
  if (sourceContains(context.sources[source], needle, { html: /html/i.test(source) })) {
    errors.push("negativeProof literal is present in the declared source");
  }
  return unique(errors);
}

function criticAccepted(context, slot) {
  const verdicts = context?.criticVerdicts;
  const verdict = verdicts instanceof Map ? verdicts.get(slot) : verdicts?.[slot] ?? verdicts?.[String(slot)];
  return verdict === true || (isPlainRecord(verdict) && verdict.accepted === true);
}

export function validateVariation(variation, context, planned, offset = 0) {
  const slot = Number(planned?.slot ?? offset + 1);
  const prefix = `variation ${slot}`;
  const errors = exactObjectErrors(variation, VARIATION_FIELDS, prefix);
  if (!isPlainRecord(variation)) return errors;
  if (variation.slot !== slot) errors.push(`${prefix} slot mismatch`);
  if (variation.outputFormat !== planned?.outputFormat) errors.push(`${prefix} outputFormat must be ${planned?.outputFormat}`);
  if (!SUPPORTED_OUTPUT_FORMATS.includes(variation.outputFormat)) errors.push(`${prefix} outputFormat is unsupported`);
  if (!/^[a-z][a-z\d_]{1,63}$/.test(String(variation.capability || ""))) errors.push(`${prefix} capability must be snake_case`);
  if (!/^[a-z][a-z\d_]{1,63}$/.test(String(variation.taskType || ""))) errors.push(`${prefix} taskType must be snake_case`);
  const instruction = String(variation.instruction ?? "").trim();
  if (instruction.length < 6 || instruction.length > 1_000) errors.push(`${prefix} instruction length is invalid`);
  errors.push(...instructionInjectionErrors(instruction).map(error => `${prefix} ${error}`));
  if (!["whole_page", "main_content", "head_metadata"].includes(String(variation.scope || ""))) {
    errors.push(`${prefix} scope must be whole_page, main_content, or head_metadata`);
  }
  const mode = String(variation.answerMode || "");
  if (!ANSWER_MODES.includes(mode)) errors.push(`${prefix} answerMode is invalid`);
  const negative = mode === "negative";
  if (typeof variation.negative !== "boolean" || variation.negative !== negative) {
    errors.push(`${prefix} negative must exactly equal (answerMode === "negative")`);
  }
  const output = String(variation.output ?? "");
  if (/<\/?think\b/i.test(output)) errors.push(`${prefix} output contains think tags`);
  errors.push(...validateOutputFormat(variation.outputFormat, output, { negative }).map(error => `${prefix}: ${error}`));
  const evidence = variation.evidenceQuotes;
  errors.push(...evidenceErrors(evidence, context, prefix));
  const evidenceCount = Array.isArray(evidence) ? evidence.length : 0;
  const minimumEvidence = negative ? 0 : (["derived_summary", "aggregate"].includes(mode) ? 2 : 1);
  if (evidenceCount < minimumEvidence || evidenceCount > 64) errors.push(`${prefix} evidenceQuotes count is invalid`);
  const evidenceUrls = variation.evidenceUrls;
  if (!Array.isArray(evidenceUrls) || evidenceUrls.some(value => typeof value !== "string")) {
    errors.push(`${prefix} evidenceUrls must be an array of strings`);
  }
  const allowed = sourceUrls(context);
  const canonicalEvidenceUrls = new Set((Array.isArray(evidenceUrls) ? evidenceUrls : []).map(raw => canonicalUrl(raw, context?.finalUrl || "")));
  for (const raw of Array.isArray(evidenceUrls) ? evidenceUrls : []) {
    const url = canonicalUrl(raw, context?.finalUrl || "");
    if (!url || !allowed.has(url)) errors.push(`${prefix} evidence URL is not present in the page: ${raw}`);
  }
  for (const item of extractOutputUrls(variation.outputFormat, output, context?.finalUrl || "")) {
    if (!item.url) errors.push(`${prefix} output contains an unsafe or invalid URL: ${item.raw}`);
    else if (!allowed.has(item.url)) errors.push(`${prefix} URL is not present in the page: ${item.raw}`);
    else if (!canonicalEvidenceUrls.has(item.url)) errors.push(`${prefix} output URL is not mapped by evidenceUrls: ${item.raw}`);
  }
  if (["verbatim", "structured_verbatim"].includes(mode)) {
    errors.push(...validateClaimMappings(variation, context, prefix));
    if (variation.negativeProof != null) errors.push(`${prefix} non-negative answer must not include negativeProof`);
  } else if (["derived_summary", "aggregate"].includes(mode)) {
    if (String(variation.derivation || "").trim().length < 4) errors.push(`${prefix} derivation is required for ${mode}`);
    if (!criticAccepted(context, slot)) errors.push(`${prefix} independent critic acceptance is required for ${mode}`);
    if (variation.negativeProof != null) errors.push(`${prefix} non-negative answer must not include negativeProof`);
  } else if (negative) {
    errors.push(...validateNegativeMachineFacts(variation.negativeProof, context, instruction).map(error => `${prefix} ${error}`));
    if (Array.isArray(variation.claimMappings) && variation.claimMappings.length) errors.push(`${prefix} negative answer must not contain claim mappings`);
  }
  return unique(errors);
}

export function validateVariationResponse(result, context) {
  const errors = [
    ...exactObjectErrors(result, ROOT_FIELDS, "response"),
    ...dangerousKeyErrors(result),
  ];
  if (!isPlainRecord(result)) return unique(errors);
  if (typeof result.schema !== "string" || !result.schema.trim()) errors.push("schema must be a non-empty string");
  else if (context?.responseSchema && result.schema !== context.responseSchema) errors.push(`schema must be ${context.responseSchema}`);
  if (result.sampleId !== context?.sampleId) errors.push("sampleId mismatch");
  const plans = Array.isArray(context?.assignedSlots) ? context.assignedSlots : [];
  if (!Array.isArray(result.variations) || result.variations.length !== plans.length || plans.length === 0) {
    errors.push(`variations must contain exactly ${plans.length || "the assigned number of"} items`);
    return unique(errors);
  }
  const capabilities = new Set();
  const instructions = new Set();
  let negatives = 0;
  result.variations.forEach((variation, index) => {
    errors.push(...validateVariation(variation, context, plans[index], index));
    const capability = String(variation?.capability || "");
    const instruction = canonicalEvidenceText(variation?.instruction || "");
    if (capabilities.has(capability)) errors.push("variations must use distinct capabilities");
    if (instructions.has(instruction)) errors.push("variations must use distinct instructions");
    capabilities.add(capability);
    instructions.add(instruction);
    if (variation?.negative === true) negatives += 1;
  });
  if (negatives > 1) errors.push("at most one variation may be negative");
  return unique(errors);
}
