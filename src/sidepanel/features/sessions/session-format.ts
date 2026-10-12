/** Pure session labels shared by navigation and optional workspace pages. */
export function formatLiveElapsedMs(value: unknown) {
  const ms = Math.max(0, Number(value) || 0);
  const totalTenths = Math.floor(ms / 100);
  if (totalTenths < 600) return `${(totalTenths / 10).toFixed(1)}s`;
  return formatWholeSecondElapsed(Math.floor(ms / 1000));
}

export function formatWholeSecondElapsed(totalSecondsValue: unknown) {
  const totalSeconds = Math.max(0, Math.floor(Number(totalSecondsValue) || 0));
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${String(remainingMinutes).padStart(2, "0")}m ${String(seconds).padStart(2, "0")}s`;
}

export function clipText(text: unknown, maxChars: number) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  return value.length > maxChars ? `${value.slice(0, maxChars - 1)}…` : value;
}

export function goalStatusClass(status = "") {
  switch (status) {
    case "blocked": return "blocked";
    case "paused": return "paused";
    case "complete": return "complete";
    default: return "active";
  }
}

