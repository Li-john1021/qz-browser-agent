import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { compareInventory, countLines, inventorySource } from "../../scripts/source-inventory.mjs";

assert.deepEqual(countLines(""), { physicalLines: 0, nonBlankLines: 0 });
assert.deepEqual(countLines("// comment\r\n\r\nconst x = 1;"), { physicalLines: 3, nonBlankLines: 2 });
assert.deepEqual(countLines("\n"), { physicalLines: 1, nonBlankLines: 0 });

const root = mkdtempSync(path.join(os.tmpdir(), "qingzhou-source-inventory-"));
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const write = (filename, content) => {
  const absolute = path.join(root, filename);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
};
try {
  git("init", "-q");
  write(".gitignore", ".venv/\nnode_modules/\nservices/local-environment/\n");
  write("extension/a.js", "// comment\n\nexport const a = 1;\n");
  write("extension/删除.js", "export const obsolete = true;");
  write("extension/vendor/library.js", "vendor\n");
  write("services/api/main.mjs", "export const service = true;\n");
  write("services/api/main.py", "pass\n");
  write("scripts/build.mjs", "export {};\n");
  write("tests/coverage/check.mjs", "export {};\n");
  write("extension/README.md", "# Module\n");
  write("dist/extension/a.js", "generated\n");
  write("package-lock.json", "{}\n");
  git("add", ".");
  git("-c", "user.name=Inventory Test", "-c", "user.email=inventory@example.invalid", "commit", "-qm", "baseline");
  const ref = git("rev-parse", "HEAD");
  const baseline = inventorySource({ root, ref });
  assert.equal(baseline.totals.extensionJsTs.files, 2);
  assert.equal(baseline.totals.extensionJsTs.physicalLines, 4);
  assert.equal(baseline.totals.extensionJsTs.nonBlankLines, 3);
  assert.equal(baseline.totals.productionJsTs.physicalLines, 5);
  assert.equal(baseline.groups["services/Python"].physicalLines, 1);
  assert.equal(baseline.groups["tests/JavaScript"].files, 1, "coverage tooling is source, not a generated report");
  assert.ok(!baseline.files.some(file => /vendor|dist|package-lock/.test(file.path)), "tracked generated/vendor files stay excluded");

  renameSync(path.join(root, "extension"), path.join(root, "src"));
  const renamed = inventorySource({ root });
  assert.deepEqual(renamed.totals, baseline.totals, "a source-directory rename cannot manufacture a reduction");
  assert.deepEqual(renamed.groups, baseline.groups, "historical and current source roots share the same scope");
  assert.ok(renamed.files.some(file => file.path === "src/a.js"), "the report preserves actual current paths");

  write("src/a.js", "export const a = 2;\n");
  rmSync(path.join(root, "src/删除.js"));
  write("src/new.ts", "export const newSource: boolean = true;\n");
  write("src/contracts.d.ts", "export interface Contract {}\n");
  write("services/local-environment/do-not-read.ts", "local environment\n");
  write("services/api/.venv/do-not-read.py", "local environment\n");
  write("node_modules/dependency.js", "dependency\n");
  write("new-runtime/main.ts", "export {};\n");
  const current = inventorySource({ root });
  assert.equal(current.totals.extensionJsTs.files, 3, "new files count before staging and deleted tracked files disappear");
  assert.equal(current.totals.extensionJsTs.physicalLines, 3);
  assert.equal(current.totals.declarations.physicalLines, 1, "type declarations count toward production totals");
  assert.equal(current.totals.productionJsTs.physicalLines, 4);
  assert.equal(current.totals.unclassifiedJsTs.files, 1, "source outside owned directories must remain visible for review");
  assert.ok(!current.files.some(file => /do-not-read|node_modules/.test(file.path)), "ignored local environments are not inventoried");
  assert.deepEqual(current, inventorySource({ root }), "inventory output is deterministic");
  assert.deepEqual(baseline, inventorySource({ root, ref }), "the committed baseline is independent of current source changes");
  assert.equal(compareInventory(current, baseline).extensionJsTs.physicalLines, -1);
  assert.equal(compareInventory(current, baseline).extensionJsTs.files, 1);

  symlinkSync(path.join(root, "src/a.js"), path.join(root, "src/link.js"));
  assert.throws(() => inventorySource({ root }), /Source must be a regular file/, "source symlinks cannot pull external code into a worktree report");
  git("add", "src/link.js");
  git("-c", "user.name=Inventory Test", "-c", "user.email=inventory@example.invalid", "commit", "-qm", "symlink");
  assert.throws(() => inventorySource({ root, ref: "HEAD" }), /Source symlink cannot be inventoried/);
  assert.throws(() => inventorySource({ root, ref: "nonexistent-baseline" }), /Command failed/, "missing history is a failure, not an empty baseline");
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log("source inventory tests passed");
