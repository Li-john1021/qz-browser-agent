import assert from "node:assert/strict";
import { registerTableExample } from "../fixtures/capabilities/example/table-tool.js";

/** Execute the production example against the real Background Tool pipeline. */
export async function assertTableToolExample(tools) {
  registerTableExample(tools.defineTool);
  const definition = tools.resolveToolDefinition("example_table");
  assert.equal(definition.rendererId, "table");
  assert.equal(tools.getToolIdentity("example_table").rendererId, "table");
  const input = { title: "Revenue", rows: [{ label: "A", value: 1 }, { label: "B", value: 2 }] };
  assert.deepEqual(await tools.executeTool("example_table", input), input);
  for (const rows of ["wrong", [{ label: "A", value: "1" }], [{ label: "A", value: Infinity }]]) {
    await assert.rejects(tools.executeTool("example_table", { rows }), error => error.code === "INVALID_ARGUMENTS");
  }
  await assert.rejects(tools.executeTool("example_table", { rows: [{ label: "A" }] }),
    error => error.code === "MISSING_REQUIRED_ARGUMENTS");
  assert.deepEqual(await tools.executeTool("example_table", input), input, "invalid calls must not poison later valid execution");
}
