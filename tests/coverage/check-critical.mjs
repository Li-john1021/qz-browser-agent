import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const reportPath = "tests/results/coverage/coverage-summary.json";
const report = JSON.parse(readFileSync(reportPath, "utf8"));

// Values are [lines, branches, functions]. Keep these lists risk-based rather than global.
const backgroundThresholds = {
  "background/agent/agent.js": [70, 50, 75],
  "background/agent/context.js": [80, 65, 85],
  "background/agent/message-queue.js": [95, 85, 95],
  "background/automation/repository.js": [95, 55, 50],
  "background/automation/runtime.js": [72, 50, 65],
  "background/background-api.js": [100, 60, 100],
  "background/mcp/mcp-client.js": [72, 40, 75],
  "background/mcp/mcp-runtime.js": [95, 40, 75],
  "background/skills/skill-tool-runtime.js": [88, 58, 90],
  "background/service-worker.js": [90, 90, 70],
  "background/skills/skill-network.js": [88, 58, 95],
  "background/skills/skill-settings.js": [92, 72, 85],
  "background/tools/runtime.js": [82, 65, 85],
  "capabilities/provider-anthropic/adapter.js": [65, 40, 70],
  "capabilities/provider-codex/adapter.js": [70, 52, 70],
  "background/llm/config.js": [80, 65, 80],
  "background/llm/index.js": [95, 80, 95],
  "background/llm/capability-chat.js": [100, 100, 100],
  "capabilities/provider-openai/adapter.js": [75, 58, 75],
  "background/llm/provider-rate-governor.js": [92, 78, 90],
  "background/llm/provider-rate-learning.js": [92, 88, 95],
  "background/llm/provider-rate-runtime.js": [92, 82, 90],
  "background/llm/transport.js": [90, 65, 85],
  "background/session/artifacts.js": [82, 35, 80],
  "background/session/agent-host.js": [90, 68, 85],
  "background/session/commands.js": [75, 52, 70],
  "background/session/repository.js": [85, 70, 80],
  "background/session/runtime-reducer.js": [90, 48, 90],
  "background/session/runtime-state.js": [88, 60, 85],
  "background/session/supervisor.js": [88, 65, 80],
  "background/session/tabs.js": [70, 50, 75],
  "background/session/task-state.js": [95, 70, 90],
  "background/session/transcript.js": [98, 58, 85],
  "background/transports/runtime-message.js": [95, 85, 85],
  "background/transports/sidepanel-channel.js": [82, 55, 55],
  "background/transports/sidepanel.js": [95, 80, 70],
};

const browserThresholds = {
  "content/article-extractor.js": [90, 70, 90],
  "content/content-script.js": [50, 60, 50],
  "sidepanel/app.js": [90, 75, 85],
  "sidepanel/sidepanel.js": [98, 95, 95],
  "sidepanel/features/app/workspace-composition.js": [80, 70, 50],
  "sidepanel/features/chat/chat-workspace-feature.js": [90, 65, 60],
  "sidepanel/features/chat/transcript/recovery.js": [75, 55, 70],
  "sidepanel/features/chat/transcript/renderer.js": [70, 55, 70],
  "sidepanel/features/chat/transcript/scheduler.js": [90, 85, 90],
  "sidepanel/features/chat/transcript/waiting-card.js": [85, 70, 85],
  "sidepanel/features/chat/transcript/message-actions.js": [85, 70, 85],
  "capabilities/data/workspace/data-feature.js": [50, 45, 35],
  "capabilities/data/workspace/data-grid-adapter.js": [55, 45, 35],
  "capabilities/settings/settings-feature.js": [65, 60, 75],
};

const fullScope = process.argv.includes("--scope")
  ? process.argv[process.argv.indexOf("--scope") + 1] === "full"
  : process.argv.includes("--scope=full");
const thresholds = fullScope
  ? { ...backgroundThresholds, ...browserThresholds }
  : backgroundThresholds;

const entries = new Map(
  Object.entries(report)
    .filter(([name]) => name !== "total")
    .map(([name, value]) => [name.split("/src/").at(-1), value]),
);
const failures = [];
const expectedFiles = listProductJavaScript("src");
const sourceFiles = new Set(expectedFiles);
for (const file of expectedFiles) {
  if (!entries.has(file)) failures.push(`${file}: missing from coverage inventory`);
}
for (const [file, [lines, branches, functions]] of Object.entries(thresholds)) {
  const sourceFile = sourceFiles.has(file) ? file : file.replace(/\.js$/, ".ts");
  const coverage = sourceFiles.has(sourceFile) ? entries.get(sourceFile) : undefined;
  if (!coverage) {
    failures.push(`${sourceFile}: missing source or coverage report`);
    continue;
  }
  for (const [metric, minimum] of Object.entries({ lines, branches, functions })) {
    const actual = Number(coverage[metric]?.pct);
    if (!Number.isFinite(actual) || actual < minimum) {
      failures.push(`${sourceFile}: ${metric} ${actual}% < ${minimum}%`);
    }
  }
}

if (failures.length) {
  console.error(`Critical ${fullScope ? "runtime" : "background"} coverage gate failed:`);
  failures.forEach(failure => console.error(`  ${failure}`));
  process.exit(1);
}

console.log(
  `critical ${fullScope ? "runtime" : "background"} coverage gate passed `
  + `(${Object.keys(thresholds).length} modules; ${expectedFiles.length} production files inventoried)`,
);

function listProductJavaScript(root) {
  const files = [];
  walk(root);
  return files.sort();

  function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === "vendor") continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && /\.(?:js|ts)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) files.push(relative("src", path));
    }
  }
}
