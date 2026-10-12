import { build } from "esbuild";
import { chromium } from "playwright";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "./fixtures.mjs";
import { ensureTestExtension } from "../support/extension-build.mjs";

const literal = "$5 / $$6 / $$$7 / $HOME$ / $1 / $QZ_LITERAL$ / {name} / trailing $";
const userText = "$9 {name} <script>user text</script>";
const literalId = "qz_native_002dcheck_002eliteral";
// This expected wire value is deliberately independent of the encoder exercised in the browser.
const literalEntry = { message: "$QZ_LITERAL$", placeholders: { qz_literal: {
  content: "$$5 / $$$6 / $$$$7 / $$HOME$$ / $$1 / $$QZ_LITERAL$$ / {name} / trailing $$",
} } };

for (const [language, chromeLocale, brand, tagline] of [
  ["en", "en", "qz", "A lighter way to get things done."],
  ["zh-CN", "zh_CN", "轻舟", "万重山外，一舟轻渡"],
  ["zh-TW", "zh_TW", "輕舟", "萬重山外，一舟輕渡"],
  ["ja", "ja", "軽舟", "やりたいことを、軽やかに。"],
  ["ar", "ar", "qz", "أفق أوسع، وخطوة أخف."],
]) {
  test(`Chrome loads the generated ${language} catalog and resolves it through the real kernel`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "qingzhou-native-locale-"));
    let context;
    try {
      const extension = join(directory, "extension");
      // A controlled default locale makes native resource loading deterministic on macOS, where --lang
      // does not change the OS-selected Chrome UI language. No user's profile is touched.
      const compiled = await ensureTestExtension();
      for (const locale of new Set([chromeLocale, "ja", "ar"])) {
        await mkdir(join(extension, "_locales", locale), { recursive: true });
        const messages = JSON.parse(await readFile(join(compiled, "_locales", locale, "messages.json"), "utf8"));
        messages[literalId] = literalEntry;
        messages.literalManifest = { message: "$QZ_LITERAL$", placeholders: { qz_literal: { content: literal } } };
        await writeFile(join(extension, "_locales", locale, "messages.json"), JSON.stringify(messages));
      }
      await writeFile(join(extension, "manifest.json"), JSON.stringify({
        manifest_version: 3, name: "__MSG_extensionName__", version: "1.0", default_locale: chromeLocale,
        description: "__MSG_literalManifest__",
        action: { default_title: "__MSG_extensionName__" },
        background: { service_worker: "worker.js" },
      }));
      await writeFile(join(extension, "worker.js"), "chrome.runtime.onInstalled.addListener(() => {});");
      await writeFile(join(extension, "probe.html"), '<!doctype html><script type="module" src="probe.js"></script>');
      await build({ stdin: { contents: `
        export { getLanguage, getTextDirection, createTranslator } from "./src/shared/i18n/index.ts";
        export { languageRuntime } from "./src/shared/i18n/runtime.ts";
        export { defineMessages, chromeMessageId, decodeChromeMessage, encodeChromeMessage } from "./src/shared/i18n/definition.ts";
        export { t } from "./src/sidepanel/i18n/index.ts";
      `, resolveDir: resolve(".") }, bundle: true, format: "esm", target: "chrome120", outfile: join(extension, "probe.js") });
      context = await chromium.launchPersistentContext(join(directory, "profile"), {
        headless: true, executablePath: chromium.executablePath(),
        ignoreDefaultArgs: ["--disable-extensions"],
        args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
      });
      const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
      const page = await context.newPage();
      await page.goto(new URL("/probe.html", worker.url()).href);
      const result = await page.evaluate(async ({ language, userText, literal }) => {
        const native = chrome.i18n.getMessage("qz_language");
        Object.defineProperty(chrome.i18n, "getUILanguage", { configurable: true, value: () => language });
        const { getLanguage, getTextDirection, createTranslator, defineMessages, chromeMessageId, encodeChromeMessage, languageRuntime, t } = await import("./probe.js");
        const thirdParty = createTranslator(defineMessages("native-check", {
          saved: { en: "Saved {name}", "zh-CN": "已保存 {name}" },
          literal: { en: "Literal {name}", "zh-CN": "原文 {name}" },
        }));
        return {
          native, language: getLanguage(), direction: getTextDirection(), brand: t("brand"), tagline: t("tagline"),
          historicalTitle: languageRuntime.isHistoricalLabel("新开页面", "Open tab"),
          customTitle: languageRuntime.isHistoricalLabel("My personal tab", "Open tab"),
          manifestName: chrome.runtime.getManifest().name,
          actionTitle: chrome.runtime.getManifest().action.default_title,
          unknown: thirdParty("saved", { name: '$5 {name} <script>user text</script>' }),
          literal: thirdParty("literal", { name: userText }),
          manifestLiteral: chrome.runtime.getManifest().description,
          literalId: chromeMessageId("native-check.literal"), encodedLiteral: encodeChromeMessage(literal),
          encodedManifestLiteral: encodeChromeMessage(literal, { substitutions: false }),
        };
      }, { language, userText, literal });
      expect(result).toEqual({ native: language, language, direction: language === "ar" ? "rtl" : "ltr", brand, tagline,
        historicalTitle: true, customTitle: false,
        manifestName: brand, actionTitle: brand,
        unknown: `${language === "zh-CN" ? "已保存" : "Saved"} $5 {name} <script>user text</script>`,
        literal: literal.replace("{name}", userText), manifestLiteral: literal,
        literalId, encodedLiteral: literalEntry,
        encodedManifestLiteral: { message: "$QZ_LITERAL$", placeholders: { qz_literal: { content: literal } } },
      });
      // Extension pages and workers can load another language privately, regardless of Chrome's
      // chosen native locale. Content scripts use the Background protocol instead of exposing WAR.
      async function readPrivateCatalog({ locale, literalId }) {
        const response = await fetch(chrome.runtime.getURL(`_locales/${locale}/messages.json`));
        const messages = await response.json();
        return {
          status: response.status, language: messages.qz_language.message,
          native: chrome.i18n.getMessage("qz_language"), count: Object.keys(messages).length,
          exposed: Boolean(chrome.runtime.getManifest().web_accessible_resources),
          nativeLiteral: chrome.i18n.getMessage(literalId), rawLiteral: messages[literalId],
        };
      }
      for (const locale of ["ja", "ar"]) {
        for (const target of [page, worker]) {
          const fetched = await target.evaluate(readPrivateCatalog, { locale, literalId });
          expect(fetched).toMatchObject({ status: 200, language: locale, native: language, exposed: false });
          expect(fetched.nativeLiteral).toBe(literal);
          expect(await page.evaluate(async entry => {
            const { decodeChromeMessage } = await import("./probe.js");
            return decodeChromeMessage(entry);
          }, fetched.rawLiteral)).toBe(literal);
          expect(fetched.count).toBeGreaterThan(2000);
        }
      }
      const nativeMessages = JSON.parse(await readFile(join(extension, "_locales", chromeLocale, "messages.json"), "utf8"));
      if (language === "en" || language === "zh-CN") {
        // Source-language UI strings use their authored fallbacks; Chrome owns only manifest
        // metadata, the language marker and historical title aliases, plus the two literal probes.
        expect(Object.keys(nativeMessages).sort()).toEqual([
          "extensionName", "extensionDescription", "switchModel", "qz_language", "qz_historical_labels", literalId, "literalManifest",
        ].sort());
      } else {
        expect(Object.keys(nativeMessages).length).toBeGreaterThan(2000);
      }
    } finally {
      await context?.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}
