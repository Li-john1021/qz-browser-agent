import assert from "node:assert/strict";
import { normalizeWaitingForm } from "../../src/sidepanel/features/chat/transcript/waiting-card.js";

await testBackgroundFormDefaults();
testSidepanelFormDefaults();

console.log("wait form default value tests passed");

async function testBackgroundFormDefaults() {
  const { registerWaitTools } = await import("../../src/capabilities/wait/tools.js");
  const definitions = new Map();
  const events = [];
  registerWaitTools({
    registerTool: definition => definitions.set(definition.name, definition),
    getToolRuntimeDependencies: () => ({
      emit: event => events.push(event),
      sessions: {
        async beginUserWait() { return { submitted: true, answers: {} }; },
        resolveUserWait() {}, rejectUserWait() {}, isWaitingForUser() {},
      },
    }),
  });
  await definitions.get("ask_user").execute({ message: "Choose", fields: [
    { id: "skill_name", type: "text", defaultValue: " bilibili-codesign-smoke " },
    { id: "output_shape", type: "single_choice", default: "mixed", options: [{ label: "混合", value: "mixed" }] },
    { id: "selected_tools", type: "multi_choice", defaultValues: ["search", " detail ", ""], options: ["search", "detail", "author"] },
  ] }, undefined, { sessionId: "test", runId: "run" });
  const [text, single, multi] = events[0].form.fields;
  assert.equal(text.defaultValue, "bilibili-codesign-smoke");
  assert.equal(single.defaultValue, "mixed");
  assert.deepEqual(multi.defaultValue, ["search", "detail"]);
}

function testSidepanelFormDefaults() {
  const form = normalizeWaitingForm({
    fields: [
      {
        id: "skill_name",
        label: "Skill 名称",
        type: "text",
        defaultValue: "bilibili-codesign-smoke",
      },
      {
        id: "notes",
        label: "备注",
        type: "textarea",
        default: "只读 smoke",
      },
      {
        id: "output_shape",
        label: "输出形态",
        type: "single_choice",
        defaultValue: "mixed",
        options: [
          { label: "表格", value: "table" },
          { label: "混合", value: "mixed" },
        ],
      },
      {
        id: "selected_tools",
        label: "工具",
        type: "multi_choice",
        defaultValues: ["search", "detail"],
        options: [
          { label: "搜索", value: "search" },
          { label: "详情", value: "detail" },
          { label: "作者", value: "author" },
        ],
      },
    ],
  });

  assert.equal(form.fields[0].defaultValue, "bilibili-codesign-smoke");
  assert.equal(form.fields[1].defaultValue, "只读 smoke");
  assert.equal(form.fields[2].defaultValue, "mixed");
  assert.deepEqual(form.fields[3].defaultValue, ["search", "detail"]);
}
