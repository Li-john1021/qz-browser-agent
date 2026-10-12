import assert from "node:assert/strict";
import test from "node:test";
import {
  MODEL_PARAMETER_RESERVED_KEYS,
  MODEL_PARAMETER_SUGGESTIONS,
  formatModelParameterValue,
  normalizeModelParameters,
  parseModelParameterEntries,
  parseModelParameterValue,
  serializeModelParameters,
} from "../../src/shared/models/model-parameters.js";

test("model parameter suggestions expose one provider-neutral corpus", () => {
  const keys = MODEL_PARAMETER_SUGGESTIONS.map(item => item.key);
  assert.equal(new Set(keys).size, keys.length);
  for (const key of [
    "reasoning_effort",
    "reasoning",
    "thinking",
    "enable_thinking",
    "thinking_budget",
    "temperature",
    "top_p",
    "max_tokens",
    "max_completion_tokens",
    "max_output_tokens",
    "parallel_tool_calls",
  ]) {
    assert.ok(keys.includes(key), `missing suggestion: ${key}`);
  }
  assert.ok(MODEL_PARAMETER_RESERVED_KEYS.includes("model"));
  assert.ok(MODEL_PARAMETER_RESERVED_KEYS.includes("tools"));
  assert.equal(keys.some(key => MODEL_PARAMETER_RESERVED_KEYS.includes(key)), false);
});

test("model parameter values preserve JSON types and free text", () => {
  assert.equal(parseModelParameterValue("true"), true);
  assert.equal(parseModelParameterValue("FALSE"), false);
  assert.equal(parseModelParameterValue("null"), null);
  assert.equal(parseModelParameterValue("-12.5e2"), -1250);
  assert.equal(parseModelParameterValue("high"), "high");
  assert.equal(parseModelParameterValue(""), "");
  assert.deepEqual(parseModelParameterValue('{"type":"enabled","budget_tokens":4096}'), {
    type: "enabled",
    budget_tokens: 4096,
  });
  assert.deepEqual(parseModelParameterValue('["STOP",42]'), ["STOP", 42]);
  assert.equal(parseModelParameterValue('"001"'), "001");
  assert.throws(() => parseModelParameterValue("{oops}"), /JSON 参数值格式不正确/);
  assert.equal(formatModelParameterValue({ effort: "high" }), '{"effort":"high"}');
  assert.equal(formatModelParameterValue("high"), "high");
});

test("model parameter entries reject ambiguous or kernel-owned fields", () => {
  assert.deepEqual(parseModelParameterEntries([
    { key: "temperature", value: "0.2" },
    { key: "thinking", value: '{"type":"enabled"}' },
    { key: "parallel_tool_calls", value: "false" },
    { key: "", value: "" },
  ]), {
    temperature: 0.2,
    thinking: { type: "enabled" },
    parallel_tool_calls: false,
  });
  assert.throws(
    () => parseModelParameterEntries([{ key: "temperature", value: "0" }, { key: "temperature", value: "1" }]),
    /temperature 重复/,
  );
  assert.throws(() => parseModelParameterEntries([{ key: "", value: "1" }]), /Key 不能为空/);
  assert.throws(() => parseModelParameterEntries([{ key: "messages", value: "[]" }]), /由轻舟管理/);
  assert.throws(() => parseModelParameterEntries([{ key: "__proto__", value: "{}" }]), /由轻舟管理/);
});

test("stored model parameters normalize safely and compare independent of key order", () => {
  const left = normalizeModelParameters({
    temperature: 0.2,
    thinking: { type: "enabled", budget_tokens: 4096 },
  }, { strict: true });
  assert.deepEqual(left, {
    temperature: 0.2,
    thinking: { type: "enabled", budget_tokens: 4096 },
  });
  assert.equal(
    serializeModelParameters({ temperature: 0.2, thinking: { type: "enabled", budget_tokens: 4096 } }),
    serializeModelParameters({ thinking: { budget_tokens: 4096, type: "enabled" }, temperature: 0.2 }),
  );
  assert.deepEqual(normalizeModelParameters({ model: "evil", temperature: 0.2 }), { temperature: 0.2 });
  assert.throws(
    () => normalizeModelParameters({ tools: [] }, { strict: true }),
    /tools 由轻舟管理/,
  );
  assert.throws(
    () => normalizeModelParameters({ temperature: Number.POSITIVE_INFINITY }, { strict: true }),
    /有限值/,
  );
  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(() => normalizeModelParameters({ cyclic }, { strict: true }), /循环引用/);
});
