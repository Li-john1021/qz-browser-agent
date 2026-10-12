import { expect, test } from "./fixtures.mjs";

for (const colorScheme of ["light", "dark"]) {
  test.describe(`shared Toast · ${colorScheme}`, () => {
    test.use({ viewport: { width: 430, height: 800 }, colorScheme });

    test("keeps error copy and controls on one aligned token grid", async ({ page }) => {
      await mountToastProbe(page);
      await page.evaluate(() => {
        window.__toastActionCount = 0;
        window.__toastFeature.show("无法读取 main 分支，请确认权限。", {
          title: "仓库绑定未完成",
          tone: "error",
          durationMs: 0,
          key: "browser-error",
          actionLabel: "重试",
          onAction: () => { window.__toastActionCount += 1; },
        });
      });

      const toast = page.locator(".case-toast");
      await expect(toast).toHaveClass(/visible/);
      const metrics = await toast.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const centerY = rect.top + rect.height / 2;
        const part = selector => element.querySelector(selector)?.getBoundingClientRect();
        const icon = part(".case-toast-icon");
        const title = part(".case-toast-title");
        const message = part(".case-toast-message");
        const action = part(".case-toast-action");
        const close = part(".case-toast-close");
        const style = getComputedStyle(element);
        return {
          top: rect.top,
          left: rect.left,
          right: rect.right,
          height: rect.height,
          centerY,
          iconCenterY: icon.top + icon.height / 2,
          actionCenterY: action.top + action.height / 2,
          closeCenterY: close.top + close.height / 2,
          titleTop: title.top,
          titleHeight: title.height,
          messageTop: message.top,
          messageHeight: message.height,
          background: style.backgroundColor,
          radius: style.borderRadius,
          role: element.getAttribute("role"),
          live: element.getAttribute("aria-live"),
          count: document.querySelectorAll(".case-toast").length,
          overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        };
      });

      expect(metrics.top).toBeCloseTo(66, 0);
      expect(metrics.left).toBeGreaterThanOrEqual(16);
      expect(metrics.right).toBeLessThanOrEqual(414);
      expect(metrics.height).toBeLessThanOrEqual(42);
      expect(Math.abs(metrics.iconCenterY - metrics.centerY)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(metrics.actionCenterY - metrics.centerY)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(metrics.closeCenterY - metrics.centerY)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(metrics.titleTop - metrics.messageTop)).toBeLessThanOrEqual(0.5);
      expect(metrics.titleHeight).toBe(metrics.messageHeight);
      expect(metrics.background).toBe(colorScheme === "light" ? "rgb(23, 23, 23)" : "rgb(43, 43, 43)");
      expect(metrics.radius).toBe("4px");
      expect(metrics.role).toBe("alert");
      expect(metrics.live).toBe("assertive");
      expect(metrics.count).toBe(1);
      expect(metrics.overflow).toBe(0);

      const action = page.locator(".case-toast-action");
      await expect(action).toBeVisible();
      await action.click();
      await expect(toast).not.toHaveClass(/visible/);
      expect(await page.evaluate(() => window.__toastActionCount)).toBe(1);
    });
  });
}

test.describe("shared Toast narrow and long states", () => {
  test.use({ viewport: { width: 340, height: 640 }, colorScheme: "light" });

  test("reuses one surface for short, anchored, and goal feedback", async ({ page }) => {
    await mountToastProbe(page);
    await page.evaluate(() => {
      window.__toastFeature.show("已开始下载文件。", {
        durationMs: 0,
        dismissible: false,
        key: "short",
      });
      window.__toastFeature.show("目标仍在运行，当前已完成 18 项，还剩 7 项等待处理。", {
        durationMs: 0,
        key: "goal",
        variant: "goal-status",
      });
    });

    const toast = page.locator(".case-toast");
    await expect(toast).toHaveClass(/goal-status-toast/);
    const metrics = await toast.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return {
        count: document.querySelectorAll(".case-toast").length,
        left: rect.left,
        right: rect.right,
        height: rect.height,
        top: rect.top,
        background: getComputedStyle(element).backgroundColor,
        actionHidden: element.querySelector(".case-toast-action").hidden,
        closeHidden: element.querySelector(".case-toast-close").hidden,
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    });
    expect(metrics.count).toBe(1);
    expect(metrics.left).toBeGreaterThanOrEqual(16);
    expect(metrics.right).toBeLessThanOrEqual(324);
    expect(metrics.height).toBeGreaterThanOrEqual(40);
    expect(metrics.top).toBeCloseTo(66, 0);
    expect(metrics.background).toBe("rgb(23, 23, 23)");
    expect(metrics.actionHidden).toBe(true);
    expect(metrics.closeHidden).toBe(false);
    expect(metrics.overflow).toBe(0);

    await page.evaluate(() => {
      const anchor = document.createElement("button");
      anchor.type = "button";
      anchor.style.position = "fixed";
      anchor.style.left = "154px";
      anchor.style.top = "180px";
      anchor.style.width = "32px";
      anchor.style.height = "28px";
      document.body.appendChild(anchor);
      window.__toastFeature.show("暂时无法确认这个页面元素。", {
        tone: "error",
        durationMs: 0,
        dismissible: false,
        anchorEl: anchor,
        key: "anchored",
      });
    });
    await expect(toast).toHaveClass(/anchored/);
    const anchored = await toast.evaluate((element) => ({
      count: document.querySelectorAll(".case-toast").length,
      top: element.getBoundingClientRect().top,
      background: getComputedStyle(element).backgroundColor,
    }));
    expect(anchored.count).toBe(1);
    expect(anchored.top).toBeCloseTo(216, 0);
    expect(anchored.background).toBe("rgb(23, 23, 23)");
  });
});

async function mountToastProbe(page) {
  await page.goto("/tests/git-skill-source/probe.html", { waitUntil: "domcontentloaded" });
  await page.evaluate(async () => {
    document.head.innerHTML = '<meta charset="utf-8">';
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "/extension/sidepanel/sidepanel.css";
    document.head.appendChild(link);
    await new Promise((resolve, reject) => {
      link.addEventListener("load", resolve, { once: true });
      link.addEventListener("error", reject, { once: true });
    });
    document.body.replaceChildren();
    document.body.style.width = "100vw";
    document.body.style.height = "100vh";
    const module = await import("/extension/sidepanel/ui/toast-feature.js");
    window.__toastFeature = module.createToastFeature({ root: document });
  });
}
