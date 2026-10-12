import type { ModelOptions, ProviderDefinition, ProviderPreset, ProviderGroup, RuntimeConfig } from "../../src/sdk/background/providers.js";

const providerGroup: ProviderGroup = { id: "example", label: "Example", priority: 10 };
const provider: ProviderDefinition = { label: "Example", group: providerGroup, api: "example", protocol: "example" };
void provider;
const specializedProvider: ProviderPreset = { override: true, sessionAffinityHeader: "x-session" };
void specializedProvider;
// @ts-expect-error Partial provider contributions require an explicit override marker.
const implicitOverride: ProviderPreset = { sessionAffinityHeader: "x-session" };
// @ts-expect-error Overrides retain the original field contracts.
const invalidOverride: ProviderPreset = { override: true, requiresApiKey: "no" };
// @ts-expect-error Priorities are numbers; strings must not silently change menu ordering.
const invalidGroup: ProviderGroup = { id: "example", label: "Example", priority: "10" };

const options: ModelOptions = {
  sessionId: "session", runId: "run", spanId: "span",
  rateLimit: false, inputTokensEstimate: 1200, maxTokens: 512,
  traceparent: "00-trace-span-01", baggage: "task=example",
  retry: { maxRetries: 2, baseDelayMs: 100, maxDelayMs: 1000, jitterRatio: 0 },
  onProviderResponse: event => ({ retryAfterMs: event.retryAfterMs }),
};
void options;
// @ts-expect-error Misspelled host policy must not silently bypass admission control.
const typo: ModelOptions = { rateLimt: false };
// @ts-expect-error Normalized request options use booleans, not stored/form values.
const invalidRateLimit: ModelOptions = { rateLimit: "false" };
// @ts-expect-error Retry options are finite typed host policy, not arbitrary provider parameters.
const invalidRetry: ModelOptions = { retry: { maxRetries: "2" } };
// @ts-expect-error Legacy top-level retry options retain the same numeric contract.
const invalidTopLevelRetry: ModelOptions = { maxRetries: "2" };
// @ts-expect-error Input estimates used for admission must be numbers.
const invalidEstimate: ModelOptions = { inputTokensEstimate: "1200" };
// @ts-expect-error Model parameters belong in config.modelParameters.
const misplacedParameter: ModelOptions = { temperature: 0.2 };
// @ts-expect-error Tracing headers carry strings.
const invalidTrace: ModelOptions = { traceparent: {} };

// Provider-declared options and request-body parameters remain explicit extension points.
const config: RuntimeConfig = {
  provider: "example", requestRateLimit: true, debugMode: false,
  modelParameters: { temperature: 0.2, thinking: { budget: 1024 } },
  exampleReasoningMode: "balanced",
};
void config;
// @ts-expect-error Known fields remain typed even alongside provider-owned option keys.
const invalidRuntimeFlag: RuntimeConfig = { requestRateLimit: "yes" };
// @ts-expect-error Normalized model identity is text.
const invalidModelLabel: RuntimeConfig = { modelLabel: 123 };
