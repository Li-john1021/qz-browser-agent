#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import "../support/typescript-loader.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const TARGETS = {
  conversation: ["tests/benchmarks/conversation-render/run.mjs", "--mode", "all", "--json", "--fail-on-health"],
  grid: ["tests/benchmarks/data-grid-large-runner.mjs"],
  stream: ["tests/support/run-python-browser.mjs", "tests/benchmarks/message-stream.py", "--fail-on-budget"],
  rate: ["tests/benchmarks/provider-rate-replay.mjs"],
  images: ["tests/benchmarks/large-image-conversation.mjs"],
};
const GRID_NUMBERS = {
  rows: ["ROWS", 1, 1_000_000], cols: ["COLS", 1, 1_000],
  width: ["WIDTH", 640, 3840], height: ["HEIGHT", 480, 2160],
  timeout: ["PROCESS_TIMEOUT_MS", 5_000, 3_600_000], "step-timeout": ["STEP_TIMEOUT_MS", 5_000, 600_000],
};

/** Route to existing benchmarks; measurements and thresholds stay with their owners. */
export function benchmarkCommand(argv) {
  const args = [...argv];
  const first = args[0];
  const target = Object.hasOwn(TARGETS, first) ? args.shift() : "conversation";
  if (first && target === "conversation" && first !== "conversation" && !first.startsWith("-")
    && !/\.(?:html?|json)$/i.test(first) && !existsSync(first)) {
    throw new Error(`Unknown benchmark: ${first}. Choose conversation, grid, stream, rate or images.`);
  }
  if (args.includes("--help") || args.includes("-h")) return { help: benchmarkHelp(first && Object.hasOwn(TARGETS, first) ? target : "") };
  if (target === "grid") return { target, args: TARGETS.grid, env: gridEnvironment(args) };
  if (target === "rate" && !args.length) throw new Error("Rate replay needs an exported session HTML file. See npm run benchmark -- rate --help.");
  return { target, args: [...TARGETS[target], ...args], env: {} };
}

function gridEnvironment(args) {
  const { values } = parseArgs({ args, options: {
    ...Object.fromEntries(Object.keys(GRID_NUMBERS).map(name => [name, { type: "string" }])),
    "table-height": { type: "string" }, headed: { type: "boolean" },
    "no-runtime-sync": { type: "boolean" }, "no-range-selection": { type: "boolean" },
  } });
  const env = {};
  for (const [name, [key, min, max]] of Object.entries(GRID_NUMBERS)) {
    if (values[name] === undefined) continue;
    const value = Number(values[name]);
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`--${name} must be an integer between ${min} and ${max}`);
    env[`DATA_GRID_BENCH_${key}`] = String(value);
  }
  if (values["table-height"] !== undefined) {
    if (!values["table-height"].trim() || values["table-height"].startsWith("--")) throw new Error("--table-height requires a height (pixels, CSS length, or 0)");
    env.DATA_GRID_BENCH_TABLE_HEIGHT = values["table-height"];
  }
  for (const [flag, key] of [["headed", "HEADLESS"], ["no-runtime-sync", "RUNTIME_SYNC"], ["no-range-selection", "RANGE_SELECTION"]]) {
    if (values[flag]) env[`DATA_GRID_BENCH_${key}`] = "0";
  }
  return env;
}

function benchmarkHelp(target) {
  const usage = {
    conversation: "conversation [fixture.html|fixture.json | --real-examples] [--mode <mode>] [--color-scheme light|dark]\n  [--artifact-dir <dir>] [--budget <file>] [other conversation benchmark options]\n  Defaults: --mode all --json --fail-on-health. See docs/benchmarks.md#replay-a-conversation.",
    grid: "grid [--rows <count>] [--cols <count>] [--width <px>] [--height <px>]\n  [--timeout <ms>] [--step-timeout <ms>] [--table-height <height>]\n  [--headed] [--no-runtime-sync] [--no-range-selection]\n  Flags override DATA_GRID_BENCH_* environment settings; existing defaults remain unchanged.",
    stream: "stream [--samples <count>] [--sizes <chars> ...] [--budget-ms <ms>] [--timeout <ms>] [--json]\n  Stream rendering retains the --fail-on-budget gate.",
    rate: "rate <session.html> [--output-dir <dir>] [--rpm <count>] [--tpm <tokens>]\n  [--scenarios unlimited,governed,learning] [--from-request <index>] [--no-history]\n  Replays recorded requests locally; does not call a model provider.",
    images: "images [--cases single,history,stream,collect] [--output-dir <dir>] [--max-errors <count>] [--headed] [--verify]\n  Defaults: single,history,stream, tests/results/large-image-conversation, --max-errors 6 (1..10).\n  collect: 40 real image reads, then cancel a pending 41st read; select it explicitly.\n  Explicit loaded-extension diagnostic with synthetic images and local deterministic SSE; no real provider.\n  Saves JSON and screenshots; caps the error loop. See docs/benchmarks.md#reproduce-large-image-communication-failures.",
  };
  return target ? `Usage: npm run benchmark -- ${usage[target]}` : `Usage: npm run benchmark -- [conversation|grid|stream|rate|images] [options]\n\nDefault: conversation (all modes, JSON metrics, health gates).\nUse <target> --help for options. No benchmark runs when showing help.`;
}

async function main() {
  const plan = benchmarkCommand(process.argv.slice(2));
  if (plan.help) { console.log(plan.help); return; }
  const child = spawn(process.execPath, plan.args, { cwd: ROOT, stdio: "inherit", env: { ...process.env, ...plan.env }, detached: process.platform !== "win32" });
  const handlers = new Map();
  let interrupted = "";
  let forceKill;
  const stop = signal => {
    if (!child.pid) return;
    try {
      if (process.platform === "win32") {
        spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).unref();
      } else process.kill(-child.pid, signal);
    } catch (error) { if (error.code !== "ESRCH") throw error; }
  };
  for (const signal of ["SIGINT", "SIGTERM"]) {
    const handler = () => {
      if (interrupted) return;
      interrupted = signal; stop(signal);
      forceKill = setTimeout(() => stop("SIGKILL"), 3000); forceKill.unref();
    };
    handlers.set(signal, handler); process.on(signal, handler);
  }
  try {
    process.exitCode = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve(interrupted === "SIGINT" || signal === "SIGINT" ? 130 : interrupted || signal ? 143 : code ?? 1));
    });
  } finally {
    clearTimeout(forceKill);
    for (const [signal, handler] of handlers) process.off(signal, handler);
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
