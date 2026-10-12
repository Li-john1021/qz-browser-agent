import assert from "node:assert/strict";
import test from "node:test";
import { registerWaitTools } from "../../src/capabilities/wait/tools.js";
import { normalizeWaitingForm } from "../../src/sidepanel/features/chat/transcript/waiting-card.js";

for (const language of ["zh-CN", "en-US"]) {
  test(`Question labels follow ${language} while answer values retain their original contract`, async context => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, "chrome");
    Object.defineProperty(globalThis, "chrome", { configurable: true, value: { i18n: { getUILanguage: () => language } } });
    context.after(() => previous ? Object.defineProperty(globalThis, "chrome", previous) : delete globalThis.chrome);
    const definitions = new Map();
    const events = [];
    registerWaitTools({
      registerTool: definition => definitions.set(definition.name, definition),
      getToolRuntimeDependencies: () => ({
        emit: event => events.push(event),
        sessions: {
          async beginUserWait() { return { submitted: true, answers: { choice: "选项 5" } }; },
          resolveUserWait() {}, rejectUserWait() {}, isWaitingForUser() {},
        },
      }),
    });
    const result = await definitions.get("ask_user").execute({ message: "用户原文", fields: [{
      id: "choice", label: "用户问题", type: "single_choice", defaultValue: "选项 5",
      options: [
        { label: "显式标签", value: "explicit_value" },
        { label: " 原始标签 " },
        { value: "value_without_label" },
        "字符串选项",
        {},
        { label: null, value: null },
        { label: "", value: "" },
      ],
    }] }, undefined, { sessionId: "session", runId: "run" });
    const form = events.find(event => event.type === "waiting_for_user").form;
    const expectedOptions = [
      { label: "显式标签", value: "explicit_value", description: "" },
      { label: "原始标签", value: "原始标签", description: "" },
      { label: "value_without_label", value: "value_without_label", description: "" },
      { label: "字符串选项", value: "字符串选项" },
      { label: language === "zh-CN" ? "选项 5" : "Option 5", value: "选项 5", description: "" },
      { label: language === "zh-CN" ? "选项 6" : "Option 6", value: "选项 6", description: "" },
    ];
    assert.equal(form.message, "用户原文");
    assert.deepEqual(form.fields[0].options, expectedOptions);
    const displayed = normalizeWaitingForm(form).fields[0];
    assert.equal(displayed.defaultValue, "选项 5");
    assert.deepEqual(displayed.options.map(({ value }) => value), expectedOptions.map(({ value }) => value));
    assert.deepEqual(result.answers, { choice: "选项 5" });
  });
}
