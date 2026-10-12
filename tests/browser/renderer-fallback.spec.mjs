import { expect, test } from "./fixtures.mjs";

const compactCases = [
  { name: "get_working_tab", args: {}, result: { id: 17, windowId: 1, active: true, title: "竞品详情", url: "https://example.com/brand/detail" }, expected: "竞品详情" },
  { name: "group_tabs", args: { tabIds: [17, 18, 19], color: "green" }, result: { groupId: 12, tabIds: [17, 18, 19], title: "轻舟任务", color: "green" }, expected: "轻舟任务" },
  { name: "manage_goal", args: { sample: true }, result: { ok: true, message: "目标追踪 已完成", count: 1 }, expected: "目标追踪 已完成" },
  { name: "run_skill_script", args: { sample: true }, result: { ok: true, message: "执行技能脚本 已完成", count: 1 }, expected: "执行技能脚本 已完成" },
  { name: "fallback_test__skill", args: {}, result: { action: "save", saved: true, name: "测试技能", scope: "global", domains: [], urlPatterns: [], resources: [] }, expected: "测试技能" },
];

test.beforeEach(async ({ page }) => {
  await page.goto("/__test_health");
  await page.evaluate(() => document.body.replaceChildren());
  await page.addStyleTag({ url: "/extension/sidepanel/sidepanel.css" });
});

for (const colorScheme of ["light", "dark"]) {
  test(`default and unmatched registered profiles keep compact results in ${colorScheme} skin`, async ({ page }) => {
    await page.emulateMedia({ colorScheme });
    await page.setViewportSize({ width: 360, height: 900 });
    const rendered = await page.evaluate(async cases => {
      const { renderToolEvent, disposeRendererTree } = await import("/extension/sidepanel/tools/tool-renderer.js");
      const { setSkillToolUiCatalog } = await import("/extension/sidepanel/tools/skill-tool-ui-registry.js");
      setSkillToolUiCatalog({ plugins: [{ id: "fallback-test", tools: [{
        name: "fallback_test__skill", title: "Renderer skill", runtime: "page", renderer: { type: "skill", action: "save" },
      }] }] });
      const messages = document.createElement("main"); messages.id = "messages"; document.body.append(messages);
      return cases.map(({ expected, ...tool }) => [false, true].map(staticOutput => {
        const root = renderToolEvent(tool, { expanded: true, lazyDetails: false, static: staticOutput });
        messages.replaceChildren(root);
        const result = {
          name: tool.name, staticOutput, expected,
          text: root.querySelector(".tool-details").textContent,
          chips: root.querySelectorAll(".tool-chip").length,
          fieldCards: root.querySelectorAll(".tool-kv-item").length,
          height: root.getBoundingClientRect().height,
        };
        disposeRendererTree(root);
        return result;
      }));
    }, compactCases);
    for (const [live, exported] of rendered) {
      for (const result of [live, exported]) {
        expect(result.text, result.name).toContain(result.expected);
        expect(result.chips, result.name).toBeGreaterThan(0);
        expect(result.fieldCards, result.name).toBe(0);
        expect(result.height, result.name).toBeLessThan(260);
      }
      expect(exported.height, live.name).toBeCloseTo(live.height, 2);
    }
  });
}

test("generic arrays stay concise while unknown renderer IDs retain shape-based readable fallback", async ({ page }) => {
  const rendered = await page.evaluate(async () => {
    const { renderToolEvent, disposeRendererTree } = await import("/extension/sidepanel/tools/tool-renderer.js");
    const items = Array.from({ length: 15 }, (_, index) => ({ title: `Result ${index + 1}`, url: `https://example.test/${index + 1}` }));
    return [false, true].map(staticOutput => {
      const render = tool => {
        const root = renderToolEvent(tool, { expanded: true, lazyDetails: false, static: staticOutput });
        document.body.append(root);
        const result = {
          text: root.querySelector(".tool-details").textContent,
          slimRows: root.querySelectorAll(".tool-slim-row").length,
          records: root.querySelectorAll(".tool-record-card").length,
          fields: root.querySelectorAll(".tool-kv-item").length,
          tabs: root.querySelectorAll(".tool-tab-list").length,
        };
        disposeRendererTree(root); root.remove();
        return result;
      };
      return {
        generic: render({ name: "custom_result", result: items }),
        unknown: render({ name: "list_tabs", rendererId: "uninstalled-renderer", result: items }),
        unknownObject: render({ name: "data_store", rendererId: "uninstalled-renderer", result: { details: "retained diagnostics", rows: [{ value: 42 }], title: "retained fields" } }),
      };
    });
  });
  for (const { generic, unknown, unknownObject } of rendered) {
    expect(generic.slimRows).toBe(12);
    expect(generic.records).toBe(0);
    expect(generic.text).toContain("前 12 / 15");
    expect(unknown.records).toBe(8);
    expect(unknown.slimRows).toBe(0);
    expect(unknown.tabs).toBe(0);
    expect(unknownObject.fields).toBe(2);
    expect(unknownObject.text).toContain("retained fields");
    expect(unknownObject.text).toContain("42");
  }
});
