import { expect, test } from "./fixtures.mjs";

test("provider error cards show diagnostic details within a bounded summary", async ({ page }) => {
  await page.goto("/tests/tool-timeline/visual-test.html", { waitUntil: "networkidle" });

  const card = await page.evaluate(async () => {
    const { renderAssistantContentHtml } = await import("/extension/sidepanel/features/chat/markdown-feature.js");
    const host = document.createElement("div");
    const providerMessage = `provider diagnostic ${"x".repeat(650)} root-cause-tail`;
    host.innerHTML = renderAssistantContentHtml(
      `❌ LLM 调用失败: 模型服务未能完成本次响应（LLM_PROVIDER_RESPONSE_ERROR）。\n${providerMessage}`,
    );
    document.body.appendChild(host);
    return {
      title: host.querySelector(".chat-error-title")?.textContent || "",
      summary: host.querySelector(".chat-error-summary")?.textContent || "",
    };
  });

  expect(card.title).toBe("未能继续执行");
  expect(card.summary).toContain("LLM_PROVIDER_RESPONSE_ERROR");
  expect(card.summary).toContain("provider diagnostic");
  expect(card.summary).not.toContain("root-cause-tail");
  expect(card.summary.length).toBe(600);
});
