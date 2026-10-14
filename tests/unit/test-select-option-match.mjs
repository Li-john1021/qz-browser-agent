import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const source = readFileSync(join(root, "src/content/content-script.ts"), "utf8");

test("select prefers option textContent before value and errors when unmatched", () => {
  assert.match(source, /option\.textContent\?\.trim\(\) === wanted/);
  assert.match(source, /option\.value === wanted/);
  assert.match(source, /OPTION_NOT_FOUND/);
  assert.match(source, /No <option> matched text or value/);
  // Prefer text before value: text find must appear before value find in source order.
  const textIdx = source.indexOf("option.textContent?.trim() === wanted");
  const valueIdx = source.indexOf("option.value === wanted");
  assert.ok(textIdx > 0 && valueIdx > textIdx, "text match must come before value fallback");
});

/** Mirror of the content-script select matcher for behavioral coverage without Playwright. */
function matchSelectOption(options, value) {
  const wanted = String(value ?? "").trim();
  let match = options.find(option => String(option.textContent || "").trim() === wanted);
  if (!match) match = options.find(option => option.value === wanted);
  if (!match && wanted) {
    return { code: "OPTION_NOT_FOUND", selected: undefined };
  }
  return {
    selected: match ? match.value : "",
    selectedText: match ? String(match.textContent || "").trim() : "",
  };
}

test("matcher selects by visible label when value codes differ", () => {
  const options = [
    { value: "", textContent: "请选择" },
    { value: "sh", textContent: "上海" },
    { value: "bj", textContent: "北京" },
  ];
  assert.deepEqual(matchSelectOption(options, "北京"), { selected: "bj", selectedText: "北京" });
  assert.deepEqual(matchSelectOption(options, "sh"), { selected: "sh", selectedText: "上海" });
  assert.equal(matchSelectOption(options, "广州").code, "OPTION_NOT_FOUND");
});
