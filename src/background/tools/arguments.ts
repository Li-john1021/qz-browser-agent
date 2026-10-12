/** Pure argument validation, before tab ownership, permissions, or execution. */
export class ToolExecutionError extends Error {
  constructor(public code: string, message: string, public details: Record<string, unknown> = {}) {
    super(message);
    this.name = "ToolExecutionError";
  }
}

export function isMissingRequiredValue(value: unknown): boolean {
  return value == null || (typeof value === "string" && !value.trim()) || (Array.isArray(value) && !value.length);
}

export function requireToolFields(
  name: string,
  args: Record<string, unknown>,
  requirements: readonly (string | readonly string[])[],
  details: Record<string, unknown> = {},
): undefined {
  const missing = requirements.filter(requirement => typeof requirement === "string"
    ? isMissingRequiredValue(args[requirement])
    : !requirement.some(key => !isMissingRequiredValue(args[key])));
  if (missing.length) throwMissingToolArgs(name, missing.map(value => typeof value === "string" ? value : value.join(" or ")), args, details);
}

export function throwMissingToolArgs(name: string, missing: readonly string[], args: object, details: Record<string, unknown> = {}): never {
  throw new ToolExecutionError("MISSING_REQUIRED_ARGUMENTS", `Invalid arguments for ${name}: missing required field(s): ${missing.join(", ")}`, {
    name, missing, ...details, providedKeys: Object.keys(args).slice(0, 50),
  });
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Open schemas retain extension fields; declared values are never coerced. */
export function validateToolSchema(name: string, value: unknown, schema: unknown, path = "$"): void {
  if (!record(schema)) return;
  const types = typeof schema.type === "string" ? [schema.type] : Array.isArray(schema.type) ? schema.type : [];
  const actual = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  const matches = types.length === 0 || types.some(type => type === "integer"
    ? typeof value === "number" && Number.isInteger(value)
    : type === "number" ? typeof value === "number" && Number.isFinite(value) : type === actual);
  if (!matches || (Array.isArray(schema.enum) && !schema.enum.some(item => Object.is(item, value)))) {
    const values = Array.isArray(schema.enum) ? schema.enum.map(String) : [];
    const expected = values.length > 1 ? `${values.slice(0, -1).join(", ")}, or ${values.at(-1)}` : values[0];
    throw new ToolExecutionError("INVALID_ARGUMENTS", `Invalid arguments for ${name}: ${path} must be ${expected || types.join(" or ")}`, {
      name, path, expectedType: schema.type, allowedValues: schema.enum, actualType: actual,
    });
  }
  if (Array.isArray(value)) value.forEach((item, index) => validateToolSchema(name, item, schema.items, `${path}[${index}]`));
  if (!record(value)) return;
  if (path !== "$" && Array.isArray(schema.required)) {
    const missing = schema.required.filter((key): key is string => typeof key === "string"
      && (!Object.hasOwn(value, key) || value[key] === undefined));
    if (missing.length) throwMissingToolArgs(name, missing, value, { path });
  }
  if (!record(schema.properties)) return;
  for (const [key, property] of Object.entries(schema.properties)) {
    if (Object.hasOwn(value, key) && value[key] !== undefined) validateToolSchema(name, value[key], property, `${path}.${key}`);
  }
}
