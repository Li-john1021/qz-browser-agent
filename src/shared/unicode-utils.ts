const REPLACEMENT_CHARACTER = "\uFFFD";

export function replaceLoneSurrogates(value: unknown = "") {
  const text = String(value ?? "");
  let output = "";
  let changed = false;

  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0xD800 && code <= 0xDBFF) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xDC00 && next <= 0xDFFF) {
        output += text[index] + text[index + 1];
        index += 1;
      } else {
        output += REPLACEMENT_CHARACTER;
        changed = true;
      }
    } else if (code >= 0xDC00 && code <= 0xDFFF) {
      output += REPLACEMENT_CHARACTER;
      changed = true;
    } else {
      output += text[index];
    }
  }

  return changed ? output : text;
}

export function sanitizeJsonValue(value: unknown, seen = new WeakMap<object, unknown>()): unknown {
  if (typeof value === "string") return replaceLoneSurrogates(value);
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Date) return value;
  if (seen.has(value)) return seen.get(value);

  if (Array.isArray(value)) {
    const next: unknown[] = [];
    seen.set(value, next);
    for (const item of value) next.push(sanitizeJsonValue(item, seen));
    return next;
  }

  const next: Record<string, unknown> = {};
  seen.set(value, next);
  for (const [key, item] of Object.entries(value)) {
    next[replaceLoneSurrogates(key)] = sanitizeJsonValue(item, seen);
  }
  return next;
}

export function stringifyJsonSafe(value: unknown) {
  return JSON.stringify(sanitizeJsonValue(value));
}

/** Clean invisible title prefixes before clipping, preserving joiners and direction marks in text. */
export function stripInvisibleTitlePrefix(value: string): string {
  return value.replace(/^[\s\u200b-\u200d\u202c\u2061-\u2064\ufeff]+/u, "");
}
