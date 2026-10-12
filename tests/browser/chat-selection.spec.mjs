import { expect, test } from "./fixtures.mjs";

const skins = [
  { name: "default", href: "/extension/sidepanel/sidepanel.css" },
];

for (const skin of skins) {
  for (const colorScheme of ["light", "dark"]) {
    test.describe(`${skin.name} user selection · ${colorScheme}`, () => {
      test.use({ colorScheme, viewport: { width: 720, height: 360 } });

      test("keeps a visible selection in a non-editing user message", async ({ page }) => {
        await page.goto("/tests/tool-timeline/visual-test.html", { waitUntil: "networkidle" });
        await loadSidepanelSkin(page, skin.href);

        const state = await page.evaluate(() => {
          const messages = document.querySelector("#messages");
          messages.innerHTML = `
            <div class="msg msg-user">
              <div class="msg-user-row">
                <div class="msg-content user-selectable">
                  <div class="user-text">帮我整理这份资料，保留关键事实和出处。</div>
                </div>
              </div>
            </div>
          `;
          const content = messages.querySelector(".msg-user .msg-content");
          const userText = content.querySelector(".user-text");
          const range = document.createRange();
          range.setStart(userText.firstChild, 2);
          range.setEnd(userText.firstChild, 12);
          const selection = window.getSelection();
          selection.removeAllRanges();
          selection.addRange(range);

          const rootStyle = getComputedStyle(document.documentElement);
          const bubbleStyle = getComputedStyle(content);
          const selectionStyle = getComputedStyle(userText, "::selection");
          const surfaceProbe = document.createElement("span");
          surfaceProbe.style.background = "var(--bg-primary)";
          document.body.appendChild(surfaceProbe);
          const surfaceBg = getComputedStyle(surfaceProbe).backgroundColor;
          surfaceProbe.remove();
          return {
            selectedText: selection.toString(),
            isEditing: content.closest(".msg-user").classList.contains("is-editing"),
            legacyTextToken: rootStyle.getPropertyValue("--qz-user-bubble-text").trim(),
            selectionBgToken: rootStyle.getPropertyValue("--user-bubble-selection-bg").trim(),
            selectionTextToken: rootStyle.getPropertyValue("--user-bubble-selection-text").trim(),
            surfaceBg,
            bubbleBg: bubbleStyle.backgroundColor,
            bubbleText: bubbleStyle.color,
            selectionBg: selectionStyle.backgroundColor,
            selectionText: selectionStyle.color,
          };
        });

        expect(state.selectedText.length).toBeGreaterThan(0);
        expect(state.isEditing).toBe(false);
        expect(state.legacyTextToken).toBe("");
        expect(state.selectionBgToken).not.toBe("");
        expect(state.selectionTextToken).not.toBe("");

        const surfaceBg = compositeColor(parseColor(state.surfaceBg), [255, 255, 255]);
        const bubbleBg = compositeColor(parseColor(state.bubbleBg), surfaceBg);
        const bubbleText = compositeColor(parseColor(state.bubbleText), bubbleBg);
        const selectionBg = compositeColor(parseColor(state.selectionBg), bubbleBg);
        const selectionText = compositeColor(parseColor(state.selectionText), selectionBg);
        expect(contrastRatio(bubbleBg, surfaceBg), "bubble should be a quiet same-tone surface").toBeGreaterThan(1.04);
        expect(contrastRatio(bubbleBg, surfaceBg), "bubble must not become an inverse card").toBeLessThan(1.3);
        expect(contrastRatio(bubbleText, bubbleBg), "bubble text must remain readable").toBeGreaterThanOrEqual(7);
        expect(colorDistance(bubbleBg, selectionBg), "selection must separate from the bubble surface").toBeGreaterThan(70);
        expect(contrastRatio(selectionText, selectionBg), "selected text must remain readable").toBeGreaterThanOrEqual(4.5);
      });
    });
  }
}

async function loadSidepanelSkin(page, href) {
  await page.evaluate(async stylesheetHref => {
    const link = document.querySelector('link[rel="stylesheet"][href*="sidepanel"]');
    if (!link) throw new Error("sidepanel stylesheet link not found");
    const nextHref = new URL(stylesheetHref, location.href).href;
    if (link.href === nextHref) return;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`skin load timeout: ${stylesheetHref}`)), 5000);
      link.addEventListener("load", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      link.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error(`skin load failed: ${stylesheetHref}`));
      }, { once: true });
      link.href = nextHref;
    });
  }, href);
}

function parseColor(value) {
  const channels = String(value).match(/[\d.]+/g)?.map(Number);
  if (!channels || channels.length < 3 || channels.slice(0, 3).some(channel => !Number.isFinite(channel))) {
    throw new Error(`Unsupported color: ${value}`);
  }
  return {
    rgb: channels.slice(0, 3),
    alpha: Number.isFinite(channels[3]) ? channels[3] : 1,
  };
}

function compositeColor(foreground, background) {
  return foreground.rgb.map((channel, index) => (
    (channel * foreground.alpha) + (background[index] * (1 - foreground.alpha))
  ));
}

function colorDistance(left, right) {
  return Math.hypot(...left.map((channel, index) => channel - right[index]));
}

function contrastRatio(foreground, background) {
  const lighter = Math.max(relativeLuminance(foreground), relativeLuminance(background));
  const darker = Math.min(relativeLuminance(foreground), relativeLuminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

function relativeLuminance(color) {
  const [red, green, blue] = color.map(channel => {
    const normalized = channel / 255;
    return normalized <= 0.04045
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return (0.2126 * red) + (0.7152 * green) + (0.0722 * blue);
}
