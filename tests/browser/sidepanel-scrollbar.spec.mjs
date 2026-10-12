import { expect, test } from "./fixtures.mjs";
import { installBenchmarkChromeStub } from "./benchmark-chrome-stub.mjs";

for (const colorScheme of ["light", "dark"]) {
  test.describe(`sidepanel scrollbar · ${colorScheme}`, () => {
    test.use({ colorScheme, viewport: { width: 420, height: 700 } });

    test("uses the chat scrollbar language across resource panels", async ({ page }, testInfo) => {
      const sessions = Object.fromEntries(Array.from({ length: 30 }, (_, index) => {
        const id = `scrollbar-session-${index}`;
        return [id, {
          id,
          title: `滚动条测试任务 ${String(index + 1).padStart(2, "0")}`,
          parentSessionId: "0",
          createdAt: `2026-08-25 ${String(23 - (index % 24)).padStart(2, "0")}:00:00`,
          updatedAt: `2026-08-25 ${String(23 - (index % 24)).padStart(2, "0")}:00:00`,
        }];
      }));

      await page.goto("/__test_health");
      await page.evaluate(() => {
        localStorage.clear();
        localStorage.setItem("qingzhou_onboarding_v2", JSON.stringify({ status: "dismissed" }));
      });
      await page.addInitScript(installBenchmarkChromeStub, {
        localStorage: { _sessions: sessions },
      });
      await page.goto("/extension/sidepanel/sidepanel.html", { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => Boolean(window.qingzhouConversationBenchmark));

      await page.locator('button.tab-btn[data-tab="sessions"]').click();
      await expect(page.locator("#sessions-list")).toContainText("滚动条测试任务 01");

      const geometry = await page.evaluate(() => {
        const list = document.querySelector("#sessions-list");
        const chat = document.querySelector("#messages");
        const read = element => ({
          width: getComputedStyle(element, "::-webkit-scrollbar").width,
          height: getComputedStyle(element, "::-webkit-scrollbar").height,
          radius: getComputedStyle(element, "::-webkit-scrollbar-thumb").borderRadius,
        });
        return {
          isScrollable: list.scrollHeight > list.clientHeight,
          list: read(list),
          chat: read(chat),
        };
      });
      expect(geometry.isScrollable).toBe(true);
      expect(geometry.list).toEqual(geometry.chat);
      expect(geometry.list).toEqual({ width: "4px", height: "4px", radius: "2px" });

      await page.locator("#sessions-list").hover();
      const listThumbColor = await page.locator("#sessions-list").evaluate(element => (
        getComputedStyle(element, "::-webkit-scrollbar-thumb").backgroundColor
      ));
      expect(listThumbColor).not.toBe("rgba(0, 0, 0, 0)");

      await page.locator("#sessions-list").evaluate(element => {
        element.scrollTop = (element.scrollHeight - element.clientHeight) / 2;
      });
      await testInfo.attach(`sidepanel-scrollbar-${colorScheme}.png`, {
        body: await page.screenshot(),
        contentType: "image/png",
      });

      await page.locator('button.tab-btn[data-tab="chat"]').click();
      await page.locator("#messages").hover();
      const chatThumbColor = await page.locator("#messages").evaluate(element => (
        getComputedStyle(element, "::-webkit-scrollbar-thumb").backgroundColor
      ));
      expect(listThumbColor).toBe(chatThumbColor);

      const generic = await page.evaluate(() => {
        const element = document.createElement("div");
        element.className = "qz-scroll";
        document.body.append(element);
        const read = () => ({ width: getComputedStyle(element, "::-webkit-scrollbar").width,
          radius: getComputedStyle(element, "::-webkit-scrollbar-thumb").borderRadius,
          scrollbarWidth: getComputedStyle(element).scrollbarWidth });
        const quiet = read();
        element.classList.add("qz-scroll--native");
        const native = read();
        element.remove();
        return { quiet, native };
      });
      expect(generic.quiet).toEqual({ width: "4px", radius: "2px", scrollbarWidth: "thin" });
      expect(generic.native.scrollbarWidth).toBe("auto");

      await page.evaluate(async () => {
        const store = await import("/extension/shared/data-store.js");
        await store.insertDataRows("scroll_grid", [{ value: "row" }]);
        await store.insertDataRows("scroll_images", [{ title: "image" }]);
        await store.updateDataTableMetadata("scroll_images", { kind: "image_collection", assetKind: "image" });
      });
      await page.locator('.tab-btn[data-tab="data"]').click();
      for (const [table, native] of [["scroll_grid", true], ["scroll_images", false], ["scroll_grid", true]]) {
        await page.locator("#data-table-search").click();
        await page.locator(`.data-table-select[data-table="${table}"]`).click();
        await expect(page.locator("#data-table-search")).toHaveValue(table);
        await expect.poll(() => page.locator("#data-preview").evaluate(element => ({
          grid: element.classList.contains("grid-mode"), native: element.classList.contains("qz-scroll--native"),
          scrollbarWidth: getComputedStyle(element).scrollbarWidth,
        }))).toEqual({ grid: native, native, scrollbarWidth: native ? "auto" : "thin" });
      }
    });

    test("streaming profiles preserve shell clipping before their content is available", async ({ page }) => {
      await page.goto("/tests/tool-timeline/visual-test.html");
      await page.waitForFunction(() => Boolean(window.visualTimelineTest));
      for (const name of ["run_script", "create_skill", "edit_skill_resource", "update_skill", "save_file", "get_ax_tree"]) {
        const style = await page.evaluate(tool => {
          window.visualTimelineTest.debugToolVariantCase(tool, "running");
          const computed = getComputedStyle(document.querySelector(".tool-details"));
          return { maxHeight: computed.maxHeight, overflowY: computed.overflowY, gutter: computed.scrollbarGutter };
        }, name);
        expect(style, name).toEqual(name === "get_ax_tree"
          ? { maxHeight: "294px", overflowY: "auto", gutter: "stable" }
          : { maxHeight: "none", overflowY: "visible", gutter: name === "run_script" ? "auto" : "stable" });
      }
    });
  });
}
