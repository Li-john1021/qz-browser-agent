import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const worker = join(root, "tests/benchmarks/data-grid-large.mjs");
const timeoutMs = clampNumber(
  process.env.DATA_GRID_BENCH_PROCESS_TIMEOUT_MS,
  5_000,
  3_600_000,
  300_000,
);

const child = spawn(process.execPath, [worker], {
  cwd: root,
  env: process.env,
  stdio: "inherit",
  detached: process.platform !== "win32",
});

let finished = false;
let timedOut = false;
let forwardedSignal = "";

const timeout = setTimeout(() => {
  timedOut = true;
  console.error(JSON.stringify({
    stage: "process-timeout",
    ok: false,
    timeoutMs,
    hint: "Increase DATA_GRID_BENCH_PROCESS_TIMEOUT_MS for an intentionally longer run.",
  }));
  terminateTree("SIGTERM");
  const forceKill = setTimeout(() => terminateTree("SIGKILL"), 3_000);
  forceKill.unref();
}, timeoutMs);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    forwardedSignal = signal;
    clearTimeout(timeout);
    terminateTree(signal);
  });
}

child.once("error", error => {
  finished = true;
  clearTimeout(timeout);
  console.error(JSON.stringify({ stage: "process-error", ok: false, error: String(error?.stack || error) }));
  process.exitCode = 1;
});

child.once("exit", (code, signal) => {
  finished = true;
  clearTimeout(timeout);
  if (timedOut) process.exitCode = 124;
  else if (forwardedSignal === "SIGINT" || signal === "SIGINT") process.exitCode = 130;
  else if (forwardedSignal || signal) process.exitCode = 1;
  else process.exitCode = code ?? 1;
});

function terminateTree(signal) {
  if (finished || !child.pid) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    }).unref();
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}
