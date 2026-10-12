import assert from "node:assert/strict";
import test from "node:test";
import { createSidepanelTransport } from "../../src/background/transports/sidepanel.js";

test("device authentication routes arbitrary providers and retains old message envelopes", async () => {
  const calls = [], replies = [];
  const transport = createSidepanelTransport({
    system: { ready: async () => {} },
    auth: Object.fromEntries(["startLogin", "pollLogin", "logout"].map(method => [method, async (...args) => {
      calls.push([method, ...args]);
      return { marker: method };
    }])),
  });
  for (const [type, response, method, args] of [
    ["start_provider_login", "provider_login_started", "startLogin", ["custom-device"]],
    ["poll_provider_login", "provider_login_polled", "pollLogin", ["custom-device", "flow"]],
    ["logout_provider", "provider_logged_out", "logout", ["custom-device"]],
    ["start_codex_login", "codex_login_started", "startLogin", ["openaicodex"]],
    ["poll_codex_login", "codex_login_polled", "pollLogin", ["openaicodex", "flow"]],
    ["logout_codex", "codex_logged_out", "logout", ["openaicodex"]],
  ]) {
    assert.equal(await transport.dispatch({ type, requestId: type, provider: "custom-device", loginId: "flow" }, { postMessage: value => replies.push(value) }), true);
    assert.deepEqual(calls.at(-1), [method, ...args]);
    assert.deepEqual(replies.at(-1), { type: response, requestId: type, marker: method });
  }
});

test("an authentication error does not send a success response or poison later login attempts", async () => {
  const replies = [];
  const transport = createSidepanelTransport({
    system: { ready: async () => {} },
    auth: { startLogin: async provider => {
      if (provider === "broken") throw new Error("login unavailable");
      return { loginId: "recovered" };
    } },
  });
  const port = { postMessage: value => replies.push(value) };
  await assert.rejects(transport.dispatch({ type: "start_provider_login", provider: "broken" }, port), /login unavailable/);
  assert.deepEqual(replies, []);
  await transport.dispatch({ type: "start_provider_login", provider: "custom-device", requestId: "retry" }, port);
  assert.equal(replies[0].loginId, "recovered");
  assert.equal(replies[0].requestId, "retry");
});
