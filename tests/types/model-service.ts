import type { ModelRequestOptions, ToolExtensionAPI } from "../../src/sdk/background.js";
import type { ModelMessage } from "../../src/shared/contracts/model-message.js";

declare const qz: ToolExtensionAPI;
declare const signal: AbortSignal;
const messages: ModelMessage[] = [{ role: "user", content: "Summarize this page." }];
const options: ModelRequestOptions = { sessionId: "session", runId: "run" };
void qz.models.chat(messages, [], signal, options);
void qz.models.chat(messages, []);

// @ts-expect-error Request identity is string-based.
void qz.models.chat(messages, [], signal, { sessionId: 1 });
// @ts-expect-error Gateway configuration is not a capability request option.
void qz.models.chat(messages, [], signal, { config: {} });
// @ts-expect-error Provider selection belongs to the configured gateway.
void qz.models.chat(messages, [], signal, { providerDefinition: {} });
// @ts-expect-error Raw exchanges are an internal diagnostic capability.
void qz.models.chat(messages, [], signal, { rawExchange: {} });
// @ts-expect-error Transport callbacks are internal to the gateway.
void qz.models.chat(messages, [], signal, { onProviderResponse: () => {} });
// @ts-expect-error The host owns retry policy.
void qz.models.chat(messages, [], signal, { retry: { maxRetries: 100 } });
// @ts-expect-error Authentication headers are not request identity.
void qz.models.chat(messages, [], signal, { headers: { Authorization: "unused" } });
