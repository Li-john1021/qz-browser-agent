import type { UiExtensionAPI, UiPage, UiSettingsSection } from "../../src/sdk/sidepanel/ui.js";

declare const host: UiExtensionAPI;
declare const page: UiPage;
// @ts-expect-error UI packages use finite ports, never other feature instances.
host.data.openTable("example");
// @ts-expect-error Extension storage never exposes an unscoped owner selector.
host.storage.forOwner("other");
// @ts-expect-error The single event entry point is on(type, listener).
host.onEvent(() => {});
host.on("agent_end", event => {
  // @ts-expect-error Observers receive facts, not authority to rewrite the routed event.
  event.type = "other";
});
// @ts-expect-error Preferences must cross the JSON boundary, not retain executable values.
host.storage.set("callback", () => {});
// @ts-expect-error Page identity remains stable after registration.
page.id = "other";
const invalidPage: UiPage = {
  id: "invalid", title: "Invalid", elements: [],
  // @ts-expect-error Visibility is synchronous; loading belongs to activate.
  async isEnabled() { return true; },
};
const section: UiSettingsSection = {
  id: "example", title: "Example", element: document.createElement("section"),
  save({ signal }) {
    // @ts-expect-error The host owns cancellation; packages receive only its signal.
    signal.abort();
  },
};
void [invalidPage, section];
