export function prefixLines(value: unknown, prefix: string) {
  return String(value || "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map(line => `${prefix}${line}`)
    .join("\n");
}

export function formatDurationMsForUi(value: unknown) {
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const seconds = ms / 1000;
  if (seconds < 60) return `${formatCompactDurationNumber(seconds)}s`;
  const minutes = seconds / 60;
  if (minutes < 60) return `${formatCompactDurationNumber(minutes)}min`;
  return `${formatCompactDurationNumber(minutes / 60)}h`;
}

export function formatCompactDurationNumber(value: number) {
  if (Number.isInteger(value)) return String(value);
  if (value < 10) return String(Math.round(value * 10) / 10);
  return String(Math.round(value));
}

export function formatMcpHeadersMeta(server: Record<string, unknown> = {}) {
  const headers = server.headers && typeof server.headers === "object" && !Array.isArray(server.headers)
    ? server.headers
    : null;
  if (headers && Object.keys(headers).length) return `headers: ${JSON.stringify(headers)}`;
  const names = Array.isArray(server.headerNames) ? server.headerNames : [];
  return names.length ? `headers: ${names.join(", ")}` : "";
}
