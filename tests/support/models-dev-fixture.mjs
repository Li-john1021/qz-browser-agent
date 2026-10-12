import { providers } from "@opencode-ai/models/snapshot";
import { loadBundledModelsDevProviders } from "../../src/shared/models/models-dev.js";

/** Source-level tests serve the same packaged asset as the extension build. */
export async function loadModelsDevFixture() {
  const browser = globalThis.chrome;
  const fetch = globalThis.fetch;
  const url = "chrome-extension://models-fixture/vendor/models-dev/providers.json";
  globalThis.chrome = { ...browser, runtime: { ...browser?.runtime, getURL: () => url } };
  globalThis.fetch = (input, options) => String(input) === url
    ? Promise.resolve(new Response(JSON.stringify(providers))) : fetch(input, options);
  try { await loadBundledModelsDevProviders(); }
  finally { globalThis.chrome = browser; globalThis.fetch = fetch; }
}
