#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { parseBehaviorArgs } from "./cli.mjs";
import "../support/typescript-loader.mjs";
import {
  PROJECT_ROOT,
  createEvidencePlan,
  detectSkippedCommandOutput,
  loadBehaviorIndex,
  relativeIndexPath,
  summarizeCoverage,
} from "./model.mjs";

const options = parseBehaviorArgs(process.argv.slice(2), PROJECT_ROOT);
if (options.help) { printHelp(); process.exit(0); }
const index = loadBehaviorIndex();
const plan = createEvidencePlan(index, options);
if (!plan.selectedJourneys.length) throw new Error("no behavior journeys matched the filters");
if (!options.list && !plan.commands.length) {
  throw new Error("no executable behavior evidence matched the filters");
}

printPlan(index, plan, options);
if (options.list) process.exit(0);

const results = [];
for (const item of plan.commands) {
  const startedAt = performance.now();
  console.log(`\n== ${item.layer} · ${item.key} ==`);
  console.log(`$ ${item.label}`);
  const env = { ...process.env };
  Object.assign(env, item.env || {});
  if (item.bin === "uv") {
    delete env.VIRTUAL_ENV;
    delete env.UV_INDEX_URL;
    delete env.UV_EXTRA_INDEX_URL;
  }
  const result = spawnSync(item.bin, item.args, {
    cwd: item.cwd,
    env,
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) console.error(`Unable to execute ${item.key}: ${result.error.message}`);
  const elapsedMs = performance.now() - startedAt;
  const skipped = result.status === 0 && detectSkippedCommandOutput(result.stdout, result.stderr);
  const passed = result.status === 0 && !skipped;
  results.push({
    key: item.key,
    layer: item.layer,
    journeys: item.journeys,
    targets: item.targets,
    status: skipped ? "skipped" : passed ? "passed" : "failed",
    exitCode: result.status,
    signal: result.signal,
    error: result.error?.message || "",
    elapsedMs: Math.round(elapsedMs),
  });
  console.log(`${skipped ? "○" : passed ? "✓" : "✗"} ${item.key} · ${skipped ? "skipped · " : ""}${formatDuration(elapsedMs)}`);
  if (!passed && options.failFast) break;
}

const report = buildReport(index, plan, results, options);
mkdirSync(dirname(options.report), { recursive: true });
writeFileSync(options.report, `${JSON.stringify(report, null, 2)}\n`);
printResult(report, options.report);
process.exit(report.summary.failedCommands || report.summary.skippedCommands ? 1 : 0);

function buildReport(indexValue, planValue, commandResults, cli) {
  const commandByKey = new Map(commandResults.map(item => [item.key, item]));
  const evidence = planValue.evidenceItems.map(item => {
    let status = item.mode;
    if (item.mode === "automated") status = commandByKey.get(item.groupKey)?.status || "not-run";
    if (item.mode === "explicit") status = cli.includeExplicit
      ? commandByKey.get(item.groupKey)?.status || "not-run"
      : "skipped-explicit";
    return { ...item, status };
  });
  const evidenceByJourney = new Map();
  for (const item of evidence) {
    for (const journeyId of item.journeys) {
      const values = evidenceByJourney.get(journeyId) || [];
      values.push(item);
      evidenceByJourney.set(journeyId, values);
    }
  }
  const journeys = planValue.selectedJourneys.map(journey => {
    const items = evidenceByJourney.get(journey.id) || [];
    const automated = items.filter(item => item.mode === "automated");
    const failed = automated.filter(item => item.status === "failed");
    const skipped = automated.filter(item => item.status === "skipped");
    const passed = automated.filter(item => item.status === "passed");
    const status = failed.length
      ? "failed"
      : skipped.length
        ? "skipped"
        : automated.length && passed.length === automated.length
          ? "evidence-passed"
          : automated.length
            ? "partial"
            : "no-automated-evidence";
    return {
      id: journey.id,
      title: journey.title,
      role: journey.role,
      coverage: journey.coverage,
      evidenceStatus: status,
      automatedEvidence: automated.length,
      passedEvidence: passed.length,
      explicitEvidence: items.filter(item => item.mode === "explicit").length,
      referenceEvidence: items.filter(item => item.mode === "reference").length,
    };
  });
  return {
    schema: "qingzhou.behavior_evidence.v1",
    createdAt: new Date().toISOString(),
    index: relativeIndexPath(indexValue.indexPath),
    filters: {
      journeyIds: split(cli.journeyIds),
      actors: split(cli.actors),
      coverages: split(cli.coverages),
      layers: split(cli.layers),
      includeExplicit: cli.includeExplicit,
    },
    summary: {
      ...summarizeCoverage(planValue.selectedJourneys),
      commands: commandResults.length,
      passedCommands: commandResults.filter(item => item.status === "passed").length,
      failedCommands: commandResults.filter(item => item.status === "failed").length,
      skippedCommands: commandResults.filter(item => item.status === "skipped").length,
      evidence: evidence.length,
      automatedEvidence: evidence.filter(item => item.mode === "automated").length,
      skippedExplicitEvidence: evidence.filter(item => item.status === "skipped-explicit").length,
      referenceEvidence: evidence.filter(item => item.mode === "reference").length,
    },
    commands: commandResults,
    journeys,
    evidence,
  };
}

function printPlan(indexValue, planValue, cli) {
  const coverage = summarizeCoverage(planValue.selectedJourneys);
  console.log(`Behavior index: ${relativeIndexPath(indexValue.indexPath)}`);
  console.log(`Journeys: ${coverage.total} · 强 ${coverage.强} / 中 ${coverage.中} / 弱 ${coverage.弱} / 缺 ${coverage.缺}`);
  console.log(`Evidence: ${planValue.evidenceItems.length} unique · ${planValue.commands.length} deduplicated commands`);
  const explicit = planValue.evidenceItems.filter(item => item.mode === "explicit").length;
  const references = planValue.evidenceItems.filter(item => item.mode === "reference").length;
  if (explicit && !cli.includeExplicit) console.log(`Explicit model evidence skipped: ${explicit} (use --include-explicit)`);
  if (references) console.log(`Reference/manual evidence: ${references}`);
  if (cli.list) {
    for (const item of planValue.commands) {
      console.log(`\n${item.key} [${item.journeys.join(", ")}]`);
      console.log(`  ${item.label}`);
    }
  }
}

function printResult(report, reportPath) {
  const { summary } = report;
  const unverified = summary.failedCommands || summary.skippedCommands;
  console.log(`\nBehavior evidence ${unverified ? "failed" : "passed"}`);
  console.log(`Commands: ${summary.passedCommands}/${summary.commands} passed${summary.skippedCommands ? `; ${summary.skippedCommands} skipped` : ""}`);
  console.log(`Journeys: ${summary.total} selected; coverage 强 ${summary.强} / 中 ${summary.中} / 弱 ${summary.弱} / 缺 ${summary.缺}`);
  console.log(`Report: ${reportPath}`);
}


function printHelp() {
  console.log(`Usage:
  npm test -- behavior
  npm test -- behavior --journey H03,A07
  npm test -- behavior --actor human --layer browser
  npm test -- behavior --coverage 强,中 --list

Options:
  --journey <ids>       comma-separated journey IDs
  --actor <actors>      human, agent, or system
  --coverage <ratings>  强, 中, 弱, 缺
  --layer <layers>      unit, service, browser, e2e, benchmark, visual, release, agent
  --include-explicit    run model/real-site evidence; credentials remain required
  --list                validate and print the deduplicated plan without running
  --fail-fast           stop after the first failed command
  --report <path>       JSON report path (default: tests/results/behavior/latest.json)
`);
}

function split(value) {
  return String(value || "").split(",").map(item => item.trim()).filter(Boolean);
}

function formatDuration(milliseconds) {
  if (milliseconds < 1_000) return `${Math.round(milliseconds)}ms`;
  return `${(milliseconds / 1_000).toFixed(milliseconds < 10_000 ? 2 : 1)}s`;
}
