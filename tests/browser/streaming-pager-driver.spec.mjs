import { readFileSync } from "node:fs";
import { parse } from "acorn";
import { expect, test } from "./fixtures.mjs";

// Load the actual interaction driver without running its standalone benchmark
// CLI. The page fixture controls scroll races while its health thresholds stay intact.
const source = readFileSync(new URL("../benchmarks/conversation-render/run.mjs", import.meta.url), "utf8");
const driver = parse(source, { ecmaVersion: "latest", sourceType: "module" }).body
  .find(node => node.type === "FunctionDeclaration" && node.id.name === "sampleStreamingPagerInteraction");
const samplePager = new Function(`return (${source.slice(driver.start, driver.end)})`)();

test("pager clicks wait for a visible target after a tail snap and transcript replacement", async ({ page }) => {
  await preparePage(page);
  await page.evaluate(() => {
    const nativeScroll = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function(options) {
      nativeScroll.call(this, options);
      if (++window.driverFixture.positionAttempts !== 1) return;
      requestAnimationFrame(() => {
        const messages = document.querySelector("#messages");
        const card = messages.querySelector(".msg-tool-timeline");
        card.replaceWith(card.cloneNode(true));
        messages.scrollTop = messages.scrollHeight;
        window.driverFixture.offscreenTop = messages.querySelector("button").getBoundingClientRect().top;
      });
    };
  });

  const result = await samplePager(page, { direction: 1, preferredMode: "steps" });
  const fixture = await page.evaluate(() => window.driverFixture);
  expect(fixture.offscreenTop).toBeLessThan(0);
  expect(fixture.clicks).toBe(1);
  expect(result.clicked).toBe(true);
  expect(result.activeChanged).toBe(true);
  expect(result.preparation.scrollAdjustments).toBeGreaterThan(0);
  expect(result.preparation.stableMs).toBeGreaterThanOrEqual(64);
  expect(result.preparation.elapsedMs).toBeLessThan(1000);
  expect(fixture.clickRect.top).toBeGreaterThanOrEqual(result.preparation.viewport.top);
  expect(fixture.clickRect.bottom).toBeLessThanOrEqual(result.preparation.viewport.bottom);
  expect(result.topDeltaPx).toBeLessThanOrEqual(1);
  expect(result.leftDeltaPx).toBeLessThanOrEqual(1);
});

test("a pager that remains offscreen fails preparation without clicking or skipping it", async ({ page }) => {
  await preparePage(page);
  await page.evaluate(() => {
    Element.prototype.scrollIntoView = () => {
      window.driverFixture.positionAttempts += 1;
      const messages = document.querySelector("#messages");
      messages.scrollTop = messages.scrollHeight;
    };
  });
  await expect(samplePager(page)).rejects.toThrow("Pager preparation did not become visible and stable within 1000 ms");
  const fixture = await page.evaluate(() => window.driverFixture);
  expect(fixture.positionAttempts).toBeGreaterThan(1);
  expect(fixture.clicks).toBe(0);
});

async function preparePage(page) {
  await page.setViewportSize({ width: 640, height: 480 });
  await page.setContent(`
    <style>
      body { margin: 0; }
      #messages { margin: 20px; width: 400px; height: 200px; overflow: auto; }
      .history { height: 180px; }
      .tool-timeline-slot-body { height: 20px; }
      .tool-timeline-slot-nav { height: 40px; }
      button { width: 80px; height: 30px; }
      #tail { height: 1800px; }
    </style>
    <main id="messages">
      <div class="history"></div>
      <section class="msg-tool-timeline tool-timeline-expanded" data-transcript-key="stable-target">
        <div class="tool-timeline-details" data-timeline-mode="steps" data-active-tool-key="first">
          <div class="tool-timeline-slot-body"></div>
          <div class="tool-timeline-slot-nav">
            <button class="tool-timeline-nav-btn" data-timeline-nav-direction="1">Next</button>
            <button class="tool-timeline-nav-btn" data-timeline-nav-direction="-1">Previous</button>
          </div>
        </div>
      </section>
      <div id="tail"></div>
    </main>
  `);
  await page.evaluate(() => {
    window.qingzhouConversationBenchmark = { collectViewportAnchorState: () => null };
    window.driverFixture = { clicks: 0, positionAttempts: 0, offscreenTop: null, clickRect: null };
    document.querySelector("#messages").addEventListener("click", event => {
      const button = event.target.closest("button");
      if (!button) return;
      window.driverFixture.clicks += 1;
      const rect = button.getBoundingClientRect();
      window.driverFixture.clickRect = { top: rect.top, bottom: rect.bottom };
      button.closest(".tool-timeline-details").dataset.activeToolKey = "second";
      // Reproduce the old 173 px bottom clamp when an offscreen target was clicked.
      document.querySelector("#tail").style.height = "1627px";
    });
  });
}


const scrollDriver = parse(source, { ecmaVersion: "latest", sourceType: "module" }).body
  .find(node => node.type === "FunctionDeclaration" && node.id.name === "sampleStreamingScrollInteraction");
const sampleScroll = new Function(`return (${source.slice(scrollDriver.start, scrollDriver.end)})`)();

for (const jitter of [false, true]) {
  test(`scroll probe ${jitter ? "detects a 1 px card jitter" : "accepts stable cards"} while the reading anchor stays fixed`, async ({ page }) => {
    await page.setContent(`
      <style>
        body { margin: 0; }
        #messages { width: 400px; height: 300px; overflow: auto; }
        .msg { height: 60px; }
        .msg-tool { ${jitter ? "animation: jitter 160ms steps(1) infinite;" : ""} }
        @keyframes jitter { 0%, 49% { transform: translateY(0); } 50%, 100% { transform: translateY(1px); } }
      </style>
      <main id="messages">${Array.from({ length: 30 }, (_, index) =>
        `<div class="msg ${index % 5 === 0 ? "msg-tool" : ""}" data-transcript-key="row-${index}">row ${index}</div>`).join("")}</main>
    `);
    const result = await sampleScroll(page, { fuzzPlan: { deltas: [-1], gapMs: 32, holdMs: 320 } });
    expect(result.sampled).toBe(true);
    expect(result.monitoredCards).toBeGreaterThan(0);
    expect(result.lostCards).toBe(false);
    expect(result.maxCardDriftPx).toBe(jitter ? 1 : 0);
    expect(result.maxAnchorDriftPx).toBe(0);
    expect(result.resumeFailed).toBe(false);
  });
}
