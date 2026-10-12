import { expect, test } from "./fixtures.mjs";
import { prepareAuditControl } from "../benchmarks/conversation-render/visual-audit.mjs";

test("historical controls receive real scroll intent before hovering and clicking", async ({ page }) => {
  await preparePage(page);
  const target = page.locator("#edit");
  expect((await target.boundingBox()).y).toBeLessThan(0);
  const result = await prepareAuditControl(page, target);
  expect(result.ready).toBe(true);
  expect(result.wheelCount).toBe(1);
  expect(result.stableMs).toBeGreaterThanOrEqual(64);
  await target.click();
  const state = await page.evaluate(() => window.auditFixture);
  expect(state.trustedWheel).toBe(true);
  expect(state.clicks).toBe(1);
  expect(state.clickTop).toBeGreaterThanOrEqual(20);
});

test("a control that keeps snapping out of view fails preparation", async ({ page }) => {
  await preparePage(page, { persistentSnap: true });
  const result = await prepareAuditControl(page, page.locator("#edit"));
  expect(result.ready).toBe(false);
  expect(result.error).toContain("visible and stable");
  expect(await page.evaluate(() => window.auditFixture.clicks)).toBe(0);
});

test("positioning a control does not bypass an actual obstruction", async ({ page }) => {
  await preparePage(page);
  const target = page.locator("#edit");
  expect((await prepareAuditControl(page, target)).ready).toBe(true);
  await page.evaluate(() => {
    const rect = document.querySelector("#edit").getBoundingClientRect();
    const blocker = document.createElement("div");
    blocker.style.cssText = `position:fixed;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;z-index:100;background:red`;
    document.body.append(blocker);
  });
  expect((await prepareAuditControl(page, target)).ready).toBe(true);
  await expect(target.click({ timeout: 250 })).rejects.toThrow();
  expect(await page.evaluate(() => window.auditFixture.clicks)).toBe(0);
});

async function preparePage(page, { persistentSnap = false } = {}) {
  await page.setViewportSize({ width: 430, height: 600 });
  await page.setContent(`
    <style>
      body { margin: 0; }
      #messages { margin: 20px; height: 300px; padding: 20px; overflow: auto; }
      .message { height: 50px; }
      button { width: 60px; height: 30px; opacity: 0; pointer-events: none; }
      .message:hover button { opacity: 1; pointer-events: auto; }
      #tail { height: 2400px; }
    </style>
    <main id="messages"><div class="message"><button id="edit">Edit</button></div><div id="tail"></div></main>
  `);
  await page.evaluate(persistentSnap => {
    const state = window.auditFixture = { following: true, trustedWheel: false, clicks: 0 };
    const messages = document.querySelector("#messages");
    messages.scrollTop = messages.scrollHeight;
    messages.addEventListener("wheel", event => {
      state.trustedWheel = event.isTrusted;
      if (!persistentSnap) state.following = false;
    });
    const follow = () => {
      if (state.following) messages.scrollTop = messages.scrollHeight;
      requestAnimationFrame(follow);
    };
    requestAnimationFrame(follow);
    document.querySelector("#edit").onclick = event => {
      state.clicks += 1;
      state.clickTop = event.currentTarget.getBoundingClientRect().top;
    };
  }, persistentSnap);
}
