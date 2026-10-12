import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const run = read("tests/benchmarks/conversation-render/run.mjs");
const audit = read("tests/benchmarks/conversation-render/visual-audit.mjs");
const matrix = read("tests/benchmarks/conversation-render/run-visual-audit-matrix.mjs");
const benchmark = read("tests/benchmarks/conversation-render/runtime.mjs");
const benchmarkHost = read("tests/benchmarks/conversation-render/host.mjs");
const fixturePath = new URL("../benchmarks/conversation-render/fixtures/visual-audit.json", import.meta.url);
const fixture = existsSync(fixturePath) ? JSON.parse(readFileSync(fixturePath, "utf8")) : null;

for (const root of ["conversation", "expanded", "search", "composer", "running", "queued", "welcome"]) {
  assert.match(audit, new RegExp(`id: ["']${root}["']`), `visual audit root missing: ${root}`);
}

for (const visualCheck of [
  "viewport-horizontal-overflow",
  "chat-horizontal-overflow",
  "duplicate-dom-id",
  "sibling-control-overlap",
  "panel-clipped",
  "target-clipped",
  "target-occluded",
  "control-text-overflow",
  "unstable-after-settle",
  "page-error",
  "console-error",
]) {
  assert.ok(audit.includes(visualCheck), `visual anomaly check missing: ${visualCheck}`);
}

assert.match(audit, /button, \[role='button'\]/, "button inventory must include semantic role buttons");
assert.match(audit, /function isBlockedByOpenPanel[\s\S]*BLOCKING_PANEL_SELECTORS/u, "controls behind blocking panels must not be scheduled as clickable");
assert.match(audit, /item\.blockedByPanel === true/u, "newly revealed controls must be scheduled only outside blocking panels");
assert.match(audit, /before[\s\S]*frame-1[\s\S]*settled/, "each control must capture before, first, and settled frames");
assert.match(audit, /scheduleInventoryTasks/, "newly revealed controls must be discoverable");
assert.match(audit, /resetOnboarding: true/, "action roots must reset onboarding state");
assert.match(audit, /page\.keyboard\.press\("Escape"\)/u, "action roots must dismiss transient popovers before replay");
assert.match(benchmark, /configureVisualState:\s*host\.configureVisualState/, "benchmark API must expose visual state setup");
assert.match(benchmarkHost, /function configureVisualState[\s\S]*options\.closeSettings\?\.\(\)[\s\S]*options\.notifyUi\?\.\(\{ type: "ui_close_transient" \}\)[\s\S]*options\.chatSearch\.close/, "visual state setup must isolate settings, capability overlays, and chat search");
assert.match(read("src/capabilities/sessions/ui.ts"), /event\.type === "ui_close_transient"[^\n]*artifacts\.closePanel\(\); automations\.closeEditor\(\)/, "session capability must close artifact and automation overlays for visual isolation");
assert.match(benchmarkHost, /function reset[\s\S]*options\.resetUi\?\.\(\)[\s\S]*options\.hideToast\?\.\(\)/, "each benchmark mode must reset transient toast feedback");

for (const budget of [
  "visualAuditMinActions",
  "visualAuditMaxUnexercisedKinds",
  "visualAuditMaxClickFailures",
  "visualAuditMaxErrors",
  "visualAuditMaxWarnings",
  "visualAuditMaxStableMovementPx",
  "visualAuditMaxUnexpectedLayoutShift",
]) {
  assert.ok(run.includes(budget), `visual health budget missing: ${budget}`);
}
assert.match(run, /interaction-visual-snapshots\.json/, "interaction screenshot manifest must be persisted");
assert.match(run, /steer_follow_up[\s\S]*follow_up_steered/, "benchmark transport stub must settle queue actions instead of leaking timeout toasts across audit roots");
assert.match(run, /visual-audit\.html/, "human-readable visual review must be generated");
assert.match(run, /comparison\.interactionVisuals/, "interaction screenshots must participate in baseline comparison");
assert.match(run, /compareVisualSnapshotInventory/, "all interaction frame names must participate in baseline comparison");
assert.match(run, /isStableInteractionSnapshot/, "transient and stable interaction frames must have separate pixel policies");
assert.match(run, /missing baseline screenshot/, "new interaction frames must fail an old baseline");

for (const profile of ["narrow-light", "sidepanel-light", "wide-light", "sidepanel-dark"]) {
  assert.ok(matrix.includes(profile), `visual matrix profile missing: ${profile}`);
}
assert.match(matrix, /--fail-on-health/, "matrix runs must fail on visual health regressions");

if (fixture) {
  const transcript = Array.isArray(fixture.transcript) ? fixture.transcript : [];
  const tools = transcript.filter(item => item.type === "tool");
  assert.ok(tools.length > 12, "visual fixture must exercise family-mode tool timelines");
  assert.ok(transcript.filter(item => item.type === "thinking").length >= 2, "visual fixture must exercise thinking pagination");
  assert.ok(transcript.some(item => item.type === "wait" && item.form?.fields?.length), "visual fixture must exercise a waiting form");
  assert.ok(transcript.some(item => item.type === "assistant" && /```/.test(item.content || "")), "visual fixture must exercise code-copy controls");
  assert.ok(tools.some(item => item.name === "data_store"), "visual fixture must exercise data artifacts");
  assert.ok(tools.some(item => item.name === "save_file"), "visual fixture must exercise file artifacts");
  assert.ok(transcript.filter(item => item.type === "user" && item.clientMessageId).length >= 2, "visual fixture must exercise user-message editing");
}

console.log("conversation visual audit contract tests passed");

function read(path) {
  return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
}
