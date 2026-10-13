export function mergeBudgets(target, source) {
  if (!source || typeof source !== "object") return target;
  for (const [key, value] of Object.entries(source)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
    if (value && typeof value === "object" && !Array.isArray(value) && Object.hasOwn(target, key) && target[key] && typeof target[key] === "object") {
      mergeBudgets(target[key], value);
    } else {
      target[key] = value;
    }
  }
  return target;
}
