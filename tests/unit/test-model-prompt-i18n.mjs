import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

for (const language of ["zh-CN", "en"]) {
  test(`model requests use complete ${language} instructions without translating user content`, () => {
    const result = spawnSync(process.execPath, ["--import", "tsx", "tests/fixtures/model-prompt-locale.mjs", language], {
      cwd: new URL("../../", import.meta.url), encoding: "utf8", timeout: 60_000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /4 actual Agent requests/);
  });
}
