import { expect, test } from "./fixtures.mjs";

for (const colorScheme of ["light", "dark"]) {
  test.describe(`chat turn spacing · ${colorScheme}`, () => {
    test.use({ colorScheme, viewport: { width: 520, height: 420 } });

    test("keeps a user bubble centered between compact execution lanes", async ({ page }) => {
      await page.goto("/tests/tool-timeline/visual-test.html", { waitUntil: "networkidle" });

      const gaps = await page.evaluate(() => {
        const messages = document.querySelector("#messages");
        messages.innerHTML = `
          <div class="msg msg-thinking-group">
            <button class="thinking-group-summary">上一轮思考</button>
          </div>
          <div class="msg msg-user">
            <div class="msg-user-row">
              <div class="msg-content"><div class="user-text">纯视觉来解</div></div>
            </div>
          </div>
          <div class="msg msg-thinking-group">
            <button class="thinking-group-summary">本轮思考</button>
          </div>
          <div class="msg msg-tool">
            <button class="tool-summary">执行工具</button>
          </div>
        `;
        const [previous, user, next, compactFollower] = messages.querySelectorAll(".msg");
        const previousSurface = previous.querySelector(".thinking-group-summary").getBoundingClientRect();
        const userSurface = user.querySelector(".msg-content").getBoundingClientRect();
        const nextSurface = next.querySelector(".thinking-group-summary").getBoundingClientRect();
        const compactFollowerSurface = compactFollower.querySelector(".tool-summary").getBoundingClientRect();
        return {
          beforeUser: userSurface.top - previousSurface.bottom,
          afterUser: nextSurface.top - userSurface.bottom,
          compactLane: compactFollowerSurface.top - nextSurface.bottom,
        };
      });

      expect(gaps.beforeUser).toBeCloseTo(14, 1);
      expect(gaps.afterUser).toBeCloseTo(14, 1);
      expect(gaps.compactLane).toBeCloseTo(8, 1);
    });
  });
}
