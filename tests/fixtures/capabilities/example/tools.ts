import type { ToolExtension } from "#sdk/background";
import { registerTableExample } from "./table-tool.js";

const register: ToolExtension = ({ registerTool }) => {
  registerTableExample(registerTool, { rendererId: "example.value-card" });
};
export default register;
