import assert from "node:assert/strict";
import test from "node:test";
import { createCdpTouch } from "../../src/background/tools/cdp-touch.js";
import { ToolExecutionError } from "../../src/background/tools/arguments.js";

const touch = createCdpTouch({ ToolExecutionError });
const point = { x: 20, y: 30 };

test("touch tap and drag finish with no active contacts", async () => {
  const calls = [];
  const send = async (method, params) => { calls.push({ method, ...params }); };
  await touch(send, point);
  assert.deepEqual(calls.map(call => call.type), ["touchStart", "touchEnd"]);
  assert.deepEqual(calls.at(-1).touchPoints, []);
  calls.length = 0;
  await touch(send, point, { end: { x: 220, y: 80 }, durationMs: 16 });
  assert.equal(calls.filter(call => call.type === "touchMove").length, 8);
  assert.deepEqual(calls.at(-2).touchPoints[0], { x: 220, y: 80, id: 0, radiusX: 1, radiusY: 1, force: 1 });
  assert.deepEqual(calls.at(-1).touchPoints, []);
  assert(calls.every(call => call.method === "Input.dispatchTouchEvent"));
});

for (const phase of ["before", "start", "hold", "move"]) {
  test(`cancel during ${phase} never commits a tap or continues a drag`, async () => {
    const controller = new AbortController();
    const calls = [];
    if (phase === "before") controller.abort();
    const send = async (_method, params) => {
      calls.push(params.type);
      if ((phase === "start" || phase === "hold") && params.type === "touchStart") {
        if (phase === "hold") setTimeout(() => controller.abort(), 5);
        else controller.abort();
      }
      if (phase === "move" && params.type === "touchMove") controller.abort();
    };
    await assert.rejects(touch(send, point, {
      signal: controller.signal, durationMs: 1000, ...(phase === "move" ? { end: { x: 200, y: 300 } } : {}),
    }), { code: "OPERATION_ABORTED" });
    if (phase === "before") assert.deepEqual(calls, []);
    else {
      assert.equal(calls.at(-1), "touchCancel");
      assert.equal(calls.includes("touchEnd"), false);
      assert.equal(calls.filter(type => type === "touchMove").length, phase === "move" ? 1 : 0);
    }
  });
}

test("a lost connection stops the gesture and preserves the original error even when cleanup fails", async () => {
  const calls = [];
  const lost = new ToolExecutionError("CDP_RUN_RELEASED", "connection replaced");
  await assert.rejects(touch(async (_method, params) => {
    calls.push(params.type);
    if (params.type !== "touchStart") throw lost;
  }, point, { end: { x: 100, y: 100 }, durationMs: 8 }), error => error === lost);
  assert.deepEqual(calls, ["touchStart", "touchMove", "touchCancel"]);
});
