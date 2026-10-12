import { readStylesheetSource } from "../support/stylesheet-source.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const styles = ["sidepanel.css"].map(filename => ({
  filename,
  css: readStylesheetSource(join(root, "src/sidepanel", filename)),
}));
const benchmark = readFileSync(join(root, "tests/benchmarks/conversation-render/runtime.mjs"), "utf8");
const benchmarkRunner = readFileSync(join(root, "tests/benchmarks/conversation-render/run.mjs"), "utf8");

for (const { filename, css } of styles) {
  for (const selector of [".msg", ".msg-thinking-group", ".msg-waiting"]) {
    assert.match(
      cssRuleBody(css, selector),
      /animation:\s*none\s*;/,
      `${filename} ${selector} must not animate the whole conversation-flow item`,
    );
  }
  assert.match(
    cssRuleBody(css, ".msg-user.msg-user-outgoing-enter .msg-content"),
    /animation:\s*user-message-sail-in/,
    `${filename} should retain the local outgoing-message motion`,
  );
  assert.match(
    cssRuleBody(css, ".tool-summary .dot.running,\n.thinking-dot.running"),
    /animation:\s*pulse/,
    `${filename} should retain compact running-state feedback`,
  );
}

assert.match(benchmark, /function startVisualStabilityProbe\(options = \{\}\)/);
assert.match(benchmark, /repeatedHostAnimationStarts/);
assert.match(benchmark, /framesWithHostMotion/);
assert.match(benchmark, /frameInterval:\s*summarizeDurations\(frameIntervals\)/);
assert.match(benchmarkRunner, /streamMaxHostAnimationStarts:\s*0/);
assert.match(benchmarkRunner, /visualStability\.hostAnimationStarts/);
assert.match(benchmarkRunner, /mode === "stream-fixture-interaction"/);
assert.match(benchmarkRunner, /sampleStreamingScrollInteraction/);
assert.match(benchmarkRunner, /streamScrollMaxTailHijacks:\s*0/);
assert.match(benchmarkRunner, /streamScrollMaxResumeLagFrames:\s*1/);
assert.match(benchmarkRunner, /streamScrollMaxResumeFailures:\s*0/);
assert.match(benchmarkRunner, /visualStability\.frameInterval\?\.p95Ms/);

console.log("chat motion contract tests passed");

function cssRuleBody(css, selector) {
  const start = css.indexOf(`${selector} {`);
  assert.notEqual(start, -1, `missing CSS rule: ${selector}`);
  const bodyStart = css.indexOf("{", start) + 1;
  const end = css.indexOf("}", bodyStart);
  assert.notEqual(end, -1, `unterminated CSS rule: ${selector}`);
  return css.slice(bodyStart, end);
}
