import { parseArgs as parseOptions } from "node:util";

export function parseAgentArgs(argv) {
  const { values } = parseOptions({ args: argv, options: {
    ...Object.fromEntries(["suite", "cases", "concurrency", "repetitions", "bridge-timeout", "ak-file", "provider", "model", "report", "capture-dir", "language"].map(name => [name, { type: "string" }])),
    vision: { type: "boolean" }, "window-target-probe": { type: "boolean" },
  } });
  for (const [name, value] of Object.entries(values)) {
    if (typeof value === "string" && !value.trim()) throw new Error(`--${name} requires a non-empty value`);
  }
  const out = {
    suite: "base",
    cases: "",
    concurrency: 4,
    akFile: "",
    provider: "",
    model: "",
    report: "",
    captureDir: "",
    language: "",
    repetitions: 1,
    bridgeTimeout: 90,
    vision: false,
    windowTargetProbe: false,
    concurrencyExplicit: values.concurrency !== undefined,
    ...Object.fromEntries(Object.entries(values).map(([name, value]) => [name.replace(/-([a-z])/g, (_, char) => char.toUpperCase()), value])),
  };
  for (const name of ["concurrency", "repetitions", "bridgeTimeout"]) out[name] = Number(out[name]);
  if (!["base", "journeys", "journeys-vision", "realworld", "all"].includes(out.suite)) {
    throw new Error(`invalid --suite: ${out.suite}`);
  }
  if (out.language && !["zh-CN", "en", "ja", "ar"].includes(out.language)) {
    throw new Error("--language must be zh-CN, en, ja or ar (authored live task prompts)");
  }
  if (out.suite === "journeys-vision" && !out.vision) {
    throw new Error("--suite journeys-vision requires --vision and a vision-capable model");
  }
  if (out.suite.startsWith("journeys") && !out.concurrencyExplicit) out.concurrency = 1;
  if (!Number.isFinite(out.concurrency) || out.concurrency < 1 || out.concurrency > 12) {
    throw new Error("--concurrency must be between 1 and 12");
  }
  if (!Number.isInteger(out.repetitions) || out.repetitions < 1 || out.repetitions > 10) {
    throw new Error("--repetitions must be between 1 and 10");
  }
  if (!Number.isInteger(out.bridgeTimeout) || out.bridgeTimeout < 30 || out.bridgeTimeout > 600) {
    throw new Error("--bridge-timeout must be between 30 and 600 seconds");
  }
  out.concurrency = Math.floor(out.concurrency);
  delete out.concurrencyExplicit;
  return out;
}
