import assert from "node:assert/strict";
import {
  createElementReferenceToken,
  findElementReferenceTokens,
} from "../../src/shared/element-reference.js";

const selector = 'main > section[data-label="a]b"] > button:nth-child(2)';
const token = createElementReferenceToken({ selector });
assert.equal(token, `[css: ${selector}]`);

assert.deepEqual(findElementReferenceTokens(`查看 ${token} 是否正常`), [{
  kind: "element",
  start: 3,
  end: 3 + token.length,
  raw: token,
  selector,
}]);

const multiple = "先看 [css: #list > [data-id='a\\]b']] 再看 [css: main article]";
assert.deepEqual(
  findElementReferenceTokens(multiple).map(item => item.selector),
  ["#list > [data-id='a\\]b']", "main article"],
);

assert.equal(createElementReferenceToken({ selector: "#ok" }), "[css: #ok]");
assert.equal(createElementReferenceToken({ selector: "" }), "");
assert.deepEqual(findElementReferenceTokens("[css: [data-id='x']"), []);

console.log("element reference tests passed");
