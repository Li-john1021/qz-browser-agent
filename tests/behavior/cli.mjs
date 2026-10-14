import { parseArgs as parseOptions } from "node:util";
import { resolve } from "node:path";

export function parseBehaviorArgs(argv, root) {
  const { values } = parseOptions({ args: argv, options: {
    help: { type: "boolean", short: "h" }, list: { type: "boolean" },
    "include-explicit": { type: "boolean" }, "fail-fast": { type: "boolean" },
    ...Object.fromEntries(["journey", "actor", "coverage", "layer", "report"].map(name => [name, { type: "string" }])),
  } });
  if (values.help) return { help: true };
  const out = {
    journeyIds: "",
    actors: "",
    coverages: "",
    layers: "",
    includeExplicit: values["include-explicit"] === true,
    list: values.list === true,
    failFast: values["fail-fast"] === true,
    report: resolve(root, "tests/results/behavior/latest.json"),
  };
  for (const [name, value] of Object.entries(values)) {
    if (typeof value !== "string") continue;
    if (!value.trim()) throw new Error(`--${name} requires a non-empty value`);
    const field = {
      journey: "journeyIds", actor: "actors", coverage: "coverages", layer: "layers", report: "report",
    }[name];
    out[field] = field === "report" ? resolve(root, value) : value;
  }
  return out;
}
