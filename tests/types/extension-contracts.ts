import type { ContextRequest, ContextSource } from "../../src/sdk/background/context.js";
import type { LifecycleEvent, LifecycleObserver } from "../../src/sdk/background/observers.js";
import type { RuntimeConfig, ProviderAdapter } from "../../src/sdk/background/providers.js";
import type { JsonValue, ReadonlyJsonValue } from "../../src/shared/contracts/json.js";
import type { CapabilityStateStore, JsonValue as StorageValue, ToolView } from "../../src/sdk/sidepanel.js";
import type { ToolEvent as PresentationEvent } from "../../src/sdk/sidepanel/presentation.js";
import type { ToolEvent as RendererEvent } from "../../src/sdk/sidepanel/renderers.js";

const mutable: JsonValue[] = ["a", { nested: true }];
mutable.push(null);
const readonly: ReadonlyJsonValue = { nested: ["a", { enabled: true }] } as const;
const storageValue: StorageValue = readonly;
declare const store: CapabilityStateStore;
void store.set("preferences", storageValue);
void store.set("mutable", mutable);
const readonlyArray: readonly JsonValue[] = ["a"];
// @ts-expect-error Readonly arrays are accepted by storage, not mutable JSON builders.
const mutableCopy: JsonValue = readonlyArray;
// @ts-expect-error JSON excludes executable values.
void store.set("callback", () => {});

const source: ContextSource = { id: "example", reasons: ["snapshot"], read: request => request.sessionId };
const request: ContextRequest = { sessionId: "session", runId: "run", reason: "snapshot" };
void source.read(request);
// @ts-expect-error Context identity is immutable across an asynchronous read.
request.sessionId = "another";
// @ts-expect-error Run identity remains required.
source.read({ sessionId: "session", reason: "snapshot" });
const observer: LifecycleObserver = { id: "example", onEvent: event => event.phase };
declare const event: LifecycleEvent;
void observer.onEvent(event, new AbortController().signal);
// @ts-expect-error Observers receive immutable metadata.
event.timestamp = 0;

const config: RuntimeConfig = { modelParameters: { temperature: 0 }, productOption: true };
const emptyConfig: RuntimeConfig = {};
declare const adapter: ProviderAdapter;
void adapter.chat([], [], undefined, {}, config);
void adapter.chat([], [], undefined, {}, emptyConfig);
// @ts-expect-error Known provider fields retain their original types.
const invalidConfig: RuntimeConfig = { provider: 7 };
if (config.modelParameters) {
  // @ts-expect-error Providers cannot mutate the received parameter map through its contract.
  config.modelParameters.temperature = 1;
}

declare const view: ToolView;
// @ts-expect-error Renderer input is a readonly snapshot.
view.args.changed = true;
// @ts-expect-error Runtime status remains a closed set.
const invalidState: ToolView["state"] = "unknown";
declare const rendererEvent: RendererEvent;
const presentationEvent: PresentationEvent = rendererEvent;
const sameEvent: RendererEvent = presentationEvent;
void sameEvent;
