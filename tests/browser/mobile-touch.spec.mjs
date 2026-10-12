import { expect, test } from "./fixtures.mjs";
import { createScreenActionHarness } from "./screen-action-harness.mjs";

test("mobile actions use trusted touch input for taps, holds, drags and input focus", async ({ page, context }) => {
  await page.goto("/tests/fixtures/mobile-touch.html");
  const h = await createScreenActionHarness(page, context, "mobile-touch", { mobile: true });
  try {
    await h.capture();
    const point = await h.point("#surface", { x: 0.15 });
    const end = await h.point("#surface", { x: 0.85 });
    const act = (action, args = {}) => h.act({ action, returnScreenshot: false, ...point, ...args }, undefined, { source: "run_script" });
    await act("click");
    await act("double_click");
    expect((await h.state()).taps).toBe(3);
    await act("long_press", { durationMs: 350 });
    expect((await h.state()).holds).toBe(1);
    await act("drag", { endX: end.x, endY: end.y });
    expect(await h.state()).toMatchObject({ slides: 1, mouse: 0, active: 0 });
    expect((await h.state()).events.every(event => event.trusted)).toBe(true);
    await act("type", { ...await h.point("#query"), text: "关键词", replace: true });
    await expect(page.locator("#query")).toHaveValue("关键词");
    await h.act({ action: "press", key: "Backspace", returnScreenshot: false }, undefined, { source: "run_script" });
    await expect(page.locator("#query")).toHaveValue("关键");
    await act("scroll", { ...await h.point("#scroll"), deltaY: 180 });
    await expect.poll(() => page.locator("#scroll").evaluate(el => el.scrollTop)).toBeGreaterThan(0);
    await h.capture();
    const before = await h.state();
    await expect(act("hover")).rejects.toMatchObject({code:"TOUCH_ACTION_UNSUPPORTED"});
    await expect(act("click", {button:"right"})).rejects.toMatchObject({code:"TOUCH_ACTION_UNSUPPORTED"});
    expect(await h.state()).toEqual(before);
  } finally { await h.close(); }
});

test("cancel releases a held finger; navigation invalidates the old screenshot", async ({ page, context }) => {
  await page.goto("/tests/fixtures/mobile-touch.html");
  const h = await createScreenActionHarness(page, context, "mobile-touch-cancel", { mobile: true });
  try {
    await h.capture();
    const point = await h.point("#surface");
    const controller = new AbortController();
    const action = h.act({action:"long_press", durationMs:3000, returnScreenshot:false, ...point}, controller.signal, {source:"run_script"});
    const rejection = expect(action).rejects.toMatchObject({code:"OPERATION_ABORTED"});
    await expect.poll(async () => (await h.state()).active).toBe(1);
    controller.abort();
    await rejection;
    await expect.poll(async () => (await h.state()).active).toBe(0);
    expect((await h.state()).events.at(-1).type).toBe("touchcancel");
    expect(await h.state()).toMatchObject({taps:0, holds:0});
    await h.capture();
    await page.goto("/tests/fixtures/mobile-touch.html?new");
    await expect(h.act({action:"click", returnScreenshot:false, ...point})).rejects.toMatchObject({code:"SCREENSHOT_CONTEXT_STALE"});
    expect((await h.state()).events).toEqual([]);
  } finally { await h.close(); }
});
