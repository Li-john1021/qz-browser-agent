import assert from "node:assert/strict";
import { rankModelPresetOptions } from "../../src/capabilities/settings/model-preset-switcher.js";

const presets = [
  {
    id: "deepseek",
    label: "DeepSeek · deepseek-v4-flash",
    provider: "deepseek",
    providerLabel: "DeepSeek",
    model: "deepseek-v4-flash",
  },
  {
    id: "kimi",
    label: "KimiCode · kimi-k3",
    provider: "kimicode",
    providerLabel: "KimiCode",
    model: "kimi-k3",
  },
  {
    id: "qwen",
    label: "百炼 · qwen3.7-max",
    provider: "bailian",
    providerLabel: "百炼",
    model: "qwen3.7-max",
  },
];

assert.deepEqual(
  rankModelPresetOptions(presets, "").map(item => item.id),
  ["deepseek", "kimi", "qwen"],
  "an empty query without an active preset should preserve the configured preset order",
);
assert.deepEqual(
  rankModelPresetOptions(presets, "", {
    activePresetId: "deepseek",
    presetUsage: {
      selections: { deepseek: 30, kimi: 4, qwen: 20 },
      transitions: { deepseek: { kimi: 3, qwen: 1 } },
    },
  }).map(item => item.id),
  ["kimi", "qwen", "deepseek"],
  "transition frequency should outrank global selection frequency and keep the current preset last",
);
assert.deepEqual(
  rankModelPresetOptions(presets, "", {
    activePresetId: "deepseek",
    presetUsage: {
      selections: { kimi: 2, qwen: 8 },
      transitions: {},
    },
  }).map(item => item.id),
  ["qwen", "kimi", "deepseek"],
  "selection frequency should order candidates when the current preset has no transition history",
);
assert.deepEqual(
  rankModelPresetOptions(presets, "   ", {
    activePresetId: "deepseek",
    presetUsage: {
      selections: { kimi: 1, qwen: 9 },
      transitions: { deepseek: { kimi: 2, qwen: 2 } },
    },
  }).map(item => item.id),
  ["qwen", "kimi", "deepseek"],
  "equal transition counts should fall back to destination selection frequency",
);
assert.deepEqual(
  rankModelPresetOptions(presets, "", {
    activePresetId: "deepseek",
    presetUsage: {
      selections: { kimi: "invalid", qwen: -2 },
      transitions: { deepseek: { kimi: Number.NaN } },
    },
  }).map(item => item.id),
  ["kimi", "qwen", "deepseek"],
  "malformed memory should fall back to stable configured order",
);
assert.equal(rankModelPresetOptions(presets, "deep v4")[0]?.id, "deepseek");
assert.equal(rankModelPresetOptions(presets, "DÉEP")[0]?.id, "deepseek", "matching should ignore case and Latin accents");
assert.equal(rankModelPresetOptions(presets, "qwen3.7")[0]?.id, "qwen", "punctuation-separated model names should stay searchable");
assert.equal(
  rankModelPresetOptions(presets, "deep v4", {
    activePresetId: "deepseek",
    presetUsage: { selections: { qwen: 999 }, transitions: { deepseek: { qwen: 999 } } },
  })[0]?.id,
  "deepseek",
  "typed search relevance should remain independent from learned default ordering",
);
assert.equal(rankModelPresetOptions(presets, "km k3")[0]?.id, "kimi", "subsequence matching should tolerate abbreviated provider names");
assert.equal(rankModelPresetOptions(presets, "dsk")[0]?.id, "deepseek", "ordered abbreviations should match across omitted characters");
assert.equal(rankModelPresetOptions(presets, "百炼 qwen")[0]?.id, "qwen", "Chinese labels and model ids should share one search corpus");
assert.deepEqual(rankModelPresetOptions(presets, "kimi qwen"), [], "every query token must match the same preset");
assert.deepEqual(rankModelPresetOptions(presets, "deepz"), [], "subsequence matching should not silently accept wrong characters");
assert.deepEqual(
  rankModelPresetOptions([
    { id: "subsequence", model: "a-x-b-x-c" },
    { id: "exact", model: "abc" },
  ], "abc").map(item => item.id),
  ["exact", "subsequence"],
  "a contiguous match should outrank a sparse subsequence",
);
assert.deepEqual(presets.map(item => item.id), ["deepseek", "kimi", "qwen"], "ranking must not mutate persisted preset order");

console.log("model preset switcher tests passed");
