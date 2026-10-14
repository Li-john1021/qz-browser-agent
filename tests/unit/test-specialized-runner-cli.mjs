import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { parseAgentArgs } from "../background/agent-behavior-cli.mjs";
import { parseBehaviorArgs } from "../behavior/cli.mjs";

test("Agent argument validation covers every flag and rejects malformed values", () => {
  for (const flag of ["suite", "cases", "concurrency", "repetitions", "bridge-timeout", "ak-file", "provider", "model", "report", "capture-dir"]) {
    for (const args of [[`--${flag}`], [`--${flag}=`], [`--${flag}`, " "], [`--${flag}`, "--vision"]]) {
      assert.throws(() => parseAgentArgs(args), undefined, args.join(" "));
    }
  }
  for (const args of [["--typo"], ["unexpected"], ["--concurrency", "0"], ["--repetitions", "1.5"], ["--bridge-timeout", "29"], ["--suite", "journeys-vision"]]) {
    assert.throws(() => parseAgentArgs(args), undefined, args.join(" "));
  }
});

for (const [entry, args] of [
  ["background/agent-behavior-e2e.mjs", ["--suite"]],
  ["background/agent-behavior-e2e.mjs", ["--repetitions", "1.5"]],
  ["behavior/run.mjs", ["--journey"]],
  ["behavior/run.mjs", ["--report", " "]],
]) test(`${entry} rejects ${JSON.stringify(args)} before credentials, discovery or execution`, async t => {
  const fixture = await runnerFixture(t, entry);
  const result = fixture.run(args);
  assert.ifError(result.error);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /argument missing|requires a non-empty value|--repetitions must/);
  assert.equal(fixture.observed(), null);
});

test("Agent values retain spaces and equals signs at the credential boundary", async t => {
  const fixture = await runnerFixture(t, "background/agent-behavior-e2e.mjs");
  const result = fixture.run(["--provider=custom=provider", "--ak-file=a directory/key=value",
    "--suite", "journeys", "--cases", "one,two", "--concurrency", "2", "--repetitions", "3"]);
  assert.match(result.stderr, /fixture stopped before credentials/);
  assert.deepEqual(fixture.observed(), { provider: "custom=provider", keyFile: "a directory/key=value" });
});

test("behavior argument validation covers every filter and rejects malformed values", () => {
  for (const flag of ["journey", "actor", "coverage", "layer", "report"]) {
    for (const args of [[`--${flag}`], [`--${flag}=`], [`--${flag}`, " "], [`--${flag}`, "--list"]]) {
      assert.throws(() => parseBehaviorArgs(args, "/fixture"), undefined, args.join(" "));
    }
  }
  for (const args of [["--typo"], ["unexpected"]]) {
    assert.throws(() => parseBehaviorArgs(args, "/fixture"), undefined, args.join(" "));
  }
});

test("behavior preserves filters and report paths, and help does not discover tests", async t => {
  const fixture = await runnerFixture(t, "behavior/run.mjs");
  const result = fixture.run(["--journey=H03,A07", "--actor", "human", "--coverage", "强,中",
    "--layer", "browser", "--report=a directory/report=x.json", "--include-explicit", "--fail-fast", "--list"]);
  assert.match(result.stderr, /fixture stopped before test execution/);
  assert.deepEqual(fixture.observed(), { journeyIds: "H03,A07", actors: "human", coverages: "强,中", layers: "browser",
    includeExplicit: true, failFast: true, list: true, report: join(fixture.root, "a directory/report=x.json") });
  for (const args of [["--help"], ["-h"]]) {
    assert.equal(fixture.run(args).status, 0);
    assert.equal(fixture.observed(), null);
  }
});

async function runnerFixture(t, entry) {
  const root = await mkdtemp(join(tmpdir(), "qingzhou-runner-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const marker = join(root, "observed.json");
  const observation = `import { writeFileSync } from "node:fs";
const record = value => writeFileSync(${JSON.stringify(marker)}, JSON.stringify(value));\n`;
  const files = {
    "support/typescript-loader.mjs": "",
    "support/isolated-extension-mcp.mjs": `export const PROJECT_ROOT = ${JSON.stringify(root)};
export function launchIsolatedExtensionMcp() { throw new Error("unexpected browser launch"); }
export const assertNoUnexpectedDiagnostics = () => {}, runBridgePython = () => {}, saveExtensionLlmConfig = () => {};`,
    "support/local-credentials.mjs": `${observation}
export function readTestApiKey(provider, { keyFile }) { record({ provider, keyFile }); throw new Error("fixture stopped before credentials"); }`,
    "behavior/model.mjs": `${observation}
export const PROJECT_ROOT = ${JSON.stringify(root)};
export function loadBehaviorIndex() { record("index loaded"); return {}; }
export function createEvidencePlan(index, options) { record(options); throw new Error("fixture stopped before test execution"); }
export const detectSkippedCommandOutput = () => {}, relativeIndexPath = () => {}, summarizeCoverage = () => {};`,
  };
  for (const [path, source] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), source);
  }
  const script = join(root, entry);
  await mkdir(dirname(script), { recursive: true });
  await copyFile(new URL(`../${entry}`, import.meta.url), script);
  const cli = entry.startsWith("background/") ? "background/agent-behavior-cli.mjs" : "behavior/cli.mjs";
  await copyFile(new URL(`../${cli}`, import.meta.url), join(root, cli));
  // These copied JS entrypoints only exercise argument handling against stubs.
  const env = { ...process.env };
  for (const name of ["NODE_OPTIONS", "NODE_V8_COVERAGE", "NODE_TEST_CONTEXT"]) delete env[name];
  return { root,
    run(args) {
      rmSync(marker, { force: true });
      return spawnSync(process.execPath, [script, ...args], { env, encoding: "utf8", timeout: 10_000 });
    },
    observed() { return existsSync(marker) ? JSON.parse(readFileSync(marker, "utf8")) : null; },
  };
}
