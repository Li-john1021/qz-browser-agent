import { expect, test } from "./fixtures.mjs";

const variants = [
  { name: "narrow light", colorScheme: "light", viewport: { width: 340, height: 720 } },
  { name: "wide light", colorScheme: "light", viewport: { width: 820, height: 620 } },
  { name: "narrow dark", colorScheme: "dark", viewport: { width: 340, height: 720 } },
  { name: "wide dark", colorScheme: "dark", viewport: { width: 820, height: 620 } },
];

test("unmount cancels queued and visible dialogs without closing another owner's dialog", async ({ page }) => {
  await page.goto("/__test_health");
  await page.evaluate(async () => {
    const [{ createDecisionDialogFeature }, { createSidepanelUiRuntime }, { createWorkspaceExtensions }] = await Promise.all([
      import("/extension/sidepanel/ui/decision-dialog-feature.js"),
      import("/extension/sidepanel/capability-host/runtime.js"),
      import("/extension/sidepanel/features/app/workspace-extensions.js"),
    ]);
    const dialogs = createDecisionDialogFeature({ root: document });
    const runtime = createSidepanelUiRuntime({ host: { root: document, settings: {}, extensions: createWorkspaceExtensions(), dialogs } });
    const scopes = {};
    for (const id of ["queued", "visible"]) runtime.mount({ id, mount(host) { scopes[id] = host; return {}; } });
    window.__dialogLifetime = { runtime, scopes, results: {} };
    void dialogs.confirm({ title: "Other owner" }).then(value => { window.__dialogLifetime.results.other = value; });
    void scopes.queued.dialogs.choose({ title: "Cancelled queue" }).then(value => { window.__dialogLifetime.results.queued = value; });
    void scopes.visible.dialogs.confirm({ title: "Next owner" }).then(value => { window.__dialogLifetime.results.visible = value; });
  });
  await expect(page.locator("#qz-decision-title")).toHaveText("Other owner");
  await page.evaluate(() => window.__dialogLifetime.runtime.unmount("queued"));
  await expect.poll(() => page.evaluate(() => window.__dialogLifetime.results.queued)).toBe(null);
  await expect(page.locator("#qz-decision-title")).toHaveText("Other owner");
  await page.locator("#qz-decision-cancel").click();
  await expect(page.locator("#qz-decision-title")).toHaveText("Next owner");
  await page.evaluate(() => window.__dialogLifetime.runtime.unmount("visible"));
  await expect(page.locator("#qz-decision-dialog")).not.toBeVisible();
  expect(await page.evaluate(() => window.__dialogLifetime.results)).toEqual({ other: false, queued: null, visible: false });
  expect(await page.evaluate(() => window.__dialogLifetime.scopes.visible.dialogs.requestText({ title: "Too late" }))).toBe(null);
  await expect(page.locator("#qz-decision-dialog")).not.toBeVisible();
});

test("owner cancellation overrides a confirmation during its closing animation", async ({ page }) => {
  await page.goto("/__test_health");
  await page.evaluate(async () => {
    const { createDecisionDialogFeature } = await import("/extension/sidepanel/ui/decision-dialog-feature.js");
    const dialogs = createDecisionDialogFeature({ root: document, shouldReduceMotion: () => false });
    window.__dialogOwner = new AbortController();
    window.__cancelledAnswer = "pending";
    void dialogs.confirm({ title: "Pending confirmation", signal: window.__dialogOwner.signal })
      .then(result => { window.__cancelledAnswer = result; });
  });
  await expect(page.locator("#qz-decision-dialog")).toBeVisible();
  await page.evaluate(() => {
    document.querySelector("#qz-decision-confirm").click();
    window.__dialogOwner.abort();
  });
  await expect.poll(() => page.evaluate(() => window.__cancelledAnswer)).toBe(false);
  await expect(page.locator("#qz-decision-dialog")).not.toBeVisible();
});

for (const variant of variants) {
  test.describe(`decision dialog · ${variant.name}`, () => {
    test.use({ viewport: variant.viewport, colorScheme: variant.colorScheme });

    test("stays quiet, centered and keyboard-safe", async ({ page }, testInfo) => {
      await page.goto("/tests/git-skill-source/probe.html", { waitUntil: "domcontentloaded" });
      await page.evaluate(async () => {
        document.head.innerHTML = '<meta charset="utf-8">';
        const link = document.createElement("link");
        link.rel = "stylesheet";
        link.href = "/extension/sidepanel/sidepanel.css";
        document.head.append(link);
        await new Promise((resolve, reject) => {
          link.addEventListener("load", resolve, { once: true });
          link.addEventListener("error", reject, { once: true });
        });
        document.body.innerHTML = '<button id="decision-opener" class="qz-btn qz-btn--secondary" type="button">解除绑定</button>';
        document.body.style.margin = "0";
        document.body.style.padding = "16px";
        const module = await import("/extension/sidepanel/ui/decision-dialog-feature.js");
        window.__decision = module.createDecisionDialogFeature({ root: document });
        document.querySelector("#decision-opener").addEventListener("click", () => {
          window.__decisionResult = "pending";
          void window.__decision.confirm({
            title: "覆盖本地修改？",
            message: "继续后会以仓库版本覆盖当前修改。",
            confirmLabel: "继续覆盖",
            tone: "danger",
          }).then(result => { window.__decisionResult = result; });
        });
      });

      await page.locator("#decision-opener").click();
      await expect(page.locator("#qz-decision-dialog")).toBeVisible();
      const metrics = await page.evaluate(() => {
        const dialog = document.querySelector("#qz-decision-dialog");
        const panel = dialog.querySelector(".qz-decision-panel");
        const confirm = dialog.querySelector("#qz-decision-confirm");
        const bounds = panel.getBoundingClientRect();
        const panelStyle = getComputedStyle(panel);
        const confirmStyle = getComputedStyle(confirm);
        return {
          pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          panelWidth: bounds.width,
          panelContained: bounds.left >= 0 && bounds.right <= document.documentElement.clientWidth,
          panelCenterY: bounds.top + bounds.height / 2,
          viewportCenterY: document.documentElement.clientHeight / 2,
          surface: panelStyle.backgroundImage,
          shadow: panelStyle.boxShadow,
          borderBalanced: panelStyle.borderLeftColor === panelStyle.borderTopColor
            && panelStyle.borderLeftWidth === panelStyle.borderTopWidth,
          dangerFill: confirmStyle.backgroundColor,
          cancelFocused: document.activeElement?.id === "qz-decision-cancel",
        };
      });
      expect(metrics.pageOverflow).toBe(0);
      expect(metrics.panelWidth).toBeLessThanOrEqual(360);
      expect(metrics.panelContained).toBe(true);
      expect(metrics.panelCenterY).toBeLessThan(metrics.viewportCenterY);
      expect(metrics.panelCenterY).toBeGreaterThan(metrics.viewportCenterY - 48);
      expect(metrics.surface).not.toBe("none");
      expect(metrics.shadow).not.toBe("none");
      expect(metrics.borderBalanced).toBe(true);
      expect(metrics.dangerFill).toBe("rgba(0, 0, 0, 0)");
      expect(metrics.cancelFocused).toBe(true);

      const screenshot = await page.screenshot({ fullPage: true });
      await testInfo.attach("decision-confirm.png", { body: screenshot, contentType: "image/png" });

      await page.locator("#qz-decision-cancel").click();
      await expect.poll(() => page.evaluate(() => window.__decisionResult)).toBe(false);
      await expect(page.locator("#decision-opener")).toBeFocused();

      await page.evaluate(() => {
        window.__decisionResult = "pending";
        void window.__decision.choose({
          title: "解除 testlib？",
          message: "本地修改会保留，不会被自动删除。",
          choices: [
            { value: "keep", label: "保留 Skill", description: "仅解除仓库关系，已安装内容继续保留。" },
            { value: "delete", label: "清除未修改项", description: "本地修改仍会保留。", tone: "danger" },
          ],
        }).then(result => { window.__decisionResult = result; });
      });
      await expect(page.locator("#qz-decision-dialog")).toBeVisible();
      await expect(page.locator("#qz-decision-confirm")).not.toBeVisible();
      await expect(page.locator('[data-qz-decision-value="keep"]')).toBeFocused();
      await page.locator('[data-qz-decision-value="keep"]').click();
      await expect.poll(() => page.evaluate(() => window.__decisionResult)).toBe("keep");
      await expect(page.locator("#decision-opener")).toBeFocused();

      await page.evaluate(() => {
        window.__decisionResult = "pending";
        void window.__decision.requestText({
          title: "新增字段",
          inputLabel: "字段名",
          confirmLabel: "新增",
          maxLength: 128,
        }).then(result => { window.__decisionResult = result; });
      });
      await expect(page.locator("#qz-decision-dialog")).toBeVisible();
      const input = page.locator("[data-qz-decision-input]");
      await expect(input).toBeFocused();
      await expect(page.locator("#qz-decision-confirm")).toBeDisabled();
      await input.fill("city");
      await page.keyboard.press("Enter");
      await expect.poll(() => page.evaluate(() => window.__decisionResult)).toBe("city");
      await expect(page.locator("#decision-opener")).toBeFocused();
    });
  });
}
