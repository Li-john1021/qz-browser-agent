import { expect, test } from "./fixtures.mjs";
import { installBenchmarkChromeStub } from "./benchmark-chrome-stub.mjs";

for (const language of ["zh-CN", "en-US"]) {
  for (const colorScheme of ["light", "dark"]) {
    test.describe(`settings and skills · ${language} · ${colorScheme}`, () => {
      test.use({ locale: language, colorScheme, viewport: { width: 430, height: 900 } });
      test("localizes static templates, dynamic controls, and skill summaries without changing user content", async ({ page }) => {
        const english = language === "en-US";
        await page.addInitScript(installBenchmarkChromeStub, {
          uiLanguage: language,
          config: { provider: "custom", model: "用户模型", apiKey: "test-key", customEndpoint: "https://example.test/v1/chat/completions", contextWindow: 128000, vision: false },
          localStorage: { _skills: { personal: {
            name: "personal", displayName: "用户技能", description: "用户描述保持原样", content: "# 用户正文\n这是用户的内容。", scope: "global", status: "active", resources: [], updatedAt: "2026-09-20 12:00:00",
          } } },
        });
        await page.goto("/extension/sidepanel/sidepanel.html", { waitUntil: "domcontentloaded" });
        await page.waitForFunction(() => Boolean(window.qingzhouConversationBenchmark));
        await page.locator("#btn-settings").click();
        await expect(page.locator("#btn-save-settings")).toHaveText(english ? "Save" : "保存配置");
        await expect(page.locator('#model-preset-switcher [data-i18n="core.close"]')).toHaveText(english ? "Close" : "关闭");
        await expect(page.locator("#btn-provider-logout")).toHaveText(english ? "Sign out" : "退出登录");
        await expect(page.locator('[data-i18n="settings.currentPreset"]')).toHaveText(english ? "Preset" : "当前");
        await expect(page.locator("#cfg-model-parameters-label")).toHaveText(english ? "Custom parameters" : "自定义参数");
        await expect(page.locator("#cfg-context-preset")).toHaveAttribute("aria-label", english ? "Context window" : "上下文长度");
        await expect(page.locator("#cfg-model")).toHaveValue("用户模型");
        await page.locator("#btn-add-model-parameter").click();
        await expect(page.locator('[data-model-parameter-field="key"]').last()).toHaveAttribute("aria-label", english ? "Parameter name" : "参数名称");
        await expect(page.locator('[data-model-parameter-field="key"]').last()).toHaveAttribute("placeholder", english ? "Parameter name" : "参数名称");
        await expect(page.locator('[data-model-parameter-field="value"]').last()).toHaveAttribute("placeholder", english ? "Parameter value" : "参数值");
        await page.locator("#btn-close-settings").click();
        await page.locator('[data-tab="skills"]').click();
        await expect(page.locator("#skills-search")).toHaveAttribute("placeholder", english ? "Search skills..." : "搜索技能...");
        const skill = page.locator('.skill-card[data-name="personal"]');
        await expect(skill.locator(".skill-card-name")).toHaveText("用户技能");
        await expect(skill.locator(".skill-card-desc")).toHaveText("用户描述保持原样");
        await skill.click();
        await expect(page.locator("#skill-detail-content")).toContainText("这是用户的内容。");
        await expect(page.locator("#btn-add-skill-resource")).toHaveAttribute("title", english ? "Add resource" : "添加资源");
        const result = await page.evaluate(async () => {
          const { settingsTargetSummary } = await import("/extension/capabilities/settings/presentation.js");
          const { appendDeleteSkillProfile } = await import("/extension/capabilities/skills/profile.js");
          const container = document.createElement("div");
          appendDeleteSkillProfile(container, { name: "用户技能" }, { deleted: true, name: "用户技能" });
          return { summary: settingsTargetSummary({ action: "update_config", requestRateLimit: true }), result: container.textContent };
        });
        expect(result.summary).toBe(english ? "Request rate limiting enabled" : "请求限速开启");
        expect(result.result).toContain(english ? "Skill deleted" : "已删除 skill");
        expect(result.result).toContain("用户技能");

        const attributes = await page.evaluate(async () => {
          const { createGitSkillSourcesPanel } = await import("/extension/capabilities/skills/workspace/git-skill-sources-panel.js");
          const root = document.createElement("div");
          root.innerHTML = '<section id="git-skill-sources-panel"><div id="git-skill-sources-list"></div></section>';
          const name = '用户" onfocus="window.pwned=true';
          const source = { id: "source", name, subpath: name, repositoryUrl: "https://example.test/repo", host: "example.test", namespace: "user", skillNames: [] };
          const panel = createGitSkillSourcesPanel({ root, request: async () => ({ sources: [source] }) });
          await panel.open();
          return {
            check: root.querySelector('[data-git-source-action="check"]').getAttribute("aria-label"),
            remove: root.querySelector('[data-git-source-action="remove"]').getAttribute("aria-label"),
            directory: root.querySelector(".git-skill-source-subpath").getAttribute("title"),
            injected: root.querySelectorAll("[onfocus]").length,
          };
        });
        const sourceName = '用户" onfocus="window.pwned=true';
        expect(attributes.check).toBe(english ? `Check ${sourceName} for updates` : `检查 ${sourceName} 更新`);
        expect(attributes.remove).toBe(english ? `Unlink ${sourceName}` : `解除 ${sourceName} 绑定`);
        expect(attributes.directory).toBe(english ? `Folder: ${sourceName}` : `目录 ${sourceName}`);
        expect(attributes.injected).toBe(0);
      });
    });
  }
}

for (const scenario of [
  { name: "navigator fallback uses English for unsupported Polish", locale: "pl-PL", uiLanguage: null, english: true },
  { name: "Chrome UI language takes priority over navigator", locale: "en-US", uiLanguage: "zh-CN", english: false },
]) {
  test.describe(scenario.name, () => {
    test.use({ locale: scenario.locale });
    test("localizes workspace startup and capability templates", async ({ page }) => {
      await page.addInitScript(installBenchmarkChromeStub, {
        uiLanguage: scenario.uiLanguage,
        config: { provider: "custom", model: "test-model", apiKey: "test-key", customEndpoint: "https://example.test/v1/chat/completions", contextWindow: 128000 },
      });
      if (!scenario.uiLanguage) await page.addInitScript(() => { delete window.chrome.i18n; });
      await page.goto("/extension/sidepanel/sidepanel.html", { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => Boolean(window.qingzhouConversationBenchmark));
      await expect(page.locator("#btn-settings")).toHaveAttribute("title", scenario.english ? "Settings" : "设置");
      await page.locator("#btn-settings").click();
      await expect(page.locator("#cfg-model-parameters-label")).toHaveText(scenario.english ? "Custom parameters" : "自定义参数");
      await expect(page.locator("#cfg-context-preset")).toHaveAttribute("aria-label", scenario.english ? "Context window" : "上下文长度");
    });
  });
}
