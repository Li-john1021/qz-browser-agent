import { expect, test } from "./sidepanel-fixtures.mjs";

for (const colorScheme of ["light", "dark"]) {
  test.describe(`Skill transfer feedback · ${colorScheme}`, () => {
    test.use({ colorScheme, viewport: { width: 430, height: 800 } });

    test("keeps a successful export silent", async ({ page }, testInfo) => {
      await page.evaluate(() => {
        document.querySelectorAll(".tab-panel").forEach(panel => panel.classList.add("hidden"));
        document.querySelector("#skills-panel")?.classList.remove("hidden");
      });
      await page.locator("#btn-export-skills").click();

      await expect(page.locator("#skills-status")).toHaveCount(0);
      await expect(page.locator(".skills-toolbar")).not.toContainText("已导出 0 个技能");
      await expect(page.locator(".case-toast")).toBeHidden();

      await testInfo.attach(`skill-export-silent-${colorScheme}.png`, {
        body: await page.screenshot(),
        contentType: "image/png",
      });
    });

    test("refreshes the list without a success toast after import", async ({ page }) => {
      await page.evaluate(async () => {
        document.querySelectorAll(".tab-panel").forEach(panel => panel.classList.add("hidden"));
        document.querySelector("#skills-panel")?.classList.remove("hidden");
        const { exportSkillsZip } = await import("/extension/shared/skills/skill-package.js");
        const archive = await exportSkillsZip([{
          name: "silent-import",
          description: "Import feedback fixture.",
          content: "# Silent import",
        }]);
        const file = new File([await archive.arrayBuffer()], "silent-import.zip", { type: "application/zip" });
        const input = document.querySelector("#skills-import-file");
        Object.defineProperty(input, "files", { configurable: true, value: [file] });
        input.dispatchEvent(new Event("change", { bubbles: true }));
      });

      const request = await page.waitForFunction(() => (
        window.__qzPostedMessages.find(message => (
          message.type === "import_workspace_skills"
          && message.skills[0].name === "silent-import"
        )) || null
      )).then(handle => handle.jsonValue());
      await page.evaluate(({ requestId, skills }) => {
        window.__qzEmitPortMessage({
          type: "skill_workspace_imported",
          skills, installStates: {}, registryReady: true,
          requestId,
          ok: true,
        });
      }, request);

      await expect(page.locator('.skill-card[data-name="silent-import"]')).toBeVisible();
      await expect(page.locator(".case-toast")).toBeHidden();
    });
  });
}
