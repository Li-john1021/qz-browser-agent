import assert from "node:assert/strict";
import test from "node:test";
import {
  CHAT_TEXT_SIZES,
  DEFAULT_CHAT_TEXT_SIZE,
  normalizeChatTextSize,
  stepChatTextSize,
} from "../../src/sidepanel/features/chat/chat-text-size-feature.js";

test("chat text size normalization accepts only stable semantic levels", () => {
  assert.deepEqual(CHAT_TEXT_SIZES.map(item => item.id), [
    "small",
    "compact",
    "standard",
    "comfortable",
    "large",
    "xlarge",
  ]);
  assert.equal(normalizeChatTextSize(" LARGE "), "large");
  assert.equal(normalizeChatTextSize("110"), DEFAULT_CHAT_TEXT_SIZE);
  assert.equal(normalizeChatTextSize("unknown"), DEFAULT_CHAT_TEXT_SIZE);
  assert.equal(normalizeChatTextSize(null), DEFAULT_CHAT_TEXT_SIZE);
});

test("chat text size stepping is bounded and resets invalid input", () => {
  assert.equal(stepChatTextSize("standard", 1), "comfortable");
  assert.equal(stepChatTextSize("standard", -1), "compact");
  assert.equal(stepChatTextSize("compact", -1), "small");
  assert.equal(stepChatTextSize("small", -1), "small");
  assert.equal(stepChatTextSize("xlarge", 1), "xlarge");
  assert.equal(stepChatTextSize("large", 0), "large");
  assert.equal(stepChatTextSize("invalid", 1), "comfortable");
});
