import { expect, test } from "./fixtures.mjs";
import { createScreenActionHarness } from "./screen-action-harness.mjs";

const FIXTURE_URL = "/tests/fixtures/screen-action-structures.html";
const STATE_READER = "__readScreenStructureState";

test.describe("act_on_screen · structural edge cases in real Chrome", () => {
  test.describe.configure({ timeout: 90_000 });

  test.use({
    viewport: { width: 1100, height: 800 },
    deviceScaleFactor: 2,
  });

  test("maps high-DPR pixels through transforms, SVG, Canvas, overlays, mouse buttons, and native range drag", async ({ page, context }) => {
    await page.goto(FIXTURE_URL);
    const harness = await createScreenActionHarness(page, context, "geometry-edges");

    try {
      const captured = await harness.capture();
      const viewport = await page.evaluate(() => ({
        width: innerWidth,
        height: innerHeight,
        devicePixelRatio,
      }));
      expect(viewport.devicePixelRatio).toBe(2);
      expect(captured.coordinateSpace.width / viewport.width).toBeCloseTo(
        captured.coordinateSpace.height / viewport.height,
        2,
      );

      const transformedPoint = await harness.point("#transformed-target");
      expectStable(await harness.act({
        action: "click",
        returnScreenshot: false,
        ...transformedPoint,
      }));
      expect((await harness.state(STATE_READER)).transformedClicks).toBe(1);

      const svgPoint = await harness.point("#svg-target");
      expectStable(await harness.act({
        action: "click",
        returnScreenshot: false,
        ...svgPoint,
      }));
      expect((await harness.state(STATE_READER)).svgClicks).toBe(1);

      const canvasPoint = await harness.point("#canvas-target", { x: 0.72, y: 0.42 });
      expectStable(await harness.act({
        action: "click",
        returnScreenshot: false,
        ...canvasPoint,
      }));
      const canvasState = await harness.state(STATE_READER);
      expect(canvasState.canvasClicks).toBe(1);
      expect(canvasState.canvasLastPoint.ratioX).toBeGreaterThan(0.71);
      expect(canvasState.canvasLastPoint.ratioX).toBeLessThan(0.73);
      expect(canvasState.canvasLastPoint.ratioY).toBeGreaterThan(0.40);
      expect(canvasState.canvasLastPoint.ratioY).toBeLessThan(0.43);
      expect(canvasState.canvasLastPoint.backingX).toBeGreaterThan(450);
      expect(canvasState.canvasLastPoint.backingX).toBeLessThan(470);
      expect(canvasState.canvasLastPoint.backingY).toBeGreaterThan(100);
      expect(canvasState.canvasLastPoint.backingY).toBeLessThan(115);

      const coveredPoint = await harness.point("#underlay-target");
      expectStable(await harness.act({
        action: "click",
        returnScreenshot: false,
        ...coveredPoint,
      }));
      const overlayState = await harness.state(STATE_READER);
      expect(overlayState.overlayClicks).toBe(1);
      expect(overlayState.underlayClicks).toBe(0);

      const mousePoint = await harness.point("#mouse-target");
      expectStable(await harness.act({
        action: "click",
        button: "right",
        returnScreenshot: false,
        ...mousePoint,
      }));
      expectStable(await harness.act({
        action: "click",
        button: "middle",
        returnScreenshot: false,
        ...mousePoint,
      }));
      const mouseState = await harness.state(STATE_READER);
      expect(mouseState.contextMenus).toBe(1);
      expect(mouseState.auxClicks).toBe(2);
      expect(mouseState.mouseEvents).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "mousedown", button: 2 }),
        expect.objectContaining({ type: "contextmenu", button: 2 }),
        expect.objectContaining({ type: "auxclick", button: 2 }),
        expect.objectContaining({ type: "mousedown", button: 1 }),
        expect.objectContaining({ type: "auxclick", button: 1 }),
      ]));

      const captureStart = await harness.point("#pointer-capture-target");
      const captureEnd = await harness.point("#pointer-capture-end");
      expectStable(await harness.act({
        action: "drag",
        returnScreenshot: false,
        x: captureStart.x,
        y: captureStart.y,
        endX: captureEnd.x,
        endY: captureEnd.y,
      }));
      const pointerState = await harness.state(STATE_READER);
      expect(pointerState.pointerDown).toBe(1);
      expect(pointerState.pointerMoves).toBeGreaterThanOrEqual(8);
      expect(pointerState.pointerUp).toBe(1);
      expect(pointerState.pointerCaptured).toBe(false);

      const rangeStart = await harness.point("#range-target", { x: 0.1, y: 0.5 });
      const rangeEnd = await harness.point("#range-target", { x: 0.9, y: 0.5 });
      const dragged = await harness.act({
        action: "drag",
        returnScreenshot: true,
        x: rangeStart.x,
        y: rangeStart.y,
        endX: rangeEnd.x,
        endY: rangeEnd.y,
      });
      expect(dragged.feedbackAvailable).toBe(true);
      expect(dragged.coordinateBasisReady).toBe(true);
      expect(dragged._image).toMatch(/^data:image\/jpeg;base64,/);
      const rangeState = await harness.state(STATE_READER);
      expect(Number(rangeState.rangeValue)).toBeGreaterThan(75);
      expect(rangeState.rangeInputs).toBeGreaterThan(0);
    } finally {
      await harness.close();
    }
  });

  test("operates inside open Shadow DOM and an opaque sandboxed iframe without DOM targeting", async ({ page, context }) => {
    await page.goto(FIXTURE_URL);
    await expect.poll(async () => (await page.evaluate(() => window.__readScreenStructureState())).frameReady).toBe(true);
    await page.locator("#context-section").scrollIntoViewIfNeeded();
    const harness = await createScreenActionHarness(page, context, "browsing-contexts");

    try {
      await harness.capture();
      const shadowButton = page.locator("#shadow-host").locator("#shadow-button");
      const shadowButtonPoint = await harness.point(shadowButton);
      expectStable(await harness.act({
        action: "click",
        returnScreenshot: false,
        ...shadowButtonPoint,
      }));
      expect((await harness.state(STATE_READER)).shadowClicks).toBe(1);

      const shadowInput = page.locator("#shadow-host").locator("#shadow-input");
      const shadowInputPoint = await harness.point(shadowInput);
      expectStable(await harness.act({
        action: "type",
        returnScreenshot: false,
        ...shadowInputPoint,
        text: "Shadow 新值🙂",
        replace: true,
      }));
      const shadowState = await harness.state(STATE_READER);
      expect(shadowState.shadowInputValue).toBe("Shadow 新值🙂");
      expect(shadowState.shadowInputs).toBeGreaterThan(0);
      expect(shadowState.activeElementId).toBe("shadow-input");

      // The inner button cannot be queried from page JavaScript or Playwright,
      // so the host's visible center is the only coordinate reference.
      expect(await page.evaluate(() => document.querySelector("#closed-shadow-host").shadowRoot)).toBeNull();
      const closedShadowPoint = await harness.point("#closed-shadow-host", { x: 0.5, y: 0.34 });
      expectStable(await harness.act({
        action: "click",
        returnScreenshot: false,
        ...closedShadowPoint,
      }));
      expect((await harness.state(STATE_READER)).closedShadowClicks).toBe(1);

      // The previous actions changed another rendered tree. Re-observe before
      // crossing into a separate browsing context instead of assuming that
      // viewport stability also proves semantic position stability.
      await harness.capture();
      const frame = page.frameLocator("#opaque-frame");
      const frameButtonPoint = await harness.point(frame.locator("#frame-button"));
      const frameClicked = await harness.act({
        action: "click",
        returnScreenshot: true,
        ...frameButtonPoint,
      });
      expect(frameClicked.feedbackAvailable).toBe(true);
      await expect(frame.locator("#frame-button")).toHaveAttribute("data-clicked", "true");

      const frameInputPoint = await harness.point(frame.locator("#frame-input"));
      const frameTyped = await harness.act({
        action: "type",
        returnScreenshot: true,
        ...frameInputPoint,
        text: "Frame 新值\n第二行",
        replace: true,
      });
      expect(frameTyped.feedbackAvailable).toBe(true);
      // Native single-line inputs normalize inserted line breaks to spaces.
      const normalizedFrameValue = "Frame 新值 第二行";
      await expect(frame.locator("#frame-input")).toHaveValue(normalizedFrameValue);
    } finally {
      await harness.close();
    }
  });

  test("keeps the top-level coordinate system through nested scrolling, then reaches the newly revealed target", async ({ page, context }) => {
    await page.goto(FIXTURE_URL);
    await page.locator("#scroll-section").scrollIntoViewIfNeeded();
    const harness = await createScreenActionHarness(page, context, "nested-scroll");

    try {
      await harness.capture();
      const before = await harness.state(STATE_READER);
      const nestedPoint = await harness.point("#nested-scroll", { x: 0.5, y: 0.72 });
      const scrolled = await harness.act({
        action: "scroll",
        returnScreenshot: false,
        ...nestedPoint,
        deltaY: 180,
        repeat: 2,
      });
      expectStable(scrolled);
      expect(scrolled.repeat).toBe(2);
      await expect.poll(async () => (await harness.state(STATE_READER)).nestedScrollTop).toBeGreaterThan(250);
      const after = await harness.state(STATE_READER);
      expect(after.nestedWheelEvents).toBe(2);
      expect(after.scrollY).toBe(before.scrollY);

      const revealedPoint = await harness.point("#nested-target");
      const clicked = await harness.act({
        action: "click",
        returnScreenshot: true,
        ...revealedPoint,
      });
      expect(clicked.feedbackAvailable).toBe(true);
      expect(clicked.viewportChange).toMatchObject({ observed: true, scrolled: false });
      expect((await harness.state(STATE_READER)).nestedClicks).toBe(1);
    } finally {
      await harness.close();
    }
  });

  test("edits textarea, contenteditable, controlled, readonly, and disabled fields and follows keyboard focus", async ({ page, context }) => {
    await page.goto(FIXTURE_URL);
    await page.locator("#editors-section").scrollIntoViewIfNeeded();
    const harness = await createScreenActionHarness(page, context, "editing-surfaces");

    try {
      await harness.capture();
      const textareaPoint = await harness.point("#textarea-target");
      const textareaText = "第一行\n第二行🙂  ";
      expectStable(await harness.act({
        action: "type",
        returnScreenshot: false,
        ...textareaPoint,
        text: textareaText,
        replace: true,
      }));
      expect((await harness.state(STATE_READER)).textareaValue).toBe(textareaText);

      expectStable(await harness.act({
        action: "type",
        returnScreenshot: false,
        text: "尾部",
        replace: false,
      }));
      expect((await harness.state(STATE_READER)).textareaValue).toBe(`${textareaText}尾部`);

      const editablePoint = await harness.point("#editable-target");
      expectStable(await harness.act({
        action: "type",
        returnScreenshot: false,
        ...editablePoint,
        text: "纯文本替换 ✓",
        replace: true,
      }));
      const editableState = await harness.state(STATE_READER);
      expect(editableState.editableText).toBe("纯文本替换 ✓");
      expect(editableState.editableInputs).toBeGreaterThan(0);

      const controlledPoint = await harness.point("#controlled-target");
      expectStable(await harness.act({
        action: "type",
        returnScreenshot: false,
        ...controlledPoint,
        text: "mixed-轻舟",
        replace: true,
      }));
      const controlledState = await harness.state(STATE_READER);
      expect(controlledState.controlledValue).toBe("MIXED-轻舟");
      expect(controlledState.controlledInputs).toBeGreaterThan(0);

      const readonlyPoint = await harness.point("#readonly-target");
      expectStable(await harness.act({
        action: "type",
        returnScreenshot: false,
        ...readonlyPoint,
        text: "不应写入",
        replace: true,
      }));
      expect((await harness.state(STATE_READER)).readonlyValue).toBe("不可改");

      const disabledPoint = await harness.point("#disabled-target");
      expectStable(await harness.act({
        action: "type",
        returnScreenshot: false,
        ...disabledPoint,
        text: "也不应写入",
        replace: true,
      }));
      const disabledState = await harness.state(STATE_READER);
      expect(disabledState.disabledValue).toBe("已禁用");
      expect(disabledState.activeElementId).toBe("");

      // A native collapsed select responds to physical keys when reached by
      // keyboard focus; its browser-owned popup is deliberately not modeled as DOM.
      expectStable(await harness.act({
        action: "click",
        returnScreenshot: false,
        ...readonlyPoint,
      }));
      expect((await harness.state(STATE_READER)).activeElementId).toBe("readonly-target");
      expectStable(await harness.act({ action: "press", returnScreenshot: false, key: "Tab" }));
      expect((await harness.state(STATE_READER)).activeElementId).toBe("select-target");
      const firstTabPoint = await harness.point("#tab-first");
      expectStable(await harness.act({ action: "press", returnScreenshot: false, key: "b" }));
      expectStable(await harness.act({
        action: "type",
        returnScreenshot: false,
        ...firstTabPoint,
        text: "AB",
        replace: true,
      }));
      const selectState = await harness.state(STATE_READER);
      expect(selectState.selectValue).toBe("beta");
      expect(selectState.selectChanges).toBe(1);
      expect(selectState.activeElementId).toBe("tab-first");
      expectStable(await harness.act({ action: "press", returnScreenshot: false, key: "ArrowLeft" }));
      expectStable(await harness.act({ action: "type", returnScreenshot: false, text: "X" }));
      await expect(page.locator("#tab-first")).toHaveValue("AXB");

      expectStable(await harness.act({ action: "press", returnScreenshot: false, key: "Tab" }));
      expect((await harness.state(STATE_READER)).activeElementId).toBe("tab-second");
      expectStable(await harness.act({ action: "press", returnScreenshot: false, key: "Shift+Tab" }));
      expect((await harness.state(STATE_READER)).activeElementId).toBe("tab-first");
      expectStable(await harness.act({ action: "press", returnScreenshot: false, key: "Tab" }));
      expectStable(await harness.act({ action: "press", returnScreenshot: false, key: "Tab" }));
      expect((await harness.state(STATE_READER)).activeElementId).toBe("tab-third");
      const activated = await harness.act({ action: "press", returnScreenshot: true, key: "Space" });
      expect(activated.feedbackAvailable).toBe(true);
      expect((await harness.state(STATE_READER)).tabThirdClicks).toBe(1);
    } finally {
      await harness.close();
    }
  });

  test("distinguishes stable viewport coordinates from moved page content and recovers after a real resize", async ({ page, context }) => {
    await page.goto(FIXTURE_URL);
    await page.locator("#layout-section").scrollIntoViewIfNeeded();
    const harness = await createScreenActionHarness(page, context, "layout-recovery");

    try {
      await harness.capture();
      const originalPoint = await harness.point("#moving-target");
      const moved = await harness.act({
        action: "click",
        returnScreenshot: false,
        ...originalPoint,
      });
      expectStable(moved);
      expect(moved.note).toContain("未截取观察图");
      let state = await harness.state(STATE_READER);
      expect(state.movingClicks).toBe(1);
      expect(state.movingTargetMoved).toBe(true);

      const staleSemanticClick = await harness.act({
        action: "click",
        returnScreenshot: false,
        ...originalPoint,
      });
      expectStable(staleSemanticClick);
      state = await harness.state(STATE_READER);
      expect(state.movingClicks).toBe(1);
      expect(state.layoutMisses).toBe(1);

      await harness.capture();
      const movedPoint = await harness.point("#moving-target");
      const recovered = await harness.act({
        action: "click",
        returnScreenshot: true,
        ...movedPoint,
      });
      expect(recovered.feedbackAvailable).toBe(true);
      state = await harness.state(STATE_READER);
      expect(state.movingClicks).toBe(2);
      expect(state.movingTargetMoved).toBe(false);

      const animatedPoint = await harness.point("#animated-target");
      const animated = await harness.act({
        action: "click",
        returnScreenshot: true,
        ...animatedPoint,
      });
      expect(animated.feedbackAvailable).toBe(true);
      state = await harness.state(STATE_READER);
      expect(state.animatedClicks).toBe(1);
      expect(state.animatedTargetMoved).toBe(true);
      expect(state.animatedTransitions).toBe(0, "screen actions must not wait for a page-owned CSS transition");
      await expect.poll(async () => (await harness.state(STATE_READER)).animatedTransitions).toBe(1);

      const beforeResize = await harness.capture();
      await page.setViewportSize({ width: 980, height: 720 });
      await expect(harness.act({
        action: "click",
        returnScreenshot: false,
        x: Math.min(originalPoint.x, beforeResize.coordinateSpace.width - 1),
        y: Math.min(originalPoint.y, beforeResize.coordinateSpace.height - 1),
      })).rejects.toMatchObject({
        code: "SCREENSHOT_CONTEXT_STALE",
        details: { reason: "viewport_resized" },
      });

      await page.locator("#layout-section").scrollIntoViewIfNeeded();
      await harness.capture();
      const edgePoint = await harness.point("#edge-target");
      const edgeClicked = await harness.act({
        action: "click",
        returnScreenshot: true,
        ...edgePoint,
      });
      expect(edgeClicked.coordinateBasisReady).toBe(true);
      expect((await harness.state(STATE_READER)).edgeClicks).toBe(1);
    } finally {
      await harness.close();
    }
  });

  test("observes a native top-layer dialog after opening, supports Escape, and resumes the flow", async ({ page, context }) => {
    await page.goto(FIXTURE_URL);
    await page.locator("#modal-section").scrollIntoViewIfNeeded();
    const harness = await createScreenActionHarness(page, context, "dialog-flow");

    try {
      await harness.capture();
      const openPoint = await harness.point("#open-dialog-target");
      const opened = await harness.act({
        action: "click",
        returnScreenshot: true,
        ...openPoint,
      });
      expect(opened.feedbackAvailable).toBe(true);
      expect((await harness.state(STATE_READER)).dialogOpen).toBe(true);

      const escaped = await harness.act({
        action: "press",
        returnScreenshot: true,
        key: "Escape",
      });
      expect(escaped.feedbackAvailable).toBe(true);
      let state = await harness.state(STATE_READER);
      expect(state.dialogOpen).toBe(false);
      expect(state.dialogCancels).toBe(1);

      const reopenedPoint = await harness.point("#open-dialog-target");
      await harness.act({
        action: "click",
        returnScreenshot: true,
        ...reopenedPoint,
      });
      const confirmPoint = await harness.point("#confirm-dialog-target");
      const confirmed = await harness.act({
        action: "click",
        returnScreenshot: true,
        ...confirmPoint,
      });
      expect(confirmed.feedbackAvailable).toBe(true);
      state = await harness.state(STATE_READER);
      expect(state.dialogOpen).toBe(false);
      expect(state.dialogOpens).toBe(2);
      expect(state.dialogConfirms).toBe(1);
    } finally {
      await harness.close();
    }
  });

  test("separates dispatched input from native validation and page-owned asynchronous results", async ({ page, context }) => {
    await page.goto(FIXTURE_URL);
    await page.locator("#form-section").scrollIntoViewIfNeeded();
    const harness = await createScreenActionHarness(page, context, "form-validation-flow");

    try {
      await harness.capture();
      const submitPoint = await harness.point("#form-submit-target");
      const rejected = await harness.act({
        action: "click",
        returnScreenshot: true,
        ...submitPoint,
      });
      expect(rejected.status).toBe("completed");
      expect(rejected.feedbackAvailable).toBe(true);
      let state = await harness.state(STATE_READER);
      expect(state.formInvalid).toBe(1);
      expect(state.formSubmits).toBe(0);
      expect(state.activeElementId).toBe("form-input");

      expectStable(await harness.act({
        action: "type",
        returnScreenshot: false,
        text: "订单-42",
        replace: true,
      }));
      state = await harness.state(STATE_READER);
      expect(state.formInputValue).toBe("订单-42");
      expect(state.formSubmits).toBe(0);

      // Hold the page's business callback independently of screenshot timing.
      await page.clock.install();
      await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
      const submitted = await harness.act({
        action: "press",
        returnScreenshot: true,
        key: "Enter",
      });
      expect(submitted.feedbackAvailable).toBe(true);
      state = await harness.state(STATE_READER);
      expect(state.formSubmits).toBe(1);
      expect(state.formResultReady).toBe(false, "screen actions must not wait for application business callbacks");
      await page.clock.fastForward(1000);
      await expect.poll(async () => (await harness.state(STATE_READER)).formResultReady).toBe(true);
      expect((await harness.state(STATE_READER)).formResultText).toBe("Accepted: 订单-42");
    } finally {
      await harness.close();
    }
  });

  test("combines checkboxes, radios, details, number stepping, mouse text selection, and native copy/paste", async ({ page, context }) => {
    await page.goto(FIXTURE_URL);
    await page.locator("#controls-section").scrollIntoViewIfNeeded();
    const harness = await createScreenActionHarness(page, context, "common-controls-clipboard");

    try {
      await harness.capture();
      const checkboxLabel = await harness.point("#checkbox-label", { x: 0.7, y: 0.5 });
      expectStable(await harness.act({
        action: "click",
        returnScreenshot: false,
        ...checkboxLabel,
      }));
      let state = await harness.state(STATE_READER);
      expect(state.checkboxChecked).toBe(true);
      expect(state.checkboxChanges).toBe(1);

      const checkboxInput = await harness.point("#checkbox-target");
      expectStable(await harness.act({
        action: "click",
        returnScreenshot: false,
        ...checkboxInput,
      }));
      state = await harness.state(STATE_READER);
      expect(state.checkboxChecked).toBe(false);
      expect(state.checkboxChanges).toBe(2);

      const radioB = await harness.point("#radio-b");
      expectStable(await harness.act({
        action: "click",
        returnScreenshot: false,
        ...radioB,
      }));
      state = await harness.state(STATE_READER);
      expect(state.radioValue).toBe("b");
      expect(state.radioChanges).toBe(1);

      const summaryPoint = await harness.point("#details-summary", { x: 0.35, y: 0.5 });
      expectStable(await harness.act({
        action: "click",
        returnScreenshot: false,
        ...summaryPoint,
      }));
      await expect.poll(async () => (await harness.state(STATE_READER)).detailsOpen).toBe(true);

      const numberPoint = await harness.point("#number-target");
      expectStable(await harness.act({
        action: "click",
        returnScreenshot: false,
        ...numberPoint,
      }));
      expectStable(await harness.act({ action: "press", returnScreenshot: false, key: "ArrowUp" }));
      state = await harness.state(STATE_READER);
      expect(state.numberValue).toBe("11");
      expect(state.numberInputs).toBe(1);

      // Re-observe after controls have expanded/reflowed before relying on text geometry.
      await harness.capture();
      const selectionStart = await harness.point("#copy-fragment", { x: 0.02, y: 0.5 });
      const selectionEnd = await harness.point("#copy-fragment", { x: 0.98, y: 0.5 });
      const selected = await harness.act({
        action: "drag",
        returnScreenshot: true,
        x: selectionStart.x,
        y: selectionStart.y,
        endX: selectionEnd.x,
        endY: selectionEnd.y,
      });
      expect(selected.feedbackAvailable).toBe(true);
      state = await harness.state(STATE_READER);
      expect(state.clipboardSelection).toBe("复制片段");

      expectStable(await harness.act({
        action: "press",
        returnScreenshot: false,
        key: `${harness.primaryModifier}+C`,
      }));
      state = await harness.state(STATE_READER);
      expect(state.copyEvents).toBe(1);
      expect(state.copiedText).toBe("复制片段");

      const pasteTarget = await harness.point("#clipboard-target");
      expectStable(await harness.act({
        action: "click",
        returnScreenshot: false,
        ...pasteTarget,
      }));
      const pasted = await harness.act({
        action: "press",
        returnScreenshot: true,
        key: `${harness.primaryModifier}+V`,
      });
      expect(pasted.feedbackAvailable).toBe(true);
      state = await harness.state(STATE_READER);
      expect(state.pasteEvents).toBe(1);
      expect(state.pastedText).toBe("复制片段");
      expect(state.clipboardTargetValue).toBe("复制片段");
    } finally {
      await harness.close();
    }
  });
});

function expectStable(result) {
  expect(result.status).toBe("completed");
  expect(result.feedbackAvailable).toBe(false);
  expect(result.coordinateBasisReady).toBe(true);
  expect(result.viewportChange).toEqual({
    observed: true,
    scrolled: false,
    deltaX: 0,
    deltaY: 0,
    scaled: false,
    resized: false,
  });
  return result;
}
