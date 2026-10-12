export function createElementReferenceToken({ selector }: { selector?: unknown } = {}) {
  const css = String(selector || "").replace(/[\r\n]+/g, " ").trim();
  if (!css) return "";
  return `[css: ${css}]`;
}

export function findElementReferenceTokens(value: unknown) {
  const source = String(value || "");
  const tokens = [];
  const startPattern = /\[css\s*:/gi;
  let startMatch;

  while ((startMatch = startPattern.exec(source)) !== null) {
    const selectorStart = startPattern.lastIndex;
    const closeIndex = findOuterBracketEnd(source, selectorStart);
    if (closeIndex < 0) continue;
    const selector = source.slice(selectorStart, closeIndex).trim();
    if (!selector) continue;

    tokens.push({
      kind: "element",
      start: startMatch.index,
      end: closeIndex + 1,
      raw: source.slice(startMatch.index, closeIndex + 1),
      selector,
    });
    startPattern.lastIndex = closeIndex + 1;
  }

  return tokens;
}

function findOuterBracketEnd(source: string, selectorStart: number) {
  let depth = 1;
  let quote = "";
  let escaped = false;

  for (let index = selectorStart; index < source.length; index += 1) {
    const char = source[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "[") {
      depth += 1;
      continue;
    }
    if (char !== "]") continue;
    depth -= 1;
    if (depth === 0) return index;
  }
  return -1;
}
