import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyEvidence,
  createEvidencePlan,
  detectSkippedCommandOutput,
  loadBehaviorIndex,
} from "../behavior/model.mjs";

const index = loadBehaviorIndex();
const plan = createEvidencePlan(index);

assert.equal(index.journeys.length, 51, "the product behavior catalog should stay explicit and reviewable");
assert.equal(Object.keys(index.summaryCoverage).length, 51, "every detailed journey needs one summary coverage rating");
assert.ok(plan.evidenceItems.length >= 100, "journeys should link concrete evidence rather than broad suite names");
assert.ok(plan.commands.length >= 10, "the runner should preserve distinct product boundaries");
assert.ok(plan.commands.length < plan.evidenceItems.length / 2, "shared evidence must be deduplicated before execution");
assert.equal(plan.evidenceItems.some(item => item.mode === "unknown"), false, "every evidence path needs an execution policy");
const browserCommand = plan.commands.find(item => item.key === "browser");
assert.equal(
  browserCommand?.env?.QINGZHOU_PLAYWRIGHT_WORKERS,
  "1",
  "behavior browser evidence should default to deterministic single-worker execution",
);
const streamBenchmarkCommand = plan.commands.find(item => item.key === "benchmark:message-stream");
assert.equal(
  streamBenchmarkCommand?.args?.includes("--fail-on-budget"),
  true,
  "stream performance evidence must fail when its user-visible cadence budget is exceeded",
);

for (const journey of index.journeys.filter(item => item.coverage === "强")) {
  const evidence = journey.evidence.map(item => classifyEvidence(item.target));
  assert.ok(evidence.some(item => item.mode === "automated"), `${journey.id} is strong without unattended evidence`);
}

const scoped = createEvidencePlan(index, { journeyIds: "H02,H03" });
assert.deepEqual(scoped.selectedJourneys.map(item => item.id), ["H02", "H03"]);
assert.equal(
  scoped.commands.filter(item => item.key === "e2e:extension").length,
  1,
  "shared extension E2E evidence should run once",
);
assert.equal(scoped.commands.some(item => item.mode === "explicit"), false, "model evidence must stay opt-in");

const explicit = createEvidencePlan(index, { journeyIds: "A07", includeExplicit: true });
assert.equal(explicit.commands.some(item => item.key === "agent:model-regression"), true);

const weakAgentJourneys = createEvidencePlan(index, {
  journeyIds: "A10,A11,A12,A14,A15,A17,A20,A21",
  includeExplicit: true,
});
assert.equal(
  weakAgentJourneys.commands.filter(item => item.key === "agent:model-regression").length,
  1,
  "all weak Agent journeys should share one isolated real-model suite",
);
const notificationProbe = createEvidencePlan(index, { journeyIds: "H16", includeExplicit: true });
assert.equal(
  notificationProbe.commands.some(item => item.key === "probe:notification-return"),
  true,
  "notification return should stay covered by its focused behavior probe",
);
assert.equal(
  notificationProbe.evidenceItems.find(item => item.groupKey === "probe:notification-return")?.mode,
  "automated",
  "the repaired notification return path belongs in the default behavior gate",
);

const browserOnly = createEvidencePlan(index, { actors: "human", layers: "browser" });
assert.ok(browserOnly.selectedJourneys.every(item => item.role === "Human"));
assert.ok(browserOnly.commands.every(item => item.layer === "browser"));

assert.equal(detectSkippedCommandOutput('{"stage":"skipped","reason":"Chrome missing"}'), true);
assert.equal(detectSkippedCommandOutput("data grid extension page e2e skipped: extension missing"), true);
assert.equal(detectSkippedCommandOutput("2 skipped, 15 passed"), false, "test-level skips must not hide a healthy command");
assert.equal(detectSkippedCommandOutput('{"stage":"done","ok":true}'), false);

// Documentation language must not change report fields, coverage filters, or executed evidence.
const fixtureRoot = mkdtempSync(join(tmpdir(), "qz-behavior-index-"));
try {
  mkdirSync(join(fixtureRoot, "unit"));
  writeFileSync(join(fixtureRoot, "unit/test-example.mjs"), "// Synthetic evidence path.\n");
  const fieldLabels = [
    ["角色", "Role"], ["任务", "Task"], ["前置", "Preconditions"], ["步骤", "Steps"],
    ["成功结果", "Expected outcome"], ["失败与恢复", "Failure and recovery"],
    ["现有证据", "Evidence"], ["覆盖判断", "Coverage"], ["下一测试", "Next test"],
  ];
  const ratings = [["强", "Strong"], ["中", "Medium"], ["弱", "Weak"], ["缺", "Missing"]];
  function fixture(language) {
    const records = Object.entries({ H: 16, A: 21, S: 13 }).flatMap(([prefix, count]) => (
      Array.from({ length: count }, (_, offset) => {
        const id = `${prefix}${String(offset + 1).padStart(2, "0")}`;
        const coverage = ratings[offset % ratings.length][language];
        const values = [
          { H: "Human", A: "Agent", S: "System" }[prefix],
          "Read a page", "A readable page", "Read and verify", "The expected text is shown",
          "Retry after a temporary failure", "[Example](unit/test-example.mjs)", coverage, "Verify restart recovery",
        ];
        const separator = language === 0 ? "：" : ": ";
        return {
          summary: `| ${id} | Read a page | ${coverage} | Restart recovery |`,
          detail: `### ${id} · Read a page\n\n${fieldLabels.map((labels, index) => (
            `- **${labels[language]}**${separator}${values[index]}`
          )).join("\n")}`,
        };
      })
    ));
    return `${records.map(record => record.summary).join("\n")}\n\n${records.map(record => record.detail).join("\n\n")}\n`;
  }
  function readFixture(name, source) {
    const path = join(fixtureRoot, name);
    writeFileSync(path, source);
    return loadBehaviorIndex(path);
  }
  const englishSource = fixture(1);
  const english = readFixture("english.md", englishSource);
  const legacy = readFixture("legacy.md", fixture(0));
  assert.deepEqual(english.journeys.map(item => item.fields), legacy.journeys.map(item => item.fields));
  assert.deepEqual(english.summaryCoverage, legacy.summaryCoverage);
  assert.deepEqual(createEvidencePlan(english).commands, createEvidencePlan(legacy).commands);
  assert.deepEqual(
    createEvidencePlan(english, { coverages: "strong,medium" }).selectedJourneys.map(item => item.id),
    createEvidencePlan(legacy, { coverages: "强,中" }).selectedJourneys.map(item => item.id),
  );
  assert.throws(
    () => readFixture("invalid.md", englishSource.replace("**Coverage**: Strong", "**Coverage**: Excellent")),
    /invalid coverage rating/u,
  );
  assert.throws(
    () => readFixture("mismatch.md", englishSource.replace("| H01 | Read a page | Strong |", "| H01 | Read a page | Weak |")),
    /coverage differs between summary and detail/u,
  );
  assert.throws(
    () => readFixture("missing.md", englishSource.replace("- **Failure and recovery**: Retry after a temporary failure\n", "")),
    /is missing/u,
  );
  assert.throws(
    () => readFixture("duplicate.md", englishSource.replace("- **Role**: Human", "- **Role**: Human\n- **角色**：Human")),
    /duplicate behavior field/u,
  );
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true });
}

console.log(`behavior index and evidence plan passed (${index.journeys.length} journeys, ${plan.evidenceItems.length} evidence paths)`);
