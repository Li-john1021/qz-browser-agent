import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import settingsMessages from "../../src/capabilities/settings/messages.js";
import skillsMessages from "../../src/capabilities/skills/messages.js";
import coreMessages from "../../src/sidepanel/i18n/messages.js";
import { t as settingsText } from "../../src/capabilities/settings/i18n.js";
import { t as skillsText } from "../../src/capabilities/skills/i18n.js";
import { settingsTargetSummary, settingsGuardrailActionLabel } from "../../src/capabilities/settings/presentation.js";
import { formatSkillArgsPreview } from "../../src/capabilities/skills/presentation.js";

function inLanguage(language, run) {
  const original = Object.getOwnPropertyDescriptor(globalThis, "chrome");
  Object.defineProperty(globalThis, "chrome", { configurable: true, value: { i18n: { getUILanguage: () => language } } });
  try { return run(); }
  finally {
    if (original) Object.defineProperty(globalThis, "chrome", original);
    else delete globalThis.chrome;
  }
}

test("settings and skill summaries localize owned copy and preserve user arguments", () => {
  const name = '用户数据 <img src=x onerror=alert(1)> {count}';
  for (const [language, provider, block, characters] of [
    ["zh-CN", "服务商", "阻止", "3 字符"],
    ["en-US", "Provider:", "Block", "Characters: 3"],
  ]) inLanguage(language, () => {
    assert.equal(settingsTargetSummary({ action: "list_models", provider: name }), `${provider} ${name}`);
    assert.equal(settingsGuardrailActionLabel("block"), block);
    assert.equal(settingsText("deletePresetConfirmation", { name }), language === "zh-CN" ? `删除「${name}」？` : `Delete “${name}”?`);
    assert.equal(skillsText("skillNotFound", { name }), language === "zh-CN" ? `未找到技能“${name}”` : `Skill "${name}" not found`);
    assert.ok(formatSkillArgsPreview({ name: "keep-user-name", content: "abc" }, null, "", "create_skill").includes(characters));
  });
});

test("every static package localization marker resolves in both languages", () => {
  for (const catalog of [settingsMessages, skillsMessages]) {
    const html = readFileSync(new URL(`../../src/capabilities/${catalog.namespace}/ui.html`, import.meta.url), "utf8");
    const keys = [...html.matchAll(/data-i18n(?:-[\w-]+)?="([^"]+)"/g)].map(match => match[1]);
    assert.ok(keys.length > 50, `${catalog.namespace} templates expose their localizable UI`);
    for (const qualified of keys) {
      const owner = qualified.startsWith("core.") ? coreMessages : catalog;
      assert.ok(qualified.startsWith(`${owner.namespace}.`));
      const key = qualified.slice(owner.namespace.length + 1);
      const message = owner.messages[key];
      assert.ok(message, `Unknown template message: ${qualified}`);
      assert.ok(message["zh-CN"] && message.en, qualified);
      assert.doesNotMatch(message.en, /\p{Script=Han}/u, qualified);
    }
  }
});

test("closing the model switcher and signing out retain distinct meanings", () => {
  const html = readFileSync(new URL("../../src/capabilities/settings/ui.html", import.meta.url), "utf8");
  assert.match(html, /<kbd>Esc<\/kbd>\s*<span data-i18n="core\.close">/);
  assert.match(html, /<button[^>]+id="btn-provider-logout"[^>]+data-i18n="settings\.signOut"/);
  assert.equal(coreMessages.messages.close.en, "Close");
  assert.equal(settingsMessages.messages.signOut.en, "Sign out");
  assert.equal(settingsMessages.messages.signOut["zh-CN"], "退出登录");
});

test("Hindi save buttons use the same action throughout the workspace", () => {
  const owners = { core: ["save", "saveSettings"], data: ["save"], sessions: ["save"], settings: ["save", "saveConfiguration"], skills: ["save"] };
  for (const [namespace, keys] of Object.entries(owners)) {
    const catalog = JSON.parse(readFileSync(new URL(`../../src/capabilities/i18n/locales/hi/${namespace}.json`, import.meta.url), "utf8"));
    for (const key of keys) assert.equal(catalog[`${namespace}.${key}`], "सेव करें", `${namespace}.${key}`);
  }
});

test("translated repository confirmations interpolate names exactly once", () => {
  inLanguage("en", () => {
    const names = '用户技能 {count} <script>alert("x")</script>';
    const text = skillsText("containLocalModificationsContinuingToWillOverwriteThemWithThe", { names, more: "", action: "Update" });
    assert.ok(text.includes(names));
    assert.ok(text.includes("Local changes"));
    assert.ok(text.startsWith("Update these skills?"));
  });
});
