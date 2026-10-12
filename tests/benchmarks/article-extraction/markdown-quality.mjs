import { marked } from "marked";
import { gunzipSync } from "node:zlib";

// Generated from the complete WHATWG HTML named-character-reference table
// exposed by Python's standard-library html.entities.html5. Keeping the
// generated table local makes benchmark results deterministic and avoids
// treating the small XML-only entity set as HTML.
const HTML5_NAMED_ENTITIES_GZIP_BASE64 = [
  "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",
  "oCZo+oM//T8t8JQ9Z44AAA==",
].join("");
const HTML5_NAMED_ENTITIES = Object.freeze(JSON.parse(gunzipSync(
  Buffer.from(HTML5_NAMED_ENTITIES_GZIP_BASE64, "base64"),
).toString("utf8")));
if (Object.keys(HTML5_NAMED_ENTITIES).length !== 2_231) {
  throw new Error("complete HTML5 named-character-reference table is unavailable");
}
const HTML5_NAMED_ENTITY_MAX_LENGTH = Math.max(...Object.keys(HTML5_NAMED_ENTITIES)
  .map(name => name.length));
const HTML_NUMERIC_REFERENCE_REPLACEMENTS = Object.freeze({
  0x80: 0x20ac,
  0x82: 0x201a,
  0x83: 0x0192,
  0x84: 0x201e,
  0x85: 0x2026,
  0x86: 0x2020,
  0x87: 0x2021,
  0x88: 0x02c6,
  0x89: 0x2030,
  0x8a: 0x0160,
  0x8b: 0x2039,
  0x8c: 0x0152,
  0x8e: 0x017d,
  0x91: 0x2018,
  0x92: 0x2019,
  0x93: 0x201c,
  0x94: 0x201d,
  0x95: 0x2022,
  0x96: 0x2013,
  0x97: 0x2014,
  0x98: 0x02dc,
  0x99: 0x2122,
  0x9a: 0x0161,
  0x9b: 0x203a,
  0x9c: 0x0153,
  0x9e: 0x017e,
  0x9f: 0x0178,
});

const STRUCTURE_TYPES = Object.freeze(["heading", "list", "table", "code", "link", "image", "html"]);
const SENSITIVE_BOUNDARY_TYPES = new Set([
  "code", "table", "html", "blockquote", "list", "list_item",
  "link", "image", "codespan", "strong", "em", "del",
]);
const SAFE_LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:", "tel:"]);

function normalizedText(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[\u200b-\u200f\ufeff]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function ngrams(value, size = 3) {
  const text = normalizedText(value);
  const counts = new Map();
  for (let index = 0; index <= text.length - size; index += 1) {
    const gram = text.slice(index, index + size);
    counts.set(gram, (counts.get(gram) || 0) + 1);
  }
  return counts;
}

function semanticScores(actualValue, expectedValue) {
  const actualText = normalizedText(actualValue);
  const expectedText = normalizedText(expectedValue);
  if (actualText.length < 3 || expectedText.length < 3) {
    const equal = actualText === expectedText;
    return {
      precision: equal ? 1 : 0,
      recall: equal ? 1 : 0,
      f1: equal ? 1 : 0,
      exact: equal,
    };
  }
  const actual = ngrams(actualText);
  const expected = ngrams(expectedText);
  let overlap = 0;
  let actualTotal = 0;
  let expectedTotal = 0;
  for (const count of actual.values()) actualTotal += count;
  for (const count of expected.values()) expectedTotal += count;
  for (const [gram, count] of actual) overlap += Math.min(count, expected.get(gram) || 0);
  const precision = actualTotal ? overlap / actualTotal : 0;
  const recall = expectedTotal ? overlap / expectedTotal : 0;
  return {
    precision,
    recall,
    f1: precision + recall ? 2 * precision * recall / (precision + recall) : 0,
    exact: actualText === expectedText,
  };
}

function decodeHtmlNumericReference(reference) {
  const hexadecimal = reference[1]?.toLowerCase() === "x";
  let point = Number.parseInt(reference.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
  if (!Number.isFinite(point)
    || point === 0
    || point > 0x10ffff
    || (point >= 0xd800 && point <= 0xdfff)) return "\ufffd";
  point = HTML_NUMERIC_REFERENCE_REPLACEMENTS[point] ?? point;
  return String.fromCodePoint(point);
}

function decodeHtmlEntities(value) {
  const source = String(value || "");
  if (!source.includes("&")) return source;
  let result = "";
  let cursor = 0;
  while (cursor < source.length) {
    const ampersand = source.indexOf("&", cursor);
    if (ampersand < 0) {
      result += source.slice(cursor);
      break;
    }
    result += source.slice(cursor, ampersand);
    const tail = source.slice(ampersand + 1);
    const numeric = /^#(?:[xX][\da-fA-F]+|\d+);?/.exec(tail);
    if (numeric) {
      result += decodeHtmlNumericReference(numeric[0]);
      cursor = ampersand + 1 + numeric[0].length;
      continue;
    }
    const maximum = Math.min(HTML5_NAMED_ENTITY_MAX_LENGTH, tail.length);
    let matchedName = "";
    for (let length = maximum; length > 0; length -= 1) {
      const candidate = tail.slice(0, length);
      if (Object.hasOwn(HTML5_NAMED_ENTITIES, candidate)) {
        matchedName = candidate;
        break;
      }
    }
    if (matchedName) {
      result += HTML5_NAMED_ENTITIES[matchedName];
      cursor = ampersand + 1 + matchedName.length;
    } else {
      result += "&";
      cursor = ampersand + 1;
    }
  }
  return result;
}

function htmlText(value) {
  return decodeHtmlEntities(String(value || "")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(?:script|style)\b[\s\S]*?<\/(?:script|style)\s*>/gi, " ")
    .replace(/<\/?(?:address|article|aside|blockquote|br|dd|details|div|dl|dt|figcaption|figure|footer|h[1-6]|header|hr|li|main|ol|p|pre|section|summary|table|tbody|td|tfoot|th|thead|tr|ul)\b[^>]*>/gi, "\n")
    .replace(/<[^>]*>/g, " "));
}

function tokenText(token) {
  if (!token || typeof token !== "object") return "";
  switch (token.type) {
    case "space":
    case "hr":
    case "def":
      return "";
    case "br":
      return "\n";
    case "image":
      return "";
    case "code":
    case "codespan":
    case "escape":
      return String(token.text || "");
    case "html":
      return htmlText(token.text || token.raw || "");
    case "table": {
      const cells = [
        ...(token.header || []),
        ...(token.rows || []).flat(),
      ];
      return cells.map(cell => (
        Array.isArray(cell.tokens) ? inlineTokensText(cell.tokens) : decodeHtmlEntities(cell.text || "")
      )).join("\n");
    }
    case "list":
      return (token.items || []).map(tokenText).join("\n");
    case "list_item":
      return Array.isArray(token.tokens) ? tokensText(token.tokens) : decodeHtmlEntities(token.text || "");
    case "heading":
    case "paragraph":
      return Array.isArray(token.tokens) ? inlineTokensText(token.tokens) : decodeHtmlEntities(token.text || "");
    case "text":
    case "strong":
    case "em":
    case "del":
    case "link":
      return Array.isArray(token.tokens) ? inlineTokensText(token.tokens) : decodeHtmlEntities(token.text || "");
    default:
      if (Array.isArray(token.tokens)) return tokensText(token.tokens);
      return decodeHtmlEntities(token.text || "");
  }
}

function inlineTokensText(tokens) {
  return (tokens || []).map(tokenText).join("");
}

function tokensText(tokens) {
  return (tokens || []).map(tokenText).filter(Boolean).join("\n");
}

function walkTokens(tokens, visitor) {
  for (const token of tokens || []) {
    if (!token || typeof token !== "object") continue;
    visitor(token);
    if (Array.isArray(token.tokens)) walkTokens(token.tokens, visitor);
    if (Array.isArray(token.items)) walkTokens(token.items, visitor);
    if (token.type === "table") {
      for (const cell of [...(token.header || []), ...(token.rows || []).flat()]) {
        walkTokens(cell?.tokens || [], visitor);
      }
    }
  }
}

function structureCounts(tokens) {
  const counts = Object.fromEntries(STRUCTURE_TYPES.map(type => [type, 0]));
  walkTokens(tokens, token => {
    if (Object.hasOwn(counts, token.type)) counts[token.type] += 1;
  });
  return counts;
}

function hasFenceCloser(raw) {
  const lines = String(raw || "").split("\n");
  const opener = /^ {0,3}(`{3,}|~{3,})/.exec(lines[0] || "");
  if (!opener) return true;
  const marker = opener[1][0];
  const minimum = opener[1].length;
  return lines.slice(1).some(line => {
    const match = /^ {0,3}(`+|~+)[ \t]*$/.exec(line);
    return Boolean(match && match[1][0] === marker && match[1].length >= minimum);
  });
}

function tableCellCount(line) {
  const cells = [];
  let value = "";
  let escaped = false;
  let codeFence = 0;
  const text = String(line || "").trim();
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (escaped) {
      value += character;
      escaped = false;
      continue;
    }
    if (character === "\\") {
      value += character;
      escaped = true;
      continue;
    }
    if (character === "`") {
      let run = 1;
      while (text[index + run] === "`") run += 1;
      if (!codeFence) codeFence = run;
      else if (run === codeFence) codeFence = 0;
      value += "`".repeat(run);
      index += run - 1;
      continue;
    }
    if (character === "|" && !codeFence) {
      cells.push(value);
      value = "";
    } else {
      value += character;
    }
  }
  cells.push(value);
  if (cells[0]?.trim() === "") cells.shift();
  if (cells.at(-1)?.trim() === "") cells.pop();
  return cells.length;
}

function raggedTableRows(token) {
  const lines = String(token?.raw || "").trimEnd().split("\n");
  if (lines.length < 2) return 0;
  const columns = tableCellCount(lines[0]);
  return lines.slice(1).filter(line => tableCellCount(line) !== columns).length;
}

function linkDiagnostics(markdown, tokens) {
  const linkTokens = [];
  walkTokens(tokens, token => {
    if (token.type === "link" || token.type === "image") linkTokens.push(token);
  });
  let emptyDestinations = 0;
  let unsafeDestinations = 0;
  for (const token of linkTokens) {
    const href = String(token.href || "").trim();
    if (!href) {
      emptyDestinations += 1;
      continue;
    }
    const scheme = /^([a-z][a-z\d+.-]*:)/i.exec(href)?.[1]?.toLowerCase();
    if (scheme && !SAFE_LINK_PROTOCOLS.has(scheme)) unsafeDestinations += 1;
  }

  const isLiteralFragment = value => /^!?\[\s*$/.test(value)
    || /^\]\([^\n)]+\)$/.test(value)
    || /^!?\[[^\]\n]{1,200}$/.test(value)
    || /^!?\[[^\]\n]{0,200}\]\([^\n)]*$/.test(value);
  const parsedFragmentsWithoutExactSpan = new Map();
  let residual = String(markdown || "");
  for (const token of [...linkTokens].sort((left, right) => String(right.raw || "").length - String(left.raw || "").length)) {
    const raw = String(token.raw || "");
    if (!raw) continue;
    const index = residual.indexOf(raw);
    if (index < 0) {
      // Marked removes container indentation from nested token.raw values. In that
      // case the parsed multi-line link cannot be located byte-for-byte in the
      // document, even though it is a real link token. Track only its fragment-
      // shaped lines as a multiset so an identical unparsed fragment elsewhere
      // is still reported.
      for (const line of raw.split(/\r?\n/)) {
        const value = line.trim();
        if (!isLiteralFragment(value)) continue;
        parsedFragmentsWithoutExactSpan.set(
          value,
          (parsedFragmentsWithoutExactSpan.get(value) || 0) + 1,
        );
      }
      continue;
    }
    residual = `${residual.slice(0, index)}${raw.replace(/[^\n]/g, " ")}${residual.slice(index + raw.length)}`;
  }
  let literalFragments = 0;
  for (const line of residual.split(/\r?\n/)) {
    const value = line.trim();
    if (!isLiteralFragment(value)) continue;
    const parsedCount = parsedFragmentsWithoutExactSpan.get(value) || 0;
    if (parsedCount > 0) {
      parsedFragmentsWithoutExactSpan.set(value, parsedCount - 1);
      continue;
    }
    literalFragments += 1;
  }
  return { emptyDestinations, unsafeDestinations, literalFragments };
}

function astShapeErrors(tokens) {
  let errors = 0;
  walkTokens(tokens, token => {
    if (token.type === "list" && !Array.isArray(token.items)) errors += 1;
    if ((token.type === "link" || token.type === "image") && typeof token.href !== "string") errors += 1;
    if (token.type === "table") {
      if (!Array.isArray(token.header) || !Array.isArray(token.rows)) {
        errors += 1;
      } else {
        errors += token.rows.filter(row => !Array.isArray(row) || row.length !== token.header.length).length;
      }
    }
  });
  return errors;
}

function parseMarkdown(markdown) {
  try {
    const tokens = marked.lexer(String(markdown || ""), { gfm: true, breaks: true });
    return {
      error: "",
      tokens,
      text: tokensText(tokens),
      structure: structureCounts(tokens),
    };
  } catch (error) {
    return {
      error: `${error?.name || "Error"}: ${error?.message || error}`,
      tokens: [],
      text: "",
      structure: Object.fromEntries(STRUCTURE_TYPES.map(type => [type, 0])),
    };
  }
}

function childTokenGroups(token) {
  const groups = [];
  if (Array.isArray(token.tokens)) groups.push(token.tokens);
  if (Array.isArray(token.items)) groups.push(token.items);
  return groups;
}

function sensitiveRanges(tokens, source, baseOffset = 0) {
  const ranges = [];
  let cursor = 0;
  for (const token of tokens || []) {
    const raw = String(token?.raw || "");
    const relative = raw ? source.indexOf(raw, cursor) : cursor;
    const start = relative >= 0 ? relative : cursor;
    const end = start + raw.length;
    if (SENSITIVE_BOUNDARY_TYPES.has(token?.type) && end > start) {
      ranges.push({ type: token.type, start: baseOffset + start, end: baseOffset + end });
    }
    for (const group of childTokenGroups(token)) {
      ranges.push(...sensitiveRanges(group, raw, baseOffset + start));
    }
    cursor = Math.max(cursor, end);
  }
  return ranges;
}

function isBenignUnorderedListBoundary(text, boundary, types) {
  if (!types.size || [...types].some(type => type !== "list" && type !== "list_item")) return false;
  const before = text.slice(0, boundary);
  const after = text.slice(boundary);
  return /(?:\r?\n)[ \t]*$/.test(before)
    && /^[ \t]*(?:\r?\n[ \t]*)*[-+*][ \t]+/.test(after);
}

function paginationDiagnostics(markdown, chunkEnds, fullParse) {
  const text = String(markdown || "");
  const ends = [...new Set((chunkEnds || [])
    .map(Number)
    .filter(value => Number.isInteger(value) && value > 0 && value <= text.length))]
    .sort((left, right) => left - right);
  if (!ends.length || ends.at(-1) !== text.length) ends.push(text.length);
  const boundaries = ends.slice(0, -1);
  if (!boundaries.length) {
    return {
      chunks: 1,
      boundaries: 0,
      sensitiveBoundaries: 0,
      boundaryTypes: {},
      semanticPrecision: 1,
      semanticRecall: 1,
      semanticF1: 1,
      semanticDrift: false,
      structureLoss: 0,
      structureDelta: 0,
      structureDrift: false,
      benignListFragmentations: 0,
      unattributedDrift: 0,
      total: 0,
    };
  }

  const ranges = sensitiveRanges(fullParse.tokens, text);
  const affected = new Set();
  const boundaryTypeSets = new Map();
  const boundaryTypes = {};
  for (const boundary of boundaries) {
    const types = new Set(ranges
      .filter(range => boundary > range.start && boundary < range.end)
      .map(range => range.type));
    boundaryTypeSets.set(boundary, types);
    if (types.size) affected.add(boundary);
    for (const type of types) boundaryTypes[type] = (boundaryTypes[type] || 0) + 1;
  }

  const parts = [];
  let start = 0;
  for (const end of ends) {
    parts.push(parseMarkdown(text.slice(start, end)));
    start = end;
  }
  const partText = parts.map(part => part.text).join("\n");
  const semantic = semanticScores(partText, fullParse.text);
  const partStructure = Object.fromEntries(STRUCTURE_TYPES.map(type => [
    type,
    parts.reduce((count, part) => count + part.structure[type], 0),
  ]));
  const structureLoss = STRUCTURE_TYPES.reduce((sum, type) => (
    sum + Math.max(0, fullParse.structure[type] - partStructure[type])
  ), 0);
  const structureDelta = STRUCTURE_TYPES.reduce((sum, type) => (
    sum + Math.abs(fullParse.structure[type] - partStructure[type])
  ), 0);
  const semanticDrift = !semantic.exact;
  const listDelta = partStructure.list - fullParse.structure.list;
  const onlyAdditionalLists = listDelta > 0
    && STRUCTURE_TYPES.every(type => (
      type === "list" || partStructure[type] === fullParse.structure[type]
    ));
  const benignBoundaries = boundaries.filter(boundary => (
    isBenignUnorderedListBoundary(text, boundary, boundaryTypeSets.get(boundary) || new Set())
  ));
  const benignListFragmentations = !semanticDrift
    && structureLoss === 0
    && onlyAdditionalLists
    && listDelta === benignBoundaries.length
    ? benignBoundaries.length
    : 0;
  const structureDrift = structureDelta > 0 && benignListFragmentations !== structureDelta;
  const unattributedDrift = Number((semanticDrift || structureDrift) && affected.size === 0);
  const attributedDefects = Math.max(0, affected.size - benignListFragmentations);
  return {
    chunks: parts.length,
    boundaries: boundaries.length,
    sensitiveBoundaries: affected.size,
    boundaryTypes,
    semanticPrecision: semantic.precision,
    semanticRecall: semantic.recall,
    semanticF1: semantic.f1,
    semanticDrift,
    structureLoss,
    structureDelta,
    structureDrift,
    benignListFragmentations,
    unattributedDrift,
    total: semanticDrift || structureDrift ? attributedDefects + unattributedDrift : 0,
  };
}

export function analyzeMarkdown(markdown, { sourceText = null, chunkEnds = [] } = {}) {
  const value = String(markdown || "");
  const parsed = parseMarkdown(value);
  let unclosedFences = 0;
  let raggedRows = 0;
  walkTokens(parsed.tokens, token => {
    if (token.type === "code" && !hasFenceCloser(token.raw)) unclosedFences += 1;
    if (token.type === "table") raggedRows += raggedTableRows(token);
  });
  const links = linkDiagnostics(value, parsed.tokens);
  const syntax = {
    unclosedFences,
    literalLinkFragments: links.literalFragments,
    emptyLinkDestinations: links.emptyDestinations,
    unsafeLinkDestinations: links.unsafeDestinations,
    raggedTableRows: raggedRows,
    astShapeErrors: astShapeErrors(parsed.tokens),
    controlCharacters: (value.match(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g) || []).length,
    replacementCharacters: (value.match(/\ufffd/g) || []).length,
  };
  syntax.total = Object.values(syntax).reduce((sum, count) => sum + count, 0);

  const sourceAvailable = sourceText !== null && sourceText !== undefined;
  const source = sourceAvailable ? String(sourceText || "") : "";
  const semantic = sourceAvailable ? semanticScores(parsed.text, source) : null;
  const roundTrip = {
    available: sourceAvailable,
    sourceChars: sourceAvailable ? normalizedText(source).length : 0,
    renderedChars: normalizedText(parsed.text).length,
    precision: semantic?.precision ?? null,
    recall: semantic?.recall ?? null,
    f1: semantic?.f1 ?? null,
    exact: semantic?.exact ?? null,
    materialRecallDrift: Boolean(sourceAvailable && normalizedText(source).length >= 20 && semantic.recall < 0.99),
    materialPrecisionDrift: Boolean(sourceAvailable && normalizedText(parsed.text).length >= 20 && semantic.precision < 0.99),
  };
  roundTrip.drift = roundTrip.materialRecallDrift || roundTrip.materialPrecisionDrift;
  const pagination = paginationDiagnostics(value, chunkEnds, parsed);
  const parserErrors = Number(Boolean(parsed.error));
  return {
    parser: {
      errors: parserErrors,
      message: parsed.error,
      tokens: parsed.tokens.length,
    },
    syntax,
    roundTrip,
    pagination,
    total: parserErrors
      + syntax.total
      + Number(roundTrip.drift)
      + pagination.total,
  };
}
