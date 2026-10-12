import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const nodeBin = process.execPath;
const smokeScript = join(root, "tests/data-grid/browser-smoke.mjs");

const scenarios = [
  { name: "sidepanel", width: 520, height: 680 },
  { name: "desktop", width: 960, height: 540 },
  { name: "wide", width: 1360, height: 760 },
];

for (const scenario of scenarios) {
  const result = spawnSync(nodeBin, [smokeScript], {
    cwd: root,
    env: {
      ...process.env,
      DATA_GRID_SMOKE_WIDTH: String(scenario.width),
      DATA_GRID_SMOKE_HEIGHT: String(scenario.height),
    },
    encoding: "utf8",
  });
  process.stdout.write(result.stdout || "");
  process.stderr.write(result.stderr || "");
  assert.equal(result.status, 0, `data grid browser smoke failed for ${scenario.name} viewport`);
}

console.log("data grid browser matrix passed");
