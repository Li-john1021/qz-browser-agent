import { hljs } from "./highlight-config.js";

const LANGUAGE_ALIASES = new Map([
  ["cjs", "javascript"],
  ["console", "shell"],
  ["html", "xml"],
  ["js", "javascript"],
  ["jsx", "javascript"],
  ["mjs", "javascript"],
  ["py", "python"],
  ["python3", "python"],
  ["sh", "bash"],
  ["shellsession", "shell"],
  ["ts", "typescript"],
  ["tsx", "typescript"],
  ["txt", "plaintext"],
  ["text", "plaintext"],
  ["plain", "plaintext"],
  ["xhtml", "xml"],
  ["yml", "yaml"],
  ["zsh", "bash"],
]);

export const DEFAULT_HIGHLIGHT_MAX_LENGTH = 120_000;
export const LIVE_HIGHLIGHT_MAX_LENGTH = DEFAULT_HIGHLIGHT_MAX_LENGTH;
export const LIVE_HIGHLIGHT_INTERVAL_MS = 48;

interface HighlightResult { html: string; language: string; relevance: number; vendor: string; skipped?: string; provisional?: boolean; highlightedLength?: number }
interface HighlightState { text: string; language: string; result: HighlightResult; highlightedAt: number }
interface StreamingOptions { scope?: object | null; index?: number; final?: boolean; now?: number; intervalMs?: number; maxLength?: number }
const liveHighlightStates = new WeakMap<object, Map<number, HighlightState>>();

export function normalizeCodeLanguage(language: unknown = "") {
  const normalized = String(language || "").trim().toLowerCase().replace(/[^a-z0-9_+.-]/g, "");
  if (!normalized) return "";
  return LANGUAGE_ALIASES.get(normalized) || normalized;
}

export function highlightCode(
  code: unknown,
  language: unknown = "",
  { autoDetect = true, maxLength = DEFAULT_HIGHLIGHT_MAX_LENGTH } = {},
): HighlightResult {
  const text = String(code ?? "");
  const normalizedLanguage = normalizeCodeLanguage(language);
  const resolvedLanguage = normalizedLanguage || (autoDetect ? inferCodeLanguage(text) : "");
  const safeMaxLength = Number.isFinite(maxLength) && maxLength >= 0
    ? maxLength
    : DEFAULT_HIGHLIGHT_MAX_LENGTH;

  if (text.length > safeMaxLength) {
    return plainHighlightResult(text, resolvedLanguage, "length-limit");
  }

  if (hljs?.highlight) {
    try {
      if (resolvedLanguage && resolvedLanguage !== "plaintext" && hljs.getLanguage?.(resolvedLanguage)) {
        const highlighted = hljs.highlight(text, {
          language: resolvedLanguage,
          ignoreIllegals: true,
        });
        return {
          html: highlighted.value,
          language: highlighted.language || resolvedLanguage,
          relevance: highlighted.relevance || 0,
          vendor: "highlight.js",
        };
      }
    } catch (_err) {
      // Fall through to escaped plain text. Highlighting should never break chat rendering.
    }
  }

  return plainHighlightResult(text, resolvedLanguage);
}

export function highlightStreamingCode(
  code: unknown,
  language: unknown = "",
  {
    scope = null,
    index = 0,
    final = false,
    now = highlightNow(),
    intervalMs = LIVE_HIGHLIGHT_INTERVAL_MS,
    maxLength = DEFAULT_HIGHLIGHT_MAX_LENGTH,
  }: StreamingOptions = {},
): HighlightResult {
  const text = String(code ?? "");
  const liveText = final ? { body: text, suffix: "" } : splitLiveTrailingNewline(text);
  const body = liveText.body;
  const resolvedLanguage = normalizeCodeLanguage(language) || inferCodeLanguage(body);
  if (!isWeakMapKey(scope) || final) {
    const result = highlightCode(text, resolvedLanguage, { autoDetect: false, maxLength });
    if (isWeakMapKey(scope)) liveHighlightStates.get(scope)?.delete(index);
    return result;
  }

  let states = liveHighlightStates.get(scope);
  if (!states) {
    states = new Map();
    liveHighlightStates.set(scope, states);
  }
  const previous = states.get(index);
  const appendOnly = previous
    && previous.language === resolvedLanguage
    && body.startsWith(previous.text);
  const safeInterval = Number.isFinite(intervalMs) && intervalMs >= 0
    ? intervalMs
    : LIVE_HIGHLIGHT_INTERVAL_MS;
  const canReuse = appendOnly
    && Number(now) - previous.highlightedAt < safeInterval
    && body.length <= maxLength;

  if (canReuse) {
    const tail = body.slice(previous.text.length);
    if (!tail) return appendLiveSuffix(previous.result, liveText.suffix);
    return {
      ...previous.result,
      html: `${previous.result.html}${escapeCodeHtml(tail)}${escapeCodeHtml(liveText.suffix)}`,
      language: resolvedLanguage || previous.result.language,
      provisional: true,
      highlightedLength: previous.text.length,
    };
  }

  const result = highlightCode(body, resolvedLanguage, { autoDetect: false, maxLength });
  states.set(index, {
    text: body,
    language: resolvedLanguage,
    result,
    highlightedAt: Number(now) || 0,
  });
  return appendLiveSuffix(result, liveText.suffix);
}

export function inferCodeLanguage(code: unknown = "") {
  const text = String(code || "").trim();
  if (!text) return "";

  if (/^(?:diff --git\s|@@\s|Index:\s)|^(?:\+\+\+|---)\s+\S+/m.test(text)) return "diff";
  if (/^(?:<!doctype\s+html|<\?xml\s|<[A-Za-z][\w:-]*(?:\s|>|\/))/i.test(text)) return "xml";
  if (/^#!\s*\/.*\b(?:ba|z|k)?sh\b/m.test(text) || /^(?:\$|>)\s+\S+/m.test(text)) return "bash";
  if (/^(?:SELECT\b[\s\S]+\bFROM\b|INSERT\s+INTO\b|UPDATE\b[\s\S]+\bSET\b|DELETE\s+FROM\b|CREATE\s+(?:TABLE|VIEW)\b)/i.test(text)) return "sql";
  if (/^(?:interface|type|enum|namespace)\s+[A-Za-z_$][\w$]*\b/m.test(text)) return "typescript";
  if (/\b(?:const|let|var|function|return|await|async|import|export|class|new)\b|=>|\?\.|\?\?/m.test(text)) return "javascript";
  if (/^(?:from\s+[A-Za-z_][\w.]*\s+import\s+|import\s+[A-Za-z_][\w.]*\s*$|def\s+\w+\s*\(|class\s+\w+\s*[:(]|if\s+__name__\s*==)/m.test(text)) return "python";
  if (/^[\[{]/.test(text) && (/(?:^|[,{\n]\s*)"(?:\\.|[^"\\])+"\s*:/m.test(text) || /^\[\s*(?:["{[\d-]|true\b|false\b|null\b)/i.test(text))) return "json";
  if (/^(?:[.#]?[A-Za-z][\w \t>+~:[\]="'-]*|\*)[ \t]*\{[\s\S]*\b[-A-Za-z]+\s*:/m.test(text)) return "css";
  const yamlKeys = text.match(/^(?:\s*-\s+)?[A-Za-z_][\w.-]*\s*:/gm) || [];
  if (yamlKeys.length >= 2 || (yamlKeys.length === 1 && /^[A-Za-z_][\w.-]*\s*:\s*[\[{]/.test(text))) return "yaml";
  if (/^(?:#{1,6}\s+|>\s+|[-*+]\s+\S|\d+\.\s+\S)/m.test(text)) return "markdown";
  return "";
}

export function highlightMarkdownDocument(
  code: unknown,
  { maxLength = LIVE_HIGHLIGHT_MAX_LENGTH } = {},
) {
  const text = String(code ?? "");
  const safeMaxLength = Number.isFinite(maxLength) && maxLength >= 0
    ? maxLength
    : LIVE_HIGHLIGHT_MAX_LENGTH;
  if (text.length > safeMaxLength) {
    return plainHighlightResult(text, "markdown", "length-limit");
  }

  const split = splitMarkdownFrontmatter(text);
  if (!split) {
    return highlightCode(text, "markdown", { autoDetect: false, maxLength: safeMaxLength });
  }

  const frontmatter = highlightCode(split.frontmatter, "yaml", {
    autoDetect: false,
    maxLength: safeMaxLength,
  });
  if (!split.hasBody) {
    return {
      ...frontmatter,
      language: "markdown",
    };
  }
  const body = highlightCode(split.body, "markdown", {
    autoDetect: false,
    maxLength: safeMaxLength,
  });
  return {
    html: `${frontmatter.html}\n${body.html}`,
    language: "markdown",
    relevance: (frontmatter.relevance || 0) + (body.relevance || 0),
    vendor: frontmatter.vendor === "highlight.js" && body.vendor === "highlight.js"
      ? "highlight.js"
      : "plain",
    skipped: frontmatter.skipped || body.skipped || "",
  };
}

export function codeLineCount(code: unknown) {
  const text = String(code ?? "");
  if (!text) return 1;
  return Math.max(1, text.replace(/\r\n?/g, "\n").split("\n").length);
}

function plainHighlightResult(text: string, language = "", skipped = ""): HighlightResult {
  return {
    html: escapeCodeHtml(text),
    language,
    relevance: 0,
    vendor: "plain",
    skipped,
  };
}

function highlightNow() {
  return globalThis.performance?.now?.() ?? Date.now();
}

function isWeakMapKey(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

function splitLiveTrailingNewline(text = "") {
  const value = String(text || "");
  if (value.endsWith("\n")) return { body: value.slice(0, -1), suffix: "\n" };
  return { body: value, suffix: "" };
}

function appendLiveSuffix(result: HighlightResult, suffix = ""): HighlightResult {
  if (!suffix) return result;
  return {
    ...result,
    html: `${result.html}${escapeCodeHtml(suffix)}`,
  };
}

function escapeCodeHtml(value: unknown) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function splitMarkdownFrontmatter(text: string) {
  const lines = String(text || "").split("\n");
  if ((lines[0] || "").replace(/^\uFEFF/, "").trim() !== "---") return null;
  let end = -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (/^(?:---|\.\.\.)\s*$/.test(lines[index].trim())) {
      end = index;
      break;
    }
  }
  if (end < 0) {
    return {
      frontmatter: text,
      body: "",
      hasBody: false,
    };
  }
  return {
    frontmatter: lines.slice(0, end + 1).join("\n"),
    body: lines.slice(end + 1).join("\n"),
    hasBody: end < lines.length - 1,
  };
}
