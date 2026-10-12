import { defineMessages } from "#sdk/shared/i18n-definition";
import { createTranslator } from "#sdk/shared/i18n";

/** Model documentation is separate from the eager UI translation catalog. */
const messages = defineMessages("mcp-model", {
  mcpInspectServer: {
    "zh-CN": "探测尚未注册到 skill 的远程 HTTP MCP server，读取 serverInfo、capabilities 和 tools/list 等 metadata。默认使用本地 metadata cache；cache miss 或 refresh=true 时才请求远端。不会注册 server，不支持本地 stdio。",
    en: "Inspect an unregistered remote HTTP MCP server for metadata such as serverInfo, capabilities, and tools/list. Uses the local metadata cache unless it is missing or refresh=true. Does not register the server. Local stdio is unsupported.",
  },
  mcpUrl: {
    "zh-CN": "远程 HTTP MCP endpoint URL，例如 https://example.com/mcp。只支持 http(s)，不支持本地 stdio。",
    en: "Remote HTTP MCP endpoint URL, for example https://example.com/mcp. Only http(s) is supported; local stdio is unsupported.",
  },
  mcpName: {
    "zh-CN": "可选临时名称，用于结果展示和缓存 key；不填时使用 adhoc。",
    en: "Optional temporary name for display and the cache key. Default: adhoc.",
  },
  mcpHeaders: {
    "zh-CN": "可选请求头，例如 Authorization 或 API key。",
    en: "Optional request headers, such as Authorization or an API key.",
  },
  mcpRefreshMetadata: {
    "zh-CN": "是否绕过 metadata cache，强制重新 initialize 并执行 tools/list。",
    en: "Bypass the metadata cache, initialize again, and run tools/list.",
  },
  mcpIncludeResources: {
    "zh-CN": "是否尝试读取 resources/list 和 resource templates；仅在 server capabilities 声明支持时执行。",
    en: "Attempt resources/list and resource templates only if the server declares support in its capabilities.",
  },
  mcpIncludePrompts: {
    "zh-CN": "是否尝试读取 prompts/list；仅在 server capabilities 声明支持时执行。",
    en: "Attempt prompts/list only if the server declares support in its capabilities.",
  },
  mcpMetadataLimit: {
    "zh-CN": "tools/resources/prompts 最多返回多少项，默认 100。",
    en: "Maximum tools/resources/prompts to return. Default: 100.",
  },
  mcpListTools: {
    "zh-CN": "列出所有 skill/plugin.json 汇总出的虚拟全局 MCP registry。结果里的 pluginTool.name 是已注册 MCP 的正式调用入口；应先 load_skill(skillName)，再调用该 Skill 工具名。若只看当前页面或本会话已加载 skill 激活的 MCP，传 activeOnly=true。",
    en: "List the virtual global MCP registry assembled from all skill/plugin.json manifests. pluginTool.name in each result is the registered invocation entry point. Call load_skill(skillName) first, then use that Skill tool name. Set activeOnly=true to include only MCP tools activated by the current page or Skills loaded in this session.",
  },
  mcpServerFilter: {
    "zh-CN": "可选 MCP server 引用，如 pluginId:serverId 或 serverId；不填时列出虚拟 registry 中所有 MCP server。",
    en: "Optional MCP server reference, such as pluginId:serverId or serverId. If omitted, lists every server in the virtual registry.",
  },
  mcpRefreshTools: {
    "zh-CN": "是否绕过本地 MCP 工具缓存，重新向远程 server 执行 tools/list。",
    en: "Bypass the local MCP tool cache and request tools/list from the remote server again.",
  },
  mcpListActiveOnly: {
    "zh-CN": "是否只包含当前页面或已 load_skill 激活的 Skill MCP。默认 false，即全局列出所有 skill 声明的 MCP。",
    en: "Include only Skill MCP tools activated by the current page or load_skill. Default: false, which lists MCP tools declared by all Skills.",
  },
  mcpToolLimit: {
    "zh-CN": "最多返回多少个工具，默认 50。",
    en: "Maximum tools to return. Default: 50.",
  },
  mcpSearchTools: {
    "zh-CN": "搜索所有 skill/plugin.json 汇总出的虚拟全局 MCP registry。结果里的 pluginTool.name 是已注册 MCP 的正式调用入口；应先 load_skill(skillName)，再调用该 Skill 工具名。若只搜索当前页面或本会话已加载 skill 激活的 MCP，传 activeOnly=true。",
    en: "Search the virtual global MCP registry assembled from all skill/plugin.json manifests. pluginTool.name in each result is the registered invocation entry point. Call load_skill(skillName) first, then use that Skill tool name. Set activeOnly=true to search only MCP tools activated by the current page or Skills loaded in this session.",
  },
  mcpQuery: {
    "zh-CN": "搜索关键词，可以是工具名、能力描述、serverId、pluginId 或 skill 名。",
    en: "Search terms: a tool name, capability description, serverId, pluginId, or Skill name.",
  },
  mcpServerReference: {
    "zh-CN": "可选 MCP server 引用，如 pluginId:serverId 或 serverId。",
    en: "Optional MCP server reference, such as pluginId:serverId or serverId.",
  },
  mcpRefreshSearch: {
    "zh-CN": "是否重新向远程 server 执行 tools/list。",
    en: "Request tools/list from the remote server again.",
  },
  mcpSearchActiveOnly: {
    "zh-CN": "是否只包含当前页面或已 load_skill 激活的 Skill MCP。默认 false，即全局搜索所有 skill 声明的 MCP。",
    en: "Search only Skill MCP tools activated by the current page or load_skill. Default: false, which searches MCP tools declared by all Skills.",
  },
  mcpCallTool: {
    "zh-CN": "直接按 URL 调用尚未注册到 skill 的远程 HTTP MCP tool，用于开发期一次性验证或轻量请求。已注册 MCP 必须先 load_skill(skillName)，再调用 registry 返回的 Skill 工具名 pluginTool.name；不要用本工具绕过 Skill 工具层。建议先探测 inputSchema；默认不重复执行 tools/list。不会注册 server，不支持本地 stdio。",
    en: "Call an unregistered remote HTTP MCP tool directly by URL for a one-off request or development check. For registered MCP tools, first load_skill(skillName), then invoke pluginTool.name from the registry. Do not bypass the Skill tool layer with this tool. Inspect inputSchema first. Does not repeat tools/list by default or register the server. Local stdio is unsupported.",
  },
  mcpToolName: {
    "zh-CN": "远程 MCP tool 原始名称。建议来自 qingzhou_mcp__mcp_inspect_server 返回的 tools[].name。",
    en: "Original remote MCP tool name. Prefer tools[].name returned by qingzhou_mcp__mcp_inspect_server.",
  },
  mcpArguments: {
    "zh-CN": "传给远程 MCP tool 的 JSON 参数对象。",
    en: "JSON argument object to pass to the remote MCP tool.",
  },
  mcpValidate: {
    "zh-CN": "调用前是否用 tools/list 校验 tool 存在。默认 false；传 true 时使用 metadata cache，refresh=true 时强制刷新。",
    en: "Check that the tool exists using tools/list before calling it. Default: false. When true, uses the metadata cache unless refresh=true.",
  },
  mcpRefreshCall: {
    "zh-CN": "validate=true 时是否绕过 metadata cache，强制重新执行 tools/list。",
    en: "When validate=true, bypass the metadata cache and request tools/list again.",
  },
  builtinContent: {
    "zh-CN": `# MCP 接入

用于发现、探测和试调用 MCP。轻舟只支持远程 HTTP MCP，不支持本地 stdio。

## 先判断对象

- 已写入某个 skill 的 MCP：使用虚拟全局 registry 查找，正式调用对应 Skill 工具。
- 用户给出尚未注册的 MCP URL：先探测 metadata；只有需要一次性验证时才直调。
- 用户要长期接入：先完成探测和最小试调用，再加载 \`skill-workbench\`，把选中的 server/tool 写入目标 skill。

## 已注册 MCP

1. 不知道入口时，用 \`{SEARCH}\` 按能力、工具名、server 或 Skill 搜索；需要浏览全量时用 \`{LIST}\`。
2. 结果中的 \`skillName\` 表示所属 skill，\`pluginTool.name\` 是正式执行入口。
3. 先 \`load_skill(skillName)\` 激活该 Skill，再调用 \`pluginTool.name\`。不要用 \`{CALL}\` 绕过 Skill 工具层。
4. \`activeOnly:false\` 会搜索所有 skill 声明的虚拟 registry；只看当前页面或本会话已加载能力时传 \`activeOnly:true\`。
5. 默认使用 metadata cache；只有需要确认远端最新工具时才传 \`refresh:true\`。

## 未注册 MCP

1. 调用 \`{INSPECT}\`，传入 URL 和必要 headers，读取 \`serverInfo\`、\`capabilities\`、\`tools\` 与 \`inputSchema\`。不要为了探测创建临时 skill。
2. 默认只读取工具 metadata；只有任务确实需要时才传 \`includeResources:true\` 或 \`includePrompts:true\`。
3. 一次性请求或开发期验证使用 \`{CALL}\`。工具名和参数必须来自刚探测到的 \`tools[].name/inputSchema\`。
4. \`{CALL}\` 默认不重复执行 \`tools/list\`；需要调用前校验时传 \`validate:true\`，需要强制刷新时再传 \`refresh:true\`。

## 长期接入

1. 先通过 \`{INSPECT}\` 和必要的 \`{CALL}\` 确认 server 可用、目标工具名称和参数契约。
2. 只绑定用户任务真正需要的工具，不默认包装 server 的全部工具。
3. 根据最小试调用的真实返回结构选择轻舟标准 renderer；加载 \`skill-workbench\` 后先读取可用渲染器，再把 renderer 与返回 shape 一起设计。不要把原本只有自然语言的 MCP 文本臆测成表格。
4. 在目标 skill 的 \`plugin.json.mcpServers\` 声明 server，并在 \`tools[]\` 中配置 \`runtime:"mcp"\`、\`mcp:{ server, tool }\` 和匹配返回结构的 \`renderer\`。未声明 renderer 时只使用结构化数据或文本兜底。
5. 写入后重新 \`load_skill\`，再用 \`{SEARCH}\` 或 \`{LIST}\` 验证 registry 中出现 \`pluginTool.name\`，最后通过该 Skill 工具做正式调用并确认结果 UI。

## 结果

- 最终说明使用的是已注册 Skill 入口还是一次性 URL 调用，并给出 server/tool 名称、结果摘要和必要限制；不要复制大段 MCP 原始响应。`,
    en: `# MCP integration

Discover, inspect, and test MCP tools. qz supports remote HTTP MCP only, not local stdio.

## Identify the target

- MCP already declared in a Skill: find it through the virtual global registry and invoke the registered Skill tool.
- An unregistered MCP URL supplied by the user: inspect its metadata first; call it directly only for a one-off check.
- Persistent integration: inspect the server and make a minimal test call, then load \`skill-workbench\` to add selected servers/tools to the target Skill.

## Registered MCP

1. Use \`{SEARCH}\` to find tools by capability, tool name, server, or Skill; use \`{LIST}\` to browse all tools.
2. \`skillName\` identifies the owning Skill; \`pluginTool.name\` is the registered invocation entry point.
3. Activate it with \`load_skill(skillName)\`, then call \`pluginTool.name\`. Do not bypass the Skill tool layer with \`{CALL}\`.
4. \`activeOnly:false\` searches the virtual registry declared by all Skills. Use \`activeOnly:true\` for capabilities activated by the current page or loaded in this session.
5. Use the metadata cache by default. Set \`refresh:true\` only when you need the latest remote tool definitions.

## Unregistered MCP

1. Call \`{INSPECT}\` with the URL and required headers to read \`serverInfo\`, \`capabilities\`, \`tools\`, and \`inputSchema\`. Do not create a temporary Skill just for inspection.
2. Read tool metadata by default. Set \`includeResources:true\` or \`includePrompts:true\` only when the task needs them.
3. Use \`{CALL}\` for a one-off request or development check. Tool names and arguments must come from the freshly inspected \`tools[].name/inputSchema\`.
4. \`{CALL}\` does not repeat \`tools/list\` by default. Set \`validate:true\` to check before calling, and add \`refresh:true\` only when a fresh check is needed.

## Persistent integration

1. Use \`{INSPECT}\` and, if needed, \`{CALL}\` to verify server availability, the target tool names, and their argument contracts.
2. Bind only tools the user's task needs; do not wrap every tool by default.
3. Choose a standard qz renderer from the actual minimal test response. After loading \`skill-workbench\`, inspect available renderers and design the renderer together with the result shape. Do not assume natural-language MCP text is a table.
4. Declare the server in the target Skill's \`plugin.json.mcpServers\`. In \`tools[]\`, set \`runtime:"mcp"\`, \`mcp:{ server, tool }\`, and a \`renderer\` matching the response shape. If no renderer is declared, structured-data or text fallback is used.
5. After writing, call \`load_skill\` again. Use \`{SEARCH}\` or \`{LIST}\` to verify that \`pluginTool.name\` appears in the registry, then invoke that Skill tool and inspect its result UI.

## Delivery

- State whether you used a registered Skill entry point or a one-off URL call. Give the server/tool names, a concise result, and material limitations; do not reproduce large raw MCP responses.`,
  },
  mcpDisplayName: {
    "zh-CN": "MCP 接入",
    en: "MCP integration",
  },
  mcpDescription: {
    "zh-CN": "发现已注册的 MCP 能力，探测尚未注册的远程 HTTP MCP server，并进行一次性试调用。用户要求查找、测试、接入或调用 MCP 时加载；长期接入时再配合技能工作台写入 skill。",
    en: "Discover registered MCP capabilities, inspect unregistered remote HTTP MCP servers, and make one-off test calls. Load when the user asks to find, test, integrate, or call MCP tools. For persistent integrations, use the Skill workbench to add them to a Skill.",
  },
  mcpManifestTitle: {
    "zh-CN": "MCP 接入 Skill 工具清单",
    en: "MCP integration Skill tool manifest",
  },
  mcpManifestDescription: {
    "zh-CN": "声明按需加载的 MCP 发现、探测和试调用 host 工具。",
    en: "Declares on-demand host tools for MCP discovery, inspection, and test calls.",
  },
  mcpScriptDescription: {
    "zh-CN": "MCP 接入 host runtime 转发脚本。",
    en: "MCP integration host runtime forwarding script.",
  },
});

export const modelT = createTranslator(messages);
