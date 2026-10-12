import { expect, test } from "./sidepanel-fixtures.mjs";

for (const colorScheme of ["light", "dark"]) {
  test.describe(`session title editing · ${colorScheme}`, () => {
    test.use({ colorScheme, viewport: { width: 430, height: 620 } });

    test("edits in place without moving the chat layout", async ({ page }, testInfo) => {
      await page.evaluate(async () => {
        await window.qingzhouConversationBenchmark.runSnapshotRender({
          sessionId: "manual-title-session",
          title: "原始对话标题",
          transcript: [{ type: "assistant", content: "用于验证标题栏布局。" }],
        });
      });

      const bar = page.locator("#session-title-bar");
      const editor = page.locator(".session-title-editor");
      const trigger = page.locator("#btn-edit-session-title");
      const input = page.locator("#session-title-input");
      await expect(bar).toBeVisible();
      await expect(page.locator("#current-session-title")).toHaveText("原始对话标题");
      await expect(trigger.locator("svg")).toHaveCount(0);
      const displayHeight = await bar.evaluate(element => element.getBoundingClientRect().height);
      const titleLeft = await page.locator("#current-session-title").evaluate(element => element.getBoundingClientRect().left);
      const displayBounds = await page.locator("#current-session-title").evaluate(element => {
        const title = element.getBoundingClientRect();
        const trigger = element.parentElement.getBoundingClientRect();
        const editor = element.parentElement.parentElement.getBoundingClientRect();
        return {
          titleWidth: title.width,
          triggerWidth: trigger.width,
          editorWidth: editor.width,
        };
      });
      expect(displayBounds.triggerWidth - displayBounds.titleWidth).toBeGreaterThanOrEqual(0);
      expect(displayBounds.triggerWidth - displayBounds.titleWidth).toBeLessThanOrEqual(7);
      expect(displayBounds.triggerWidth).toBeLessThan(displayBounds.editorWidth - 20);

      const editorBox = await editor.boundingBox();
      await editor.click({ position: { x: editorBox.width - 2, y: editorBox.height / 2 } });
      await expect(input).toBeHidden();

      await trigger.click();
      await expect(input).toBeVisible();
      await expect(input).toBeFocused();
      await expect(input).toHaveValue("原始对话标题");
      const editHeight = await bar.evaluate(element => element.getBoundingClientRect().height);
      expect(Math.abs(editHeight - displayHeight)).toBeLessThanOrEqual(1);
      expect(await input.evaluate(element => element.getBoundingClientRect().width)).toBeLessThanOrEqual(320);
      const inplaceStyle = await input.evaluate(element => {
        const style = getComputedStyle(element);
        return {
          left: element.getBoundingClientRect().left,
          borderWidth: style.borderTopWidth,
          background: style.backgroundColor,
          shadow: style.boxShadow,
        };
      });
      expect(Math.abs(inplaceStyle.left - titleLeft)).toBeLessThanOrEqual(1);
      expect(inplaceStyle.borderWidth).toBe("0px");
      expect(inplaceStyle.background).toBe("rgba(0, 0, 0, 0)");
      expect(inplaceStyle.shadow).toBe("none");
      const editorScreenshot = await bar.screenshot();
      await testInfo.attach(`session-title-input-${colorScheme}.png`, {
        body: editorScreenshot,
        contentType: "image/png",
      });

      await input.fill("不会保存的标题");
      await input.press("Escape");
      await expect(input).toBeHidden();
      await expect(trigger).toBeFocused();
      await expect(page.locator("#current-session-title")).toHaveText("原始对话标题");

      await trigger.click();
      await input.fill("用户手动标题");
      await input.press("Enter");
      await expect(input).toBeHidden();
      await expect(page.locator("#current-session-title")).toHaveText("用户手动标题");

      await trigger.click();
      await input.fill("失焦保存标题");
      await input.blur();
      await expect(input).toBeHidden();
      await expect(page.locator("#current-session-title")).toHaveText("失焦保存标题");

      const renameRequest = await page.evaluate(() => (
        window.__qzPostedMessages.filter(message => message?.type === "rename_session").at(-1) || null
      ));
      expect(renameRequest).toMatchObject({
        type: "rename_session",
        sessionId: "manual-title-session",
        title: "失焦保存标题",
      });

      const layout = await bar.evaluate(element => ({
        width: element.clientWidth,
        scrollWidth: element.scrollWidth,
      }));
      expect(layout.scrollWidth).toBeLessThanOrEqual(layout.width);
      const screenshot = await bar.screenshot();
      await testInfo.attach(`session-title-edit-${colorScheme}.png`, {
        body: screenshot,
        contentType: "image/png",
      });
    });
  });
}

test.describe("session title editing failure", () => {
  test.use({ colorScheme: "light", viewport: { width: 430, height: 620 } });

  test("restores the persisted title when saving fails", async ({ page }) => {
    await page.evaluate(async () => {
      await window.qingzhouConversationBenchmark.runSnapshotRender({
        sessionId: "failed-title-session",
        title: "保留的标题",
        transcript: [{ type: "assistant", content: "保存失败后保持原状。" }],
      });
      window.__qzRenameSessionFailure = true;
    });

    await page.locator("#btn-edit-session-title").click();
    await page.locator("#session-title-input").fill("无法保存的标题");
    await page.locator("#session-title-input").press("Enter");
    await expect(page.locator("#session-title-input")).toBeHidden();
    await expect(page.locator("#current-session-title")).toHaveText("保留的标题");
    await expect(page.locator(".case-toast.visible")).toContainText("重命名失败：模拟保存失败");
  });
});
