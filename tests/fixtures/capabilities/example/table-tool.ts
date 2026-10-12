import type { ToolExtensionAPI } from "#sdk/background";
import { t } from "./i18n.js";
import { modelT } from "./model-messages.js";
import type { ExampleTableResult } from "./result.js";

/** Shared implementation for the discovered entry and focused execution tests. */
export function registerTableExample(registerTool: ToolExtensionAPI["registerTool"], { rendererId = "table" } = {}) {
  registerTool({
    name: "example_table",
    get title() { return t("dataTitle"); },
    get description() { return modelT("description"); },
    rendererId,
    get parameters() { return {
      type: "object",
      properties: {
        title: { type: "string", description: modelT("title") },
        rows: { type: "array", description: modelT("rows"), items: {
          type: "object",
          properties: {
            label: { type: "string", description: modelT("rowLabel") },
            value: { type: "number", description: modelT("rowValue") },
          },
          required: ["label", "value"],
        } },
      },
      required: ["rows"],
    } as const; },
    execute: ({ title = t("dataTitle"), rows }, signal): ExampleTableResult => {
      signal?.throwIfAborted();
      return { title, rows };
    },
  });
}
