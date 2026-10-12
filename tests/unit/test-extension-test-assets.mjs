import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureTestExtension, resolveTestAsset } from "../support/extension-build.mjs";
import { prepareBenchmarkAssets } from "../support/benchmark-assets.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), "qingzhou-test-assets-"));
const extensionDir = join(temporary, "extension");
let server;
try {
  await mkdir(join(extensionDir, "sidepanel"), { recursive: true });
  const pageHtml = "<!doctype html><html><head></head><body>Compiled fixture</body></html>";
  await writeFile(join(extensionDir, "sidepanel/sidepanel.html"), pageHtml);
  await writeFile(join(extensionDir, "manifest.json"), JSON.stringify({ manifest_version: 3, name: "Compiled fixture" }));
  await writeFile(join(extensionDir, "probe.js"), "export const source = 'compiled';\n");
  await writeFile(join(extensionDir, "probe.js.map"), "{}\n");
  assert.equal(await ensureTestExtension({ extensionDir }), extensionDir);
  await assert.rejects(ensureTestExtension({ extensionDir: join(temporary, "missing") }), { code: "ENOENT" });
  assert.equal(resolveTestAsset("/extension/probe.js", { root, extensionDir }), join(extensionDir, "probe.js"));
  assert.equal(resolveTestAsset("/tests/README.md", { root, extensionDir }), resolve(root, "tests/README.md"));
  assert.equal(resolveTestAsset("/extension/../../outside.js", { root, extensionDir }), null);
  const exampleAsset = resolveTestAsset("/extension/examples/value-card.js", { root, extensionDir });
  assert.match(await readFile(exampleAsset, "utf8"), /valueCardRenderer/);
  await assert.rejects(access(resolveTestAsset("/extension/examples/index.js", { root, extensionDir })), { code: "ENOENT" }, "the package declaration must not become a cross-context runtime module");
  assert.equal(resolveTestAsset("/extension/examples/../../outside.js", { root, extensionDir }), null);
  await assert.rejects(access(join(extensionDir, "examples")), { code: "ENOENT" }, "test helpers must not mutate a supplied release extension");

  server = spawn(process.execPath, [join(root, "tests/support/static-server.mjs"), "--port", "0"], {
    cwd: temporary,
    env: { ...process.env, QINGZHOU_TEST_EXTENSION_DIR: extensionDir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const baseUrl = await new Promise((resolveUrl, reject) => {
    let output = "";
    // Readiness includes compiling two fixture overlays under the full suite's
    // parallel coverage load; it is not an assertion about product startup speed.
    const timer = setTimeout(() => fail(new Error(`test server startup timed out: ${output}`)), 30_000);
    const fail = error => { cleanup(); reject(error); };
    const exited = (code, signal) => fail(new Error(`test server exited ${code ?? signal}: ${output}`));
    const stderr = chunk => { output += chunk; };
    const stdout = chunk => {
      output += chunk;
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) { cleanup(); resolveUrl(match[0]); }
    };
    function cleanup() {
      clearTimeout(timer);
      server.off("error", fail);
      server.off("exit", exited);
      server.stderr.off("data", stderr);
      server.stdout.off("data", stdout);
    }
    server.once("error", fail);
    server.once("exit", exited);
    server.stderr.on("data", stderr);
    server.stdout.on("data", stdout);
  });
  const page = await fetch(`${baseUrl}/extension/sidepanel/sidepanel.html`);
  assert.match(await page.text(), /benchmark-test-hook\.js/, "fixture pages receive the test-only benchmark installer");
  assert.equal(await readFile(join(extensionDir, "sidepanel/sidepanel.html"), "utf8"), pageHtml, "fixture injection never modifies the compiled extension");
  const source = await fetch(`${baseUrl}/extension/probe.js`);
  assert.match(source.headers.get("content-type"), /javascript/);
  assert.equal(await source.text(), "export const source = 'compiled';\n");
  const sourceMap = await fetch(`${baseUrl}/extension/probe.js.map`);
  assert.match(sourceMap.headers.get("content-type"), /json/);
  assert.equal((await fetch(`${baseUrl}/extension/shared/tools/tool-metadata.js`)).status, 404, "missing built assets must never fall back to source");
  assert.equal((await fetch(`${baseUrl}/tests/README.md`)).status, 200, "repository fixtures remain available");
  const example = await fetch(`${baseUrl}/extension/examples/value-card.js`);
  assert.equal(example.status, 200);
  assert.match(example.headers.get("content-type"), /javascript/);
  assert.match(await example.text(), /valueCardRenderer/);
  assert.equal((await fetch(`${baseUrl}/extension/..%2f..%2fpackage.json`)).status, 403, "encoded traversal cannot escape the extension build");
  const installedAssets = await prepareBenchmarkAssets(extensionDir, join(temporary, "installed-assets"), { extensionUrlPrefix: "" });
  const installer = await readFile(join(installedAssets, "benchmark-test-hook.js"), "utf8");
  assert.match(installer, /from "\/sidepanel\//, "real extension fixtures resolve imports from the extension root");
  assert.doesNotMatch(installer, /from "\/extension\//, "HTTP routing prefixes must not leak into extension URLs");
  assert.equal(await readFile(join(extensionDir, "sidepanel/sidepanel.html"), "utf8"), pageHtml, "installed fixture generation still leaves its source untouched");
  assert.equal(resolveTestAsset("/extension/sidepanel/sidepanel.html", { root, extensionDir }), join(extensionDir, "sidepanel/sidepanel.html"), "extension-only assets never replace the HTTP fixture overlay");
} finally {
  if (server && server.exitCode === null) {
    const exited = once(server, "exit");
    server.kill("SIGTERM");
    await exited;
  }
  await rm(temporary, { recursive: true, force: true });
}

// A standalone Python fixture may receive /var/... while realpath is /private/var/....
// Exercise actual HTTP routing through a temporary-directory symlink on every platform.
const python = spawnSync(process.platform === "win32" ? "python" : "python3", ["-c", String.raw`
import json, os, sys, tempfile
from pathlib import Path
from urllib.request import urlopen
from urllib.error import HTTPError
from unittest.mock import patch
sys.path.insert(0, str(Path(sys.argv[1]) / "tests/support"))
import extension_assets as assets
sys.path.insert(0, str(Path(sys.argv[1]) / "tests/background"))
from agent_behavior.fixtures import fixture_server

with tempfile.TemporaryDirectory() as temporary:
    directory = Path(temporary)
    real = directory / "real"
    real.mkdir()
    alias = directory / "alias"
    alias.symlink_to(real, target_is_directory=True)
    def temporary_build(**kwargs):
        return tempfile.TemporaryDirectory(dir=alias, **kwargs)
    def build(command, **_):
        if "--output" not in command:
            return
        output = Path(command[command.index("--output") + 1])
        output.mkdir()
        (output / "manifest.json").write_text(json.dumps({"manifest_version": 3}))
        (output / "probe.js").write_text("export const source = 'compiled';")
        (output.parent / "outside.js").write_text("private fixture")
    with patch.dict(os.environ, {"QINGZHOU_TEST_EXTENSION_DIR": ""}), patch.object(assets, "TemporaryDirectory", temporary_build), patch.object(assets.subprocess, "run", build), patch("socket.getfqdn", side_effect=AssertionError("local fixture must not resolve DNS")):
        with assets.serve_repository() as base:
            assert assets.extension_directory() == assets.extension_directory().resolve()
            assert urlopen(base + "/extension/probe.js").read() == b"export const source = 'compiled';"
            try:
                urlopen(base + "/extension/..%2foutside.js")
                raise AssertionError("compiled fixture allowed path traversal")
            except HTTPError as error:
                assert error.code == 404
        with fixture_server() as base:
            assert b"Fixture News 1" in urlopen(base + "/news").read()
        assets._temporary_build.cleanup()
        assets._benchmark_assets.cleanup()
`, root], { encoding: "utf8", timeout: 10_000 });
assert.ifError(python.error);
assert.equal(python.status, 0, python.stdout + python.stderr);

console.log("compiled extension test asset routing passed");
