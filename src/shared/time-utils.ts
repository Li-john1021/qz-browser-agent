export const BEIJING_TIME_ZONE = "Asia/Shanghai";
export const BEIJING_DATE_TIME_PATTERN = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

const BEIJING_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: BEIJING_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

export function nowBeijingDateTime() {
  return formatBeijingDateTime(new Date());
}

export function formatBeijingDateTime(value: Date | string | number = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  const parts = Object.fromEntries(
    BEIJING_FORMATTER.formatToParts(date)
      .filter(part => part.type !== "literal")
      .map(part => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

export function isBeijingDateTime(value: unknown): value is string {
  return typeof value === "string" && BEIJING_DATE_TIME_PATTERN.test(value);
}

export function parseBeijingDateTime(value: unknown) {
  if (!isBeijingDateTime(value)) return null;
  const [datePart, timePart] = value.split(" ");
  const [year, month, day] = datePart.split("-").map(Number);
  const [hour, minute, second] = timePart.split(":").map(Number);
  return Date.UTC(year, month - 1, day, hour - 8, minute, second);
}

export function compareBeijingDateTimeDesc(a: unknown, b: unknown) {
  return (parseBeijingDateTime(b) || 0) - (parseBeijingDateTime(a) || 0);
}

export function formatDisplayDateTime(value: unknown) {
  if (isBeijingDateTime(value)) return value;
  if (value instanceof Date || typeof value === "number") return formatBeijingDateTime(value);
  return "";
}
