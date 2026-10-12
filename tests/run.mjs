#!/usr/bin/env node
import { availableParallelism } from "node:os";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureTestExtension } from "./support/extension-build.mjs";
import "./support/typescript-loader.mjs";
import { clampNumber, parseCliArgs, printHelp, printSelectedTests, validateSelection } from "./runner/cli.mjs";
import { coverageCommands, directEntrypoint, printEntrypointHelp } from "./runner/entrypoints.mjs";
import { BROWSER_RESOURCE_SUITES, commandLabel, createSuiteCatalog } from "./runner/suites.mjs";
import { runTasks } from "./runner/scheduler.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const argv = process.argv.slice(2);
const cpuCapacity = availableParallelism();
const defaultUnitConcurrency = Math.max(4, Math.min(8, Math.ceil(cpuCapacity * 2 / 3)));
const unitConcurrency = clampNumber(process.env.QINGZHOU_TEST_CONCURRENCY, 1, 16, defaultUnitConcurrency);
const defaultTestJobs = cpuCapacity >= 10 ? 3 : cpuCapacity >= 6 ? 2 : 1;

try { await main(); } catch (error) { console.error(error.message); process.exitCode = 1; }

async function main() {
  const direct = directEntrypoint(argv);
  if (direct) {
    if (direct.helpRequested) return printEntrypointHelp(direct);
    if (direct.list) { direct.commands.forEach(item => console.log(commandLabel(item))); return; }
    if (direct.prepareBrowser) await prepareBrowser();
    return runCommands(direct.commands, direct.name);
  }
  const cli = parseCliArgs(argv);
  if (cli.help) return printHelp(defaultTestJobs);
  const testJobs = clampNumber(cli.jobs || process.env.QINGZHOU_TEST_JOBS, 1, 4, defaultTestJobs);

  const catalog = createSuiteCatalog({ root: ROOT, match: cli.match, unitConcurrency });
  const { suites: SUITES, browserHeavyUnitFiles, filteredCommands } = catalog;
  validateSelection(cli, SUITES);
  const selected = cli.suites;

  if (cli.list) return printSelectedTests(selected, catalog, cli);
  if (cli.coverage) return runCommands(coverageCommands(argv, cli.all), "coverage");

  const tasks = selected.flatMap(suite => filteredCommands(suite).map(item => ({
    suite, item, label: commandLabel(item),
    resource: item.resource || (BROWSER_RESOURCE_SUITES.has(suite) ? "browser" : "general"),
  })));
  if (!tasks.length) throw new Error(cli.match ? `No tests matched: ${cli.match}` : "No tests selected");

  if (selected.some(suite => BROWSER_RESOURCE_SUITES.has(suite))
      || (selected.includes("unit") && browserHeavyUnitFiles.length)) {
    await prepareBrowser();
  }

  await runTasks(tasks, { root: ROOT, jobs: testJobs, selected });
}

async function prepareBrowser() {
  process.env.CHROME_EXECUTABLE ||= (await import("playwright")).chromium.executablePath();
  process.env.QINGZHOU_TEST_EXTENSION_DIR = await ensureTestExtension();
}

function runCommands(commands, suite) {
  return runTasks(commands.map(item => ({ suite, item, label: commandLabel(item), resource: "general" })),
    { root: ROOT, jobs: 1, selected: [suite] });
}
