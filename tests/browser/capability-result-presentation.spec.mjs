import { expect, test } from "./fixtures.mjs";

test("script owns code context and outer-error diagnostics in both live and exported rendering", async ({ page }) => {
  await page.goto("/__test_health");
  const results = await page.evaluate(async () => {
    const { renderToolEvent, disposeRendererTree } = await import("/extension/sidepanel/tools/tool-renderer.js");
    const examples = [];
    for (const staticOutput of [false, true]) {
      const root = renderToolEvent({
        name: "run_script", args: { code: "throw new Error('failure');", target: "inner" },
        result: { ok: false, error: "外层执行失败", result: { error: "内层业务数据" }, trace: [{ message: "before failure", level: "debug" }] },
      }, { expanded: true, static: staticOutput });
      document.body.append(root);
      const details = root.querySelector(".tool-details");
      const text = details.textContent;
      examples.push({ staticOutput, codeBlocks: details.querySelectorAll(".js-code-block").length,
        codeBeforeError: text.indexOf("运行代码") < text.indexOf("外层执行失败"),
        error: details.querySelector(".tool-error-section")?.textContent || text,
        trace: Boolean(details.querySelector(".tool-script-trace")),
      });
      disposeRendererTree(root); root.remove();
    }
    return examples;
  });
  for (const result of results) {
    expect(result.codeBlocks).toBe(1);
    expect(result.codeBeforeError, JSON.stringify(results)).toBe(true);
    expect(result.error).toContain("外层执行失败");
    expect(result.trace).toBe(true);
    expect(result.error).not.toContain("内层业务数据");
  }
});
