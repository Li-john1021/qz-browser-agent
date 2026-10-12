import assert from "node:assert/strict";
import { stringSessionId, sessionIdText, optionalSessionId } from "../../src/sidepanel/features/sessions/session-id.js";

// Historical snapshots use empty strings; selection APIs use null. Do not collapse these boundaries.
for (const [input, text, strict] of [
  [undefined, "", ""], [null, "", ""], ["", "", ""], ["  ", "", ""],
  [" session-1 ", "session-1", "session-1"], [0, "0", ""], [7, "7", ""],
  [false, "false", ""], [{ toString: () => " legacy " }, "legacy", ""],
]) {
  assert.equal(stringSessionId(input), strict);
  assert.equal(sessionIdText(input), text);
  assert.equal(optionalSessionId(input), text || null);
}
console.log("sidepanel session id tests passed");
