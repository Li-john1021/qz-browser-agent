import { expect, test } from "./fixtures.mjs";

for (const skin of ["sidepanel.css"]) {
  for (const colorScheme of ["light", "dark"]) {
    test.describe(`Git skill publish UI · ${skin} · ${colorScheme}`, () => {
      test.use({ viewport: { width: 390, height: 844 }, colorScheme });

      test("keeps the command and atomic confirmation compact", async ({ page }) => {
        await page.goto("/tests/git-skill-source/probe.html", { waitUntil: "domcontentloaded" });
        await page.evaluate(async (skinName) => {
          document.head.innerHTML = '<meta charset="utf-8">';
          const link = document.createElement("link");
          link.rel = "stylesheet";
          link.href = `/extension/sidepanel/${skinName}`;
          document.head.appendChild(link);
          await new Promise((resolve, reject) => {
            link.addEventListener("load", resolve, { once: true });
            link.addEventListener("error", reject, { once: true });
          });
          const html = await fetch("/extension/sidepanel/sidepanel.html").then(response => response.text());
          const parsed = new DOMParser().parseFromString(html, "text/html");
          const detail = parsed.querySelector("#skill-detail");
          detail.classList.remove("hidden");
          detail.querySelector("#skill-detail-name").textContent = "发布测试";
          detail.querySelector("#btn-publish-skill-git").classList.remove("hidden");
          detail.querySelector("#skill-actions-menu").classList.remove("hidden");
          detail.querySelector("#skill-git-publish-confirm").classList.remove("hidden");
          detail.querySelector("#skill-git-publish-repository").textContent = "example-user/testlib";
          detail.querySelector("#skill-git-publish-path").textContent = "skills/browser/interaction/publish-smoke";
          detail.querySelector("#skill-git-publish-meta").textContent = "master · 3 个文件";
          detail.querySelector("#skill-git-publish-message").value = "feat(skill): publish publish-smoke";
          document.body.replaceChildren(document.importNode(detail, true));
          document.body.style.width = "100vw";
          document.body.style.height = "100vh";
          document.body.style.margin = "0";
          document.body.style.display = "flex";
        }, skin);
        await page.waitForFunction(() => document.getAnimations().every(animation => animation.playState === "finished"));

        const sheetBox = await page.locator(".skill-git-publish-sheet").boundingBox();
        expect(sheetBox).not.toBeNull();
        await page.mouse.move(sheetBox.x + sheetBox.width / 2, sheetBox.y + sheetBox.height / 2);
        const backdropBackground = await page.locator(".skill-git-publish-backdrop").evaluate(element => getComputedStyle(element).backgroundColor);

        const metrics = await page.evaluate(() => {
          const detail = document.querySelector("#skill-detail");
          const header = detail.querySelector(".skill-detail-header");
          const publish = detail.querySelector("#btn-publish-skill-git");
          const save = detail.querySelector("#btn-save-skill-edit-top");
          const confirm = detail.querySelector("#skill-git-publish-confirm");
          const backdrop = confirm.querySelector(".skill-git-publish-backdrop");
          const sheet = confirm.querySelector(".skill-git-publish-sheet");
          const message = confirm.querySelector("#skill-git-publish-message");
          const actionsMenu = detail.querySelector("#skill-actions-menu");
          const sheetStyle = getComputedStyle(sheet);
          const confirmRect = confirm.getBoundingClientRect();
          const backdropRect = backdrop.getBoundingClientRect();
          const exposedBackdropY = Math.max(confirmRect.top + 1, Math.min(sheet.getBoundingClientRect().top - 1, confirmRect.top + confirmRect.height / 2));
          return {
            pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            detailOverflow: detail.scrollWidth - detail.clientWidth,
            publishBeforeSave: publish.getBoundingClientRect().left < save.getBoundingClientRect().left,
            commandHeight: publish.offsetHeight,
            sheetContained: sheet.getBoundingClientRect().left >= 0
              && sheet.getBoundingClientRect().right <= document.documentElement.clientWidth,
            sheetBottomAligned: Math.abs(sheet.getBoundingClientRect().bottom - detail.getBoundingClientRect().bottom) < 1,
            backdropEdgeDelta: Math.max(
              Math.abs(backdropRect.top - confirmRect.top),
              Math.abs(backdropRect.right - confirmRect.right),
              Math.abs(backdropRect.bottom - confirmRect.bottom),
              Math.abs(backdropRect.left - confirmRect.left),
            ),
            backdropOwnsExposedSurface: document.elementFromPoint(confirmRect.left + confirmRect.width / 2, exposedBackdropY) === backdrop,
            headerContained: header.scrollWidth <= header.clientWidth,
            actionsMenuContained: actionsMenu.getBoundingClientRect().left >= header.getBoundingClientRect().left
              && actionsMenu.getBoundingClientRect().right <= header.getBoundingClientRect().right,
            actionsUseSharedMenu: actionsMenu.classList.contains("qz-popover")
              && actionsMenu.classList.contains("qz-menu")
              && actionsMenu.querySelectorAll(".qz-menu-item").length === 3,
            messageWidth: message.getBoundingClientRect().width,
            sheetWidth: sheet.getBoundingClientRect().width,
            surfaceOpaque: sheetStyle.backgroundImage !== "none" || sheetStyle.backgroundColor !== "rgba(0, 0, 0, 0)",
            scopeLabelAbsent: !detail.querySelector("#skill-detail-scope"),
          };
        });
        expect(metrics.pageOverflow).toBe(0);
        expect(metrics.detailOverflow).toBe(0);
        expect(metrics.publishBeforeSave).toBe(true);
        expect(metrics.commandHeight).toBeLessThanOrEqual(34);
        expect(metrics.sheetContained).toBe(true);
        expect(metrics.sheetBottomAligned).toBe(true);
        expect(metrics.backdropEdgeDelta).toBeLessThanOrEqual(0.5);
        expect(metrics.backdropOwnsExposedSurface).toBe(true);
        expect(metrics.headerContained).toBe(true);
        expect(metrics.actionsMenuContained).toBe(true);
        expect(metrics.actionsUseSharedMenu).toBe(true);
        expect(metrics.messageWidth).toBeLessThanOrEqual(metrics.sheetWidth - 28 + 0.5);
        expect(metrics.surfaceOpaque).toBe(true);
        expect(metrics.scopeLabelAbsent).toBe(true);

        await page.locator(".skill-git-publish-backdrop").hover({ position: { x: 8, y: 8 } });
        await expect.poll(() => page.locator(".skill-git-publish-backdrop").evaluate(element => getComputedStyle(element).backgroundColor)).toBe(backdropBackground);
      });
    });
  }
}

test.describe("Git skill publish narrow layout", () => {
  test.use({ viewport: { width: 320, height: 640 } });

  test("collapses the Git and Save labels without horizontal overflow", async ({ page }) => {
    await page.goto("/tests/git-skill-source/probe.html", { waitUntil: "domcontentloaded" });
    await page.evaluate(async () => {
      document.head.innerHTML = '<meta charset="utf-8"><link rel="stylesheet" href="/extension/sidepanel/sidepanel.css">';
      await new Promise(resolve => document.querySelector("link").addEventListener("load", resolve, { once: true }));
      const html = await fetch("/extension/sidepanel/sidepanel.html").then(response => response.text());
      const parsed = new DOMParser().parseFromString(html, "text/html");
      const detail = parsed.querySelector("#skill-detail");
      detail.classList.remove("hidden");
      detail.querySelector("#skill-detail-name").textContent = "A very long Skill title that must yield";
      detail.querySelector("#btn-publish-skill-git").classList.remove("hidden");
      document.body.replaceChildren(document.importNode(detail, true));
      document.body.style.width = "100vw";
      document.body.style.height = "100vh";
      document.body.style.margin = "0";
      document.body.style.display = "flex";
    });
    const metrics = await page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      publishWidth: document.querySelector("#btn-publish-skill-git").offsetWidth,
      saveWidth: document.querySelector("#btn-save-skill-edit-top").offsetWidth,
      publishLabelDisplay: getComputedStyle(document.querySelector("#btn-publish-skill-git span")).display,
      saveLabelDisplay: getComputedStyle(document.querySelector("#btn-save-skill-edit-top span:last-child")).display,
    }));
    expect(metrics.overflow).toBe(0);
    expect(metrics.publishWidth).toBe(32);
    expect(metrics.saveWidth).toBe(32);
    expect(metrics.publishLabelDisplay).toBe("none");
    expect(metrics.saveLabelDisplay).toBe("none");
  });
});
