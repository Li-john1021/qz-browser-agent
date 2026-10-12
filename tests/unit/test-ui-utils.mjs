import assert from "node:assert/strict";
import { rowsToTsv, formatFileSize, formatTokenCount, formatContextUsageText } from "../../src/sidepanel/ui/ui-utils.js";

const rows = [
  { title: "视频\t一", owner: "UP\n主", meta: { play: "1万" } },
  { title: "视频二", owner: "作者二", meta: ["a", "b"] },
];

assert.equal(
  rowsToTsv(rows, ["title", "owner", "meta"]),
  [
    "title\towner\tmeta",
    '视频 一\tUP 主\t{"play":"1万"}',
    '视频二\t作者二\t["a","b"]',
  ].join("\n"),
);

assert.equal(rowsToTsv([{ value: "x" }]), "value\nx");
assert.equal(rowsToTsv([]), "");

assert.equal(formatFileSize(-1), "0 B");
assert.equal(formatFileSize(1536), "2 KB");
assert.equal(formatFileSize(1.5 * 1024 * 1024), "1.5 MB");
assert.equal(formatFileSize(12 * 1024 * 1024), "12 MB");
assert.equal(formatTokenCount(Infinity), "0");
assert.equal(formatTokenCount(-1), "0");
assert.equal(formatTokenCount(1500), "1.5k");
assert.equal(formatTokenCount(1200000), "1.2M");
assert.equal(formatContextUsageText(0, 10000), "");
assert.equal(formatContextUsageText(1200, 0), "ctx 1.2k");
assert.equal(formatContextUsageText(1200, 32000), "ctx 1.2k/32k");

console.log("ui utils tests passed");
