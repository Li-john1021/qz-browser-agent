import { expect, test } from "./fixtures.mjs";
import { ensureCapabilityExtension, resolveTestAsset } from "../support/extension-build.mjs";

for (const colorScheme of ["light", "dark"]) {
  test(`generic image results retain their skin without Media (${colorScheme})`, async ({ page }) => {
    const extensionDir = await ensureCapabilityExtension({ omit: ["media"] });
    await page.route("**/extension/**", route => {
      const path = resolveTestAsset(decodeURIComponent(new URL(route.request().url()).pathname), { root: process.cwd(), extensionDir });
      return path ? route.fulfill({ path }) : route.abort();
    });
    await page.emulateMedia({ colorScheme, reducedMotion: "no-preference" });
    await page.goto("/__test_health");
    const states = await page.evaluate(async () => {
      await new Promise((resolve, reject) => {
        const skin = document.createElement("link");
        skin.rel = "stylesheet";
        skin.href = "/extension/sidepanel/sidepanel.css";
        skin.onload = resolve;
        skin.onerror = reject;
        document.head.append(skin);
      });
      const { renderToolEvent, disposeRendererTree } = await import("/extension/sidepanel/tools/tool-renderer.js");
      const image = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="320"><rect width="640" height="320" fill="seagreen"/></svg>')}`;
      const states = [];
      for (const staticOutput of [false, true]) {
        for (const action of [false, true]) {
          const root = renderToolEvent({
            name: "independent.capture", rendererId: "missing-renderer", image, args: {},
            result: { message: "Retained generic image", ...(action ? { _display: {
              type: "imageWithAction", action: "click", x: 0.25, y: 0.5, beforeImage: image, afterImage: image,
            } } : {}) },
          }, { expanded: true, lazyDetails: false, static: staticOutput });
          document.body.replaceChildren(root);
          await Promise.all([...root.querySelectorAll("img")].map(image => image.decode()));
          const thumbnail = root.querySelector(".tool-screenshot");
          const style = getComputedStyle(thumbnail);
          const overlay = root.querySelector(".tool-image-action-overlay");
          const before = root.querySelector(".tool-image-action-before-layer");
          states.push({
            action, staticOutput, text: root.textContent,
            maxWidth: style.maxWidth, overflow: style.overflow, position: style.position,
            width: thumbnail.getBoundingClientRect().width,
            imageDisplay: getComputedStyle(thumbnail.querySelector("img")).display,
            overlay: overlay && { position: getComputedStyle(overlay).position,
              pointerEvents: getComputedStyle(overlay).pointerEvents,
              cue: getComputedStyle(overlay).getPropertyValue("--tool-image-action-cue").trim() },
            animation: before && getComputedStyle(before).animationName,
          });
          disposeRendererTree(root);
        }
      }
      return states;
    });
    expect(states).toHaveLength(4);
    for (const state of states) {
      expect(state.text).toContain("Retained generic image");
      expect(state).toMatchObject({ maxWidth: "320px", overflow: "hidden", position: "relative", imageDisplay: "block" });
      expect(state.width).toBe(320);
      if (state.action) {
        expect(state.overlay).toEqual({ position: "absolute", pointerEvents: "none", cue: colorScheme === "dark" ? "#a2b2af" : "#607572" });
        expect(state.animation).toBe("tool-image-action-before-frame");
      } else {
        expect(state.overlay).toBeNull();
        expect(state.animation).toBeNull();
      }
    }
  });
}
