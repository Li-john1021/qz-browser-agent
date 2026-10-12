import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { benchmarkCommand } from "../benchmarks/run.mjs";

// These checks spawn the CLI and its TS worker; coverage and concurrent browser suites add startup cost.
const CLI_STARTUP_TIMEOUT_MS = 30000;
const CLI_STOP_TIMEOUT_MS = 15000;

test("benchmark targets retain default health gates and forward fixture arguments intact", () => {
  const conversation = benchmarkCommand(["conversation", "/tmp/a session.json", "--mode", "snapshot-render"]);
  assert.deepEqual(conversation.args, ["tests/benchmarks/conversation-render/run.mjs", "--mode", "all", "--json", "--fail-on-health", "/tmp/a session.json", "--mode", "snapshot-render"]);
  assert.deepEqual(benchmarkCommand([]).args, conversation.args.slice(0, 5));
  assert.equal(benchmarkCommand(["/tmp/a session.json"]).target, "conversation");
  assert.deepEqual(benchmarkCommand(["stream", "--sizes", "2000", "8000"]).args.slice(-4), ["--fail-on-budget", "--sizes", "2000", "8000"]);
  assert.deepEqual(benchmarkCommand(["rate", "fixture.html", "--rpm", "19"]).args.slice(1), ["fixture.html", "--rpm", "19"]);
  const images = ["--cases", "single,history,stream", "--output-dir", "/tmp/image results", "--max-errors", "6", "--headed"];
  assert.deepEqual(benchmarkCommand(["images", ...images]), {
    target: "images", args: ["tests/benchmarks/large-image-conversation.mjs", ...images], env: {},
  });
  assert.deepEqual(benchmarkCommand(["images"]).args, ["tests/benchmarks/large-image-conversation.mjs"]);
  assert.match(benchmarkCommand(["images", "--help"]).help, /--max-errors 6 \(1\.\.10\)/);
  assert.deepEqual(benchmarkCommand(["images", "--cases", "collect", "--verify"]).args,
    ["tests/benchmarks/large-image-conversation.mjs", "--cases", "collect", "--verify"]);
  assert.match(benchmarkCommand(["images", "--help"]).help, /40 real image reads/);
});

test("grid flags become actual worker settings without changing unspecified environment values", () => {
  const plan = benchmarkCommand(["grid", "--rows", "1234", "--cols=12", "--width", "1000", "--height", "800", "--timeout", "9000", "--step-timeout", "6000", "--table-height", "65vh", "--headed", "--no-runtime-sync", "--no-range-selection"]);
  assert.deepEqual(plan.env, {
    DATA_GRID_BENCH_ROWS: "1234", DATA_GRID_BENCH_COLS: "12", DATA_GRID_BENCH_WIDTH: "1000", DATA_GRID_BENCH_HEIGHT: "800",
    DATA_GRID_BENCH_PROCESS_TIMEOUT_MS: "9000", DATA_GRID_BENCH_STEP_TIMEOUT_MS: "6000", DATA_GRID_BENCH_TABLE_HEIGHT: "65vh",
    DATA_GRID_BENCH_HEADLESS: "0", DATA_GRID_BENCH_RUNTIME_SYNC: "0", DATA_GRID_BENCH_RANGE_SELECTION: "0",
  });
  assert.deepEqual(benchmarkCommand(["grid"]).env, {});
  for (const argv of [["gird"], ["grid", "--roes", "2"], ["grid", "--rows"], ["grid", "--rows", "0"], ["grid", "--rows", "1.5"], ["grid", "--cols", "1001"], ["rate"]]) {
    assert.throws(() => benchmarkCommand(argv), undefined, argv.join(" "));
  }
});

test("all benchmark help paths exit without launching a measurement", async t => {
  const fixture = await cliFixture(t);
  for (const target of [[], ["conversation"], ["grid"], ["stream"], ["rate"], ["images"]]) {
    const result = await fixture.run([...target, "--help"]);
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /Usage: npm run benchmark/);
    assert.doesNotMatch(result.output, /WORKER/);
  }
});

test("CLI forwards options and worker exit codes; invalid arguments never launch a worker", async t => {
  const fixture = await cliFixture(t);
  const rate = await fixture.run(["rate", "session with spaces.html", "--rpm", "17"], { STUB_EXIT: "7" });
  assert.equal(rate.code, 7, rate.output);
  assert.match(rate.output, /session with spaces\.html/);
  const grid = await fixture.run(["grid", "--rows", "47"], { DATA_GRID_BENCH_ROWS: "8", DATA_GRID_BENCH_COLS: "13" });
  assert.equal(grid.code, 0, grid.output);
  assert.match(grid.output, /"rows":"47","cols":"13"/);
  const invalid = await fixture.run(["grid", "--rows", "oops"]);
  assert.equal(invalid.code, 1);
  assert.doesNotMatch(invalid.output, /WORKER/);
});

test("interrupting the benchmark CLI stops its worker and preserves the signal exit status", {
  skip: process.platform === "win32", timeout: CLI_STARTUP_TIMEOUT_MS + CLI_STOP_TIMEOUT_MS,
}, async t => {
  const startedAt = performance.now();
  const fixture = await cliFixture(t);
  const child = fixture.start(["grid"], { STUB_WAIT: "1" });
  t.after(() => child.kill("SIGKILL"));
  let output = "";
  const ready = new Promise(resolve => child.stdout.on("data", bytes => { output += bytes; if (output.includes("WORKER")) resolve(); }));
  child.stderr.on("data", bytes => { output += bytes; });
  // close also drains stdout, so STOPPED cannot race the process exit event.
  const closed = once(child, "close");
  await within(Promise.race([ready, closed.then(([code, signal]) => {
    throw new Error(`CLI exited before its worker was ready (${code ?? signal}): ${output}`);
  })]), CLI_STARTUP_TIMEOUT_MS, () => `CLI worker did not start: ${output}`);
  const stoppingAt = performance.now();
  // Measure cancellation after readiness; fixture I/O and process startup have their own budget.
  const stopped = within(closed, CLI_STOP_TIMEOUT_MS, () => `CLI did not stop after SIGTERM: ${output}`);
  assert.equal(child.kill("SIGTERM"), true, output);
  const [code] = await stopped;
  t.diagnostic(`Worker startup ${(stoppingAt - startedAt).toFixed(0)}ms; SIGTERM to close ${(performance.now() - stoppingAt).toFixed(0)}ms`);
  assert.equal(code, 143, output);
  assert.match(output, /STOPPED/);
});

async function within(promise, timeout, describeFailure) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(describeFailure())), timeout);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

test("real benchmark parsers reject unknown and incomplete options before reading a fixture", () => {
  for (const [target, flag] of [["conversation", "--mode"], ["rate", "--rpm"]]) {
    for (const args of [["--typo", "1"], [flag], [flag, "--json"]]) {
      const result = spawnSync(process.execPath, ["tests/benchmarks/run.mjs", target, "/missing/session.html", ...args], { encoding: "utf8", timeout: CLI_STARTUP_TIMEOUT_MS });
      assert.ifError(result.error);
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /Unknown|requires a value|argument missing|ambiguous/);
      assert.doesNotMatch(result.stderr, /ENOENT|Chromium|missing qingzhou-session-exchange/);
    }
  }
});

test("rate command replays an exported fixture locally and honors output options", async t => {
  const directory = await mkdtemp(join(tmpdir(), "qingzhou-rate-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "session with spaces.html");
  const exchange = { session: { title: "CLI fixture", conversation: { entries: [{ message: {
    role: "assistant", content: "Completed", _usage: { total_tokens: 60 },
  } }] }, transcript: [{ type: "assistant", content: "Completed", timestamp: "2026-07-21 10:00:00" }] } };
  await writeFile(file, `<script id="qingzhou-session-exchange" type="application/json">${JSON.stringify(exchange)}</script>`);
  const result = spawnSync(process.execPath, ["tests/benchmarks/run.mjs", "rate", file, "--no-history", "--rpm", "23", "--output-dir", directory, "--name", "cli-result"], { encoding: "utf8", timeout: CLI_STARTUP_TIMEOUT_MS });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.snapshots, 1);
  assert.equal(output.artifacts.json, join(directory, "cli-result.json"));
  const report = JSON.parse(await readFile(output.artifacts.json, "utf8"));
  assert.equal(report.requests.length, 1);
  assert.equal(report.policies.governed.requestsPerWindow, 23);
});

async function cliFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "qingzhou-benchmark-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "tests/benchmarks/conversation-render"), { recursive: true });
  await mkdir(join(root, "tests/support"), { recursive: true });
  await writeFile(join(root, "package.json"), '{"type":"module"}');
  await writeFile(join(root, "tests/benchmarks/run.mjs"), await readFile(new URL("../benchmarks/run.mjs", import.meta.url)));
  await writeFile(join(root, "tests/support/typescript-loader.mjs"), "// Workers are JS-only stubs.\n");
  const worker = `
    process.on("SIGTERM", () => { console.log("STOPPED"); process.exit(0); });
    console.log("WORKER " + JSON.stringify({ args: process.argv.slice(2), rows: process.env.DATA_GRID_BENCH_ROWS, cols: process.env.DATA_GRID_BENCH_COLS }));
    if (process.env.STUB_WAIT) setInterval(() => {}, 1000);
    else process.exit(Number(process.env.STUB_EXIT || 0));
  `;
  for (const path of ["tests/benchmarks/conversation-render/run.mjs", "tests/benchmarks/data-grid-large-runner.mjs", "tests/benchmarks/provider-rate-replay.mjs", "tests/benchmarks/large-image-conversation.mjs", "tests/support/run-python-browser.mjs"]) {
    await writeFile(join(root, path), worker);
  }
  const start = (args, env) => {
    const environment = { ...process.env, ...env };
    // These copied workers are plain JS stubs, outside the production coverage graph.
    for (const key of ["NODE_OPTIONS", "NODE_V8_COVERAGE", "NODE_TEST_CONTEXT"]) delete environment[key];
    return spawn(process.execPath, ["tests/benchmarks/run.mjs", ...args], { cwd: root, env: environment, stdio: ["ignore", "pipe", "pipe"] });
  };
  return { start, async run(args, env = {}) {
    const child = start(args, env);
    let output = "";
    for (const stream of [child.stdout, child.stderr]) stream.on("data", bytes => { output += bytes; });
    const [code] = await once(child, "exit");
    return { code, output };
  } };
}
