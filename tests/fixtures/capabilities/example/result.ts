/** Package-owned wire contract shared by the tool and renderer. */
export interface ExampleTableRow {
  readonly label: string;
  readonly value: number;
}
export interface ExampleTableResult {
  readonly title: string;
  readonly rows: readonly ExampleTableRow[];
}

function isRow(value: unknown): value is ExampleTableRow {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && "label" in value && typeof value.label === "string"
    && "value" in value && typeof value.value === "number" && Number.isFinite(value.value);
}

function isTableResult(value: unknown): value is ExampleTableResult {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && "title" in value && typeof value.title === "string"
    && "rows" in value && Array.isArray(value.rows) && value.rows.every(isRow);
}

/** History is untrusted input. Unknown shapes remain available for the renderer's raw fallback. */
export function parseExampleTableResult(value: unknown): ExampleTableResult | undefined {
  return isTableResult(value) ? value : undefined;
}
