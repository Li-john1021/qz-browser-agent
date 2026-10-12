import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_CAPTURE_SETTLE_POLICY,
  resolveCaptureSettlePolicy,
} from "../benchmarks/article-extraction/capture-settle-policy.mjs";

test("capture settle policy preserves production waits and accepts bounded test timing", () => {
  assert.deepEqual(resolveCaptureSettlePolicy(), DEFAULT_CAPTURE_SETTLE_POLICY);

  const values = new Map([
    ["--settle-scroll-ms", "50"],
    ["--settle-sample-ms", "35"],
    ["--settle-min-ms", "300"],
    ["--settle-max-ms", "700"],
  ]);
  assert.deepEqual(resolveCaptureSettlePolicy(name => values.get(name)), {
    scrollDelayMs: 50,
    sampleIntervalMs: 35,
    minObservationMs: 300,
    maxObservationMs: 700,
  });
  assert.throws(
    () => resolveCaptureSettlePolicy(name => ({
      "--settle-min-ms": "800",
      "--settle-max-ms": "700",
    })[name]),
    /settle-max-ms/,
  );
});
