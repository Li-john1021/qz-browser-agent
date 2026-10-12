import { expect, test } from "./fixtures.mjs";

// Keep the built markup, utility classes and skin together. Only application
// startup is omitted: these checks exercise the cascade, not Chrome transport.
async function openCapability(page, panelId) {
  await page.route("**/extension/sidepanel/sidepanel.html", async route => {
    const response = await route.fetch();
    const html = (await response.text()).replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, "");
    await route.fulfill({ response, body: html });
  });
  await page.goto("/extension/sidepanel/sidepanel.html");
  await page.evaluate(id => {
    document.getElementById("app").removeAttribute("data-workspace-booting");
    for (const element of document.querySelectorAll("#messages, #chat-dock, #session-title-bar")) {
      element.classList.add("hidden");
    }
    for (const panel of document.querySelectorAll(".tab-panel")) {
      panel.classList.toggle("hidden", panel.id !== id);
    }
    if (id === "skills-panel") {
      document.querySelector(".skills-toolbar").classList.add("hidden");
      document.getElementById("skills-list").classList.add("hidden");
      document.getElementById("skill-detail").classList.remove("hidden");
    } else {
      document.getElementById("data-empty").classList.add("hidden");
      document.getElementById("data-detail").classList.remove("hidden");
    }
  }, panelId);
  await expect(page.locator(`#${panelId}`)).toBeVisible();
}

for (const colorScheme of ["light", "dark"]) {
  test.describe(colorScheme, () => {
    test.use({ colorScheme, viewport: { width: 660, height: 800 } });

    test("Skill workbench keeps scrolling in the editor textarea", async ({ page }) => {
      await openCapability(page, "skills-panel");
      await page.evaluate(() => {
        document.getElementById("skill-content-preview").classList.add("hidden");
        document.getElementById("skill-editor").classList.remove("hidden");
      });
      const editor = page.locator("#skill-editor");
      const textarea = page.locator("#skill-body-text");
      await expect(textarea).toBeVisible();
      // The enclosing workbench overrides the generic editor's overflow:auto.
      await expect(editor).toHaveCSS("overflow-y", "hidden");
      await expect(textarea).toHaveCSS("overflow-y", "auto");
      await textarea.fill(Array.from({ length: 100 }, (_, i) => `Skill line ${i + 1}`).join("\n"));
      const scroll = await textarea.evaluate(element => {
        element.scrollTop = 80;
        return { top: element.scrollTop, height: element.clientHeight, content: element.scrollHeight };
      });
      expect(scroll.height).toBeGreaterThan(0);
      expect(scroll.content).toBeGreaterThan(scroll.height);
      expect(scroll.top).toBe(80);
      expect(await editor.evaluate(element => element.scrollTop)).toBe(0);
    });

    test("Skill settings apply compact padding only at the narrow breakpoint", async ({ page }) => {
      await openCapability(page, "skills-panel");
      await page.locator("#skill-settings-view").evaluate(element => element.classList.remove("hidden"));
      const settings = page.locator(".skill-settings-scroll");
      await expect(settings).toBeVisible();
      // Re-enter the compact width to catch stale state as well as both edges.
      for (const [width, padding] of [[380, "10px"], [381, "14px"], [660, "14px"], [380, "10px"]]) {
        await page.setViewportSize({ width, height: 800 });
        await expect(settings).toHaveCSS("padding-left", padding);
        await expect(settings).toHaveCSS("padding-right", padding);
      }
    });

    test("Data controls stretch only in the compact single-column layout", async ({ page }) => {
      await openCapability(page, "data-panel");
      const controls = page.locator(".data-table-controls");
      await expect(controls).toBeVisible();
      for (const [width, alignment, columns] of [[520, "stretch", 1], [521, "normal", 2], [660, "normal", 2], [520, "stretch", 1]]) {
        await page.setViewportSize({ width, height: 800 });
        await expect(controls).toHaveCSS("align-items", alignment);
        expect(await controls.evaluate(element => getComputedStyle(element).gridTemplateColumns.split(" ").length)).toBe(columns);
      }
    });
  });
}
