#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { marked } from "marked";

import { chromium } from "playwright";

import { analyzeMarkdown } from "./markdown-quality.mjs";
import { instrumentContentScriptSource } from "./instrument-content-script.mjs";
import { ensureTestExtension } from "../../support/extension-build.mjs";
import { readTestApiKey } from "../../support/local-credentials.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const args = process.argv.slice(2);
const QA_POLICY_VERSION = "whole-page-markdown-v3";

const SYSTEM_PROMPT = `你是无损 HTML 转 Markdown 转写器，不是正文抽取器、摘要器或编辑。

输入中的 approvedHtml 已严格按照人工审核标注裁掉页面外内容。你只能把它转换成适合阅读和长期保存的 GitHub Flavored Markdown，不能重新选择正文。

硬性要求：
1. 保留全部可读原文、原有顺序和重复项；不得概括、改写、翻译、纠错、去重或补充事实。
2. 不得自行添加网页标题、URL、导语或说明；只有 approvedHtml 中实际存在的内容才能进入 Markdown。
3. 尽量保留标题层级、段落、列表、引用、代码、链接、图片与图注。普通表格用 GFM；rowspan/colspan 等复杂表格可保留最小安全 HTML。
4. 链接和图片地址只能来自 approvedHtml 或 baselineMarkdown；不得编造地址，不得输出 javascript:、data: 或 file: URL。
5. baselineMarkdown 是同一人工边界经确定性序列化得到的保真草稿。默认完整保留它；只有明确改善 Markdown 合法性或结构表达时才修改，且不得降低内容完整性。
6. 不要用代码围栏包住整篇 Markdown，不要输出解释。
7. approvedHtml 中作为可见文字出现的尖括号标签、HTML 实体与裸 URL 必须仍按文字渲染：必要时转义尖括号/实体，或把 URL 写成合法显式链接；不能让 Markdown 解析器吞掉文字、把中文标点并入 URL。
8. 除 approvedHtml 中真正的代码块外，不得使用四空格缩进或代码围栏。逐字保留所有可见字符（包括标点、编号、乱码与重复项）。如果收到 previousValidationError，必须针对它修复，不能原样返回已被判错的 baselineMarkdown。

只返回 JSON 对象：
{"schema":"qingzhou.gold-markdown-response.v1","sampleId":"原样返回","markdown":"完整 Markdown","warnings":[]}

即使输入很长，也必须返回完整结果，不能使用省略号、truncated、略、其余同上等缩写。`;

function option(name, fallback = "") {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] != null ? args[index + 1] : fallback;
}

function hasFlag(name) {
  return args.includes(name);
}

function numberOption(name, fallback, { minimum = 1 } = {}) {
  const value = Number(option(name, fallback));
  return Number.isFinite(value) && value >= minimum ? Math.floor(value) : fallback;
}

function json(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizedText(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[\u200b-\u200f\ufeff]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function markdownTokens(markdown) {
  return marked.lexer(String(markdown || ""), { gfm: true, breaks: true });
}

function walkMarkdownTokens(tokens, visitor) {
  for (const token of tokens || []) {
    if (!token || typeof token !== "object") continue;
    visitor(token);
    if (Array.isArray(token.tokens)) walkMarkdownTokens(token.tokens, visitor);
    if (Array.isArray(token.items)) walkMarkdownTokens(token.items, visitor);
    if (token.type === "table") {
      for (const cell of [...(token.header || []), ...(token.rows || []).flat()]) {
        walkMarkdownTokens(cell?.tokens || [], visitor);
      }
    }
  }
}

function markdownStructureCounts(markdown) {
  const counts = { headings: 0, lists: 0, tables: 0, codeBlocks: 0, links: 0, images: 0 };
  walkMarkdownTokens(markdownTokens(markdown), token => {
    if (token.type === "heading") counts.headings += 1;
    if (token.type === "list") counts.lists += 1;
    if (token.type === "table") counts.tables += 1;
    if (token.type === "code") counts.codeBlocks += 1;
    if (token.type === "link") counts.links += 1;
    if (token.type === "image") counts.images += 1;
    if (token.type === "html") {
      const raw = String(token.raw || token.text || "");
      if (/<table\b/i.test(raw)) counts.tables += 1;
      if (/<pre\b/i.test(raw)) counts.codeBlocks += 1;
      if (/<a\b[^>]*\bhref\s*=/i.test(raw)) counts.links += 1;
      if (/<img\b[^>]*\bsrc\s*=/i.test(raw)) counts.images += 1;
    }
  });
  return counts;
}

async function markdownDestinations(page, markdown, finalUrl) {
  const renderedHtml = marked.parse(String(markdown || ""), { gfm: true, breaks: true });
  return page.evaluate(({ html, base }) => {
    const document = new DOMParser().parseFromString(html, "text/html");
    const destinations = new Set();
    const anchorDestinations = new Set();
    const visibleAnchorDestinations = new Set();
    const unsafeUrls = new Set();
    const invalidUrls = new Set();
    const normalize = value => String(value || "")
      .normalize("NFKC")
      .replace(/[\u200b-\u200f\ufeff]/g, "")
      .replace(/\s+/g, " ")
      .trim();
    for (const element of document.querySelectorAll("a[href],img[src]")) {
      const value = element.hasAttribute("href") ? element.getAttribute("href") : element.getAttribute("src");
      try {
        const url = new URL(value, base);
        if (["http:", "https:", "mailto:", "tel:"].includes(url.protocol)) {
          destinations.add(url.href);
          if (element.matches("a[href]")) {
            anchorDestinations.add(url.href);
            const visibleText = normalize(element.textContent);
            const visibleImageAlt = [...element.querySelectorAll("img[alt]")]
              .some(image => normalize(image.getAttribute("alt")));
            if (visibleText || visibleImageAlt) visibleAnchorDestinations.add(url.href);
          }
        } else unsafeUrls.add(String(value || ""));
      } catch (_error) {
        invalidUrls.add(String(value || ""));
      }
    }
    return {
      destinations: [...destinations].sort(),
      anchorDestinations: [...anchorDestinations].sort(),
      visibleAnchorDestinations: [...visibleAnchorDestinations].sort(),
      unsafeUrls: [...unsafeUrls].sort(),
      invalidUrls: [...invalidUrls].sort(),
    };
  }, { html: renderedHtml, base: finalUrl });
}

function alphanumericSequence(value) {
  return (String(value || "").normalize("NFKC").match(/[\p{L}\p{N}]/gu) || []).join("");
}

function visibleCharacterSequence(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[\u200b-\u200f\ufeff\s]/gu, "");
}

function urlComparisonKey(value) {
  const decoded = {
    "5e": "^",
    "7b": "{",
    "7c": "|",
    "7d": "}",
  };
  return String(value || "").replace(/%(5e|7b|7c|7d)/gi, (_match, code) => decoded[code.toLowerCase()]);
}

function uniqueUrlsByComparisonKey(values) {
  const unique = new Map();
  for (const value of values || []) {
    const url = String(value || "");
    const key = urlComparisonKey(url);
    if (url && !unique.has(key)) unique.set(key, url);
  }
  return [...unique.values()];
}

function optionalSequenceMatches(source, parts, normalize) {
  let positions = new Set([0]);
  for (const part of parts) {
    const value = normalize(part.text);
    if (!value) continue;
    const next = part.optional ? new Set(positions) : new Set();
    for (const position of positions) {
      if (source.startsWith(value, position)) next.add(position + value.length);
    }
    positions = next;
    if (!positions.size) break;
  }
  return positions.has(source.length);
}

function mismatchContext(expected, actual, radius = 80) {
  let index = 0;
  const common = Math.min(expected.length, actual.length);
  while (index < common && expected[index] === actual[index]) index += 1;
  if (index === expected.length && index === actual.length) return null;
  return {
    index,
    expected: expected.slice(Math.max(0, index - radius), index + radius),
    actual: actual.slice(Math.max(0, index - radius), index + radius),
  };
}

function removeUnexpectedIndentedCode(markdown) {
  const rawBlocks = [];
  walkMarkdownTokens(markdownTokens(markdown), token => {
    if (token.type === "code" && token.codeBlockStyle === "indented" && token.raw) rawBlocks.push(token.raw);
  });
  let output = String(markdown || "");
  for (const raw of rawBlocks) {
    const index = output.indexOf(raw);
    if (index < 0) continue;
    const replacement = raw.split("\n").map(line => line.replace(/^(?: {4}|\t)/, "")).join("\n");
    output = `${output.slice(0, index)}${replacement}${output.slice(index + raw.length)}`;
  }
  return output;
}

function canonicalizeEmphasis(markdown) {
  return String(markdown || "").split("\n").map(line => {
    // A backslash-escaped delimiter and an unescaped delimiter on the same line
    // are ambiguous without a complete delimiter-stack implementation. Leave the
    // entire line alone rather than pairing an escaped closer with a later opener.
    if (/\\[*_]/.test(line)) return line;
    return line
      .replace(/\*\*([^*\r\n]+)\*\*/g, "<strong>$1</strong>")
      .replace(/__([^_\r\n]+)__/g, "<strong>$1</strong>")
      .replace(/(?<!\*)\*([^*\r\n]+)\*(?!\*)/g, "<em>$1</em>");
  }).join("\n");
}

function characterIsEscaped(value, index) {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === "\\"; cursor -= 1) backslashes += 1;
  return backslashes % 2 === 1;
}

function collapseMarkdownLinkLabelNewlines(markdown) {
  const input = String(markdown || "");
  const replacements = [];
  for (let index = 0; index < input.length; index += 1) {
    const bracket = input[index] === "["
      ? index
      : input[index] === "!" && input[index + 1] === "["
        ? index + 1
        : -1;
    if (bracket < 0 || characterIsEscaped(input, bracket)) continue;
    let depth = 1;
    let closeBracket = -1;
    for (let cursor = bracket + 1; cursor < input.length; cursor += 1) {
      if (input[cursor] === "\\") {
        cursor += 1;
        continue;
      }
      if (input[cursor] === "[") depth += 1;
      if (input[cursor] === "]") {
        depth -= 1;
        if (depth === 0) {
          closeBracket = cursor;
          break;
        }
      }
    }
    if (closeBracket < 0 || input[closeBracket + 1] !== "(") continue;
    let parenthesisDepth = 0;
    let closeParenthesis = -1;
    for (let cursor = closeBracket + 1; cursor < input.length; cursor += 1) {
      if (input[cursor] === "\\") {
        cursor += 1;
        continue;
      }
      if (input[cursor] === "(") parenthesisDepth += 1;
      if (input[cursor] === ")") {
        parenthesisDepth -= 1;
        if (parenthesisDepth === 0) {
          closeParenthesis = cursor;
          break;
        }
      }
    }
    if (closeParenthesis < 0) continue;
    const label = input.slice(bracket + 1, closeBracket);
    const collapsed = label.replace(/\r?\n[\t ]*/g, " ");
    if (collapsed !== label) replacements.push({ start: bracket + 1, end: closeBracket, value: collapsed });
    const destination = input.slice(closeBracket + 2, closeParenthesis);
    const collapsedDestination = destination.replace(/\r?\n[\t ]*/g, " ");
    if (collapsedDestination !== destination) {
      replacements.push({ start: closeBracket + 2, end: closeParenthesis, value: collapsedDestination });
    }
    index = closeParenthesis;
  }
  let output = input;
  for (const replacement of replacements.reverse()) {
    output = `${output.slice(0, replacement.start)}${replacement.value}${output.slice(replacement.end)}`;
  }
  return output;
}

function splitAttachedListMarker(markdown) {
  return String(markdown || "").replace(/\)([-+*])([\t ]{3,})(?=!?\[)/g, ")\n$1$2");
}

function literalMarkdownLinks(value) {
  return [...String(value || "").matchAll(/\[[^\]\n]+\]\(https?:\/\/[^\s)]+\)/g)].map(match => match[0]);
}

function escapeLiteralMarkdownLink(value) {
  return String(value || "")
    .replace(/([\\\[\]()])/g, "\\$1")
    .replace(/\b(https?):/gi, "$1&#58;");
}

function literalMarkdownLinkForms(value) {
  const literal = String(value || "");
  const closeBracket = literal.indexOf("](");
  if (!literal.startsWith("[") || closeBracket < 0 || !literal.endsWith(")")) return [literal];
  const syntaxPositions = [0, closeBracket, closeBracket + 1, literal.length - 1];
  const forms = new Set();
  for (let mask = 0; mask < 2 ** syntaxPositions.length; mask += 1) {
    let output = "";
    for (let index = 0; index < literal.length; index += 1) {
      const syntaxIndex = syntaxPositions.indexOf(index);
      if (syntaxIndex >= 0 && (mask & (1 << syntaxIndex))) output += "\\";
      output += literal[index];
    }
    forms.add(output);
  }
  return [...forms].sort((left, right) => right.length - left.length);
}

function trimUrlDisplay(value) {
  let output = String(value || "");
  let previous = "";
  while (output !== previous) {
    previous = output;
    output = output.replace(/[.,;:!?'\"]+$/g, "");
    for (const [open, close] of [["(", ")"], ["[", "]"]]) {
      const opens = [...output].filter(character => character === open).length;
      let closes = [...output].filter(character => character === close).length;
      while (output.endsWith(close) && closes > opens) {
        output = output.slice(0, -1);
        closes -= 1;
      }
    }
  }
  return output;
}

function textUrlCandidates(value) {
  const text = String(value || "");
  const candidates = [];
  const starts = /(?<![\p{L}\p{N}_@])(?:https?:\/\/|www\.)[A-Za-z0-9]/giu;
  for (const match of text.matchAll(starts)) {
    const start = match.index;
    let end = start + match[0].length;
    while (end < text.length && /^[A-Za-z0-9._~:/?#\[\]@!$&'()*+,;=%-]$/.test(text[end])) end += 1;
    const display = trimUrlDisplay(text.slice(start, end));
    if (!display) continue;
    const absolute = /^www\./i.test(display) ? `http://${display}` : display;
    try {
      const url = new URL(absolute);
      if (url.protocol !== "http:" && url.protocol !== "https:") continue;
      candidates.push({ start, end: start + display.length, display, url: url.href });
    } catch (_error) {
      // Ambiguous or malformed visible URL text is never repaired by guessing.
    }
  }
  return candidates;
}

function normalizePoisonedBareAutolinks(markdown, sourceText) {
  const original = String(markdown || "");
  const allowed = new Map(textUrlCandidates(sourceText).map(candidate => [candidate.display, candidate.url]));
  if (!allowed.size) return original;
  const targets = [];
  walkMarkdownTokens(markdownTokens(original), token => {
    if (token.type !== "link" || !token.raw || token.raw.startsWith("[") || token.raw.startsWith("<")) return;
    const candidate = textUrlCandidates(token.raw).find(item => item.start === 0);
    if (!candidate || allowed.get(candidate.display) !== candidate.url) return;
    if (token.raw === candidate.display && token.href === candidate.url) return;
    targets.push({ raw: token.raw, display: candidate.display, url: candidate.url });
  });
  const replacements = [];
  let cursor = 0;
  for (const target of targets) {
    const index = original.indexOf(target.raw, cursor);
    if (index < 0) continue;
    const label = target.display.replace(/([\\\[\]])/g, "\\$1");
    replacements.push({
      start: index,
      end: index + target.display.length,
      value: `[${label}](<${target.url}>)`,
    });
    cursor = index + target.raw.length;
  }
  let output = original;
  for (const replacement of replacements.reverse()) {
    output = `${output.slice(0, replacement.start)}${replacement.value}${output.slice(replacement.end)}`;
  }
  return output;
}

function neutralizeInvalidLiteralUrlTokens(markdown, sourceText) {
  let output = String(markdown || "")
    .replace(/(?<![\\~])~(?!~)/g, "\\~")
    .replace(/\\_/g, "&#95;");
  const invalidTokens = new Set();
  for (const match of String(sourceText || "").matchAll(/https?:\/\/\S+/gi)) {
    try {
      new URL(match[0]);
    } catch (_error) {
      const trimmed = trimUrlDisplay(match[0]);
      try {
        new URL(trimmed);
      } catch (_trimmedError) {
        invalidTokens.add(match[0]);
      }
    }
  }
  for (const token of invalidTokens) {
    const serialized = token.replace(/_/g, "&#95;");
    const neutralized = serialized.replace(/^(https?):/i, "$1&#58;");
    output = output.split(serialized).join(neutralized);
  }
  return output;
}

function removeInlineSeparatorListMarker(markdown) {
  return String(markdown || "").replace(/([|｜][\t \u00a0]*)[-+*][\t \u00a0]+/g, "$1");
}

function deterministicMarkdownVariants(markdown, sourceText, structures) {
  const original = String(markdown || "");
  const variants = [];
  const add = (name, value) => {
    if (value !== original && !variants.some(item => item.markdown === value)) {
      variants.push({ name, markdown: value });
    }
  };
  const htmlEmphasis = canonicalizeEmphasis(original);
  add("canonical-emphasis", htmlEmphasis);
  add("plain-emphasis", original.replace(/(?<!\\)(?:\*\*|__)/g, ""));
  const plainAsterisks = original.replace(/(?<!\\)\*/g, "");
  add("plain-asterisks", plainAsterisks);
  const escapedIsolatedMarkers = original.replace(
    /^(\s*)([+*-])(\s*)$/gm,
    (_match, before, marker, after) => `${before}\\${marker}${after}`,
  );
  add("escape-isolated-list-marker", escapedIsolatedMarkers);
  add("escape-line-leading-plus", original.replace(/^([\t ]*)\+(?=\s|$)/gm, "$1\\+"));
  const plainAsterisksAndMarkers = plainAsterisks
    .replace(/^(\s*)([+*-])(\s*)$/gm, (_match, before, marker, after) => `${before}\\${marker}${after}`)
    .replace(/^([\t ]*)\+(?=\s|$)/gm, "$1\\+");
  add("plain-asterisks-and-line-markers", plainAsterisksAndMarkers);
  const canonicalEmphasisAndMarkers = htmlEmphasis
    .replace(/^(\s*)([+*-])(\s*)$/gm, (_match, before, marker, after) => `${before}\\${marker}${after}`)
    .replace(/^([\t ]*)\+(?=\s|$)/gm, "$1\\+");
  add("canonical-emphasis-and-line-markers", canonicalEmphasisAndMarkers);
  add("escape-single-tilde", original.replace(/(?<![\\~])~(?!~)/g, "\\~"));
  add("neutralize-invalid-literal-url", neutralizeInvalidLiteralUrlTokens(original, sourceText));
  add("escape-line-leading-heading", original.replace(/^([ \t]{0,3})#(?=\s|\d|$)/gm, "$1\\#"));
  const collapsedLinks = collapseMarkdownLinkLabelNewlines(original);
  add("collapse-multiline-link-labels", collapsedLinks);
  add("collapse-links-and-remove-separator-marker", removeInlineSeparatorListMarker(collapsedLinks));
  add("split-attached-list-marker", splitAttachedListMarker(original));

  let dedented = original;
  if (Number(structures?.preBlocks || 0) === 0) {
    dedented = removeUnexpectedIndentedCode(original);
    add("remove-layout-indentation", dedented);
  }

  const literalTags = new Set(
    [...String(sourceText || "").matchAll(/<\/?([A-Za-z][\w:-]*)\b[^>]*>/g)]
      .map(match => match[1].toLowerCase()),
  );
  const escapedTags = original.replace(/<\/?([A-Za-z][\w:-]*)\b[^>]*>/g, match => {
    const name = /^<\/?([A-Za-z][\w:-]*)/.exec(match)?.[1]?.toLowerCase();
    return literalTags.has(name) ? match.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") : match;
  });
  add("escape-visible-angle-tags", escapedTags);

  const literalEntities = new Set(
    [...String(sourceText || "").matchAll(/&(?:#x[\da-f]+|#\d+|[A-Za-z][\w]+);/gi)].map(match => match[0]),
  );
  let escapedEntities = original;
  for (const entity of literalEntities) {
    escapedEntities = escapedEntities.split(entity).join(`&amp;${entity.slice(1)}`);
  }
  add("preserve-visible-entities", escapedEntities);

  const literalMarkdownLinkSet = new Set(literalMarkdownLinks(sourceText));
  let escapedMarkdownLinks = original;
  for (const literal of literalMarkdownLinkSet) {
    const escaped = escapeLiteralMarkdownLink(literal);
    for (const form of literalMarkdownLinkForms(literal)) {
      escapedMarkdownLinks = escapedMarkdownLinks.split(form).join(escaped);
    }
  }
  add("preserve-visible-markdown-link", escapedMarkdownLinks);
  add("literal-link-and-canonical-emphasis", canonicalizeEmphasis(escapedMarkdownLinks));
  add("normalize-poisoned-bare-autolinks", normalizePoisonedBareAutolinks(original, sourceText));

  let combined = htmlEmphasis;
  combined = combined.replace(
    /^(\s*)([+*-])(\s*)$/gm,
    (_match, before, marker, after) => `${before}\\${marker}${after}`,
  );
  combined = combined.replace(/^([\t ]*)\+(?=\s|$)/gm, "$1\\+");
  combined = combined.replace(/(?<![\\~])~(?!~)/g, "\\~");
  combined = combined.replace(/^([ \t]{0,3})#(?=\s|\d|$)/gm, "$1\\#");
  combined = collapseMarkdownLinkLabelNewlines(combined);
  combined = splitAttachedListMarker(combined);
  if (Number(structures?.preBlocks || 0) === 0) {
    combined = removeUnexpectedIndentedCode(combined);
  }
  combined = combined.replace(/<\/?([A-Za-z][\w:-]*)\b[^>]*>/g, match => {
    const name = /^<\/?([A-Za-z][\w:-]*)/.exec(match)?.[1]?.toLowerCase();
    return literalTags.has(name) ? match.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") : match;
  });
  for (const entity of literalEntities) combined = combined.split(entity).join(`&amp;${entity.slice(1)}`);
  for (const literal of literalMarkdownLinkSet) {
    const escaped = escapeLiteralMarkdownLink(literal);
    for (const form of literalMarkdownLinkForms(literal)) combined = combined.split(form).join(escaped);
  }
  combined = normalizePoisonedBareAutolinks(combined, sourceText);
  add("combined-safe-normalization", combined);
  return variants;
}

function textDerivedUrls(value) {
  const urls = new Set(textUrlCandidates(value).map(candidate => candidate.url));
  const text = String(value || "");
  for (const match of text.matchAll(/(?<![\w.+-])([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})(?![\w.-])/gi)) {
    urls.add(`mailto:${match[1]}`);
  }
  return [...urls].sort();
}

function requiredVisibleAnchorUrls(
  draftDestinations,
  approvedUrls,
  textUrls,
  sourceText,
  approvedVisibleAnchorUrls = [],
) {
  const approved = new Set((approvedUrls || []).map(urlComparisonKey));
  const visibleText = new Set((textUrls || []).map(urlComparisonKey));
  const literalTextUrls = new Set(
    literalMarkdownLinks(sourceText)
      .flatMap(literal => textUrlCandidates(literal).map(candidate => urlComparisonKey(candidate.url))),
  );
  const draftRequired = [...new Set(draftDestinations?.visibleAnchorDestinations || [])]
    .filter(url => !/%5c/i.test(url))
    .filter(url => {
      const key = urlComparisonKey(url);
      return approved.has(key) || (visibleText.has(key) && !literalTextUrls.has(key));
    });
  const approvedRequired = [...new Set(approvedVisibleAnchorUrls || [])]
    .filter(url => approved.has(urlComparisonKey(url)));
  return uniqueUrlsByComparisonKey([...approvedRequired, ...draftRequired]).sort();
}

async function sequenceQuality(page, markdown, sourceText) {
  const renderedHtml = marked.parse(String(markdown || ""), { gfm: true, breaks: true });
  const rendered = await page.evaluate(html => {
    const document = new DOMParser().parseFromString(html, "text/html");
    const plain = document.body.textContent || "";
    const markers = new Map();
    for (const list of document.querySelectorAll("ol")) {
      const start = list.getAttribute("start");
      let ordinal = start === null ? 1 : Number(start);
      if (!Number.isFinite(ordinal)) ordinal = 1;
      for (const item of [...list.children].filter(child => child.tagName === "LI")) {
        const value = item.getAttribute("value");
        const explicit = value === null ? NaN : Number(value);
        if (Number.isFinite(explicit)) ordinal = explicit;
        markers.set(item, `${ordinal}. `);
        ordinal += 1;
      }
    }
    const parts = [];
    const visit = node => {
      if (node.nodeType === Node.TEXT_NODE) {
        parts.push({ text: node.nodeValue || "", optional: false });
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      if (markers.has(node)) parts.push({ text: markers.get(node), optional: true });
      for (const child of node.childNodes) visit(child);
    };
    visit(document.body);
    return { plain, parts };
  }, renderedHtml);
  const source = visibleCharacterSequence(sourceText);
  const output = visibleCharacterSequence(rendered.plain);
  const plainExact = source === output;
  const orderedListExact = optionalSequenceMatches(source, rendered.parts, visibleCharacterSequence);
  const sourceAlphanumeric = alphanumericSequence(sourceText);
  const outputAlphanumeric = alphanumericSequence(rendered.plain);
  return {
    sourceChars: source.length,
    outputChars: output.length,
    plainExact,
    orderedListExact,
    exact: plainExact || orderedListExact,
    alphanumericExact: sourceAlphanumeric === outputAlphanumeric
      || optionalSequenceMatches(sourceAlphanumeric, rendered.parts, alphanumericSequence),
    mismatch: mismatchContext(source, output),
  };
}

async function urlQuality(page, markdown, finalUrl, allowedUrls, requiredAnchorUrls = []) {
  const allowed = new Set((allowedUrls || []).map(urlComparisonKey));
  const required = uniqueUrlsByComparisonKey(requiredAnchorUrls).sort();
  const rendered = await markdownDestinations(page, markdown, finalUrl);
  const unknownUrls = uniqueUrlsByComparisonKey(
    rendered.destinations.filter(url => !allowed.has(urlComparisonKey(url))),
  ).sort();
  const renderedAnchors = new Set(rendered.anchorDestinations.map(urlComparisonKey));
  const missingRequiredAnchorUrls = required.filter(url => !renderedAnchors.has(urlComparisonKey(url)));
  return {
    destinations: rendered.destinations.length,
    anchorDestinations: rendered.anchorDestinations.length,
    requiredAnchorDestinations: required.length,
    missingRequiredAnchorUrls,
    unknownUrls,
    unsafeUrls: rendered.unsafeUrls,
    invalidUrls: rendered.invalidUrls,
    accepted: missingRequiredAnchorUrls.length === 0
      && unknownUrls.length === 0
      && rendered.unsafeUrls.length === 0
      && rendered.invalidUrls.length === 0,
  };
}

function formatQuality(markdown, structures, requiredStructures = {}) {
  const approvedPreBlocks = Number(structures?.preBlocks ?? structures?.codeBlocks ?? 0);
  const observed = markdownStructureCounts(markdown);
  const outputCodeBlocks = observed.codeBlocks;
  const unexpectedCodeBlocks = approvedPreBlocks === 0 ? outputCodeBlocks : 0;
  const missingStructures = [];
  if (Number(structures?.headings || 0) > 0
    && Number(requiredStructures?.headings || 0) > 0
    && observed.headings === 0) missingStructures.push("headings");
  for (const key of ["links", "images"]) {
    if (Number(requiredStructures?.[key] || 0) > 0 && observed[key] === 0) missingStructures.push(key);
  }
  if (approvedPreBlocks > 0
    && Number(requiredStructures?.codeBlocks || 0) > 0
    && outputCodeBlocks === 0) missingStructures.push("codeBlocks");
  return {
    approvedPreBlocks,
    outputCodeBlocks,
    unexpectedCodeBlocks,
    observed,
    missingStructures,
    accepted: unexpectedCodeBlocks === 0 && missingStructures.length === 0,
  };
}

function writeAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, value);
  renameSync(temporary, path);
}

function writeJsonAtomic(path, value) {
  writeAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

function inside(base, path) {
  const nextBase = resolve(base);
  const nextPath = resolve(path);
  return nextPath === nextBase || nextPath.startsWith(`${nextBase}${sep}`);
}

function parseJsonObject(value) {
  const text = String(value || "").trim();
  try {
    return JSON.parse(text);
  } catch (_error) {
    throw new Error("model did not return the required JSON object");
  }
}

function retryDelay(response, attempt) {
  const retryAfter = Number(response?.headers?.get?.("retry-after"));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return retryAfter * 1000;
  return 750 * (2 ** (attempt - 1)) + Math.floor(Math.random() * 250);
}

function aggregateUsage(records) {
  return records.reduce((totals, record) => {
    for (const key of ["prompt_tokens", "completion_tokens", "total_tokens", "prompt_cache_hit_tokens", "prompt_cache_miss_tokens"]) {
      totals[key] += Number(record?.usage?.[key] ?? record?.[key] ?? 0);
    }
    return totals;
  }, {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
    prompt_cache_hit_tokens: 0,
    prompt_cache_miss_tokens: 0,
  });
}

async function callDeepSeek({ apiKey, endpoint, model, packet, attempt = 1 }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 600_000);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        stream: false,
        response_format: { type: "json_object" },
        thinking: { type: "disabled" },
        max_tokens: 384_000,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: JSON.stringify(packet) },
        ],
      }),
      signal: controller.signal,
    });
    const body = await response.text();
    if (!response.ok) {
      const error = new Error(`DeepSeek HTTP ${response.status}: ${body.slice(0, 500)}`);
      error.retryable = response.status === 429 || response.status >= 500;
      error.response = response;
      throw error;
    }
    const payload = JSON.parse(body);
    const result = parseJsonObject(payload.choices?.[0]?.message?.content);
    return {
      result,
      requestId: response.headers.get("x-request-id") || payload.id || "",
      usage: payload.usage || null,
      finishReason: payload.choices?.[0]?.finish_reason || "",
    };
  } catch (error) {
    if (attempt < 4 && (error?.retryable || error?.name === "AbortError" || error instanceof TypeError)) {
      await new Promise(resolvePromise => setTimeout(resolvePromise, retryDelay(error?.response, attempt)));
      return callDeepSeek({ apiKey, endpoint, model, packet, attempt: attempt + 1 });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function qualityAccepted(quality, sourceText) {
  if (quality.parser.errors || quality.syntax.total) return false;
  if (normalizedText(sourceText).length < 20) return Boolean(quality.roundTrip.exact);
  return quality.roundTrip.precision >= 0.99 && quality.roundTrip.recall >= 0.99;
}

function syntaxNoWorse(quality, baseline) {
  if (!quality?.syntax || !baseline?.syntax || quality.parser.errors || baseline.parser.errors) return false;
  return Object.entries(quality.syntax)
    .filter(([key]) => key !== "total")
    .every(([key, value]) => (
      key === "replacementCharacters"
        ? Number(value || 0) <= Number(baseline.syntax[key] || 0)
        : Number(value || 0) === 0
    ));
}

function qualityNoWorse(quality, baseline) {
  if (!quality || !syntaxNoWorse(quality, baseline)) return false;
  if (!baseline) return false;
  return quality.roundTrip.f1 >= baseline.roundTrip.f1 - 0.01
    && quality.roundTrip.precision >= baseline.roundTrip.precision - 0.01
    && quality.roundTrip.recall >= baseline.roundTrip.recall - 0.01;
}

function qualityUsable(quality, baseline, sourceText) {
  if (!quality || quality.parser.errors) return false;
  if (qualityAccepted(quality, sourceText)) return true;
  return qualityNoWorse(quality, baseline);
}

function contentAccepted(quality, baseline, sourceText, sequence) {
  return Boolean(sequence?.exact)
    && Boolean(quality)
    && !quality.parser.errors
    && syntaxNoWorse(quality, baseline)
    && (qualityUsable(quality, baseline, sourceText) || sequence.exact);
}

function qualityRank(quality) {
  if (!quality) return -Infinity;
  return (quality.roundTrip.f1 ?? 0)
    - quality.parser.errors
    - quality.syntax.total
    - Number(quality.roundTrip.drift);
}

async function runtimeScripts() {
  const extensionDir = await ensureTestExtension();
  const prelude = `
    globalThis.__qingzhouBenchmarkListener = null;
    const runtime = {
      getManifest: () => ({ name: "Qingzhou Gold Markdown", version: "0.0.0" }),
      onMessage: { addListener(listener) { globalThis.__qingzhouBenchmarkListener = listener; } },
      sendMessage: async () => ({ ok: true }),
    };
    Object.defineProperty(globalThis, "chrome", { configurable: true, value: { runtime } });
  `;
  return [
    prelude,
    readFileSync(join(extensionDir, "content/article-extractor.js"), "utf8"),
    instrumentContentScriptSource(readFileSync(join(extensionDir, "content/content-script.js"), "utf8")),
  ];
}

async function createContext(browser, scripts) {
  const context = await browser.newContext({
    viewport: { width: 1365, height: 900 },
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
  });
  for (const content of scripts) await context.addInitScript({ content });
  await context.route("**/*", route => (
    route.request().url().startsWith("file:") ? route.continue() : route.abort()
  ));
  return context;
}

async function materializeApprovedPage(page, corpus, sample, label) {
  const snapshot = resolve(corpus, sample.snapshot);
  if (!inside(corpus, snapshot) || !existsSync(snapshot)) {
    throw new Error(`${sample.id} snapshot is missing or escapes corpus`);
  }
  await page.goto(pathToFileURL(snapshot).href, { waitUntil: "domcontentloaded", timeout: 30_000 });
  return page.evaluate(({ includeIds, excludeIds, finalUrl }) => {
    const normalize = value => String(value || "")
      .normalize("NFKC")
      .replace(/[\u200b-\u200f\ufeff]/g, "")
      .replace(/\s+/g, " ")
      .trim();
    const hiddenByMarkup = element => {
      for (let node = element; node; node = node.parentElement) {
        if (node.hidden
          || node.getAttribute("aria-hidden") === "true"
          || /display\s*:\s*none|visibility\s*:\s*(?:hidden|collapse)/i.test(node.getAttribute("style") || "")) {
          return true;
        }
      }
      return false;
    };
    const visibleText = element => normalize(element?.innerText || "");
    const semanticRegionSelector = [
      "body", "main", "article", "[role='main']", "[role='article']", "[itemprop='articleBody']",
      "header", "nav", "aside", "footer", "dialog", "form", "figure",
      "[role='banner']", "[role='navigation']", "[role='complementary']", "[role='contentinfo']",
      "[role='dialog']", "[role='alertdialog']",
      "[itemtype$='/VideoObject']", "[itemtype$='/ImageObject']",
    ].join(",");
    const regionSelector = `${semanticRegionSelector},section,div,ul,ol,dl,table`;
    const allRegions = [...document.querySelectorAll(regionSelector)].filter(element => (
      !hiddenByMarkup(element)
      && visibleText(element).length >= (element.matches(semanticRegionSelector) ? 2 : 40)
    ));
    const semantic = new Set(allRegions.filter(element => element.matches(semanticRegionSelector)));
    const generic = allRegions
      .filter(element => !semantic.has(element))
      .sort((left, right) => visibleText(right).length - visibleText(left).length)
      .slice(0, 180);
    const kept = new Set([...semantic, ...generic]);
    const regionElements = allRegions.filter(element => kept.has(element));
    const regionIds = new Map(regionElements.map((element, index) => [element, `R${String(index + 1).padStart(4, "0")}`]));
    for (const [element, id] of regionIds) element.setAttribute("data-qz-review-region", id);
    const region = id => document.querySelector(`[data-qz-review-region="${CSS.escape(id)}"]`);
    const missing = [...includeIds, ...excludeIds].filter(id => !region(id));
    if (missing.length) return { error: `unknown review region ids: ${missing.join(", ")}` };
    const selected = includeIds.map(region).sort((left, right) => (
      left === right ? 0 : (left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1)
    ));
    if (selected.some((element, index) => selected.some((other, otherIndex) => otherIndex !== index && other.contains(element)))) {
      return { error: "included regions must not contain one another" };
    }
    const excluded = excludeIds.map(region);
    if (excluded.some(element => !selected.some(included => included !== element && included.contains(element)))) {
      return { error: "excluded regions must be strict descendants of an included region" };
    }
    const fragments = selected.map(element => {
      const clone = element.cloneNode(true);
      for (const id of excludeIds) {
        clone.querySelector(`[data-qz-review-region="${CSS.escape(id)}"]`)?.remove();
      }
      clone.querySelectorAll("script,style,noscript,svg,canvas,iframe,template,[hidden],[aria-hidden='true']").forEach(node => node.remove());
      clone.querySelectorAll("[style]").forEach(node => {
        if (/display\s*:\s*none|visibility\s*:\s*(?:hidden|collapse)/i.test(node.getAttribute("style") || "")) node.remove();
      });
      const showComment = clone.ownerDocument.defaultView?.NodeFilter?.SHOW_COMMENT || 128;
      const walker = clone.ownerDocument.createTreeWalker(clone, showComment);
      const comments = [];
      while (walker.nextNode()) comments.push(walker.currentNode);
      comments.forEach(node => node.remove());
      clone.querySelectorAll("[data-qz-review-region],[data-qz-review-block]").forEach(node => {
        node.removeAttribute("data-qz-review-region");
        node.removeAttribute("data-qz-review-block");
      });
      return clone;
    });
    const safeUrl = value => {
      try {
        const parsed = new URL(value, finalUrl);
        return ["http:", "https:", "mailto:", "tel:"].includes(parsed.protocol) ? parsed.href : "";
      } catch (_error) {
        return "";
      }
    };
    const allowed = new Set();
    const visibleAnchorUrls = new Set();
    const visibleAnchors = [];
    for (const fragment of fragments) {
      fragment.querySelectorAll("a[href],img[src],source[src],video[src],audio[src]").forEach(element => {
        const attribute = element.hasAttribute("href") ? "href" : "src";
        const next = safeUrl(element.getAttribute(attribute));
        if (next) {
          element.setAttribute(attribute, next);
          allowed.add(next);
        } else {
          element.removeAttribute(attribute);
        }
      });
      fragment.querySelectorAll("*").forEach(element => {
        for (const attribute of [...element.attributes]) {
          const name = attribute.name.toLowerCase();
          const keep = [
            "href", "src", "alt", "title", "width", "height", "colspan", "rowspan",
            "start", "value", "type", "datetime", "cite", "open",
          ].includes(name) || (name === "class" && /(?:^|\s)language-[\w-]+/.test(attribute.value));
          if (!keep) element.removeAttribute(attribute.name);
        }
      });
      fragment.querySelectorAll("a[href]").forEach(anchor => {
        const imageAltLabel = [...anchor.querySelectorAll("img[alt]")]
          .map(image => normalize(image.getAttribute("alt")))
          .filter(Boolean)
          .join(" ");
        const label = normalize(anchor.textContent) || imageAltLabel;
        const url = anchor.getAttribute("href");
        if (label && url) {
          visibleAnchorUrls.add(url);
          visibleAnchors.push({ label, url });
        }
      });
    }
    const html = fragments.map(fragment => fragment.outerHTML).join("\n");
    const sourceText = normalize(fragments.map(fragment => fragment.textContent || "").join("\n"));
    const structures = {
      headings: fragments.reduce((sum, fragment) => sum + fragment.querySelectorAll("h1,h2,h3,h4,h5,h6,[role='heading']").length, 0),
      lists: fragments.reduce((sum, fragment) => sum + fragment.querySelectorAll("ul,ol,dl").length, 0),
      tables: fragments.reduce((sum, fragment) => sum + fragment.querySelectorAll("table").length, 0),
      codeBlocks: fragments.reduce((sum, fragment) => sum + fragment.querySelectorAll("pre,code").length, 0),
      preBlocks: fragments.reduce((sum, fragment) => sum + fragment.querySelectorAll("pre").length, 0),
      inlineCode: fragments.reduce((sum, fragment) => sum + fragment.querySelectorAll("code:not(pre code)").length, 0),
      links: fragments.reduce((sum, fragment) => sum + fragment.querySelectorAll("a[href]").length, 0),
      images: fragments.reduce((sum, fragment) => sum + fragment.querySelectorAll("img[src]").length, 0),
    };
    return {
      html,
      sourceText,
      structures,
      allowedUrls: [...allowed].sort(),
      visibleAnchorUrls: [...visibleAnchorUrls].sort(),
      visibleAnchors: visibleAnchors.sort((left, right) => (
        left.label.localeCompare(right.label) || left.url.localeCompare(right.url)
      )),
    };
  }, {
    includeIds: label.selection.includeRegionIds,
    excludeIds: label.selection.excludeRegionIds,
    finalUrl: sample.finalUrl,
  });
}

async function serializeDraft(page, approved) {
  return page.evaluate(({ content, text }) => {
    const serialize = globalThis.__qingzhouContentBenchmark?.serializeArticleContent;
    if (typeof serialize !== "function") throw new Error("product Markdown serializer is unavailable");
    return serialize({ content, text });
  }, { content: approved.html, text: approved.sourceText });
}

async function restoreMissingApprovedAnchors({
  page,
  markdown,
  finalUrl,
  allowedUrls,
  missingRequiredAnchorUrls,
  approvedVisibleAnchors,
}) {
  const input = String(markdown || "");
  const missing = uniqueUrlsByComparisonKey(missingRequiredAnchorUrls || []);
  if (!missing.length || !Array.isArray(approvedVisibleAnchors) || !approvedVisibleAnchors.length) return null;
  const allowedKeys = new Set((allowedUrls || []).map(urlComparisonKey));
  const labelToUrls = new Map();
  const urlToLabels = new Map();
  const approvedByUrl = new Map();
  const approvedPairOccurrences = new Map();
  for (const entry of approvedVisibleAnchors) {
    const label = normalizedText(entry?.label);
    const url = String(entry?.url || "");
    const urlKey = urlComparisonKey(url);
    if (!label || !url || !allowedKeys.has(urlKey) || /[<>\r\n]/.test(url)) continue;
    if (!labelToUrls.has(label)) labelToUrls.set(label, new Set());
    if (!urlToLabels.has(urlKey)) urlToLabels.set(urlKey, new Set());
    labelToUrls.get(label).add(urlKey);
    urlToLabels.get(urlKey).add(label);
    if (!approvedByUrl.has(urlKey)) approvedByUrl.set(urlKey, url);
    const pairKey = `${label}\u0000${urlKey}`;
    approvedPairOccurrences.set(pairKey, (approvedPairOccurrences.get(pairKey) || 0) + 1);
  }

  const paragraphs = [];
  let cursor = 0;
  for (const token of markdownTokens(input)) {
    const raw = String(token?.raw || "");
    const index = raw ? input.indexOf(raw, cursor) : -1;
    if (index < 0) continue;
    cursor = index + raw.length;
    if (token.type !== "paragraph") continue;
    const lineMatch = /^([^\r\n]*)(\r?\n)?$/.exec(raw);
    if (!lineMatch || !lineMatch[1].trim()) continue;
    paragraphs.push({
      index,
      length: raw.length,
      line: lineMatch[1],
      ending: lineMatch[2] || "",
      html: marked.parse(raw, { gfm: true, breaks: true }),
    });
  }
  const renderedParagraphs = await page.evaluate(items => items.map(item => {
    const document = new DOMParser().parseFromString(item.html, "text/html");
    const elements = [...document.body.children];
    const paragraph = elements.length === 1 && elements[0].tagName === "P" ? elements[0] : null;
    if (!paragraph || paragraph.querySelector("a[href]")) return "";
    return paragraph.textContent || "";
  }), paragraphs);
  const paragraphsByLabel = new Map();
  paragraphs.forEach((paragraph, index) => {
    const label = normalizedText(renderedParagraphs[index]);
    if (!label) return;
    if (!paragraphsByLabel.has(label)) paragraphsByLabel.set(label, []);
    paragraphsByLabel.get(label).push(paragraph);
  });

  const replacements = [];
  const usedParagraphs = new Set();
  let restoredRequiredUrls = 0;
  for (const requiredUrl of missing) {
    const urlKey = urlComparisonKey(requiredUrl);
    const labels = [...(urlToLabels.get(urlKey) || [])]
      .filter(label => labelToUrls.get(label)?.size === 1);
    if (labels.length !== 1) return null;
    const candidates = paragraphsByLabel.get(labels[0]) || [];
    const url = approvedByUrl.get(urlKey);
    const approvedOccurrences = approvedPairOccurrences.get(`${labels[0]}\u0000${urlKey}`) || 0;
    if (!url || !approvedOccurrences || candidates.length !== approvedOccurrences) return null;
    if (candidates.some(candidate => usedParagraphs.has(candidate.index))) return null;
    for (const candidate of candidates) {
      usedParagraphs.add(candidate.index);
      replacements.push({ ...candidate, url });
    }
    restoredRequiredUrls += 1;
  }
  if (restoredRequiredUrls !== missing.length) return null;

  let output = input;
  for (const replacement of replacements.sort((left, right) => right.index - left.index)) {
    const linked = `[${replacement.line}](<${replacement.url}>)${replacement.ending}`;
    output = `${output.slice(0, replacement.index)}${linked}${output.slice(replacement.index + replacement.length)}`;
  }
  const [before, after] = await Promise.all([
    markdownDestinations(page, input, finalUrl),
    markdownDestinations(page, output, finalUrl),
  ]);
  const afterAnchorKeys = new Set(after.anchorDestinations.map(urlComparisonKey));
  if (before.anchorDestinations.some(url => !afterAnchorKeys.has(urlComparisonKey(url)))) return null;
  if (missing.some(url => !afterAnchorKeys.has(urlComparisonKey(url)))) return null;
  return output;
}

async function evaluateMarkdownCandidate(options) {
  const {
    page,
    markdown,
    approved,
    requiredStructures,
    allowedUrls,
    requiredAnchorUrls,
    baselineQuality,
  } = options;
  const quality = analyzeMarkdown(markdown, { sourceText: approved.sourceText });
  const formatQa = formatQuality(markdown, approved.structures, requiredStructures);
  const urlQa = await urlQuality(page, markdown, options.finalUrl, allowedUrls, requiredAnchorUrls);
  const sequenceQa = await sequenceQuality(page, markdown, approved.sourceText);
  return {
    markdown,
    quality,
    formatQa,
    urlQa,
    sequenceQa,
    accepted: contentAccepted(quality, baselineQuality, approved.sourceText, sequenceQa)
      && formatQa.accepted
      && urlQa.accepted,
    normalization: "",
  };
}

async function repairMarkdownCandidate(options) {
  const original = await evaluateMarkdownCandidate(options);
  if (original.accepted) return original;
  const variants = [
    { name: "", markdown: options.markdown, evaluated: original },
    ...deterministicMarkdownVariants(
      options.markdown,
      options.approved.sourceText,
      options.approved.structures,
    ),
  ];
  for (const variant of variants) {
    const evaluated = variant.evaluated
      || await evaluateMarkdownCandidate({ ...options, markdown: variant.markdown });
    if (evaluated.accepted) return { ...evaluated, normalization: variant.name };
    if (!evaluated.urlQa.missingRequiredAnchorUrls.length
      || evaluated.urlQa.unknownUrls.length
      || evaluated.urlQa.unsafeUrls.length
      || evaluated.urlQa.invalidUrls.length) continue;
    const restored = await restoreMissingApprovedAnchors({
      page: options.page,
      markdown: variant.markdown,
      finalUrl: options.finalUrl,
      allowedUrls: options.allowedUrls,
      missingRequiredAnchorUrls: evaluated.urlQa.missingRequiredAnchorUrls,
      approvedVisibleAnchors: options.approved.visibleAnchors,
    });
    if (!restored || restored === variant.markdown) continue;
    const restoredEvaluation = await evaluateMarkdownCandidate({ ...options, markdown: restored });
    if (restoredEvaluation.accepted) {
      return {
        ...restoredEvaluation,
        normalization: [variant.name, "restore-approved-visible-anchors"].filter(Boolean).join("+"),
      };
    }
  }
  return original;
}

function recordIdentity({ sample, labelBytes, model, endpoint, promptSha256 }) {
  return sha256(JSON.stringify({
    sampleId: sample.id,
    inputSha256: sample.inputSha256,
    labelSha256: sha256(labelBytes),
    model,
    endpoint,
    materialization: "human-regions-v1-whole-page",
  }));
}

function recordReusable(record, markdownPath, identity, { sample, labelBytes, model }) {
  const sourceCompatible = record?.identity === identity || (
    record?.sampleId === sample.id
    && record?.inputSha256 === sample.inputSha256
    && record?.labelSha256 === sha256(labelBytes)
    && record?.model === model
  );
  if (!record
    || record.schema !== "qingzhou.article-extraction-gold-markdown.v1"
    || !sourceCompatible
    || !existsSync(markdownPath)) return false;
  const markdown = readFileSync(markdownPath, "utf8");
  return sha256(markdown) === record.markdownSha256;
}

async function refreshReusableExtract({ page, corpus, sample, label, record, recordPath, markdownPath, identity }) {
  if (record.status !== "extract"
    || record.sampleId !== sample.id
    || record.inputSha256 !== sample.inputSha256
    || (String(record.selected || "").startsWith("deepseek") && record.finishReason !== "stop")) return false;
  const markdown = readFileSync(markdownPath, "utf8");
  const approved = await materializeApprovedPage(page, corpus, sample, label);
  if (approved.error || normalizedText(approved.sourceText) !== normalizedText(label.reference.mainText)) return false;
  const draft = await serializeDraft(page, approved);
  const draftQuality = analyzeMarkdown(draft, { sourceText: approved.sourceText });
  const requiredStructures = markdownStructureCounts(draft);
  const draftDestinations = await markdownDestinations(page, draft, sample.finalUrl);
  const textAllowedUrls = textDerivedUrls(approved.sourceText);
  const outputAllowedUrls = [...new Set([
    ...approved.allowedUrls,
    ...draftDestinations.destinations,
    ...textAllowedUrls,
  ])].sort();
  const requiredAnchorUrls = requiredVisibleAnchorUrls(
    draftDestinations,
    approved.allowedUrls,
    textAllowedUrls,
    approved.sourceText,
    approved.visibleAnchorUrls,
  );
  const evaluation = {
    page,
    approved,
    finalUrl: sample.finalUrl,
    requiredStructures,
    allowedUrls: outputAllowedUrls,
    requiredAnchorUrls,
    baselineQuality: draftQuality,
  };
  const [outputCandidate, draftCandidate] = await Promise.all([
    repairMarkdownCandidate({ ...evaluation, markdown }),
    repairMarkdownCandidate({ ...evaluation, markdown: draft }),
  ]);
  if (!outputCandidate.accepted && !draftCandidate.accepted) return false;
  const useDraft = draftCandidate.accepted
    && (!outputCandidate.accepted || qualityRank(draftCandidate.quality) > qualityRank(outputCandidate.quality));
  const selectedCandidate = useDraft ? draftCandidate : outputCandidate;
  const selectedMarkdown = `${String(selectedCandidate.markdown || "").trim()}\n`;
  if (selectedMarkdown !== markdown) writeAtomic(markdownPath, selectedMarkdown);
  writeJsonAtomic(recordPath, {
    modelError: "",
    modelWarnings: [],
    ...record,
    identity,
    qaPolicyVersion: QA_POLICY_VERSION,
    generationPromptSha256: record.generationPromptSha256 || record.promptSha256 || "",
    accepted: true,
    selected: useDraft
      ? "deterministic-fallback-revalidated"
      : selectedCandidate.normalization
        ? `${record.selected || "deepseek"}-normalized`
        : record.selected,
    qa: selectedCandidate.quality,
    draftQa: draftCandidate.quality,
    structures: approved.structures,
    requiredStructures,
    allowedUrlCount: approved.allowedUrls.length,
    textDerivedAllowedUrlCount: textAllowedUrls.length,
    outputAllowedUrlCount: outputAllowedUrls.length,
    requiredAnchorUrlCount: requiredAnchorUrls.length,
    formatQa: selectedCandidate.formatQa,
    draftFormatQa: draftCandidate.formatQa,
    urlQa: selectedCandidate.urlQa,
    draftUrlQa: draftCandidate.urlQa,
    sequenceQa: selectedCandidate.sequenceQa,
    draftSequenceQa: draftCandidate.sequenceQa,
    deterministicNormalization: selectedCandidate.normalization,
    preNormalizationMarkdownSha256: selectedCandidate.normalization ? record.markdownSha256 : "",
    sourceTextSha256: sha256(approved.sourceText),
    selectedHtmlSha256: sha256(approved.html),
    selectedHtmlChars: approved.html.length,
    markdownSha256: sha256(selectedMarkdown),
    fallbackReason: useDraft
      ? "deterministic draft has lower global Markdown loss during policy revalidation"
      : record.fallbackReason || "",
    validationError: "",
  });
  return true;
}

async function convertExtract({ page, corpus, sample, label, labelBytes, api, promptSha256 }) {
  const approved = await materializeApprovedPage(page, corpus, sample, label);
  if (approved.error) throw new Error(approved.error);
  if (normalizedText(approved.sourceText) !== normalizedText(label.reference.mainText)) {
    throw new Error("materialized selected text does not match finalized human label");
  }
  const draft = await serializeDraft(page, approved);
  const draftQuality = analyzeMarkdown(draft, { sourceText: approved.sourceText });
  const requiredStructures = markdownStructureCounts(draft);
  const draftFormatQuality = formatQuality(draft, approved.structures, requiredStructures);
  const draftDestinations = await markdownDestinations(page, draft, sample.finalUrl);
  const textAllowedUrls = textDerivedUrls(approved.sourceText);
  const outputAllowedUrls = [...new Set([
    ...approved.allowedUrls,
    ...draftDestinations.destinations,
    ...textAllowedUrls,
  ])].sort();
  const requiredAnchorUrls = requiredVisibleAnchorUrls(
    draftDestinations,
    approved.allowedUrls,
    textAllowedUrls,
    approved.sourceText,
    approved.visibleAnchorUrls,
  );
  const draftUrlQuality = await urlQuality(
    page,
    draft,
    sample.finalUrl,
    outputAllowedUrls,
    requiredAnchorUrls,
  );
  const draftSequenceQuality = await sequenceQuality(page, draft, approved.sourceText);
  let response = null;
  const responses = [];
  let modelMarkdown = "";
  let modelQuality = null;
  let modelFormatQuality = null;
  let modelUrlQuality = null;
  let modelSequenceQuality = null;
  let modelNormalization = "";
  let modelRawMarkdownSha256 = "";
  let modelError = "";
  let lastProblem = "";
  for (let semanticAttempt = 1; semanticAttempt <= 3; semanticAttempt += 1) {
    const packet = {
      schema: "qingzhou.gold-markdown-request.v1",
      sampleId: sample.id,
      inputSha256: sample.inputSha256,
      pageType: sample.type || "",
      approvedSourceText: approved.sourceText,
      approvedHtml: approved.html,
      baselineMarkdown: draft,
      expectedStructures: label.reference.structures || approved.structures,
      allowedUrls: outputAllowedUrls,
      formatConstraints: {
        noCodeBlocks: Number(approved.structures.preBlocks || 0) === 0,
        minimumRequired: {
          headings: Number(requiredStructures.headings || 0) > 0 ? 1 : 0,
          lists: 0,
          tables: 0,
          links: Number(requiredStructures.links || 0) > 0 ? 1 : 0,
          images: Number(requiredStructures.images || 0) > 0 ? 1 : 0,
          codeBlocks: Number(approved.structures.preBlocks || 0) > 0
            && Number(requiredStructures.codeBlocks || 0) > 0 ? 1 : 0,
        },
        instruction: Number(approved.structures.preBlocks || 0) === 0
          ? "原始人工区域没有 pre。禁止使用代码围栏或四空格缩进代码块；同时满足 minimumRequired 中的最小结构数量。"
          : "只有 baselineMarkdown 已将原始 pre 表达为代码块时才必须保留代码块；普通排版用途的 pre 可转换成段落。满足 minimumRequired 中的最小结构数量。",
      },
      ...(lastProblem ? { previousValidationError: lastProblem } : {}),
    };
    try {
      response = await callDeepSeek({ ...api, packet });
      responses.push(response);
    } catch (error) {
      modelError = String(error?.message || error);
      lastProblem = modelError;
      break;
    }
    if (response.finishReason && response.finishReason !== "stop") {
      lastProblem = `model finish_reason=${response.finishReason}`;
      continue;
    }
    if (response.result?.schema !== "qingzhou.gold-markdown-response.v1"
      || response.result?.sampleId !== sample.id
      || typeof response.result?.markdown !== "string") {
      lastProblem = "response schema, sampleId, or markdown is invalid";
      continue;
    }
    modelMarkdown = response.result.markdown.trim();
    modelRawMarkdownSha256 = sha256(modelMarkdown);
    modelQuality = analyzeMarkdown(modelMarkdown, { sourceText: approved.sourceText });
    modelFormatQuality = formatQuality(modelMarkdown, approved.structures, requiredStructures);
    modelUrlQuality = await urlQuality(
      page,
      modelMarkdown,
      sample.finalUrl,
      outputAllowedUrls,
      requiredAnchorUrls,
    );
    modelSequenceQuality = await sequenceQuality(page, modelMarkdown, approved.sourceText);
    if (!(contentAccepted(modelQuality, draftQuality, approved.sourceText, modelSequenceQuality)
      && modelFormatQuality.accepted
      && modelUrlQuality.accepted)) {
      const repaired = await repairMarkdownCandidate({
        page,
        markdown: modelMarkdown,
        approved,
        finalUrl: sample.finalUrl,
        requiredStructures,
        allowedUrls: outputAllowedUrls,
        requiredAnchorUrls,
        baselineQuality: draftQuality,
      });
      if (repaired.accepted) {
        modelMarkdown = repaired.markdown;
        modelQuality = repaired.quality;
        modelFormatQuality = repaired.formatQa;
        modelUrlQuality = repaired.urlQa;
        modelSequenceQuality = repaired.sequenceQa;
        modelNormalization = repaired.normalization;
      }
    }
    if (contentAccepted(modelQuality, draftQuality, approved.sourceText, modelSequenceQuality)
      && modelFormatQuality.accepted
      && modelUrlQuality.accepted
      && modelSequenceQuality.exact) break;
    const mismatch = modelSequenceQuality.mismatch
      ? `; firstVisibleMismatch=${JSON.stringify(modelSequenceQuality.mismatch)}`
      : "";
    const invalid = modelUrlQuality.invalidUrls.length
      ? `; invalidUrlValues=${JSON.stringify(modelUrlQuality.invalidUrls.slice(0, 5))}`
      : "";
    const missingAnchors = modelUrlQuality.missingRequiredAnchorUrls.length
      ? `; missingRequiredAnchorUrls=${JSON.stringify(modelUrlQuality.missingRequiredAnchorUrls.slice(0, 5))}`
      : "";
    lastProblem = `Markdown QA failed: parser=${modelQuality.parser.errors}, syntax=${modelQuality.syntax.total}, unexpectedCodeBlocks=${modelFormatQuality.unexpectedCodeBlocks}, missingStructures=${modelFormatQuality.missingStructures.join("|") || "none"}, unknownUrls=${modelUrlQuality.unknownUrls.length}, unsafeUrls=${modelUrlQuality.unsafeUrls.length}, invalidUrls=${modelUrlQuality.invalidUrls.length}, sequenceExact=${modelSequenceQuality.exact}, precision=${modelQuality.roundTrip.precision}, recall=${modelQuality.roundTrip.recall}${mismatch}${invalid}${missingAnchors}. Do not copy the rejected baseline unchanged; preserve every approved visible character while fixing Markdown parsing.`;
  }

  const modelAccepted = contentAccepted(
    modelQuality || analyzeMarkdown("", { sourceText: approved.sourceText }),
    draftQuality,
    approved.sourceText,
    modelSequenceQuality,
  ) && Boolean(modelFormatQuality?.accepted)
    && Boolean(modelUrlQuality?.accepted)
    && Boolean(modelSequenceQuality?.exact);
  const draftAccepted = contentAccepted(draftQuality, draftQuality, approved.sourceText, draftSequenceQuality)
    && draftFormatQuality.accepted
    && draftUrlQuality.accepted
    && draftSequenceQuality.exact;
  let markdown = modelMarkdown;
  let selected = "deepseek";
  let quality = modelQuality;
  let fallbackReason = "";
  if (!modelAccepted && draftAccepted) {
    markdown = draft;
    selected = "deterministic-fallback";
    quality = draftQuality;
    fallbackReason = lastProblem || "model output did not pass the deterministic quality gates";
  } else if (modelAccepted && draftAccepted && qualityRank(draftQuality) > qualityRank(modelQuality)) {
    markdown = draft;
    selected = "deterministic-fallback-better-fidelity";
    quality = draftQuality;
    fallbackReason = "deterministic draft has lower global Markdown loss";
  } else if (!modelAccepted && !draftAccepted && qualityRank(draftQuality) > qualityRank(modelQuality)) {
    markdown = draft;
    selected = "deterministic-fallback-unaccepted";
    quality = draftQuality;
    fallbackReason = lastProblem || "both outputs failed quality gates; deterministic draft ranked higher";
  }
  if (selected === "deepseek" && modelNormalization) selected = "deepseek-normalized";
  const selectedFormatQuality = selected.startsWith("deterministic-fallback")
    ? draftFormatQuality
    : modelFormatQuality;
  const selectedUrlQuality = selected.startsWith("deterministic-fallback")
    ? draftUrlQuality
    : modelUrlQuality;
  const selectedSequenceQuality = selected.startsWith("deterministic-fallback")
    ? draftSequenceQuality
    : modelSequenceQuality;
  const accepted = (contentAccepted(quality, draftQuality, approved.sourceText, selectedSequenceQuality)
      && Boolean(selectedFormatQuality?.accepted)
      && Boolean(selectedUrlQuality?.accepted)
      && Boolean(selectedSequenceQuality?.exact))
    || (selected.startsWith("deterministic-fallback") && draftAccepted);
  return {
    markdown: `${String(markdown || "").trim()}\n`,
    record: {
      schema: "qingzhou.article-extraction-gold-markdown.v1",
      qaPolicyVersion: QA_POLICY_VERSION,
      sampleId: sample.id,
      inputSha256: sample.inputSha256,
      finalUrl: sample.finalUrl,
      type: sample.type || "",
      status: "extract",
      accepted,
      selected,
      model: api.model,
      promptSha256,
      generationPromptSha256: promptSha256,
      endpoint: api.endpoint,
      labelSha256: sha256(labelBytes),
      sourceTextSha256: sha256(approved.sourceText),
      selectedHtmlSha256: sha256(approved.html),
      sourceChars: approved.sourceText.length,
      selectedHtmlChars: approved.html.length,
      structures: approved.structures,
      requiredStructures,
      allowedUrlCount: approved.allowedUrls.length,
      textDerivedAllowedUrlCount: textAllowedUrls.length,
      outputAllowedUrlCount: outputAllowedUrls.length,
      requiredAnchorUrlCount: requiredAnchorUrls.length,
      requestId: response?.requestId || "",
      requestIds: responses.map(item => item.requestId).filter(Boolean),
      finishReason: response?.finishReason || "",
      usage: aggregateUsage(responses),
      modelWarnings: Array.isArray(response?.result?.warnings) ? response.result.warnings.map(String) : [],
      modelNormalization,
      modelRawMarkdownSha256,
      modelError,
      qa: quality,
      draftQa: draftQuality,
      modelQa: modelQuality,
      formatQa: selectedFormatQuality,
      draftFormatQa: draftFormatQuality,
      modelFormatQa: modelFormatQuality,
      urlQa: selectedUrlQuality,
      draftUrlQa: draftUrlQuality,
      modelUrlQa: modelUrlQuality,
      sequenceQa: selectedSequenceQuality,
      draftSequenceQa: draftSequenceQuality,
      modelSequenceQa: modelSequenceQuality,
      fallbackReason,
      validationError: accepted ? "" : lastProblem || "Markdown QA failed",
    },
  };
}

async function main() {
  const corpus = resolve(option("--corpus"));
  const labels = resolve(option("--labels", join(corpus, "manual-labels-final-v1")));
  const output = resolve(option("--output", join(corpus, "gold-markdown-deepseek-v4-flash-v1")));
  const keyFile = option("--key-file");
  const model = option("--model", "deepseek-v4-flash");
  const endpoint = option("--endpoint", "https://api.deepseek.com/chat/completions");
  const workers = numberOption("--workers", 4);
  const limit = numberOption("--limit", Number.MAX_SAFE_INTEGER);
  const resume = hasFlag("--resume");
  const idsFile = option("--ids-file");
  if (!existsSync(join(corpus, "manifest.json"))) throw new Error(`corpus manifest not found: ${corpus}`);
  if (!existsSync(join(labels, "manifest.json"))) throw new Error(`label manifest not found: ${labels}`);
  const apiKey = readTestApiKey("deepseek", { keyFile });

  const corpusBytes = readFileSync(join(corpus, "manifest.json"));
  const manifest = JSON.parse(corpusBytes);
  const labelManifestBytes = readFileSync(join(labels, "manifest.json"));
  const labelManifest = JSON.parse(labelManifestBytes);
  if (labelManifest.method !== "human-reviewed-frozen-dom" || labelManifest.pendingHumanReview !== 0) {
    throw new Error("labels must be finalized human-reviewed-frozen-dom with no pending review");
  }
  if (labelManifest.corpusDigest !== sha256(corpusBytes)) throw new Error("label corpus digest mismatch");
  if (labelManifest.samples !== manifest.samples.length) throw new Error("label sample count mismatch");

  const requestedIds = idsFile
    ? new Set(readFileSync(resolve(idsFile), "utf8").split(/\s+/).map(value => value.trim()).filter(Boolean))
    : null;
  let samples = requestedIds ? manifest.samples.filter(sample => requestedIds.has(sample.id)) : manifest.samples;
  if (requestedIds) {
    const found = new Set(samples.map(sample => sample.id));
    const missing = [...requestedIds].filter(id => !found.has(id));
    if (missing.length) throw new Error(`unknown sample ids: ${missing.join(", ")}`);
  }
  samples = samples.slice(0, limit);
  if (!samples.length) throw new Error("no samples selected");
  if (existsSync(output) && !resume) throw new Error(`output already exists; pass --resume to reuse it: ${output}`);
  mkdirSync(join(output, "markdown"), { recursive: true });
  mkdirSync(join(output, "records"), { recursive: true });

  const promptSha256 = sha256(SYSTEM_PROMPT);
  const scripts = await runtimeScripts();
  const browser = await chromium.launch({ headless: true });
  let cursor = 0;
  let completed = 0;
  let reused = 0;
  const failures = [];
  const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  const startedAt = new Date().toISOString();

  async function work() {
    const context = await createContext(browser, scripts);
    const page = await context.newPage();
    for (;;) {
      const index = cursor++;
      if (index >= samples.length) break;
      const sample = samples[index];
      const labelPath = join(labels, "labels", `${sample.id}.json`);
      const labelBytes = readFileSync(labelPath);
      const label = JSON.parse(labelBytes);
      const identity = recordIdentity({ sample, labelBytes, model, endpoint, promptSha256 });
      const markdownPath = join(output, "markdown", `${sample.id}.md`);
      const recordPath = join(output, "records", `${sample.id}.json`);
      try {
        if (label.sampleId !== sample.id || label.inputSha256 !== sample.inputSha256) {
          throw new Error("label identity does not match corpus sample");
        }
        if (label.review?.status !== "approved" || label.review?.domReviewed !== true) {
          throw new Error("label is not approved after DOM review");
        }
        if (resume && existsSync(recordPath)) {
          const previous = json(recordPath);
          if (recordReusable(previous, markdownPath, identity, { sample, labelBytes, model })) {
            let reusable = label.status === "exclude"
              && previous.status === "exclude"
              && readFileSync(markdownPath, "utf8") === "";
            if (reusable && label.status === "exclude") {
              writeJsonAtomic(recordPath, {
                ...previous,
                identity,
                qaPolicyVersion: QA_POLICY_VERSION,
                generationPromptSha256: previous.generationPromptSha256 || previous.promptSha256 || "",
                accepted: true,
                markdownSha256: sha256(""),
                validationError: "",
              });
            }
            if (label.status === "extract") {
              reusable = await refreshReusableExtract({
                page,
                corpus,
                sample,
                label,
                record: previous,
                recordPath,
                markdownPath,
                identity,
              });
            }
            if (reusable) {
              reused += 1;
              console.log(`reuse ${index + 1}/${samples.length} ${sample.id}`);
              continue;
            }
          }
        }
        let result;
        if (label.status === "exclude") {
          result = {
            markdown: "",
            record: {
              schema: "qingzhou.article-extraction-gold-markdown.v1",
              qaPolicyVersion: QA_POLICY_VERSION,
              sampleId: sample.id,
              inputSha256: sample.inputSha256,
              finalUrl: sample.finalUrl,
              type: sample.type || "",
              status: "exclude",
              accepted: true,
              selected: "human-exclude-empty",
              model,
              promptSha256,
              generationPromptSha256: promptSha256,
              endpoint,
              labelSha256: sha256(labelBytes),
              sourceTextSha256: sha256(""),
              sourceChars: 0,
              requestId: "",
              usage: null,
              qa: analyzeMarkdown("", { sourceText: "" }),
            },
          };
        } else if (label.status === "extract") {
          result = await convertExtract({
            page,
            corpus,
            sample,
            label,
            labelBytes,
            api: { apiKey, endpoint, model },
            promptSha256,
          });
        } else {
          throw new Error(`unsupported finalized label status: ${label.status || "missing"}`);
        }
        result.record.identity = identity;
        result.record.markdownSha256 = sha256(result.markdown);
        result.record.generatedAt = new Date().toISOString();
        writeAtomic(markdownPath, result.markdown);
        writeJsonAtomic(recordPath, result.record);
        if (!result.record.accepted) throw new Error(result.record.validationError || "Markdown QA rejected output");
        for (const key of Object.keys(usage)) usage[key] += Number(result.record.usage?.[key] || 0);
        completed += 1;
        console.log(`convert ${index + 1}/${samples.length} ${sample.id} ${result.record.selected} chars=${result.record.sourceChars}`);
      } catch (error) {
        failures.push({ sampleId: sample.id, error: String(error?.message || error) });
        console.error(`failed ${index + 1}/${samples.length} ${sample.id}: ${error?.message || error}`);
      }
    }
    await context.close();
  }

  try {
    await Promise.all(Array.from({ length: Math.min(workers, samples.length) }, work));
  } finally {
    await browser.close();
  }

  const records = readdirSync(join(output, "records"), { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith(".json"))
    .map(entry => {
      const path = join(output, "records", entry.name);
      const raw = json(path);
      const record = {
        modelError: "",
        modelWarnings: [],
        ...raw,
      };
      if (!("modelError" in raw) || !("modelWarnings" in raw)) {
        writeJsonAtomic(path, record);
      }
      return record;
    })
    .filter(record => samples.some(sample => sample.id === record.sampleId));
  const aggregateRecordUsage = aggregateUsage(records);
  const expectedIds = new Set(samples.map(sample => sample.id));
  const recordIds = records.map(record => record.sampleId);
  const uniqueRecordIds = new Set(recordIds);
  const markdownIds = new Set(readdirSync(join(output, "markdown"), { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith(".md"))
    .map(entry => entry.name.slice(0, -3))
    .filter(id => expectedIds.has(id)));
  const exactCoverage = records.length === expectedIds.size
    && uniqueRecordIds.size === expectedIds.size
    && markdownIds.size === expectedIds.size
    && [...expectedIds].every(id => uniqueRecordIds.has(id) && markdownIds.has(id));
  const recordsById = new Map(records.map(record => [record.sampleId, record]));
  const artifactFailures = [];
  for (const sample of samples) {
    const record = recordsById.get(sample.id);
    if (!record) continue;
    const markdownPath = join(output, "markdown", `${sample.id}.md`);
    const markdown = existsSync(markdownPath) ? readFileSync(markdownPath, "utf8") : null;
    const expectedStatus = json(join(labels, "labels", `${sample.id}.json`)).status;
    if (record.schema !== "qingzhou.article-extraction-gold-markdown.v1"
      || record.qaPolicyVersion !== QA_POLICY_VERSION
      || record.status !== expectedStatus
      || markdown === null
      || sha256(markdown) !== record.markdownSha256
      || (expectedStatus === "exclude" && markdown !== "")
      || (expectedStatus === "extract" && !String(markdown).trim())
      || (expectedStatus === "extract" && (!record.formatQa?.accepted || !record.urlQa?.accepted || !record.sequenceQa?.exact))
      || (String(record.selected || "").startsWith("deepseek") && record.finishReason !== "stop")) {
      artifactFailures.push(sample.id);
    }
  }
  const summary = {
    schema: "qingzhou.article-extraction-gold-markdown-set.v1",
    complete: failures.length === 0
      && exactCoverage
      && artifactFailures.length === 0
      && records.every(record => record.accepted),
    corpus: join(corpus, "manifest.json"),
    corpusDigest: sha256(corpusBytes),
    labels: join(labels, "manifest.json"),
    labelsManifestDigest: sha256(labelManifestBytes),
    model,
    endpoint,
    promptSha256,
    generationPromptSha256s: Object.fromEntries(
      [...new Set(records.map(record => record.generationPromptSha256 || record.promptSha256 || "unknown"))]
        .sort()
        .map(value => [value, records.filter(record => (record.generationPromptSha256 || record.promptSha256 || "unknown") === value).length]),
    ),
    qaPolicyVersion: QA_POLICY_VERSION,
    wholePageRequests: true,
    samples: samples.length,
    exactCoverage,
    artifactFailures,
    status: Object.fromEntries(["extract", "exclude"].map(status => [status, records.filter(record => record.status === status).length])),
    selected: Object.fromEntries([...new Set(records.map(record => record.selected))].sort().map(selected => [selected, records.filter(record => record.selected === selected).length])),
    modelErrors: records.filter(record => record.modelError).length,
    completed,
    reused,
    accepted: records.filter(record => record.accepted).length,
    failures,
    usage: aggregateRecordUsage,
    startedAt,
    finishedAt: new Date().toISOString(),
  };
  writeJsonAtomic(join(output, "manifest.json"), summary);
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.complete) process.exitCode = 1;
}

export {
  createContext,
  deterministicMarkdownVariants,
  formatQuality,
  materializeApprovedPage,
  markdownDestinations,
  markdownStructureCounts,
  repairMarkdownCandidate,
  requiredVisibleAnchorUrls,
  restoreMissingApprovedAnchors,
  runtimeScripts,
  serializeDraft,
  textDerivedUrls,
  urlComparisonKey,
  urlQuality,
};

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(error?.stack || error?.message || String(error));
    process.exitCode = 1;
  });
}
