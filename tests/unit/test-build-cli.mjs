import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { EXTENSION_ENTRIES } from "../../scripts/build-extension.mjs";

const CLI = fileURLToPath(new URL("../../scripts/build-extension.mjs", import.meta.url));
const TYPECHECK = new URL("../../scripts/typecheck.mjs", import.meta.url).href;

test("build help is side-effect free, including npm's production/typecheck defaults", async t => {
  const fixture = await workspace(t);
  const env = await typecheckFixture(fixture, "process.exitCode = 23;");
  for (const help of ["--help", "-h"]) {
    const result = run(["--mode", "production", "--typecheck", "--watch", help,
      "--source-dir", join(fixture.work, "missing"), "--output-dir", fixture.output], { env });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Usage: npm run dev/);
    assert.match(result.stdout, /npm run build/);
    assert.match(result.stdout, /dist\/extension\//);
    assert.equal(existsSync(fixture.output), false);
    assert.equal(existsSync(fixture.checked), false);
  }
});

test("build rejects invalid arguments before typechecking or creating output", async t => {
  const fixture = await workspace(t);
  const env = await typecheckFixture(fixture, "process.exitCode = 23;");
  for (const args of [["--unknown"], ["unexpected"], ["--output-dir"], ["--mode"],
    ["--mode", "--watch"], ["--mode=staging"], ["--product=unknown"], ["--source-dir="]]) {
    const result = run(["--typecheck", "--output-dir", fixture.output, ...args], { env });
    assert.equal(result.status, 1, args.join(" "));
    assert.ok(result.stderr.trim(), "invalid arguments explain the failure");
    assert.equal(result.stdout, "");
    assert.equal(existsSync(fixture.output), false);
    assert.equal(existsSync(fixture.checked), false);
  }
});

test("a failed or interrupted typecheck preserves the last successful output", async t => {
  const fixture = await workspace(t);
  await mkdir(fixture.output);
  const previous = join(fixture.output, "previous-build.txt");
  await writeFile(previous, "last successful extension");
  for (const [source, status, message] of [
    ['console.error("fixture type error"); process.exitCode = 23;', 23, /fixture type error/],
    ['process.kill(process.pid, "SIGTERM");', 1, /Typecheck interrupted \(SIGTERM\)/],
  ]) {
    const env = await typecheckFixture(fixture, source);
    const result = run(["--typecheck", "--source-dir", join(fixture.work, "missing"),
      "--output-dir", fixture.output], { env });
    assert.equal(result.status, status, result.stderr);
    assert.match(result.stderr, message);
    assert.equal(result.stdout, "");
    assert.equal(await readFile(previous, "utf8"), "last successful extension");
    assert.equal(existsSync(join(fixture.output, ".qingzhou-build.json")), false);
    assert.equal(existsSync(fixture.checked), true);
  }
});

test("build prints a concise summary and forwards production and product options", async t => {
  const fixture = await workspace(t);
  await extensionFixture(fixture.source);
  const result = run(["--source-dir", fixture.source, "--output-dir", fixture.output,
    "--mode=production", "--product=public", "--no-bundle", "--debug-maps"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^Built \d+ files \(production, public\) in /);
  assert.equal(result.stdout.trim().split("\n").length, 1);
  const manifest = JSON.parse(await readFile(join(fixture.output, ".qingzhou-build.json"), "utf8"));
  assert.equal(manifest.mode, "production");
  assert.equal(manifest.product, "public");
  assert.equal(manifest.debugMaps, true);
  assert.equal(manifest.bundling.enabled, false);
  assert.ok(manifest.files.includes("background/service-worker.js"));
});

test("JSON build output remains parseable when the typecheck gate prints progress", async t => {
  const fixture = await workspace(t);
  await extensionFixture(fixture.source);
  const env = await typecheckFixture(fixture, 'console.log("Typecheck fixture passed");');
  const result = run(["--source-dir", fixture.source, "--output-dir", fixture.output, "--typecheck", "--json"], { env });
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.mode, "development");
  assert.equal(summary.outputDir, fixture.output);
  assert.equal(summary.formatVersion, 1);
  assert.ok(summary.files.includes("background/service-worker.js"));
  assert.match(result.stderr, /Typecheck fixture passed/);
  assert.equal(existsSync(fixture.checked), true);
});

function run(args, options = {}) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", timeout: 30_000, ...options });
}

async function workspace(t) {
  const work = await realpath(await mkdtemp(join(tmpdir(), "qingzhou-build-cli-")));
  t.after(() => rm(work, { recursive: true, force: true }));
  return { work, source: join(work, "src"), output: join(work, "output"), checked: join(work, "typecheck-ran") };
}

async function typecheckFixture(fixture, source) {
  const hook = join(fixture.work, "typecheck-fixture.mjs");
  const checker = `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(fixture.checked)}, 'yes'); ${source}`;
  await writeFile(hook, `import { registerHooks } from 'node:module';
registerHooks({ load(url, context, next) {
  if (url === ${JSON.stringify(TYPECHECK)}) return { format: 'module', shortCircuit: true, source: ${JSON.stringify(checker)} };
  return next(url, context);
} });\n`);
  return { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS || ""} --import=${JSON.stringify(pathToFileURL(hook).href)}` };
}

async function extensionFixture(root) {
  const files = {
    "manifest.json": JSON.stringify({ manifest_version: 3,
      background: { service_worker: "background/service-worker.js", type: "module" },
      side_panel: { default_path: "sidepanel/sidepanel.html" },
      content_scripts: [{ js: EXTENSION_ENTRIES.filter(entry => entry.path.startsWith("content/")).map(entry => entry.path) }],
      sandbox: { pages: ["runner-sandbox.html"] }, declarative_net_request: { rule_resources: [] } }),
    "products/manifest.json": JSON.stringify({ version: 1, defaultProduct: "public", ports: [] }),
    "sidepanel/sidepanel.html": '<script type="module" src="sidepanel.js"></script>',
    "offscreen.html": '<script type="module" src="offscreen.js"></script>',
    "runner-sandbox.html": '<script src="runner-sandbox.js"></script>',
    ...Object.fromEntries(EXTENSION_ENTRIES.map(entry => [entry.path, "globalThis.fixture = true;\n"])),
  };
  for (const [path, source] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), source);
  }
}
