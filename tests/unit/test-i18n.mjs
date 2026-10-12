import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { createTranslator, formatDateTime, formatNumber, getLanguage, getLocale, getTextDirection, resolveLanguage } from "../../src/shared/i18n/index.ts";
import { chromeMessageId, defineMessages } from "../../src/shared/i18n/definition.ts";
import coreMessages from "../../src/sidepanel/i18n/messages.ts";
import { tHtml } from "../../src/sidepanel/i18n/index.ts";
import capabilities from "#capabilities/translations";

function withLanguage(language, run) {
  const chrome = Object.getOwnPropertyDescriptor(globalThis, "chrome");
  Object.defineProperty(globalThis, "chrome", { configurable: true, value: { i18n: { getUILanguage: () => language } } });
  try { return run(); }
  finally { if (chrome) Object.defineProperty(globalThis, "chrome", chrome); else delete globalThis.chrome; }
}

test("Chrome UI language wins, regional languages resolve and unsupported languages fall back to English", () => {
  for (const [input, expected] of [["zh-CN", "zh-CN"], ["zh-HK", "zh-TW"], ["zh-Hant", "zh-TW"], ["en-US", "en"], ["en-GB", "en"], ["fr-FR", "fr"], ["ja-JP", "ja"], ["ko-KR", "ko"], ["pt-BR", "pt-BR"], ["ar-EG", "ar"], ["hi-IN", "hi"], ["pl-PL", "en"], ["invalid_!", "en"]]) {
    withLanguage(input, () => {
      assert.equal(getLanguage(), expected);
      assert.equal(resolveLanguage(getLocale()), expected);
    });
  }
  withLanguage("en-GB", () => assert.equal(getLocale(), "en-GB"));
  withLanguage("fr-FR", () => assert.equal(getLocale(), "fr-FR"));
  withLanguage("pl-PL", () => assert.equal(getLocale(), "en"));
  withLanguage("ar-SA", () => assert.equal(getTextDirection(), "rtl"));
  withLanguage("ja-JP", () => assert.equal(getTextDirection(), "ltr"));
});

test("native language packs preserve parameters and unavailable or mismatched packs fall back to authored text", () => {
  const t = createTranslator(defineMessages("sample", { saved: { "zh-CN": "已保存 {name}", en: "Saved {name}" } }));
  withLanguage("ja-JP", () => {
    const input = '<b>ユーザー {name} $&</b>';
    chrome.i18n.getMessage = key => key === "qz_language" ? "ja" : key === chromeMessageId("sample.saved") ? "{name}を保存しました" : "";
    assert.equal(t("saved", { name: input }), `${input}を保存しました`);
    chrome.i18n.getMessage = key => key === "qz_language" ? "ko" : "잘못된 언어";
    assert.equal(t("saved", { name: input }), `Saved ${input}`);
    chrome.i18n.getMessage = () => { throw new Error("Extension context was invalidated"); };
    assert.equal(t("saved", { name: input }), `Saved ${input}`);
  });
});

test("Chrome message IDs distinguish punctuation, uppercase and literal escapes", () => {
  const keys = ["a-b.save", "a.b-save", "a.save", "a.Save", "a._0053ave", "a.name_", "a.name."];
  const ids = keys.map(chromeMessageId);
  assert.equal(new Set(ids.map(id => id.toLowerCase())).size, keys.length);
  for (const id of ids) assert.match(id, /^[a-z0-9_]+$/);
});

test("catalogs require matching named parameters and substitute once without interpreting user text", () => {
  assert.throws(() => defineMessages("sample", { bad: { "zh-CN": "{count}", en: "{name}" } }), /parameters differ/);
  assert.throws(() => defineMessages("sample", { bad: { "zh-CN": "{name}", en: "{name}", ja: "{count}" } }), /parameters differ/);
  assert.throws(() => defineMessages("../bad", {}), /namespace/);
  const labels = { title: { en: "Open", "zh-CN": "打开" } };
  assert.deepEqual(defineMessages("sample", labels, { historicalLabels: ["title"] }).historicalLabels, ["title"]);
  assert.throws(() => defineMessages("sample", labels, { historicalLabels: ["missing"] }), /Historical labels/);
  assert.throws(() => defineMessages("sample", { title: { en: "Open {name}", "zh-CN": "打开 {name}" } }, { historicalLabels: ["title"] }), /Historical labels/);
  const t = createTranslator(defineMessages("example", { greeting: { "zh-CN": "你好，{name}。{name}", en: "Hello, {name}. {name}" } }));
  const value = '<img src=x onerror=alert(1)>{count}$&中文';
  withLanguage("en", () => assert.equal(t("greeting", { name: value }), `Hello, ${value}. ${value}`));
  withLanguage("zh-CN", () => assert.equal(t("greeting", { name: "用户内容" }), "你好，用户内容。用户内容"));
  withLanguage("en", () => assert.equal(tHtml("tabNamed", { name: '<img title="x">' }), "Tab &lt;img title=&quot;x&quot;&gt;"));
});

test("dates and numbers use the supported browser locale without changing persisted values", () => {
  withLanguage("en-GB", () => {
    assert.equal(formatNumber(12345.5), "12,345.5");
    assert.equal(formatDateTime(Date.UTC(2026, 8, 19), { timeZone: "UTC", dateStyle: "medium" }), "19 Sept 2026");
  });
  withLanguage("zh-CN", () => assert.match(formatDateTime(Date.UTC(2026, 8, 19), { timeZone: "UTC", dateStyle: "long" }), /2026年9月19日/));
});

test("every shipped HTML marker resolves to a complete package-owned catalog", () => {
  const catalogs = new Map();
  for (const catalog of [coreMessages, ...capabilities]) {
    assert.ok(!catalogs.has(catalog.namespace), `Duplicate namespace: ${catalog.namespace}`);
    catalogs.set(catalog.namespace, catalog);
    for (const [key, value] of Object.entries(catalog.messages)) {
      assert.equal(typeof value.en, "string", `${catalog.namespace}.${key}: English`);
      assert.equal(typeof value["zh-CN"], "string", `${catalog.namespace}.${key}: Chinese`);
    }
  }
  const files = [];
  const walk = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (path.endsWith(".html")) files.push(path);
    }
  };
  walk(resolve("src/sidepanel")); walk(resolve("src/capabilities"));
  let markers = 0;
  for (const file of files) for (const [, key] of readFileSync(file, "utf8").matchAll(/\bdata-i18n(?:-[\w-]+)?="([^"]+)"/g)) {
    const [namespace, ...parts] = key.split(".");
    assert.ok(catalogs.get(namespace)?.messages[parts.join(".")], `${file}: unknown translation ${key}`);
    markers++;
  }
  assert.ok(markers > 200, "The real UI templates participate in localization");
});

test("Chrome manifest translations ship complete default and Chinese messages", () => {
  const manifest = JSON.parse(readFileSync("src/manifest.json", "utf8"));
  assert.equal(manifest.default_locale, "en");
  const keys = [...JSON.stringify(manifest).matchAll(/__MSG_(\w+)__/g)].map(match => match[1]);
  assert.ok(keys.includes("extensionName"));
  for (const language of ["en", "zh_CN", "zh_TW"]) {
    const messages = JSON.parse(readFileSync(`src/_locales/${language}/messages.json`, "utf8"));
    for (const key of keys) assert.ok(messages[key]?.message, `${language}: ${key}`);
  }
});
