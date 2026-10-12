import { expect, test } from "./fixtures.mjs";

test("capability registration preserves failed Plugin inputs and unknown-renderer fallback", async ({ page }) => {
  await page.goto("/__test_health");
  const results = await page.evaluate(async () => {
    const { renderToolEvent, disposeRendererTree } = await import("/extension/sidepanel/tools/tool-renderer.js");
    const { setSkillToolUiCatalog } = await import("/extension/sidepanel/tools/skill-tool-ui-registry.js");
    setSkillToolUiCatalog({ plugins: [{ id: "error-input-fixture", name: "Fixture", tools: [{
      name: "error_input_fixture__request", title: "Request", runtime: "page",
      renderer: { type: "text", source: "args", valuePath: "note", title: "输入说明" },
    }] }] });
    const cases = [
      { id: "registered", rendererId: "", profileFamily: "", inputs: true },
      { id: "unavailable", rendererId: "uninstalled-renderer", profileFamily: "", inputs: true },
      { id: "explicit-profile", rendererId: "plugin", profileFamily: "plugin", inputs: false },
    ];
    return cases.flatMap(({ id, inputs, ...identity }) => [false, true].map(staticOutput => {
      const root = renderToolEvent({
        name: "error_input_fixture__request", ...identity,
        args: { note: "保留的输入正文" }, result: { ok: false, error: "fixture request rejected" }, isError: true,
      }, { expanded: true, lazyDetails: false, static: staticOutput });
      document.body.replaceChildren(root);
      const rendered = {
        id, staticOutput, inputs,
        inputText: root.querySelector(".tool-text-preview")?.textContent || "",
        text: root.querySelector(".tool-details").textContent,
        fallbacks: root.querySelectorAll(".tool-renderer-fallback").length,
      };
      disposeRendererTree(root);
      return rendered;
    }));
  });
  for (const result of results) {
    expect(result.text, `${result.id} static=${result.staticOutput}`).toContain("工具调用失败");
    expect(result.text).toContain("保留的输入正文");
    expect(result.inputText.includes("保留的输入正文"), result.id).toBe(result.inputs);
    expect(result.fallbacks).toBe(0);
  }
});
