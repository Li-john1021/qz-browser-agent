import assert from "node:assert/strict";
import {
  replaceLoneSurrogates,
  sanitizeJsonValue,
  stringifyJsonSafe,
} from "../../src/shared/unicode-utils.js";

assert.equal(replaceLoneSurrogates("完整 emoji 😀 保留"), "完整 emoji 😀 保留");
assert.equal(replaceLoneSurrogates("坏高位 \uD83D 结束"), "坏高位 � 结束");
assert.equal(replaceLoneSurrogates("坏低位 \uDE00 开头"), "坏低位 � 开头");

const payload = {
  messages: [
    { role: "user", content: "slash 引用 [skill: bilibili-data-extractor] \uD83D" },
  ],
  "bad-key-\uD800": "\uDEAD",
};
const sanitized = sanitizeJsonValue(payload);
assert.equal(sanitized.messages[0].content, "slash 引用 [skill: bilibili-data-extractor] �");
assert.equal(sanitized["bad-key-�"], "�");

const json = stringifyJsonSafe({
  content: "完整 😀 + 半个 \uD83D",
});
assert.deepEqual(JSON.parse(json), {
  content: "完整 😀 + 半个 �",
});

console.log("unicode utils tests passed");
