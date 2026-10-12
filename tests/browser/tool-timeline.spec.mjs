import { expect, test } from "./fixtures.mjs";

const viewports = {
  desktop: { width: 980, height: 900 },
  mobile: { width: 390, height: 844 },
};

test.describe("read_article Markdown presentation", () => {
  test.use({ viewport: { width: 980, height: 900 } });

  test("renders one safe QZ Markdown surface without a format branch", async ({ page }) => {
    await page.goto("/tests/tool-timeline/visual-test.html", { waitUntil: "networkidle" });
    await page.waitForFunction(() => window.visualTimelineTest?.renderConversationFlow);
    await page.evaluate(() => {
      document.querySelector("#visual-device").style.setProperty("--visual-width", "360px");
      window.visualTimelineTest.renderConversationFlow({
        title: "read_article Markdown",
        entries: [{
          type: "tool",
          id: "article-markdown",
          name: "read_article",
          args: { source: "article", limit: 8000 },
          result: {
            title: "Structured article",
            url: "https://example.com/article",
            text: [
              "## Data",
              "",
              "- **Ready** with [documentation](https://example.com/docs)",
              "",
              "```js",
              "const answer = 42;",
              "```",
              "",
              "| Very long column heading | Another long heading | Third long heading | Fourth long heading |",
              "| --- | --- | --- | --- |",
              "| Alpha with a deliberately wide value | Beta with a deliberately wide value | Gamma with a deliberately wide value | Delta with a deliberately wide value |",
              "",
              "<table onclick=\"window.__articleInjected = true\" style=\"color:red\"><caption>Complex table</caption><tbody><tr><td colspan=\"2\" onmouseover=\"window.__articleInjected = true\">Wide cell</td></tr></tbody></table>",
              "<script>window.__articleInjected = true</script>",
              "<a id=\"unsafe-link\" href=\"javascript:window.__articleInjected = true\">unsafe link</a>",
              "<img id=\"unsafe-image\" src=\"javascript:window.__articleInjected = true\" onerror=\"window.__articleInjected = true\">",
            ].join("\n"),
            totalChars: 1200,
            linkCount: 1,
          },
        }],
      });
    });

    await page.locator(".msg-tool > .tool-summary").click();
    const body = page.locator(".tool-article-body");
    await expect(body).toBeVisible();
    await expect(body.locator("h2")).toHaveText("Data");
    await expect(body.locator("ul strong")).toHaveText("Ready");
    await expect(body.locator('a[href="https://example.com/docs"]')).toHaveText("documentation");
    await expect(body.locator("pre code")).toContainText("const answer = 42;");
    await expect(body.locator("table")).toHaveCount(2);
    await expect(body.locator("caption")).toHaveText("Complex table");
    await expect(body.locator('td[colspan="2"]')).toHaveText("Wide cell");
    await expect(body.locator("script, #unsafe-image, [onclick], [onmouseover], [onerror], [style]")).toHaveCount(0);
    await expect(body.locator("#unsafe-link")).toHaveCount(0);
    await expect(body.getByText("unsafe link")).toBeVisible();

    const layout = await body.evaluate((element) => {
      const device = document.querySelector("#visual-device");
      return {
        whiteSpace: getComputedStyle(element).whiteSpace,
        overflowX: getComputedStyle(element).overflowX,
        articleScrollWidth: element.scrollWidth,
        articleClientWidth: element.clientWidth,
        deviceScrollWidth: device.scrollWidth,
        deviceClientWidth: device.clientWidth,
        injected: Boolean(window.__articleInjected),
      };
    });
    expect(layout.whiteSpace).toBe("normal");
    expect(layout.overflowX).toBe("auto");
    expect(layout.articleScrollWidth).toBeGreaterThan(layout.articleClientWidth);
    expect(layout.deviceScrollWidth).toBeLessThanOrEqual(layout.deviceClientWidth + 1);
    expect(layout.injected).toBe(false);
  });

  test("groups adjacent article images into balanced one, two, and three-column grids", async ({ page }) => {
    await page.goto("/tests/tool-timeline/visual-test.html", { waitUntil: "networkidle" });
    await page.waitForFunction(() => window.visualTimelineTest?.renderConversationFlow);
    await page.evaluate(async () => {
      const { installImageLightbox } = await import("/extension/sidepanel/ui/image-lightbox.js");
      installImageLightbox(document.querySelector("#messages"));
      document.querySelector("#visual-device").style.setProperty("--visual-width", "360px");
      const image = "/tests/fixtures/article-image.svg";
      const icon = "/tests/fixtures/article-badge.svg";
      window.visualTimelineTest.renderConversationFlow({
        title: "read_article image gallery",
        entries: [{
          type: "tool",
          id: "article-image-gallery",
          name: "read_article",
          args: { source: "article", limit: 8000 },
          result: {
            title: "Article gallery",
            url: "https://example.com/gallery",
            text: [
              "## One",
              "",
              `![Single](${image})`,
              "",
              "Pair",
              "",
              `![Pair one](${image}) [![Pair two](${image})](https://example.com/full)`,
              "",
              "More",
              "",
              `![One](${image})`,
              "",
              `![Two](${image})`,
              "",
              `![Three](${image}) ![Four](${image})`,
              "",
              `Text keeps this ![Inline](${image}) image inline.`,
              "",
              "Icon",
              "",
              `![Site icon](${icon})`,
              "",
              "![Legacy avatar](/assets/avatar/user.png)",
            ].join("\n"),
            _display: {
              imageDisplayHints: [{ src: `${icon}?imageView2/2/w/48`, width: 24, height: 24, naturalWidth: 512, naturalHeight: 512 }],
            },
          },
        }],
      });
    });

    await page.locator(".msg-tool > .tool-summary").click();
    const body = page.locator(".tool-article-body");
    const grids = body.locator(".tool-article-media-grid");
    await expect(grids).toHaveCount(3);
    await expect(grids.nth(0)).toHaveAttribute("data-count", "1");
    await expect(grids.nth(1)).toHaveAttribute("data-count", "2");
    await expect(grids.nth(2)).toHaveAttribute("data-count", "3");
    await expect(grids.nth(0).locator(".tool-article-media-item")).toHaveCount(1);
    await expect(grids.nth(1).locator(".tool-article-media-item")).toHaveCount(2);
    await expect(grids.nth(2).locator(".tool-article-media-item")).toHaveCount(4);
    await expect(grids.nth(1).locator('a[href="https://example.com/full"] img')).toHaveCount(1);

    const inline = body.locator('p:has-text("Text keeps this") img[alt="Inline"]');
    await expect(inline).toHaveCount(1);
    await expect(inline.locator("xpath=ancestor::*[contains(@class, 'tool-article-media-grid')]")).toHaveCount(0);

    await expect(body.locator('img[alt="Site icon"]')).toHaveCount(0);
    await expect(body.locator('img[alt="Legacy avatar"]')).toHaveCount(0);

    const layout = await grids.evaluateAll((elements) => elements.map(grid => {
      const cells = [...grid.querySelectorAll(".tool-article-media-item")];
      return {
        columns: getComputedStyle(grid).gridTemplateColumns.split(" ").length,
        width: grid.getBoundingClientRect().width,
        cellHeights: cells.map(cell => cell.getBoundingClientRect().height),
        cellWidths: cells.map(cell => cell.getBoundingClientRect().width),
        cellTops: cells.map(cell => cell.getBoundingClientRect().top),
      };
    }));
    expect(layout[0].columns).toBe(1);
    expect(layout[0].width).toBeLessThanOrEqual(320.5);
    expect(layout[0].cellHeights[0]).toBeLessThanOrEqual(200.5);
    expect(layout[1].columns).toBe(2);
    expect(Math.abs(layout[1].cellWidths[0] - layout[1].cellWidths[1])).toBeLessThan(1);
    expect(layout[2].columns).toBe(3);
    expect(new Set(layout[2].cellTops.slice(0, 3).map(value => Math.round(value))).size).toBe(1);
    expect(layout[2].cellTops[3]).toBeGreaterThan(layout[2].cellTops[0]);

    const lightStyle = await grids.nth(0).locator(".tool-article-media-item").evaluate(element => ({
      background: getComputedStyle(element).backgroundColor,
      border: getComputedStyle(element).borderTopColor,
    }));
    await page.emulateMedia({ colorScheme: "dark" });
    const darkStyle = await grids.nth(0).locator(".tool-article-media-item").evaluate(element => ({
      background: getComputedStyle(element).backgroundColor,
      border: getComputedStyle(element).borderTopColor,
    }));
    expect(darkStyle.background).not.toBe(lightStyle.background);
    expect(darkStyle.border).not.toBe(lightStyle.border);

    await grids.nth(0).locator("img").click();
    await expect(page.locator(".image-lightbox img")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator(".image-lightbox")).toHaveCount(0);
  });
});

test.describe("tool field presentation", () => {
  test.use({ viewport: { width: 980, height: 900 } });

  test("renders the safe Skill settings projection", async ({ page }) => {
    await page.goto("/tests/tool-timeline/visual-test.html", { waitUntil: "networkidle" });
    await page.waitForFunction(() => window.visualTimelineTest?.renderConversationFlow);
    await page.evaluate(() => {
      window.visualTimelineTest.renderConversationFlow({
        title: "Skill settings",
        entries: [{
          type: "tool",
          id: "manage-skill-settings-get",
          name: "manage_skill_settings",
          args: { action: "get", settingId: "warehouse-query::example-warehouse" },
          result: {
            ok: true,
            action: "get",
            setting: {
              id: "warehouse-query::example-warehouse",
              title: "数据仓库查询",
              skillName: "warehouse-query",
              configured: true,
              fields: [
                { key: "project", type: "text", label: "Project", value: "analytics_dev" },
                { key: "allowWrites", type: "boolean", label: "允许写操作", value: false },
                { key: "secretAccessKey", type: "secret", label: "AccessKey Secret", hasValue: true },
              ],
            },
          },
        }],
      });
    });

    await expect(page.locator(".msg-tool > .tool-summary")).toContainText("读取 Skill 配置");
    await page.locator(".msg-tool > .tool-summary").click();
    const details = page.locator(".msg-tool .tool-details");
    await expect(details).toContainText("数据仓库查询");
    await expect(details).toContainText("analytics_dev");
    await expect(details).toContainText("Access Key Secret");
    await expect(details).toContainText("已配置");
    await expect(details).toContainText("关闭");
    await expect(details).not.toContainText("example-secret-value");
  });

  test("shows credential-shaped fields like ordinary tool data", async ({ page }) => {
    await page.goto("/tests/tool-timeline/visual-test.html", { waitUntil: "networkidle" });
    await page.waitForFunction(() => window.visualTimelineTest?.renderConversationFlow);
    await page.evaluate(() => {
      window.visualTimelineTest.renderConversationFlow({
        title: "field presentation",
        entries: [{
          type: "tool",
          id: "settings-secret-presentation",
          name: "manage_settings",
          args: {
            action: "update_config",
            provider: "kimicode",
            model: "kimi-k2-coder",
            apiKey: "sk-browser-secret",
          },
          argsText: JSON.stringify({ action: "update_config", provider: "kimicode", model: "kimi-k2-coder", apiKey: "sk-browser-secret" }),
          result: {
            ok: true,
            action: "update_config",
            saved: true,
            config: {
              provider: "kimicode",
              providerLabel: "KimiCode",
              model: "kimi-k2-coder",
              endpoint: "https://api.kimi.com/coding/v1/messages",
              contextWindow: 262000,
              vision: false,
              hasApiKey: true,
              apiKey: "sk-browser-secret",
              providerApiKeys: { kimicode: "sk-browser-secret" },
            },
            credentials: { authorization: "Bearer browser-secret" },
            nested: { one: { two: { three: { authorization: "Bearer deep-secret", public: "safe" } } } },
          },
        }],
      });
    });

    await page.locator(".msg-tool > .tool-summary").click();
    const details = page.locator(".msg-tool .tool-details");
    await expect(details).toContainText("KimiCode");
    await expect(details).toContainText("AK 已保存");
    await expect(details).toContainText("sk-browser-secret");

    await details.locator(".tool-event-raw-btn").click();
    const rawPanel = details.locator(".tool-event-raw-panel");
    await expect(rawPanel).toBeVisible();
    await expect(rawPanel).toContainText("kimi-k2-coder");
    await expect(rawPanel).toContainText("sk-browser-secret");
    await expect(rawPanel).toContainText("browser-secret");
    await expect(rawPanel).toContainText("deep-secret");
    await expect(rawPanel).toContainText("authorization");
    await expect(rawPanel).toContainText("credentials");
    const rawText = await rawPanel.textContent();
    expect(rawText).toMatch(/"apiKey"\s*:/);
    expect(rawText).toMatch(/"hasApiKey"\s*:\s*true/);
  });
});

test.describe("skill document resource presentation", () => {
  test.use({ viewport: { width: 980, height: 900 } });

  test("reuses the shared table and text surfaces without exposing base64", async ({ page }) => {
    await page.goto("/tests/tool-timeline/visual-test.html", { waitUntil: "networkidle" });
    await page.waitForFunction(() => window.visualTimelineTest?.renderConversationFlow);
    await page.evaluate(() => {
      window.visualTimelineTest.renderConversationFlow({
        title: "Skill workbook resource",
        entries: [{
          type: "tool",
          id: "skill-workbook-resource",
          name: "load_skill_resource",
          args: { name: "office-skill", path: "references/apps.xlsx" },
          result: {
            name: "office-skill",
            path: "references/apps.xlsx",
            type: "asset",
            format: "xlsx",
            size: 2048,
            sheetName: "Apps",
            columns: ["name", "status"],
            rows: [{ name: "Qingzhou", status: "ready" }],
            content: "name\tstatus\nQingzhou\tready",
            truncated: true,
            document: { docModelId: "model_skill_apps", format: "xlsx" },
          },
        }],
      });
    });

    await page.locator(".msg-tool > .tool-summary").click();
    const workbookDetails = page.locator(".msg-tool .tool-details");
    await expect(workbookDetails.locator(".tool-data-table-title")).toHaveText("Apps");
    await expect(workbookDetails.locator(".tool-data-table th")).toContainText(["#", "name", "status"]);
    await expect(workbookDetails.locator(".tool-data-table tbody")).toContainText("Qingzhou");
    await expect(workbookDetails).toContainText("model_skill_apps");
    await expect(workbookDetails.locator(".tool-skill-resource-code")).toHaveCount(0);

    await page.evaluate(() => {
      window.visualTimelineTest.renderConversationFlow({
        title: "Skill PDF resource",
        entries: [{
          type: "tool",
          id: "skill-pdf-resource",
          name: "load_skill_resource",
          args: { name: "office-skill", path: "references/guide.pdf" },
          result: {
            name: "office-skill",
            path: "references/guide.pdf",
            type: "asset",
            format: "pdf",
            size: 1024,
            contentFormat: "markdown",
            content: "# Guide\n\nUse the parsed document model.",
            truncated: false,
            document: { docModelId: "model_skill_guide", format: "pdf" },
          },
        }],
      });
    });

    const pdfDetails = page.locator(".msg-tool .tool-details");
    if (!(await pdfDetails.isVisible())) await page.locator(".msg-tool > .tool-summary").click();
    await expect(pdfDetails.locator(".tool-section-title").filter({ hasText: "文档预览" })).toBeVisible();
    await expect(pdfDetails.locator(".tool-article-body h1")).toHaveText("Guide");
    await expect(pdfDetails.locator(".tool-article-body")).toContainText("Use the parsed document model.");
    await expect(pdfDetails.locator(".tool-skill-resource-code")).toHaveCount(0);
    await expect(pdfDetails).not.toContainText("UEsDB");
  });

  test("renders the new document content projection while preserving table affordances", async ({ page }) => {
    await page.goto("/tests/tool-timeline/visual-test.html", { waitUntil: "networkidle" });
    await page.waitForFunction(() => window.visualTimelineTest?.renderConversationFlow);
    await page.evaluate(() => {
      window.visualTimelineTest.renderConversationFlow({
        title: "Document content projection",
        entries: [{
          type: "tool",
          id: "document-content-projection",
          name: "qingzhou_documents__document_read_chunk",
          args: { docModelId: "model_guide", chunkIndex: 0 },
          result: {
            docModelId: "model_guide",
            type: "docx",
            title: "Guide",
            mode: "content",
            contentFormat: "markdown",
            content: "## Section\n\nA **structured** document chunk.\n\n> Scores (`table:3`, 20 rows).\n\n<img id=\"projection-injected\" src=\"x\">",
            chunk: { index: 0, total: 2, chars: 76 },
            tables: [{ tableId: "table:3", name: "Scores", columns: ["name", "score"], columnCount: 2, totalRows: 20 }],
            next: { chunkIndex: 1 },
          },
        }],
      });
    });

    await page.locator(".msg-tool > .tool-summary").click();
    const details = page.locator(".msg-tool .tool-details");
    await expect(details).toContainText("正文块 1 / 2");
    await expect(details.locator(".tool-article-body h2")).toHaveText("Section");
    await expect(details.locator(".tool-article-body strong")).toHaveText("structured");
    await expect(details.locator("#projection-injected")).toHaveCount(0);
    await expect(details.locator(".tool-slim-list")).toContainText("Scores");
    await expect(details.locator(".tool-slim-list")).toContainText("table:3");
  });
});

for (const [viewportName, viewport] of Object.entries(viewports)) {
  test.describe(`tool timeline · ${viewportName}`, () => {
    test.use({ viewport });

    test("plugin tools aggregate into semantic families", async ({ page }) => {
      await page.goto("/tests/tool-timeline/visual-test.html", { waitUntil: "networkidle" });
      await page.waitForFunction(() => window.visualTimelineTest?.debugPluginToolFamilyGrouping);

      const metrics = await page.evaluate(() => window.visualTimelineTest.debugPluginToolFamilyGrouping());
      const rowTexts = metrics.familyRows.map(item => item.text);
      const batchTexts = metrics.batches.map(item => item.text);

      expect(metrics.timelineCount).toBe(1);
      expect(metrics.rawStepCount).toBe(0);
      expect(metrics.familyRows).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: "plugin:research", text: expect.stringContaining("研究") }),
        expect.objectContaining({ id: "plugin:artifact", text: expect.stringContaining("生成产物") }),
      ]));
      expect(batchTexts.some(text => text.includes("抽取B站搜索结果") && text.includes("×11"))).toBe(true);
      expect(batchTexts.some(text => text.includes("设置B站搜索关键词"))).toBe(true);
      expect(batchTexts.some(text => text.includes("写出 CSV"))).toBe(true);
      expect(rowTexts.join(" ")).toContain("研究");
    });
  });
}

for (const colorScheme of ["light", "dark"]) {
  test.describe(`screen action feedback · ${colorScheme}`, () => {
    test.use({ colorScheme, viewport: { width: 660, height: 720 } });

    test("keeps image pixels clean and projects the action in Chat UI", async ({ page }) => {
      await page.goto("/tests/tool-timeline/visual-test.html", { waitUntil: "networkidle" });
      await page.waitForFunction(() => window.visualTimelineTest?.renderConversationFlow);
      await page.evaluate(async () => {
        const { installImageLightbox } = await import("/extension/sidepanel/ui/image-lightbox.js");
        installImageLightbox(document.querySelector("#messages"));
      });
      const image = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='320' height='180'%3E%3Crect width='320' height='180' fill='%23dadde2'/%3E%3Crect x='32' y='30' width='256' height='120' rx='12' fill='%23fff'/%3E%3C/svg%3E";
      await page.evaluate(cleanImage => {
        window.visualTimelineTest.renderConversationFlow({
          title: "Screen action projection",
          entries: [{
            type: "tool",
            id: "screen-action-projection",
            name: "act_on_screen",
            args: { action: "type", text: "轻舟", returnScreenshot: true, x: 80, y: 135 },
            result: {
              status: "completed",
              feedbackAvailable: true,
              _display: { type: "imageWithAction", action: "type", kind: "point", x: 0.25, y: 0.75 },
            },
            image: cleanImage,
          }],
        });
      }, image);

      await page.locator(".msg-tool > .tool-summary").click();
      const screenshot = page.locator(".msg-tool .tool-screenshot");
      const point = screenshot.locator(".tool-image-action-point");
      await expect(page.locator(".msg-tool > .tool-summary")).toContainText("输入文本");
      await expect(page.locator(".msg-tool")).not.toContainText("类型");
      await expect(screenshot.locator("img")).toHaveAttribute("src", image);
      await expect(screenshot.locator(".tool-image-action-overlay")).toHaveCount(1);
      await expect(point).toHaveCount(1);
      await expect(point.locator(".tool-image-action-cursor")).toHaveCount(1);

      const metrics = await screenshot.evaluate(root => {
        const frame = root.getBoundingClientRect();
        const marker = root.querySelector(".tool-image-action-point").getBoundingClientRect();
        const overlayStyle = getComputedStyle(root.querySelector(".tool-image-action-overlay"));
        const pulseStyle = getComputedStyle(root.querySelector(".tool-image-action-point"), "::after");
        const glowStyle = getComputedStyle(root.querySelector(".tool-image-action-point"), "::before");
        const cursorStyle = getComputedStyle(root.querySelector(".tool-image-action-cursor path"));
        return {
          x: (marker.left - frame.left) / frame.width,
          y: (marker.top - frame.top) / frame.height,
          cue: overlayStyle.getPropertyValue("--tool-image-action-cue").trim(),
          glow: glowStyle.backgroundImage,
          cursorFill: cursorStyle.fill,
          animationName: pulseStyle.animationName,
          animationDuration: pulseStyle.animationDuration,
          animationIterationCount: pulseStyle.animationIterationCount,
        };
      });
      expect(metrics.x).toBeCloseTo(0.25, 2);
      expect(metrics.y).toBeCloseTo(0.75, 2);
      expect(metrics.cue).toBe(colorScheme === "dark" ? "#a2b2af" : "#607572");
      expect(metrics.glow).toContain("radial-gradient");
      expect(metrics.cursorFill).toBe("rgb(23, 25, 25)");
      expect(metrics.animationName).toBe("tool-image-action-pulse");
      expect(metrics.animationDuration).toBe("2.6s");
      expect(metrics.animationIterationCount).toBe("infinite");

      await screenshot.locator("img").click();
      await expect(page.locator(".image-lightbox img")).toHaveAttribute("src", image);
      await expect(page.locator(".image-lightbox .tool-image-action-overlay")).toHaveCount(0);
    });

    test("replays an action in Chat UI without returning an image to the model", async ({ page }) => {
      await page.goto("/tests/tool-timeline/visual-test.html", { waitUntil: "networkidle" });
      await page.waitForFunction(() => window.visualTimelineTest?.renderConversationFlow);
      const sourceImage = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='320' height='180'%3E%3Crect width='320' height='180' fill='%23e3e5e8'/%3E%3Ccircle cx='208' cy='72' r='22' fill='%23fff'/%3E%3C/svg%3E";
      const resultImage = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='320' height='180'%3E%3Crect width='320' height='180' fill='%23dce7e4'/%3E%3Ccircle cx='208' cy='72' r='22' fill='%23fff'/%3E%3C/svg%3E";
      await page.evaluate(({ source, result }) => {
        window.visualTimelineTest.renderConversationFlow({
          title: "UI-only screen action replay",
          entries: [{
            type: "tool",
            id: "screen-action-ui-only",
            name: "act_on_screen",
            args: { action: "click", returnScreenshot: false, x: 208, y: 72 },
            result: {
              status: "completed",
              feedbackAvailable: false,
              _display: {
                type: "imageWithAction",
                action: "click",
                kind: "point",
                x: 0.65,
                y: 0.4,
                beforeImage: source,
                afterImage: result,
              },
            },
          }],
        });
      }, { source: sourceImage, result: resultImage });

      await page.locator(".msg-tool > .tool-summary").click();
      const screenshot = page.locator(".msg-tool .tool-screenshot");
      await expect(screenshot).toHaveCount(1);
      await expect(screenshot).toHaveClass(/tool-image-action-transition/);
      await expect(screenshot.locator(".tool-image-action-before")).toHaveAttribute("src", sourceImage);
      await expect(screenshot.locator(".tool-image-action-after")).toHaveAttribute("src", resultImage);
      await expect(screenshot.locator(".tool-image-action-overlay")).toHaveCount(1);
      await page.getByRole("button", { name: "查看原始数据" }).click();
      await expect(page.locator(".tool-event-raw-panel")).not.toContainText("beforeImage");
      await expect(page.locator(".tool-event-raw-panel")).not.toContainText("data:image");

      await page.evaluate(({ source, result }) => {
        window.visualTimelineTest.renderConversationFlow({
          title: "Coordinate-free screen action replay",
          entries: [{
            type: "tool",
            id: "screen-action-frame-only",
            name: "act_on_screen",
            args: { action: "press", returnScreenshot: false, key: "Enter" },
            result: {
              status: "completed",
              feedbackAvailable: false,
              _display: {
                type: "imageWithAction",
                action: "press",
                kind: "frame",
                beforeImage: source,
                afterImage: result,
              },
            },
          }],
        });
      }, { source: sourceImage, result: resultImage });
      await page.locator(".msg-tool > .tool-summary").click();
      const frameOnly = page.locator(".msg-tool .tool-screenshot");
      await expect(frameOnly).toHaveClass(/tool-image-action-transition/);
      await expect(frameOnly.locator(".tool-image-action-overlay")).toHaveCount(0);
    });

    test("replays a navigation action from its source frame before revealing the clean result", async ({ page }) => {
      await page.goto("/tests/tool-timeline/visual-test.html", { waitUntil: "networkidle" });
      await page.waitForFunction(() => window.visualTimelineTest?.renderConversationFlow);
      await page.evaluate(async () => {
        const { installImageLightbox } = await import("/extension/sidepanel/ui/image-lightbox.js");
        installImageLightbox(document.querySelector("#messages"));
      });
      const beforeImage = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='320' height='180'%3E%3Crect width='320' height='180' fill='%23e3e5e8'/%3E%3Crect x='96' y='62' width='128' height='56' rx='12' fill='%23fff'/%3E%3C/svg%3E";
      const afterImage = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='320' height='180'%3E%3Crect width='320' height='180' fill='%23dce7e4'/%3E%3Ccircle cx='160' cy='90' r='34' fill='%23fff'/%3E%3C/svg%3E";
      const afterPreview = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='90'%3E%3Crect width='160' height='90' fill='%23dce7e4'/%3E%3Ccircle cx='80' cy='45' r='17' fill='%23fff'/%3E%3C/svg%3E";
      await page.evaluate(({ beforeImage: source, afterImage: result, afterPreview: preview }) => {
        window.visualTimelineTest.renderConversationFlow({
          title: "Screen navigation transition",
          entries: [{
            type: "tool",
            id: "screen-navigation-transition",
            name: "act_on_screen",
            args: { action: "click", returnScreenshot: true, x: 160, y: 90 },
            result: {
              status: "completed",
              feedbackAvailable: true,
              urlChanged: true,
              _display: {
                type: "imageWithAction",
                action: "click",
                kind: "point",
                x: 0.5,
                y: 0.5,
                beforeImage: source,
                afterImage: preview,
              },
            },
            image: result,
          }],
        });
      }, { beforeImage, afterImage, afterPreview });

      await page.locator(".msg-tool > .tool-summary").click();
      const screenshot = page.locator(".msg-tool .tool-screenshot");
      await expect(screenshot).toHaveClass(/tool-image-action-transition/);
      await expect(screenshot.locator(".tool-image-action-before")).toHaveAttribute("src", beforeImage);
      await expect(screenshot.locator(".tool-image-action-after")).toHaveAttribute("src", afterPreview);
      await expect(screenshot.locator(".tool-image-action-after")).toHaveAttribute("data-full-src", afterImage);
      await expect(screenshot.locator(".tool-image-action-cursor")).toHaveCount(1);
      await screenshot.locator(".tool-image-action-after").click({ force: true });
      await expect(page.locator(".image-lightbox img")).toHaveAttribute("src", afterImage);
      await page.getByRole("button", { name: "关闭" }).click();

      const motion = await screenshot.evaluate(root => {
        const before = getComputedStyle(root.querySelector(".tool-image-action-before-layer"));
        const point = root.querySelector(".tool-image-action-point");
        const pulse = getComputedStyle(point, "::after");
        const cursor = getComputedStyle(root.querySelector(".tool-image-action-cursor"));
        return {
          beforeAnimation: before.animationName,
          beforeDuration: before.animationDuration,
          beforeIterations: before.animationIterationCount,
          pulseAnimation: pulse.animationName,
          pulseDuration: pulse.animationDuration,
          pulseIterations: pulse.animationIterationCount,
          cursorAnimation: cursor.animationName,
        };
      });
      expect(motion).toEqual({
        beforeAnimation: "tool-image-action-before-frame",
        beforeDuration: "3.2s",
        beforeIterations: "infinite",
        pulseAnimation: "tool-image-action-transition-pulse",
        pulseDuration: "3.2s",
        pulseIterations: "infinite",
        cursorAnimation: "tool-image-action-cursor-settle",
      });

      await page.getByRole("button", { name: "查看原始数据" }).click();
      await expect(page.locator(".tool-event-raw-panel")).not.toContainText("beforeImage");

      const exportedView = await page.evaluate(async ({ beforeImage: source, afterImage: result, afterPreview: preview }) => {
        const { createSessionExportFeature } = await import("/extension/sidepanel/features/export/session-export-feature.js");
        const feature = createSessionExportFeature({
          root: document,
          runtime: {
            getManifest: () => ({ version: "test" }),
            getURL: () => "data:text/plain,",
          },
          request: async () => ({}),
          fetchStylesheet: async () => ({ ok: true, text: async () => "" }),
          renderTranscriptElement: () => document.createElement("div"),
        });
        try {
          const exported = await feature.createDocumentFromSnapshot({
            session: { id: "screen-export", title: "Screen export" },
            transcript: [{
              type: "tool",
              toolCallId: "screen-export-action",
              name: "act_on_screen",
              args: { action: "click", returnScreenshot: true, x: 160, y: 90 },
              result: {
                status: "completed",
                _display: {
                  type: "imageWithAction",
                  action: "click",
                  kind: "point",
                  x: 0.5,
                  y: 0.5,
                  beforeImage: source,
                  afterImage: preview,
                },
              },
              image: result,
              phase: "done",
              isRunning: false,
              isError: false,
            }],
          });
          const output = new DOMParser().parseFromString(exported.html, "text/html");
          return {
            beforeSrc: output.querySelector(".tool-image-action-before")?.getAttribute("src") || "",
            afterSrc: output.querySelector(".tool-image-action-after")?.getAttribute("src") || "",
            fullSrc: output.querySelector(".tool-image-action-after")?.getAttribute("data-full-src") || "",
            exchangeHasSourceFrame: output.querySelector("#qingzhou-session-exchange")?.textContent?.includes("beforeImage") === true,
          };
        } finally {
          feature.dispose();
        }
      }, { beforeImage, afterImage, afterPreview });
      expect(exportedView).toEqual({
        beforeSrc: beforeImage,
        afterSrc: afterPreview,
        fullSrc: afterImage,
        exchangeHasSourceFrame: true,
      });
    });

    test("replays drag as cursor-and-glow movement without click feedback or a drawn path", async ({ page }) => {
      await page.goto("/tests/tool-timeline/visual-test.html", { waitUntil: "networkidle" });
      await page.waitForFunction(() => window.visualTimelineTest?.renderConversationFlow);
      const beforeImage = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='320' height='180'%3E%3Crect width='320' height='180' fill='%23dadde2'/%3E%3C/svg%3E";
      const afterImage = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='320' height='180'%3E%3Crect width='320' height='180' fill='%23dce7e4'/%3E%3C/svg%3E";
      await page.evaluate(({ beforeImage: source, afterImage: result }) => {
        window.visualTimelineTest.renderConversationFlow({
          title: "Screen drag projection",
          entries: [{
            type: "tool",
            id: "screen-drag-projection",
            name: "act_on_screen",
            args: { action: "drag", returnScreenshot: true, x: 32, y: 36, endX: 256, endY: 144 },
            result: {
              status: "completed",
              feedbackAvailable: true,
              _display: {
                type: "imageWithAction",
                action: "drag",
                kind: "drag",
                x: 0.1,
                y: 0.2,
                endX: 0.8,
                endY: 0.8,
                beforeImage: source,
              },
            },
            image: result,
          }],
        });
      }, { beforeImage, afterImage });

      await page.locator(".msg-tool > .tool-summary").click();
      const screenshot = page.locator(".msg-tool .tool-screenshot");
      const moving = screenshot.locator(".tool-image-action-point-moving");
      await expect(screenshot).toHaveClass(/tool-image-action-transition/);
      await expect(moving).toHaveCount(1);
      await expect(moving.locator(".tool-image-action-cursor")).toHaveCount(1);
      await expect(screenshot.locator(".tool-image-action-path, .tool-image-action-point-start")).toHaveCount(0);

      const motion = await moving.evaluate(element => {
        const style = getComputedStyle(element);
        const glow = getComputedStyle(element, "::before");
        const pulse = getComputedStyle(element, "::after");
        return {
          animationName: style.animationName,
          animationDuration: style.animationDuration,
          animationIterationCount: style.animationIterationCount,
          glowDisplay: glow.display,
          glowBackground: glow.backgroundImage,
          pulseDisplay: pulse.display,
          fromX: style.getPropertyValue("--tool-image-action-from-x").trim(),
          fromY: style.getPropertyValue("--tool-image-action-from-y").trim(),
          toX: style.getPropertyValue("--tool-image-action-to-x").trim(),
          toY: style.getPropertyValue("--tool-image-action-to-y").trim(),
        };
      });
      expect(motion.animationName).toBe("tool-image-action-transition-travel");
      expect(motion.animationDuration).toBe("3.2s");
      expect(motion.animationIterationCount).toBe("infinite");
      expect(motion.glowDisplay).not.toBe("none");
      expect(motion.glowBackground).toContain("radial-gradient");
      expect(motion.pulseDisplay).toBe("none");
      expect(motion.fromX).toBe("10%");
      expect(motion.fromY).toBe("20%");
      expect(motion.toX).toBe("80%");
      expect(motion.toY).toBe("80%");

      await page.evaluate(result => {
        window.visualTimelineTest.renderConversationFlow({
          title: "Screen drag projection without a frame transition",
          entries: [{
            type: "tool",
            id: "screen-drag-projection-stable",
            name: "act_on_screen",
            args: { action: "drag", returnScreenshot: true, x: 32, y: 36, endX: 256, endY: 144 },
            result: {
              status: "completed",
              feedbackAvailable: true,
              _display: {
                type: "imageWithAction",
                action: "drag",
                kind: "drag",
                x: 0.1,
                y: 0.2,
                endX: 0.8,
                endY: 0.8,
              },
            },
            image: result,
          }],
        });
      }, afterImage);

      await page.locator(".msg-tool > .tool-summary").click();
      const stableScreenshot = page.locator(".msg-tool .tool-screenshot");
      const stableMoving = stableScreenshot.locator(".tool-image-action-point-moving");
      await expect(stableScreenshot).not.toHaveClass(/tool-image-action-transition/);
      await expect(stableScreenshot.locator(".tool-image-action-before")).toHaveCount(0);
      const stableMotion = await stableMoving.evaluate(element => {
        const style = getComputedStyle(element);
        const glow = getComputedStyle(element, "::before");
        const pulse = getComputedStyle(element, "::after");
        return {
          animationName: style.animationName,
          animationDuration: style.animationDuration,
          animationIterationCount: style.animationIterationCount,
          glowDisplay: glow.display,
          pulseDisplay: pulse.display,
        };
      });
      expect(stableMotion).toEqual({
        animationName: "tool-image-action-travel",
        animationDuration: "1.8s",
        animationIterationCount: "infinite",
        glowDisplay: "block",
        pulseDisplay: "none",
      });
    });

    test("moves the cursor and glow with the scroll direction without click feedback", async ({ page }) => {
      await page.goto("/tests/tool-timeline/visual-test.html", { waitUntil: "networkidle" });
      await page.waitForFunction(() => window.visualTimelineTest?.renderConversationFlow);
      const beforeImage = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='320' height='180'%3E%3Crect width='320' height='180' fill='%23e3e5e8'/%3E%3C/svg%3E";
      const afterImage = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='320' height='180'%3E%3Crect width='320' height='180' fill='%23dce7e4'/%3E%3C/svg%3E";
      await page.evaluate(({ beforeImage: source, afterImage: result }) => {
        window.visualTimelineTest.renderConversationFlow({
          title: "Screen scroll projection",
          entries: [{
            type: "tool",
            id: "screen-scroll-projection",
            name: "act_on_screen",
            args: { action: "scroll", returnScreenshot: true, x: 160, y: 90, deltaY: 280 },
            result: {
              status: "completed",
              feedbackAvailable: true,
              _display: {
                type: "imageWithAction",
                action: "scroll",
                kind: "point",
                x: 0.5,
                y: 0.5,
                beforeImage: source,
              },
            },
            image: result,
          }],
        });
      }, { beforeImage, afterImage });

      await page.locator(".msg-tool > .tool-summary").click();
      const screenshot = page.locator(".msg-tool .tool-screenshot");
      const overlay = screenshot.locator('.tool-image-action-overlay[data-action="scroll"]');
      const point = overlay.locator(".tool-image-action-point");
      const cue = point.locator('.tool-image-action-scroll-cue[data-direction="down"]');
      await expect(screenshot).toHaveClass(/tool-image-action-transition/);
      await expect(overlay).toHaveAttribute("data-direction", "down");
      await expect(cue).toHaveCount(1);

      const motion = await point.evaluate(element => {
        const pointStyle = getComputedStyle(element);
        const glow = getComputedStyle(element, "::before");
        const pulse = getComputedStyle(element, "::after");
        const cursor = getComputedStyle(element.querySelector(".tool-image-action-cursor"));
        const cueStyle = getComputedStyle(element.querySelector(".tool-image-action-scroll-cue"));
        return {
          pointAnimation: pointStyle.animationName,
          pointDuration: pointStyle.animationDuration,
          pointIterations: pointStyle.animationIterationCount,
          glowDisplay: glow.display,
          glowBackground: glow.backgroundImage,
          pulseDisplay: pulse.display,
          cursorAnimation: cursor.animationName,
          cueAnimation: cueStyle.animationName,
          cueDuration: cueStyle.animationDuration,
          cueIterations: cueStyle.animationIterationCount,
        };
      });
      expect(motion.pointAnimation).toBe("tool-image-action-scroll-point-transition");
      expect(motion.pointDuration).toBe("3.2s");
      expect(motion.pointIterations).toBe("infinite");
      expect(motion.glowDisplay).not.toBe("none");
      expect(motion.glowBackground).toContain("radial-gradient");
      expect(motion.pulseDisplay).toBe("none");
      expect(motion.cursorAnimation).toBe("none");
      expect(motion.cueAnimation).toBe("tool-image-action-scroll-cue-transition");
      expect(motion.cueDuration).toBe("3.2s");
      expect(motion.cueIterations).toBe("infinite");
    });
  });
}

test.describe("chiphead scroll anchoring", () => {
  test.use({ viewport: { width: 420, height: 844 } });

  test("80% keeps visible tool metadata at a readable floor", async ({ page }) => {
    await page.goto("/tests/tool-timeline/visual-test.html", { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "展开全部" }).click();
    const minimum = await page.locator("#messages").evaluate(element => {
      element.dataset.chatTextSize = "small";
      return Math.min(...Array.from(element.querySelectorAll("*")).filter(node => {
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && Array.from(node.childNodes).some(child => (
          child.nodeType === Node.TEXT_NODE && child.textContent.trim()
        ));
      }).map(node => Number.parseFloat(getComputedStyle(node).fontSize)));
    });
    expect(minimum).toBeGreaterThanOrEqual(10);
  });

  for (const skin of [
    { name: "default", href: "/extension/sidepanel/sidepanel.css" },
  ]) {
    test(`${skin.name} skin keeps every collapsible header vertically fixed`, async ({ page }) => {
      await page.goto("/tests/tool-timeline/visual-test.html", { waitUntil: "networkidle" });
      await page.waitForFunction(() => window.visualTimelineTest?.debugChipheadToggleScrollStability);
      await loadSidepanelSkin(page, skin.href);

      const results = await page.evaluate(() => (
        window.visualTimelineTest.debugChipheadToggleScrollStability({ cycles: 8 })
      ));

      expect(results.map(result => result.id)).toEqual(["tool", "timeline", "thinking"]);
      for (const result of results) {
        expect(result.samples).toHaveLength(8);
        expect(result.samples.map(sample => sample.expanded)).toEqual([
          true, false, true, false, true, false, true, false,
        ]);
        expect(result.maxFrameDrift, `${skin.name}/${result.id} header frame drift`).toBeLessThan(0.1);
        expect(result.maxSettledDrift, `${skin.name}/${result.id} header settled drift`).toBeLessThan(0.1);
        expect(result.maxFrameFlowDrift, `${skin.name}/${result.id} conversation frame drift`).toBeLessThan(0.1);
        expect(result.maxSettledFlowDrift, `${skin.name}/${result.id} conversation settled drift`).toBeLessThan(0.1);
        expect(result.maxScrollDrift, `${skin.name}/${result.id} scroll oscillation`).toBeLessThan(0.1);
        expect(Math.abs(result.endTopDrift), `${skin.name}/${result.id} cumulative top drift`).toBeLessThan(0.1);
        expect(Math.abs(result.endScrollDrift), `${skin.name}/${result.id} cumulative scroll drift`).toBeLessThan(0.1);
        const expandedSamples = result.samples.filter(sample => sample.expanded);
        expect(expandedSamples.every(sample => sample.cardBorderTopWidth === 0), `${skin.name}/${result.id} layout border`).toBe(true);
        expect(expandedSamples.every(sample => sample.cardBoxShadow !== "none"), `${skin.name}/${result.id} visible frame`).toBe(true);
        expect(expandedSamples.every(sample => !sample.cardBoxShadow.includes("inset")), `${skin.name}/${result.id} unobscured frame`).toBe(true);
        expect(expandedSamples.every(sample => sample.summaryBorderBottomWidth === 0), `${skin.name}/${result.id} no redundant divider`).toBe(true);
        expect(expandedSamples.every(sample => sample.summaryBoxShadow === "none"), `${skin.name}/${result.id} no shadow divider`).toBe(true);
      }
    });
  }
});

async function loadSidepanelSkin(page, href) {
  await page.evaluate(async stylesheetHref => {
    const link = document.querySelector('link[rel="stylesheet"][href*="sidepanel"]');
    if (!link) throw new Error("sidepanel stylesheet link not found");
    const nextHref = new URL(stylesheetHref, location.href).href;
    if (link.href !== nextHref) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`skin load timeout: ${stylesheetHref}`)), 5000);
        link.addEventListener("load", () => {
          clearTimeout(timer);
          resolve();
        }, { once: true });
        link.addEventListener("error", () => {
          clearTimeout(timer);
          reject(new Error(`skin load failed: ${stylesheetHref}`));
        }, { once: true });
        link.href = nextHref;
      });
    }
    await document.fonts?.ready;
  }, href);
}
