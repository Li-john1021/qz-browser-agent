import { expect, test } from "./fixtures.mjs";

test.describe("streaming code highlighting", () => {
  test.use({ viewport: { width: 430, height: 844 } });

  test("reuses one-language snapshots and finalizes with the shared highlighter", async ({ page }) => {
    await page.goto("/tests/tool-timeline/visual-test.html", { waitUntil: "networkidle" });

    const result = await page.evaluate(async () => {
      const { renderAssistantContentHtml } = await import("/extension/sidepanel/features/chat/markdown-feature.js");
      const { hljs } = await import("/extension/sidepanel/ui/highlight-config.js");
      const originalHighlight = hljs.highlight;
      const originalHighlightAuto = hljs.highlightAuto;
      let highlightCalls = 0;
      let highlightAutoCalls = 0;
      hljs.highlight = (...args) => {
        highlightCalls += 1;
        return originalHighlight(...args);
      };
      if (originalHighlightAuto) {
        hljs.highlightAuto = (...args) => {
          highlightAutoCalls += 1;
          return originalHighlightAuto(...args);
        };
      }

      try {
        const scope = {};
        const first = renderAssistantContentHtml("```js\nconst answer\n```", {
          math: "stream",
          highlightScope: scope,
        });
        const second = renderAssistantContentHtml("```js\nconst answer = <42>\n```", {
          math: "stream",
          highlightScope: scope,
        });
        const final = renderAssistantContentHtml("```js\nconst answer = <42>;\n```", {
          math: true,
          highlightScope: scope,
        });

        const host = document.createElement("div");
        host.innerHTML = final;
        document.body.appendChild(host);
        const code = host.querySelector(".markdown-code-block code");
        const snapshot = {
          highlightCalls,
          highlightAutoCalls,
          firstHasSyntax: /hljs-keyword/.test(first),
          secondHasEscapedTail: second.includes("&lt;42&gt;"),
          finalText: code?.textContent || "",
          finalLanguage: code?.classList.contains("language-javascript") || false,
          finalSyntaxSpanCount: code?.querySelectorAll("[class^='hljs-']").length || 0,
        };
        host.remove();
        return snapshot;
      } finally {
        hljs.highlight = originalHighlight;
        if (originalHighlightAuto) hljs.highlightAuto = originalHighlightAuto;
      }
    });

    expect(result.highlightAutoCalls).toBe(0);
    expect(result.highlightCalls).toBe(2);
    expect(result.firstHasSyntax).toBe(true);
    expect(result.secondHasEscapedTail).toBe(true);
    expect(result.finalText).toBe("const answer = <42>;\n");
    expect(result.finalLanguage).toBe(true);
    expect(result.finalSyntaxSpanCount).toBeGreaterThan(0);
  });
});
