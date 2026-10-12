const RUN_SCRIPT_IIFE_ARGS_RECOMMENDATION = "Use async () => { ... } and read parameters from input/args instead of invoking an IIFE with arguments.";

export function normalizeRunScriptSourceShape(source: string) {
  const original = String(source || "");
  const trimmed = trimRunScriptShell(original);
  if (!trimmed) {
    return { code: "", changed: false, sourceShape: "empty" };
  }

  if (looksLikeMainFunctionInvocation(trimmed)) {
    return {
      code: trimmed,
      changed: false,
      sourceShape: "main_invocation",
      reason: "main_invocation_not_normalized",
      recommendation: "Replace function main(){...}; main(); with async () => { ... }.",
    };
  }

  const directShape = classifyCallableExpression(trimmed);
  if (directShape) {
    return { code: trimmed, changed: false, sourceShape: directShape };
  }

  const normalized = normalizeWrappedIife(trimmed);
  if (normalized) return normalized;

  return { code: trimmed, changed: false, sourceShape: "script" };
}

export function isRunScriptCallableExpression(source: string) {
  return Boolean(classifyCallableExpression(trimOuterCallableParens(String(source || "").trim())));
}

export function wrapRunScriptSource(source: string) {
  const normalized = normalizeRunScriptSourceShape(source);
  const text = String(normalized.code || "");
  const callable = wrapCallableRunScriptSource(text);
  if (callable) return callable;
  const topLevel = scanTopLevelScript(text);
  if (topLevel.hasControlKeyword) return text;
  const transformed = returnLastTopLevelExpression(text, topLevel.lastSemicolon);
  return transformed || text;
}

function wrapCallableRunScriptSource(source: string) {
  const trimmed = String(source || "").trim().replace(/;+$/, "");
  if (!trimmed) return "";
  const leading = splitLeadingCommentTrivia(trimmed);
  const body = leading.hasComment ? leading.body.replace(/;+$/, "") : trimmed;
  const prefix = leading.hasComment ? formatLeadingCommentPrefix(leading.text) : "";
  if (isRunScriptCallableExpression(body)) {
    return `${prefix}return await (${body})();`;
  }
  if (isImmediatelyInvokedFunctionExpression(body)) {
    return `${prefix}return await (${body});`;
  }
  return "";
}

function splitLeadingCommentTrivia(source: string) {
  const text = String(source || "");
  let i = 0;
  let triviaEnd = 0;
  let hasComment = false;
  while (i < text.length) {
    while (i < text.length && /\s/.test(text[i])) i += 1;
    const next = text[i + 1];
    if (text[i] === "/" && next === "/") {
      hasComment = true;
      i += 2;
      while (i < text.length && text[i] !== "\n" && text[i] !== "\r") i += 1;
      if (text[i] === "\r" && text[i + 1] === "\n") i += 2;
      else if (text[i] === "\n" || text[i] === "\r") i += 1;
      triviaEnd = i;
      continue;
    }
    if (text[i] === "/" && next === "*") {
      const close = text.indexOf("*/", i + 2);
      if (close < 0) break;
      hasComment = true;
      i = close + 2;
      triviaEnd = i;
      continue;
    }
    break;
  }
  if (!hasComment) return { hasComment: false, text: "", body: text };
  return {
    hasComment: true,
    text: text.slice(0, triviaEnd),
    body: text.slice(triviaEnd).trimStart(),
  };
}

function formatLeadingCommentPrefix(text: string) {
  const prefix = String(text || "");
  if (!prefix) return "";
  return /[\r\n]\s*$/.test(prefix) ? prefix : `${prefix}\n`;
}

function isImmediatelyInvokedFunctionExpression(source: string) {
  return /^\(\s*(?:async\s+)?(?:function\b|(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>)/s.test(source)
    && /\)\s*\([^)]*\)\s*$/.test(source);
}

function returnLastTopLevelExpression(source: string, split: number) {
  const trimmed = String(source || "").trim().replace(/;+$/, "");
  if (!trimmed) return "";
  if (split < 0) return `return (${trimmed});`;
  const head = trimmed.slice(0, split + 1);
  const tail = trimmed.slice(split + 1).trim();
  if (!tail || /^(return|throw|if|for|while|switch|try|catch|class|function|const|let|var|import|export)\b/.test(tail)) return "";
  return `${head}\nreturn (${tail});`;
}

function scanTopLevelScript(source: string) {
  let quote = "";
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  let paren = 0;
  let bracket = 0;
  let brace = 0;
  let lastSemicolon = -1;
  let hasControlKeyword = false;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    const next = source[i + 1];
    if (lineComment) {
      if (ch === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (ch === "*" && next === "/") {
        blockComment = false;
        i += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === quote) quote = "";
      continue;
    }
    if (ch === "/" && next === "/") {
      lineComment = true;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      blockComment = true;
      i += 1;
      continue;
    }
    if (ch === "\"" || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "(") paren += 1;
    else if (ch === ")") paren = Math.max(0, paren - 1);
    else if (ch === "[") bracket += 1;
    else if (ch === "]") bracket = Math.max(0, bracket - 1);
    else if (ch === "{") brace += 1;
    else if (ch === "}") brace = Math.max(0, brace - 1);
    if (paren !== 0 || bracket !== 0 || brace !== 0) continue;
    if (ch === ";") lastSemicolon = i;
    if (!isIdentifierStart(ch)) continue;
    let end = i + 1;
    while (end < source.length && isIdentifierPart(source[end])) end += 1;
    const word = source.slice(i, end);
    if (word === "return" || word === "throw") hasControlKeyword = true;
    i = end - 1;
  }
  return { lastSemicolon, hasControlKeyword };
}

function isIdentifierStart(ch: string) {
  return /[A-Za-z_$]/.test(ch || "");
}

function isIdentifierPart(ch: string) {
  return /[A-Za-z0-9_$]/.test(ch || "");
}

function normalizeWrappedIife(source: string) {
  const standard = splitOuterParenExpression(source);
  if (standard) {
    const callable = trimOuterCallableParens(standard.inner);
    const shape = classifyCallableExpression(callable);
    if (shape && isEmptyCallSuffix(standard.tail)) {
      return {
        code: callable,
        changed: callable !== source,
        sourceShape: "iife",
        originalCallStyle: "outer_empty_call",
        callableShape: shape,
        normalizedTo: "callable_function_expression",
      };
    }
    if (shape && looksLikeCallSuffix(standard.tail)) {
      return {
        code: source,
        changed: false,
        sourceShape: "iife_with_args",
        reason: "iife_with_args_not_normalized",
        recommendation: RUN_SCRIPT_IIFE_ARGS_RECOMMENDATION,
      };
    }
  }

  const crockford = splitCrockfordIife(source);
  if (crockford) {
    const callable = trimOuterCallableParens(crockford.callable);
    const shape = classifyCallableExpression(callable);
    if (shape) {
      return {
        code: callable,
        changed: callable !== source,
        sourceShape: "iife",
        originalCallStyle: "inner_empty_call",
        callableShape: shape,
        normalizedTo: "callable_function_expression",
      };
    }
  }

  return null;
}

function splitOuterParenExpression(source: string) {
  if (!source.startsWith("(")) return null;
  const close = findMatchingParen(source, 0);
  if (close < 0) return null;
  return {
    inner: source.slice(1, close).trim(),
    tail: source.slice(close + 1).trim(),
  };
}

function splitCrockfordIife(source: string) {
  const outer = splitOuterParenExpression(source);
  if (!outer || outer.tail) return null;
  const inner = outer.inner.trim();
  const call = stripEmptyCallSuffix(inner);
  if (!call) return null;
  return { callable: call };
}

function classifyCallableExpression(source: string) {
  const text = String(source || "").trim();
  if (!text) return "";
  if (isCompleteFunctionExpression(text)) {
    return /^async\b/.test(text) ? "async_function_expression" : "function_expression";
  }
  const arrow = classifyArrowFunctionExpression(text);
  if (arrow) return arrow;
  return "";
}

function isCompleteFunctionExpression(source: string) {
  const text = String(source || "").trim();
  const head = /^(?:async\s+)?function(?:\s+[A-Za-z_$][\w$]*)?\s*/s.exec(text);
  if (!head) return false;
  const paramsOpen = text.indexOf("(", head[0].length);
  if (paramsOpen < 0) return false;
  const paramsClose = findMatchingParen(text, paramsOpen);
  if (paramsClose < 0) return false;
  const bodyOpen = skipWhitespace(text, paramsClose + 1);
  if (text[bodyOpen] !== "{") return false;
  const bodyClose = findMatchingBrace(text, bodyOpen);
  if (bodyClose < 0) return false;
  return text.slice(bodyClose + 1).trim() === "";
}

function classifyArrowFunctionExpression(source: string) {
  const text = String(source || "").trim();
  const asyncPrefix = /^async\b/.exec(text);
  const offset = asyncPrefix ? asyncPrefix[0].length : 0;
  const rest = text.slice(offset).trimStart();
  const async = offset > 0;

  if (/^[A-Za-z_$][\w$]*\s*=>/s.test(rest)) {
    return async ? "async_arrow_function" : "arrow_function";
  }
  if (!rest.startsWith("(")) return "";
  const close = findMatchingParen(rest, 0);
  if (close < 0) return "";
  const tail = rest.slice(close + 1).trimStart();
  return tail.startsWith("=>") ? (async ? "async_arrow_function" : "arrow_function") : "";
}

function trimRunScriptShell(source: string) {
  return String(source || "")
    .trim()
    .replace(/^;+\s*/, "")
    .replace(/(?:\s*;)+\s*$/g, "")
    .trim();
}

function trimOuterCallableParens(source: string) {
  let text = String(source || "").trim();
  for (let guard = 0; guard < 8; guard += 1) {
    if (!text.startsWith("(")) break;
    const close = findMatchingParen(text, 0);
    if (close !== text.length - 1) break;
    const inner = text.slice(1, close).trim();
    if (!inner) break;
    text = inner;
  }
  return text;
}

function isEmptyCallSuffix(value: unknown) {
  return /^\(\s*\)$/.test(String(value || "").trim());
}

function looksLikeCallSuffix(value: unknown) {
  return /^\(/.test(String(value || "").trim());
}

function stripEmptyCallSuffix(source: string) {
  const text = String(source || "").trim();
  const match = /\(\s*\)$/.exec(text);
  if (!match) return "";
  const callStart = match.index;
  const close = findMatchingParen(text, callStart);
  if (close !== text.length - 1) return "";
  return text.slice(0, callStart).trim();
}

function looksLikeMainFunctionInvocation(source: string) {
  return /^(?:async\s+)?function\s+[A-Za-z_$][\w$]*\s*\(/s.test(source)
    && /;\s*[A-Za-z_$][\w$]*\s*\(\s*\)\s*$/.test(source);
}

function findMatchingParen(source: string, openIndex: number) {
  return findMatchingDelimiter(source, openIndex, "(", ")");
}

function findMatchingBrace(source: string, openIndex: number) {
  return findMatchingDelimiter(source, openIndex, "{", "}");
}

function findMatchingDelimiter(source: string, openIndex: number, openChar: string, closeChar: string) {
  const text = String(source || "");
  if (text[openIndex] !== openChar) return -1;
  let depth = 0;
  let quote = "";
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  let regexLiteral = false;
  let regexClass = false;

  for (let i = openIndex; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];

    if (lineComment) {
      if (ch === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (ch === "*" && next === "/") {
        blockComment = false;
        i += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === quote) quote = "";
      continue;
    }
    if (regexLiteral) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === "[") regexClass = true;
      else if (ch === "]") regexClass = false;
      else if (ch === "/" && !regexClass) regexLiteral = false;
      continue;
    }

    if (ch === "/" && next === "/") {
      lineComment = true;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      blockComment = true;
      i += 1;
      continue;
    }
    if (ch === "/" && shouldStartRegexLiteral(text, i)) {
      regexLiteral = true;
      regexClass = false;
      continue;
    }
    if (ch === "\"" || ch === "'" || ch === "`") {
      quote = ch;
      escaped = false;
      continue;
    }

    if (ch === openChar) depth += 1;
    else if (ch === closeChar) {
      depth -= 1;
      if (depth === 0) return i;
      if (depth < 0) return -1;
    }
  }
  return -1;
}

function skipWhitespace(source: string, index: number) {
  let i = index;
  while (i < source.length && /\s/.test(source[i])) i += 1;
  return i;
}

function shouldStartRegexLiteral(source: string, index: number) {
  const next = source[index + 1];
  if (!next || next === "/" || next === "*") return false;
  const prev = previousSignificantToken(source, index);
  if (!prev) return true;
  if (prev.word && /^(return|throw|case|delete|void|typeof|instanceof|yield|await)$/.test(prev.word)) return true;
  return /[([{=,:;!&|?+\-*%^~<>]/.test(prev.char || "");
}

function previousSignificantToken(source: string, index: number) {
  let i = index - 1;
  while (i >= 0 && /\s/.test(source[i])) i -= 1;
  if (i < 0) return null;
  const char = source[i];
  if (/[A-Za-z_$]/.test(char)) {
    let start = i;
    while (start - 1 >= 0 && /[A-Za-z0-9_$]/.test(source[start - 1])) start -= 1;
    return { char, word: source.slice(start, i + 1) };
  }
  return { char, word: "" };
}
