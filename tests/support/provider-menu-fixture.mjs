import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { listProviderSummaries } from "../../src/background/llm/provider-catalog.ts";
import { decodeChromeMessage } from "../../src/shared/i18n/definition.ts";
import packs from "../../src/capabilities/i18n/locales.ts";

let pending;
/** Browser mocks use the real config wire snapshots, never a second provider catalog. */
export function providerMenuFixtures(extensionDir) {
  return pending ||= (async () => {
    const resources = await Promise.all(packs.map(async pack => [pack, JSON.parse(await readFile(
      join(extensionDir, "_locales", pack.chromeLocale, "messages.json"), "utf8",
    ))]));
    const previous = Object.getOwnPropertyDescriptor(globalThis, "chrome");
    try {
      return Object.fromEntries(resources.map(([pack, messages]) => {
        Object.defineProperty(globalThis, "chrome", { configurable: true, value: { i18n: {
          getUILanguage: () => pack.language,
          getMessage: key => decodeChromeMessage(messages[key]) || "",
        } } });
        return [pack.language, JSON.parse(JSON.stringify(listProviderSummaries()))];
      }));
    } finally {
      if (previous) Object.defineProperty(globalThis, "chrome", previous);
      else delete globalThis.chrome;
    }
  })();
}
