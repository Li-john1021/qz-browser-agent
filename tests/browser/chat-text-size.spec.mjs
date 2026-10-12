import { expect, test } from "./sidepanel-fixtures.mjs";

test.describe("chat text size", () => {
  test.use({ colorScheme: "light", viewport: { width: 390, height: 620 } });

  test("scales readable content, resets, and persists without widening chat", async ({ page }) => {
    await renderTextFixture(page, "text-size-persist");

    const messages = page.locator("#messages");
    const assistant = page.locator(".msg-assistant .msg-content").first();
    const markdownTable = assistant.locator("table");
    const thinkingSummary = page.locator(".thinking-group-summary").first();
    const toolSummary = page.locator(".msg-tool > .tool-summary").first();
    const artifactTitle = page.locator(".artifact-strip-title");
    const artifactPreview = page.locator(".artifact-strip-preview");
    const artifactName = page.locator(".artifact-strip-name > span").first();
    const artifactMeta = page.locator(".artifact-strip-name small").first();
    const artifactAction = page.locator(".artifact-solid-btn");
    const trigger = page.locator("#btn-chat-text-size");
    const decrease = page.locator('[data-chat-text-size-action="decrease"]');
    const increase = page.locator('[data-chat-text-size-action="increase"]');
    const reset = page.locator("#chat-text-size-reset");

    await expect(messages).toHaveAttribute("data-chat-text-size", "standard");
    expect(await fontSize(assistant)).toBeCloseTo(13, 1);
    expect(await fontSize(markdownTable)).toBeCloseTo(12, 1);
    expect(await fontSize(thinkingSummary)).toBeCloseTo(11, 1);
    expect(await fontSize(toolSummary)).toBeCloseTo(11, 1);
    expect(await fontSize(artifactTitle)).toBeCloseTo(13, 1);
    expect(await fontSize(artifactPreview)).toBeCloseTo(11, 1);
    expect(await fontSize(artifactName)).toBeCloseTo(12, 1);
    expect(await fontSize(artifactMeta)).toBeCloseTo(10, 1);
    expect(await fontSize(artifactAction)).toBeCloseTo(11, 1);
    await toolSummary.click();
    const toolBody = page.locator(".tool-article-body");
    const toolTable = toolBody.locator("table");
    await expect(toolBody).toBeVisible();
    expect(await fontSize(toolBody)).toBeCloseTo(12, 1);
    expect(await fontSize(toolTable)).toBeCloseTo(12, 1);
    const standardToolBox = await toolSummary.boundingBox();
    const standardThinkingBox = await thinkingSummary.boundingBox();

    await trigger.click();
    await decrease.click();
    await decrease.click();
    await expect(messages).toHaveAttribute("data-chat-text-size", "small");
    await expect(reset).toHaveText("80%");
    expect(await fontSize(assistant)).toBeCloseTo(11, 1);
    expect(await fontSize(markdownTable)).toBeCloseTo(10.5, 1);
    expect(await fontSize(toolSummary)).toBeCloseTo(10, 1);
    expect(await fontSize(toolSummary.locator(".tool-args-preview"))).toBeGreaterThanOrEqual(10);
    expect(await fontSize(toolBody)).toBeCloseTo(10.5, 1);
    expect(await fontSize(toolTable)).toBeCloseTo(10.5, 1);
    expect(await fontSize(artifactTitle)).toBeCloseTo(11.8, 1);
    expect(await fontSize(artifactPreview)).toBeCloseTo(10, 1);
    expect(await fontSize(artifactName)).toBeCloseTo(10.5, 1);
    expect(await fontSize(artifactMeta)).toBeCloseTo(10, 1);
    expect(await fontSize(artifactAction)).toBeCloseTo(10, 1);
    expect(await thinkingTextCenterDelta(thinkingSummary)).toBeLessThanOrEqual(1);
    await reset.click();

    await increase.click();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect(messages).toHaveAttribute("data-chat-text-size", "comfortable");
    await expect(reset).toHaveText("110%");
    expect(await fontSize(assistant)).toBeCloseTo(14.3, 1);
    expect(await fontSize(markdownTable)).toBeCloseTo(13.2, 1);
    expect(await fontSize(toolSummary)).toBeCloseTo(11.6, 1);
    expect(await fontSize(toolBody)).toBeCloseTo(13.2, 1);
    expect(await fontSize(toolTable)).toBeCloseTo(13.2, 1);
    expect(Math.abs((await toolSummary.boundingBox()).y - standardToolBox.y)).toBeLessThanOrEqual(2);

    await reset.click();
    await expect(messages).toHaveAttribute("data-chat-text-size", "standard");
    expect(await fontSize(assistant)).toBeCloseTo(13, 1);

    await increase.click();
    await increase.click();
    await increase.click();
    await expect(messages).toHaveAttribute("data-chat-text-size", "xlarge");
    await expect(reset).toHaveText("140%");
    expect(await fontSize(assistant)).toBeCloseTo(18, 1);
    expect(await fontSize(markdownTable)).toBeCloseTo(15.5, 1);
    expect(await fontSize(toolSummary)).toBeCloseTo(13, 1);
    expect(await fontSize(toolBody)).toBeCloseTo(15.5, 1);
    expect(await fontSize(toolTable)).toBeCloseTo(15.5, 1);
    expect(await fontSize(artifactTitle)).toBeCloseTo(15.4, 1);
    expect(await fontSize(artifactPreview)).toBeCloseTo(13, 1);
    expect(await fontSize(artifactName)).toBeCloseTo(15.5, 1);
    expect(await fontSize(artifactMeta)).toBeCloseTo(11.8, 1);
    expect(await fontSize(artifactAction)).toBeCloseTo(13, 1);
    const thinkingAlignment = await thinkingSummary.evaluate(summary => {
      const preview = summary.querySelector(".thinking-group-preview");
      const summaryRect = summary.getBoundingClientRect();
      const previewRect = preview.getBoundingClientRect();
      return {
        centerDelta: Math.abs(
          (summaryRect.top + summaryRect.bottom) / 2 - (previewRect.top + previewRect.bottom) / 2,
        ),
        lineHeight: Number.parseFloat(getComputedStyle(preview).lineHeight),
        height: previewRect.height,
      };
    });
    expect(thinkingAlignment.centerDelta).toBeLessThanOrEqual(1);
    expect(thinkingAlignment.height + 0.5).toBeGreaterThanOrEqual(thinkingAlignment.lineHeight);
    expect((await toolSummary.boundingBox()).height).toBeCloseTo(standardToolBox.height, 0);
    expect((await thinkingSummary.boundingBox()).height).toBeCloseTo(standardThinkingBox.height, 0);
    const overflow = await messages.evaluate(element => element.scrollWidth - element.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    expect(await page.evaluate(() => localStorage.getItem("qingzhou.chatTextSize"))).toBe("xlarge");

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => Boolean(window.qingzhouConversationBenchmark));
    await renderTextFixture(page, "text-size-restored");
    await expect(page.locator("#messages")).toHaveAttribute("data-chat-text-size", "xlarge");
    expect(await fontSize(page.locator(".msg-assistant .msg-content").first())).toBeCloseTo(18, 1);
  });

  test("optically balances every level by text role", async ({ page }) => {
    await renderTextFixture(page, "text-size-optical-scale");
    await page.locator(".msg-tool > .tool-summary").first().click();

    const expected = [
      ["small", 11, 10.5, 10, 11.8],
      ["compact", 11.7, 10.8, 10.5, 12.4],
      ["standard", 13, 12, 11, 13],
      ["comfortable", 14.3, 13.2, 11.6, 13.7],
      ["large", 16.25, 15, 12.4, 14.7],
      ["xlarge", 18, 15.5, 13, 15.4],
    ];
    for (const [level, contentSize, panelSize, metaSize, artifactTitleSize] of expected) {
      await page.locator("#messages").evaluate((element, value) => {
        element.dataset.chatTextSize = value;
      }, level);
      expect(await fontSize(page.locator(".msg-assistant .msg-content").first())).toBeCloseTo(contentSize, 1);
      expect(await fontSize(page.locator(".msg-assistant table").first())).toBeCloseTo(panelSize, 1);
      expect(await fontSize(page.locator(".tool-article-body"))).toBeCloseTo(panelSize, 1);
      expect(await fontSize(page.locator(".msg-tool > .tool-summary").first())).toBeCloseTo(metaSize, 1);
      expect(await fontSize(page.locator(".artifact-strip-title"))).toBeCloseTo(artifactTitleSize, 1);
      expect(await fontSize(page.locator(".artifact-strip-name > span").first())).toBeCloseTo(panelSize, 1);
      expect(await fontSize(page.locator(".artifact-solid-btn"))).toBeCloseTo(metaSize, 1);
      expect(await artifactActionCenterDelta(page)).toBeLessThanOrEqual(1);
    }
  });

  test("preserves a history anchor and keeps an active tail at the bottom", async ({ page }) => {
    await renderLongFixture(page);
    const messages = page.locator("#messages");
    await messages.hover();
    await page.mouse.wheel(0, -900);
    await page.waitForTimeout(80);

    const before = await visibleTranscriptAnchor(page);
    expect(before?.key).toBeTruthy();
    await page.locator("#btn-chat-text-size").click();
    await page.locator('[data-chat-text-size-action="increase"]').click();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const afterTop = await page.locator(`[data-transcript-key="${before.key}"]`).evaluate(element => element.getBoundingClientRect().top);
    expect(Math.abs(afterTop - before.top)).toBeLessThanOrEqual(2);

    await messages.hover();
    await page.mouse.wheel(0, 10000);
    await page.waitForTimeout(80);
    await page.locator('[data-chat-text-size-action="increase"]').click();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const bottomDistance = await messages.evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight);
    expect(bottomDistance).toBeLessThanOrEqual(2);
  });

  test("keeps the same visual center while the side panel width reflows conversation", async ({ page }) => {
    await page.setViewportSize({ width: 520, height: 720 });
    await page.evaluate(async () => {
      await window.qingzhouConversationBenchmark.runSnapshotRender({
        sessionId: "sidepanel-resize-center",
        title: "侧边栏缩放视觉中心",
        transcript: Array.from({ length: 32 }, (_, index) => ({
          type: "assistant",
          runId: `resize-center-run-${index}`,
          content: [
            `第 ${index + 1} 段视觉中心测试。`,
            `这是一段会随侧边栏宽度变化而重新折行的正文，编号 ${index + 1}。`.repeat(5),
          ].join("\n\n"),
        })),
      });
    });

    const messages = page.locator("#messages");
    await messages.hover();
    await page.mouse.wheel(0, -1_300);
    await page.waitForTimeout(120);

    const before = await page.evaluate(() => {
      const messagesEl = document.querySelector("#messages");
      const viewport = messagesEl.getBoundingClientRect();
      const centerX = viewport.left + (viewport.width / 2);
      const centerY = viewport.top + (viewport.height / 2);
      const element = document.elementFromPoint(centerX, centerY);
      if (!(element instanceof Element) || !messagesEl.contains(element) || element === messagesEl) return null;
      const rect = element.getBoundingClientRect();
      const pointRatio = Math.max(0, Math.min(1, (centerY - rect.top) / rect.height));
      window.__sidepanelResizeVisualAnchor = { element, pointRatio };
      return {
        transcriptKey: element.closest("[data-transcript-key]")?.dataset.transcriptKey || "",
        centerY,
        pointY: rect.top + (rect.height * pointRatio),
      };
    });
    expect(before?.transcriptKey).toBeTruthy();
    expect(Math.abs(before.pointY - before.centerY)).toBeLessThanOrEqual(0.5);

    const resizeSamples = [];
    for (const width of [470, 420, 370, 330]) {
      await page.setViewportSize({ width, height: 720 });
      await page.waitForTimeout(70);
      resizeSamples.push(await page.evaluate(() => {
        const messagesEl = document.querySelector("#messages");
        const viewport = messagesEl.getBoundingClientRect();
        const anchor = window.__sidepanelResizeVisualAnchor;
        const rect = anchor?.element?.getBoundingClientRect?.();
        const centerY = viewport.top + (viewport.height / 2);
        const pointY = rect ? rect.top + (rect.height * anchor.pointRatio) : null;
        return { centerY, pointY, delta: pointY == null ? null : pointY - centerY };
      }));
    }
    await page.waitForFunction(() => window.qingzhouConversationBenchmark.collectViewportAnchorState?.().resizeAnchored !== true);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

    const after = await page.evaluate(() => {
      const messagesEl = document.querySelector("#messages");
      const viewport = messagesEl.getBoundingClientRect();
      const anchor = window.__sidepanelResizeVisualAnchor;
      const rect = anchor?.element?.getBoundingClientRect?.();
      return {
        connected: Boolean(anchor?.element?.isConnected && messagesEl.contains(anchor.element)),
        centerY: viewport.top + (viewport.height / 2),
        pointY: rect ? rect.top + (rect.height * anchor.pointRatio) : null,
        bottomDistance: messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight,
      };
    });
    expect(after.connected).toBe(true);
    expect(
      resizeSamples.every(sample => Number.isFinite(sample.delta) && Math.abs(sample.delta) <= 2),
      JSON.stringify({ before, resizeSamples, after }, null, 2),
    ).toBe(true);
    expect(Math.abs(after.pointY - after.centerY), JSON.stringify({ before, after }, null, 2)).toBeLessThanOrEqual(2);
    expect(after.bottomDistance).toBeGreaterThan(28);
  });

  test("keeps one artifact anchor through a long bidirectional side panel resize", async ({ page }) => {
    await page.setViewportSize({ width: 560, height: 720 });
    const artifact = {
      type: "artifacts",
      summary: {
        sessionId: "sidepanel-resize-artifact",
        total: 5,
        signature: "sidepanel-resize-artifact:5",
        data: Array.from({ length: 2 }, (_, index) => ({
          type: "data",
          title: `年度统计结果-${index + 1}`,
          meta: "50 行 12 列",
          timeLabel: "08-25 10:00",
        })),
        files: Array.from({ length: 3 }, (_, index) => ({
          type: "file",
          title: `很长的分析报告文件名-${index + 1}.html`,
          meta: "html · 128.9 KB",
          timeLabel: "08-25 10:01",
        })),
      },
    };
    await page.evaluate(async artifactEntry => {
      const transcript = Array.from({ length: 48 }, (_, index) => ({
        type: "assistant",
        runId: `resize-artifact-run-${index}`,
        content: `第 ${index + 1} 段。${"这是一段会在侧边栏宽度变化时持续重新折行的正文。".repeat(8)}`,
      }));
      transcript.splice(24, 0, artifactEntry);
      await window.qingzhouConversationBenchmark.runSnapshotRender({
        sessionId: "sidepanel-resize-artifact",
        title: "产物卡片往返缩放",
        transcript,
      });
    }, artifact);

    const messages = page.locator("#messages");
    await messages.hover();
    await page.mouse.wheel(0, -1_000);
    await page.waitForTimeout(80);
    await page.locator(".msg-artifacts").evaluate(element => element.scrollIntoView({ block: "center" }));
    await page.waitForTimeout(120);

    const before = await page.evaluate(() => {
      const messagesEl = document.querySelector("#messages");
      const viewport = messagesEl.getBoundingClientRect();
      const centerX = viewport.left + (viewport.width / 2);
      const centerY = viewport.top + (viewport.height / 2);
      const element = document.elementFromPoint(centerX, centerY);
      if (!(element instanceof Element) || !element.closest(".msg-artifacts")) return null;
      const rect = element.getBoundingClientRect();
      window.__sidepanelArtifactResizeAnchor = {
        element,
        pointRatio: Math.max(0, Math.min(1, (centerY - rect.top) / rect.height)),
      };
      return {
        transcriptKey: element.closest("[data-transcript-key]")?.dataset.transcriptKey || "",
        centerY,
        pointY: rect.top + (rect.height * window.__sidepanelArtifactResizeAnchor.pointRatio),
      };
    });
    expect(before?.transcriptKey).toBeTruthy();

    const widths = [530, 500, 470, 440, 410, 380, 350, 330, 350, 380, 410, 440, 470, 500, 530, 560];
    const samples = [];
    for (const width of widths) {
      await page.setViewportSize({ width, height: 720 });
      await page.waitForTimeout(70);
      samples.push(await page.evaluate(currentWidth => {
        const messagesEl = document.querySelector("#messages");
        const viewport = messagesEl.getBoundingClientRect();
        const anchor = window.__sidepanelArtifactResizeAnchor;
        const rect = anchor?.element?.getBoundingClientRect?.();
        const centerY = viewport.top + (viewport.height / 2);
        const pointY = rect ? rect.top + (rect.height * anchor.pointRatio) : null;
        return {
          width: currentWidth,
          connected: Boolean(anchor?.element?.isConnected && messagesEl.contains(anchor.element)),
          delta: pointY == null ? null : pointY - centerY,
        };
      }, width));
    }

    await page.waitForFunction(() => (
      window.qingzhouConversationBenchmark.collectViewportAnchorState?.().resizeAnchored !== true
    ));
    expect(
      samples.every(sample => sample.connected && Number.isFinite(sample.delta) && Math.abs(sample.delta) <= 2),
      JSON.stringify({ before, samples }, null, 2),
    ).toBe(true);
  });

  test("clamps resize anchoring at the conversation boundary without adding blank space", async ({ page }) => {
    await page.setViewportSize({ width: 330, height: 720 });
    await renderLongFixture(page);
    const messages = page.locator("#messages");
    await messages.hover();
    await page.mouse.wheel(0, -120);
    await page.waitForTimeout(100);
    const before = await messages.evaluate(element => ({
      bottomDistance: element.scrollHeight - element.scrollTop - element.clientHeight,
      afterSpace: getComputedStyle(element).getPropertyValue("--viewport-anchor-after-space").trim(),
    }));
    expect(before.bottomDistance).toBeGreaterThan(28);
    expect(before.afterSpace).toBe("0px");

    await page.setViewportSize({ width: 650, height: 720 });
    await page.waitForTimeout(120);
    await page.waitForFunction(() => window.qingzhouConversationBenchmark.collectViewportAnchorState?.().resizeAnchored !== true);
    const after = await messages.evaluate(element => ({
      bottomDistance: element.scrollHeight - element.scrollTop - element.clientHeight,
      beforeSpace: getComputedStyle(element).getPropertyValue("--viewport-anchor-before-space").trim(),
      afterSpace: getComputedStyle(element).getPropertyValue("--viewport-anchor-after-space").trim(),
    }));
    expect(after.beforeSpace).toBe("0px");
    expect(after.afterSpace).toBe("0px");
    expect(after.bottomDistance).toBeLessThanOrEqual(2);
  });

  test("keeps following the latest message when larger text first creates overflow", async ({ page }) => {
    await page.setViewportSize({ width: 560, height: 760 });
    await page.evaluate(async () => {
      await window.qingzhouConversationBenchmark.runSnapshotRender({
        sessionId: "text-size-first-overflow",
        title: "字号首次产生滚动",
        transcript: [{
          type: "assistant",
          content: [
            "这段短对话在较大字号下仍能完整显示。",
            "继续放大后才首次产生滚动空间，此时应保持跟随最新消息。",
            "测试同时覆盖换行和行高变化。",
          ].join("\n\n"),
        }],
      });
    });

    const messages = page.locator("#messages");
    const increase = page.locator('[data-chat-text-size-action="increase"]');
    await page.locator("#btn-chat-text-size").click();
    await increase.click();
    await increase.click();
    await expect(messages).toHaveAttribute("data-chat-text-size", "large");

    await messages.evaluate(element => {
      element.style.flex = "0 0 1px";
      element.style.height = "1px";
    });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
    const largeContentHeight = await messages.evaluate(element => element.scrollHeight);
    await messages.evaluate((element, height) => {
      element.style.flex = `0 0 ${height}px`;
      element.style.height = `${height}px`;
    }, largeContentHeight);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

    const before = await messages.evaluate(element => ({
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      bottomDistance: element.scrollHeight - element.scrollTop - element.clientHeight,
    }));
    expect(before.scrollHeight - before.clientHeight).toBeLessThanOrEqual(1);
    expect(before.bottomDistance).toBeLessThanOrEqual(1);

    await increase.click();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const after = await messages.evaluate(element => ({
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      bottomDistance: element.scrollHeight - element.scrollTop - element.clientHeight,
    }));
    expect(after.scrollHeight - after.clientHeight).toBeGreaterThan(2);
    expect(after.bottomDistance).toBeLessThanOrEqual(2);
  });
});

for (const colorScheme of ["light", "dark"]) {
  test(`chat text size control matches the ${colorScheme} skin`, async ({ page }, testInfo) => {
    await page.emulateMedia({ colorScheme });
    await page.setViewportSize({ width: 430, height: 620 });
    await renderTextFixture(page, `text-size-${colorScheme}`);
    await page.locator("#btn-chat-text-size").click();
    await expect(page.locator("#chat-text-size-popover")).toBeVisible();
    await testInfo.attach(`chat-text-size-${colorScheme}.png`, {
      body: await page.screenshot(),
      contentType: "image/png",
    });
  });
}

async function renderTextFixture(page, sessionId) {
  const artifact = artifactEntry(sessionId);
  await page.evaluate(async ({ id, artifact }) => {
    await window.qingzhouConversationBenchmark.runSnapshotRender({
      sessionId: id,
      title: "对话字号预览",
      transcript: [
        { type: "user", text: "请解释这段包含较长文字的内容，并保持侧栏布局稳定。" },
        {
          type: "assistant",
          content: "## 阅读层级\n\n正文会随偏好缩放，`inline code`、标题和表格保持相同比例。\n\n| 项目 | 说明 |\n| --- | --- |\n| 对话字号 | 表格文字随正文一起缩放 |\n\n```js\nconst veryLongIdentifier = 'chat-text-size-must-wrap-without-horizontal-overflow';\n```",
        },
        {
          type: "thinking",
          spanId: `${id}-thinking`,
          runId: `${id}-run`,
          text: "先核对正文、表格和工具结果的排版比例。",
          phase: "done",
          streaming: false,
        },
        {
          type: "tool",
          toolCallId: `${id}-article`,
          runId: `${id}-run`,
          name: "read_article",
          args: { source: "article", limit: 8000 },
          result: {
            title: "工具面板字号",
            url: "https://example.com/article",
            text: "工具面板正文与 chip header 使用同一档对话字号。\n\n| 区域 | 行为 |\n| --- | --- |\n| Panel 表格 | 随对话字号缩放 |",
            totalChars: 26,
          },
          phase: "done",
          isRunning: false,
          isError: false,
        },
        artifact,
      ],
    });
  }, { id: sessionId, artifact });
}

async function renderLongFixture(page) {
  const artifact = artifactEntry("text-size-scroll");
  await page.evaluate(async artifact => {
    const transcript = Array.from({ length: 36 }, (_, index) => ({
      type: "assistant",
      content: `第 ${index + 1} 段内容。这里放置足够长的文字，用来验证改变对话字号时仍停留在同一阅读位置。`,
    }));
    transcript.splice(18, 0, artifact);
    await window.qingzhouConversationBenchmark.runSnapshotRender({
      sessionId: "text-size-scroll",
      title: "字号与滚动位置",
      transcript,
    });
  }, artifact);
}

function artifactEntry(sessionId) {
  return {
    type: "artifacts",
    summary: {
      sessionId,
      total: 2,
      signature: `${sessionId}:artifacts:2`,
      data: [{
        type: "data",
        title: "年度统计结果",
        meta: "5 行 4 列",
        timeLabel: "07-23 10:00",
      }],
      files: [{
        type: "file",
        title: "分析报告.html",
        meta: "html · 8.9 KB",
        timeLabel: "07-23 10:01",
      }],
    },
  };
}

async function visibleTranscriptAnchor(page) {
  return page.evaluate(() => {
    const messages = document.querySelector("#messages");
    const viewport = messages.getBoundingClientRect();
    const element = Array.from(messages.children).find(child => {
      if (!child.dataset.transcriptKey) return false;
      const rect = child.getBoundingClientRect();
      return rect.bottom > viewport.top + 2 && rect.top < viewport.bottom - 2;
    });
    return element ? { key: element.dataset.transcriptKey, top: element.getBoundingClientRect().top } : null;
  });
}

async function fontSize(locator) {
  return Number.parseFloat(await locator.evaluate(element => getComputedStyle(element).fontSize));
}

async function thinkingTextCenterDelta(summary) {
  return summary.evaluate(element => {
    const preview = element.querySelector(".thinking-group-preview");
    const track = element.querySelector(".thinking-group-preview-track");
    const previewRect = preview.getBoundingClientRect();
    const trackRect = track.getBoundingClientRect();
    return Math.abs(
      (previewRect.top + previewRect.bottom) / 2 - (trackRect.top + trackRect.bottom) / 2,
    );
  });
}

async function artifactActionCenterDelta(page) {
  return page.locator(".artifact-solid-btn").evaluate(button => {
    const row = button.closest(".artifact-strip-actions");
    const range = document.createRange();
    range.selectNodeContents(button);
    const rowRect = row.getBoundingClientRect();
    const textRect = range.getBoundingClientRect();
    return Math.abs(
      (rowRect.top + rowRect.bottom) / 2 - (textRect.top + textRect.bottom) / 2,
    );
  });
}
