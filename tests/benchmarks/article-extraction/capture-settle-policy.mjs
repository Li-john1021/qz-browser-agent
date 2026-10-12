export const DEFAULT_CAPTURE_SETTLE_POLICY = Object.freeze({
  scrollDelayMs: 500,
  sampleIntervalMs: 350,
  minObservationMs: 3_000,
  maxObservationMs: 5_000,
});

export function resolveCaptureSettlePolicy(readOption = () => "") {
  const policy = Object.freeze({
    scrollDelayMs: positiveInteger(readOption("--settle-scroll-ms"), DEFAULT_CAPTURE_SETTLE_POLICY.scrollDelayMs),
    sampleIntervalMs: positiveInteger(readOption("--settle-sample-ms"), DEFAULT_CAPTURE_SETTLE_POLICY.sampleIntervalMs),
    minObservationMs: positiveInteger(readOption("--settle-min-ms"), DEFAULT_CAPTURE_SETTLE_POLICY.minObservationMs),
    maxObservationMs: positiveInteger(readOption("--settle-max-ms"), DEFAULT_CAPTURE_SETTLE_POLICY.maxObservationMs),
  });
  if (policy.maxObservationMs < policy.minObservationMs) {
    throw new Error("--settle-max-ms must be greater than or equal to --settle-min-ms");
  }
  return policy;
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}
