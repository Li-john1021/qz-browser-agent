import { expect, test } from "./sidepanel-fixtures.mjs";

const SETTING = Object.freeze({
  id: "warehouse-query::example-warehouse",
  pluginId: "example-warehouse",
  pluginName: "示例数据仓库",
  skillName: "warehouse-query",
  skillDisplayName: "数据仓库查询",
  title: "数据仓库查询",
  description: "连接示例数据服务，并由 Skill 在内部运行环境中执行查询。",
  configured: true,
  missing: [],
  updatedAt: "2026-07-17T00:00:00.000Z",
  layout: {
    sections: [
      { title: "连接目标", description: "Skill 只在这个项目内执行请求。", fields: ["endpoint", "project"] },
      { title: "访问凭证", description: "AK 明文展示，SK 由密码框遮罩。", fields: ["accessId", "secretAccessKey", "securityToken"] },
      { title: "写操作", description: "", fields: ["allowWrites"] },
    ],
  },
  fields: [
    { key: "endpoint", type: "url", label: "Endpoint", required: true, value: "https://warehouse.example.com/api" },
    { key: "project", type: "text", label: "Project", required: true, value: "analytics_dev" },
    { key: "accessId", type: "text", label: "AccessKey ID", required: true, value: "example-access-id" },
    { key: "secretAccessKey", type: "secret", label: "AccessKey Secret", required: true, hasValue: true, value: "test-secret-value" },
    { key: "securityToken", type: "secret", label: "Security Token（STS 可选）", hasValue: true, value: "test-security-token" },
    { key: "allowWrites", type: "boolean", label: "允许 DDL / DML 与取消任务", description: "仍需每次工具调用显式确认；默认关闭。", value: false },
  ],
});

const SECOND_SETTING = Object.freeze({
  ...SETTING,
  id: "example-tools::example-search",
  pluginId: "example-tools",
  pluginName: "示例工具",
  skillName: "example-search",
  skillDisplayName: "示例搜索",
  title: "示例搜索",
  description: "配置示例搜索服务。",
  configured: false,
  missing: ["endpoint", "accessId"],
  layout: undefined,
  fields: [
    { key: "endpoint", type: "url", label: "Endpoint", required: true, value: "" },
    { key: "accessId", type: "text", label: "AccessKey ID", required: true, value: "" },
  ],
});

test.describe("advanced model settings", () => {
  test.use({ colorScheme: "light", viewport: { width: 430, height: 900 } });

  test("defaults request limiting off and saves an explicit opt-in through the shared settings action", async ({ page }) => {
    await page.locator("#btn-settings").click();
    await page.evaluate(() => window.__qzEmitPortMessage({
      type: "config",
      config: {
        provider: "bailian",
        providerLabel: "百炼",
        apiKey: "test-key",
        model: "deepseek-v4-flash",
        contextWindow: 1000000,
        trimOldToolResults: true,
        vision: false,
        debugMode: false,
        activePresetId: "",
        presets: [],
        providerApiKeys: { bailian: "test-key" },
        securityGuardrails: { rules: [], siteOpenRateLimits: [], order: [] },
      },
    }));
    await page.locator("#settings-tab-advanced").click();

    const requestRateLimit = page.locator("#cfg-request-rate-limit");
    await expect(page.locator("label.settings-toggle-row", { has: requestRateLimit }).locator(".advanced-setting-title"))
      .toHaveText("模型限速");
    await expect(requestRateLimit).not.toBeChecked();
    await expect(page.locator("#btn-save-settings")).toBeDisabled();

    await requestRateLimit.check();
    await expect(page.locator("#settings-save-status")).toHaveText("有未保存修改");
    await expect(page.locator("#btn-save-settings")).toBeEnabled();
    await page.locator("#btn-save-settings").click();

    const save = await latestRequest(page, "save_config");
    expect(save.config.requestRateLimit).toBe(true);
    await emitResponse(page, save, "config_saved", {
      config: { ...save.config, contextWindow: 1000000, providerLabel: "百炼", requestRateLimit: true, presets: [] },
    });
    await expect(page.locator("#settings-panel")).toBeVisible();
    await expect(page.locator("#settings-save-status")).toHaveText("已保存");
    await expect(page.locator("#btn-save-settings")).toBeDisabled();
  });

  test("shows only Codex request-supported reasoning values and defaults to medium", async ({ page }) => {
    await page.locator("#btn-settings").click();
    await page.evaluate(async () => {
      // Read the built module in the browser; Node's test collector must not transpile the background graph.
      const { listProviderSummaries } = await import("/extension/background/llm/provider-catalog.js");
      window.__qzEmitPortMessage({
        type: "config",
        config: {
          providers: listProviderSummaries(),
          provider: "openaicodex",
          providerLabel: "OpenAI Codex",
          apiKey: "",
          model: "gpt-5.6-sol",
          codexReasoningEffort: "",
          contextWindow: 272000,
          trimOldToolResults: true,
          vision: true,
          debugMode: false,
          activePresetId: "",
          presets: [],
          providerApiKeys: {},
          providerAuth: { openaicodex: { loggedIn: true } },
          securityGuardrails: { rules: [], siteOpenRateLimits: [], order: [] },
        },
      });
    });

    const reasoning = page.locator("#cfg-provider-option-codexReasoningEffort");
    await expect(reasoning).toBeVisible();
    await expect(reasoning).toHaveValue("medium");
    await expect(reasoning.locator("option")).toHaveText([
      "Low",
      "Medium",
      "High",
      "Extra High",
      "Max",
    ]);
    await expect(reasoning.locator('option[value="ultra"]')).toHaveCount(0);
  });
});

for (const colorScheme of ["light", "dark"]) {
  test.describe(`manifest-driven Skill settings · ${colorScheme}`, () => {
    test.use({ colorScheme, viewport: { width: 430, height: 900 } });

    test("renders the generic V2 section layout", async ({ page }, testInfo) => {
      await openSkillSettings(page, [SETTING]);

      const card = page.locator('[data-skill-settings-id="warehouse-query::example-warehouse"]');
      await expect(card).toBeVisible();
      await expect(card.locator(".skill-settings-title")).toHaveText("数据仓库查询");
      await expect(card.locator(".skill-settings-source")).toHaveCount(0);
      await expect(card.locator(".skill-settings-state")).toHaveCount(0);
      await expect(page.locator("#settings-save-state")).toBeVisible();
      await expect(page.locator("#btn-save-settings")).toHaveText("保存");
      await expect(page.locator("#btn-save-settings")).toBeDisabled();

      const sections = card.locator(".skill-settings-section");
      await expect(sections).toHaveCount(3);
      await expect(card.locator(".skill-settings-section-title")).toHaveText(["连接目标", "访问凭证", "写操作"]);
      await expect(sections.nth(0).locator("[data-skill-setting-field]")).toHaveCount(2);
      await expect(sections.nth(1).locator("[data-skill-setting-field]")).toHaveCount(3);
      await expect(sections.nth(2).locator("[data-skill-setting-field]")).toHaveCount(1);
      await expect(card.locator(".skill-settings-grid--ungrouped")).toHaveCount(0);

      const accessId = card.locator('[data-skill-setting-field="accessId"]');
      const accessKey = card.locator('[data-skill-setting-field="secretAccessKey"]');
      await expect(card.locator('[data-skill-setting-field="endpoint"]')).toHaveValue("https://warehouse.example.com/api");
      await expect(accessId).toHaveAttribute("type", "text");
      await expect(accessId).toHaveValue("example-access-id");
      await expect(accessKey).toHaveAttribute("type", "password");
      await expect(accessKey).toHaveValue("test-secret-value");
      await expect(card).not.toContainText("签名版本");
      await expect(card.locator(".skill-settings-clear-secret")).toHaveCount(0);
      await expect(card.locator("[data-skill-settings-delete]")).toHaveCount(0);
      await expect(card.locator("[data-skill-settings-save]")).toHaveCount(0);
      await expect(card.locator(".skill-settings-card-actions")).toHaveCount(0);

      const layout = await card.evaluate((element) => {
        const panel = document.querySelector("#settings-panel-skills");
        const tabs = document.querySelector(".settings-tabs");
        const tabsRect = tabs.getBoundingClientRect();
        const cardRect = element.getBoundingClientRect();
        const cardStyle = getComputedStyle(element);
        const saveStateStyle = getComputedStyle(document.querySelector("#settings-save-state"));
        return {
          cardOverflow: element.scrollWidth - element.clientWidth,
          panelOverflow: panel.scrollWidth - panel.clientWidth,
          leftDelta: Math.abs(cardRect.left - tabsRect.left),
          rightDelta: Math.abs(cardRect.right - tabsRect.right),
          radius: cardStyle.borderRadius,
          borderStyle: cardStyle.borderTopStyle,
          manifestFields: element.querySelectorAll("[data-skill-setting-field]").length,
          sectionCount: element.querySelectorAll(".skill-settings-section").length,
          saveStateBackground: saveStateStyle.backgroundColor,
          saveStateBackdropFilter: saveStateStyle.backdropFilter,
        };
      });
      expect(layout.cardOverflow).toBeLessThanOrEqual(1);
      expect(layout.panelOverflow).toBeLessThanOrEqual(1);
      expect(layout.leftDelta).toBeLessThanOrEqual(1);
      expect(layout.rightDelta).toBeLessThanOrEqual(1);
      expect(layout.radius).not.toBe("0px");
      expect(layout.borderStyle).toBe("solid");
      expect(layout.manifestFields).toBe(6);
      expect(layout.sectionCount).toBe(3);
      expect(layout.saveStateBackground).not.toBe("rgba(0, 0, 0, 0)");
      expect(layout.saveStateBackdropFilter).toBe("none");

      await card.locator('[data-skill-setting-field="project"]').fill("analytics_next");
      await accessKey.fill("new-secret-value");
      await expect(page.locator("#settings-save-status")).toHaveText("有未保存修改");
      await expect(page.locator("#btn-save-settings")).toBeEnabled();
      await page.locator("#btn-save-settings").click();
      const save = await latestRequest(page, "save_skill_settings");
      expect(save.pluginId).toBe("example-warehouse");
      expect(save.skillName).toBe("warehouse-query");
      expect(save.values.project).toBe("analytics_next");
      expect(save.values.accessId).toBe("example-access-id");
      expect(save.values.secretAccessKey).toBe("new-secret-value");
      expect(save.values.securityToken).toBe("test-security-token");
      expect(Object.hasOwn(save, "clearSecrets")).toBe(false);

      await emitResponse(page, save, "skill_settings_saved", {
        setting: {
          ...SETTING,
          fields: SETTING.fields.map(field => (
            field.key === "project"
              ? { ...field, value: "analytics_next" }
              : field.key === "secretAccessKey"
                ? { ...field, value: "new-secret-value" }
                : field
          )),
        },
      });
      await expect(page.locator("#settings-panel")).toBeHidden();

      await page.locator("#btn-settings").click();
      await expect(page.locator("#settings-panel")).toBeVisible();
      await expect(page.locator("#settings-panel-skills")).toBeVisible();
      await expect(card.locator('[data-skill-setting-field="secretAccessKey"]')).toHaveValue("new-secret-value");
      await expect(card.locator('[data-skill-setting-field="project"]')).toHaveValue("analytics_next");
      await expect(page.locator("#settings-save-status")).toHaveText("已保存");
      await expect(page.locator("#btn-save-settings")).toBeDisabled();

      await testInfo.attach(`skill-settings-${colorScheme}.png`, {
        body: await page.screenshot(),
        contentType: "image/png",
      });
    });

    test("keeps fields omitted from layout visible", async ({ page }) => {
      const partiallyGrouped = {
        ...SETTING,
        layout: {
          sections: SETTING.layout.sections.map(section => ({
            ...section,
            fields: section.fields.filter(key => key !== "securityToken"),
          })),
        },
      };
      await openSkillSettings(page, [partiallyGrouped]);

      const card = page.locator('[data-skill-settings-id="warehouse-query::example-warehouse"]');
      await expect(card.locator("[data-skill-setting-field]")).toHaveCount(6);
      const ungrouped = card.locator(".skill-settings-grid--ungrouped");
      await expect(ungrouped).toBeVisible();
      await expect(ungrouped.locator('[data-skill-setting-field="securityToken"]')).toHaveCount(1);
    });
  });
}

test.describe("multiple Skill settings navigation", () => {
  test.use({ colorScheme: "light", viewport: { width: 430, height: 900 } });

  test("hides the Skill tab when no installed Skill declares settings", async ({ page }) => {
    await page.locator("#btn-settings").click();
    await expect(page.locator("#settings-tab-skills")).toBeHidden();
    await respondToRequest(page, "list_skill_settings", "skill_settings", { settings: [] });

    await expect(page.locator("#settings-tab-skills")).toBeHidden();
    await expectSettingsTabs(page, ["model", "advanced"]);
    await page.locator("#settings-tab-model").focus();
    await page.keyboard.press("ArrowRight");
    await expect(page.locator("#settings-tab-advanced")).toHaveAttribute("aria-selected", "true");
    await expect(page.locator("#i18n-language-select")).toBeVisible();
    await expect(page.locator('[data-settings-tab="i18n-language"]')).toHaveCount(0);
    await page.keyboard.press("ArrowRight");
    await expect(page.locator("#settings-tab-model")).toHaveAttribute("aria-selected", "true");
    await expect(page.locator("#settings-panel-model")).toBeVisible();
  });

  test("preserves quotes in manifest and secret values without creating attributes", async ({ page }) => {
    const quotedSetting = {
      ...SECOND_SETTING,
      id: "quoted-skill::quoted-plugin",
      pluginId: "quoted-plugin",
      skillName: "quoted-skill",
      title: 'Quoted "Skill"',
      configured: true,
      missing: [],
      fields: [{
        key: "secret",
        type: "secret",
        label: 'Token "primary"',
        placeholder: 'Paste "token" here',
        required: true,
        value: 'abc" autofocus data-injected="yes',
        hasValue: true,
      }],
    };
    await openSkillSettings(page, [quotedSetting]);

    const input = page.locator('[data-skill-setting-field="secret"]');
    await expect(input).toHaveCount(1);
    await expect(input).toHaveValue('abc" autofocus data-injected="yes');
    await expect(input).toHaveAttribute("placeholder", 'Paste "token" here');
    await expect(input).toHaveAttribute("aria-label", 'Token "primary"');
    await expect(page.locator("[data-injected]")).toHaveCount(0);
    await expect(input).not.toHaveAttribute("autofocus", "");
  });

  test("removes the Skill tab when a registry refresh leaves no configurable Skills", async ({ page }) => {
    await openSkillSettings(page, [SETTING]);
    await page.evaluate(() => window.__qzEmitPortMessage({ type: "plugin_registry_update" }));
    await respondToRequest(page, "list_skill_settings", "skill_settings", { settings: [] });

    await expect(page.locator("#settings-tab-skills")).toBeHidden();
    await expectSettingsTabs(page, ["model", "advanced"]);
    await expect(page.locator("#settings-tab-model")).toHaveAttribute("aria-selected", "true");
    await expect(page.locator("#settings-panel-model")).toBeVisible();
    await expect(page.locator("#settings-save-state")).toBeVisible();
  });

  test("shows an index for multiple Skills and guards a dirty detail form", async ({ page }, testInfo) => {
    await openSkillSettings(page, [SETTING, SECOND_SETTING]);

    const rows = page.locator("[data-skill-settings-open]");
    await expect(rows).toHaveCount(2);
    await expect(page.locator(".skill-settings-card")).toHaveCount(0);
    await expect(page.locator("[data-skill-settings-search]")).toHaveCount(0);
    await expect(page.locator("#settings-save-status")).toHaveText("请选择要配置的 Skill");
    await expect(page.locator("#btn-save-settings")).toBeDisabled();
    await expect(rows.nth(0)).not.toContainText("已配置");
    await expect(rows.nth(1)).toContainText("缺 2 项");
    await testInfo.attach("skill-settings-index-light.png", {
      body: await page.screenshot(),
      contentType: "image/png",
    });

    await rows.nth(0).click();
    const card = page.locator('[data-skill-settings-id="warehouse-query::example-warehouse"]');
    await expect(card).toBeVisible();
    await expect(page.locator(".skill-settings-card")).toHaveCount(1);
    await card.locator('[data-skill-setting-field="project"]').fill("dirty_project");
    await expect(page.locator("#btn-save-settings")).toBeEnabled();
    await page.locator("[data-skill-settings-back]").click();

    const dialog = page.locator("#qz-decision-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.locator("[data-qz-decision-title]")).toHaveText("放弃未保存的修改？");
    await dialog.locator("[data-qz-decision-cancel]").click();
    await expect(dialog).toBeHidden();
    await expect(card).toBeVisible();
    await expect(card.locator('[data-skill-setting-field="project"]')).toHaveValue("dirty_project");

    await page.locator("[data-skill-settings-back]").click();
    await dialog.locator("[data-qz-decision-confirm]").click();
    await expect(rows).toHaveCount(2);
    await expect(page.locator(".skill-settings-card")).toHaveCount(0);
  });

  test("adds search only when the Skill index becomes long", async ({ page }) => {
    const settings = Array.from({ length: 6 }, (_, index) => ({
      ...SECOND_SETTING,
      id: `example-tools::skill-${index + 1}`,
      skillName: `skill-${index + 1}`,
      skillDisplayName: `示例技能 ${index + 1}`,
      title: index === 5 ? "日志分析" : `示例技能 ${index + 1}`,
      description: index === 5 ? "查询并分析服务日志。" : `第 ${index + 1} 个示例 Skill。`,
    }));
    await openSkillSettings(page, settings);

    const search = page.locator("[data-skill-settings-search]");
    await expect(search).toBeVisible();
    await expect(page.locator("[data-skill-settings-open]")).toHaveCount(6);
    await search.fill("日志");
    await expect(page.locator("[data-skill-settings-open]")).toHaveCount(1);
    await expect(page.locator("[data-skill-settings-open]")).toContainText("日志分析");

    await page.evaluate(() => window.__qzEmitPortMessage({ type: "plugin_registry_update" }));
    await respondToRequest(page, "list_skill_settings", "skill_settings", { settings: settings.slice(0, 2) });
    await expect(page.locator("[data-skill-settings-search]")).toHaveCount(0);
    await expect(page.locator("[data-skill-settings-open]")).toHaveCount(2);
  });
});

async function openSkillSettings(page, settings) {
  await page.locator("#btn-settings").click();
  await expect(page.locator("#settings-tab-skills")).toBeHidden();
  await respondToRequest(page, "list_skill_settings", "skill_settings", { settings });
  await expect(page.locator("#settings-tab-skills")).toBeVisible();
  await expectSettingsTabs(page, ["model", "skills", "advanced"]);
  await page.locator("#settings-tab-skills").click();
}

async function expectSettingsTabs(page, ids) {
  await expect(page.locator(".settings-tabs")).toHaveAttribute("data-tab-count", String(ids.length));
  const tabs = page.locator("[data-settings-tab]:visible");
  await expect(tabs).toHaveCount(ids.length);
  await expect.poll(() => tabs.evaluateAll(buttons => buttons.map(button => button.dataset.settingsTab))).toEqual(ids);
}

async function respondToRequest(page, requestType, responseType, payload) {
  const request = await latestRequest(page, requestType);
  await emitResponse(page, request, responseType, payload);
  return request;
}

async function latestRequest(page, type) {
  const handle = await page.waitForFunction((requestType) => (
    [...window.__qzPostedMessages].reverse().find(message => message?.type === requestType && message.requestId)
  ), type);
  return await handle.jsonValue();
}

async function emitResponse(page, request, type, payload) {
  await page.evaluate(({ requestId, responseType, responsePayload }) => {
    window.__qzEmitPortMessage({ type: responseType, requestId, ...responsePayload });
  }, { requestId: request.requestId, responseType: type, responsePayload: payload });
}
