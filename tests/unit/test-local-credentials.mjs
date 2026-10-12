import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { readTestApiKey } from "../support/local-credentials.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "qingzhou-credentials-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const envFile = join(root, ".env.local");
  writeFileSync(envFile, 'DEEPSEEK_API_KEY="fixture-local"\nKIMICODE_API_KEY=fixture-kimi\n');
  return { root, envFile };
}

test("explicit key files override CI credentials, which override local provider credentials", t => {
  const { root, envFile } = fixture(t);
  const keyFile = join(root, "external-key");
  writeFileSync(keyFile, "  fixture-external\n");
  const env = { DEEPSEEK_API_KEY: "fixture-ci" };
  assert.equal(readTestApiKey("deepseek", { keyFile, env, envFile }), "fixture-external");
  assert.equal(readTestApiKey("deepseek", { env, envFile }), "fixture-ci");
  assert.equal(readTestApiKey("deepseek", { env: {}, envFile }), "fixture-local");
  assert.equal(readTestApiKey("kimicode", { env, envFile }), "fixture-kimi");
  assert.deepEqual(env, { DEEPSEEK_API_KEY: "fixture-ci" });
});

test("missing or empty explicit configuration never falls back to a different credential", t => {
  const { root, envFile } = fixture(t);
  const keyFile = join(root, "external-key");
  writeFileSync(keyFile, "\n");
  assert.throws(() => readTestApiKey("deepseek", { keyFile, envFile }), /Missing DEEPSEEK_API_KEY/);
  assert.throws(() => readTestApiKey("deepseek", { keyFile: `${keyFile}-missing`, envFile }), { code: "ENOENT" });
  assert.throws(() => readTestApiKey("deepseek", { env: { DEEPSEEK_API_KEY: "" }, envFile }), /Missing DEEPSEEK_API_KEY/);
  assert.equal(readTestApiKey("deepseek", { env: {}, envFile: `${envFile}-missing`, required: false }), "");
  assert.throws(() => readTestApiKey("deepseek", { env: {}, envFile: `${envFile}-missing` }), /Missing DEEPSEEK_API_KEY/);
});

test("provider selection cannot reuse another provider's key or export local values into the process environment", t => {
  const { envFile } = fixture(t);
  const before = JSON.stringify(process.env);
  assert.equal(readTestApiKey("kimicode", { env: {}, envFile }), "fixture-kimi");
  assert.throws(() => readTestApiKey("opencodego", { env: {}, envFile }), /Missing OPENCODEGO_API_KEY/);
  assert.ok(JSON.stringify(process.env) === before, "credential loading must leave process.env unchanged");
});

test("the default local file is resolved relative to the repository, independent of cwd", t => {
  const { root } = fixture(t);
  const support = join(root, "tests", "support");
  mkdirSync(support, { recursive: true });
  const helper = join(support, "local-credentials.mjs");
  copyFileSync(new URL("../support/local-credentials.mjs", import.meta.url), helper);
  const code = `
    import { readTestApiKey } from ${JSON.stringify(pathToFileURL(helper).href)};
    if (readTestApiKey("deepseek", { env: {} }) !== "fixture-local") throw new Error("Wrong local file");
  `;
  execFileSync(process.execPath, ["--input-type=module", "-e", code], { cwd: tmpdir() });
});
