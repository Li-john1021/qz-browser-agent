import { defineMessages } from "#sdk/shared/i18n-definition";
import { createTranslator } from "#sdk/shared/i18n";

/** Model documentation is separate from the eager UI translation catalog. */
const messages = defineMessages("skills-model", {
  askLlm: {
    "zh-CN": `调用 LLM 进行独立分析。用于：数据分析、内容总结、翻译、分类、代码生成、对比等需要深度思考的子任务。
通常由 run_script 内部通过 const text = await tools.ask_llm(...) 调用，并由脚本处理返回的字符串、继续落库或决策。`,
    en: "Call an LLM for independent analysis, such as data analysis, summarization, translation, classification, code generation, or comparison. Usually called inside run_script as const text = await tools.ask_llm(...); the script processes the returned string and continues saving data or making decisions.",
  },
  analysisPrompt: {
    "zh-CN": "提示词 / 问题",
    en: "Prompt or question.",
  },
  analysisSystem: {
    "zh-CN": "可选的 system prompt，用于设定角色或输出格式",
    en: "Optional system prompt defining the role or output format.",
  },
  analysisData: {
    "zh-CN": "要分析的数据/文本（会追加到 prompt 后）",
    en: "Data or text to analyze, appended to the prompt.",
  },
  loadSkill: {
    "zh-CN": "加载一个 skill 的完整指令和真实资源清单。当任务匹配可用 skill 时，必须先调用此工具获取详细步骤再执行；正文在 content 字段中返回，resources 只包含 plugin.json、scripts、references、模板等资源。需要分块读取 references、脚本或模板等单个资源文件时，优先调用 load_skill_resource(name,path)；includeResources:true 仅作整包诊断兜底。返回的 runtime 字段说明 skill 的真实运行环境。",
    en: "Load a Skill's full instructions and actual resource index. When an available Skill matches the task, load it before following its detailed workflow. The body is returned in content; resources contains only files such as plugin.json, scripts, references, and templates. Prefer load_skill_resource(name,path) to read individual reference, script, or template files in chunks. Use includeResources:true only as a whole-package diagnostic fallback. runtime describes the Skill's actual execution environment.",
  },
  skillName: {
    "zh-CN": "skill 名称",
    en: "Skill name.",
  },
  skillIncludeResources: {
    "zh-CN": "是否返回资源源码/content。默认 false，避免把大脚本放进上下文。",
    en: "Return resource source/content. Default: false, to keep large scripts out of context.",
  },
  loadSkillResource: {
    "zh-CN": "加载 skill 包内单个真实资源文件。文本资源按字符分块返回；DOCX、XLSX、PDF 会自动使用轻舟 document pipeline 解析，返回首块预览与 docModelId，长文档可继续用 qingzhou-documents 的 document_read_chunk 读取。skill 正文请直接使用 load_skill 返回的 content 字段。",
    en: "Load one actual resource file from a Skill package. Text resources are returned in character-based chunks. DOCX, XLSX, and PDF files are parsed automatically by qz's document pipeline, returning an initial preview and docModelId. Continue long documents with qingzhou-documents document_read_chunk. For the Skill body, use content returned by load_skill.",
  },
  skillResourcePath: {
    "zh-CN": "skill 包内真实资源相对路径，如 references/checklist.md、references/report.xlsx、references/brief.docx、references/manual.pdf、scripts/collect.js 或 plugin.json",
    en: "Actual relative resource path in the Skill package, such as references/checklist.md, references/report.xlsx, references/brief.docx, references/manual.pdf, scripts/collect.js, or plugin.json.",
  },
  skillResourceStart: {
    "zh-CN": "可选：仅用于文本资源，从第几个字符开始读取，默认 0。",
    en: "Optional character offset for text resources only. Default: 0.",
  },
  skillResourceMaxChars: {
    "zh-CN": "可选：仅用于文本资源，最多返回多少字符，默认 300000，最大 1000000。",
    en: "Optional maximum characters for text resources only. Default: 300000; maximum: 1000000.",
  },
  manageSkillInternal: {
    "zh-CN": "内部工具：创建、更新、删除或列出 skill。仅供技能工作台 Skill 脚本调用；模型不直接使用。",
    en: "Internal tool to create, update, delete, or list Skills. Called only by Skill workbench scripts, not directly by the model.",
  },
  manageSkillAction: {
    "zh-CN": "skill 管理动作。分支必填：create 需 name、description、content；update/delete 需 name；list_skills 可只传 scope。",
    en: "Skill operation. create requires name, description, and content; update/delete requires name; list_skills may supply only scope.",
  },
  manageSkillScope: {
    "zh-CN": "action=list_skills 时的技能范围",
    en: "Skill scope for action=list_skills.",
  },
  importSkillZipInternal: {
    "zh-CN": "内部工具：使用当前任务网页标签页的登录态下载并导入 Skill Zip。仅供技能工作台 Skill 调用。",
    en: "Internal tool to download and import a Skill ZIP using the login state of a web tab owned by this task. Called only by the Skill workbench.",
  },
  skillZipUrl: {
    "zh-CN": "页面中的 Skill Zip 下载地址",
    en: "Skill ZIP download URL from the page.",
  },
  skillPageTabId: {
    "zh-CN": "当前任务拥有的页面标签页 ID",
    en: "Web tab ID owned by the current task.",
  },
  skillZipOverwrite: {
    "zh-CN": "是否覆盖本地同名 Skill，默认 false",
    en: "Overwrite a local Skill with the same name. Default: false.",
  },
  importSkillGitInternal: {
    "zh-CN": "内部工具：在当前任务拥有的仓库标签页中探测并导入 Git Skill 仓库。仅供技能工作台 Skill 调用。",
    en: "Internal tool to inspect and import a Git Skill repository in a repository tab owned by this task. Called only by the Skill workbench.",
  },
  skillRepositoryUrl: {
    "zh-CN": "已支持的 Git 仓库/目录页地址",
    en: "Supported Git repository or directory page URL.",
  },
  skillRepositoryTabId: {
    "zh-CN": "当前任务拥有的仓库标签页 ID",
    en: "Repository tab ID owned by the current task.",
  },
  skillGitOverwrite: {
    "zh-CN": "是否覆盖同名或本地修改的 Skill，默认 false",
    en: "Overwrite a same-name or locally modified Skill. Default: false.",
  },
  installSkillGitInternal: {
    "zh-CN": "内部工具：将本地 Skill 提交到当前任务拥有的受支持 Git 仓库目录。仅供技能工作台 Skill 调用。",
    en: "Internal tool to commit a local Skill to a supported Git repository directory owned by this task. Called only by the Skill workbench.",
  },
  skillInstallName: {
    "zh-CN": "要提交的本地 Skill 名称",
    en: "Local Skill name to commit.",
  },
  skillInstallTabId: {
    "zh-CN": "当前任务拥有的受支持 Git 仓库根页或目录页标签页 ID",
    en: "Tab ID of a supported repository root or directory page owned by this task.",
  },
  skillCommitMessage: {
    "zh-CN": "可选 Git commit message",
    en: "Optional Git commit message.",
  },
  runtimeGuidance: {
    "zh-CN": `Skill 运行环境是轻舟 Chrome 浏览器扩展，不是 Node.js，也不是服务器。
Markdown content 应描述浏览器操作 SOP：页面观察、元素定位、Network/Data/下载/书签等 Skill 工具如何协作。
Markdown content 引用 references、模板、示例或其他资源文件时，先用 load_skill_resource(name,path) 按需读取单个文件。
DOCX、XLSX、PDF 资源由 load_skill_resource 自动解析为 document model；返回 truncated 时加载 qingzhou-documents，并用 document_read_chunk 继续读取。
script resources 与 run_script.code 使用同一种源码形态：默认写成 async () => { ... } 函数表达式，由轻舟自动调用；可访问 document/window/Web APIs、input/args、tabId、tools/tool；不能使用 fs/path/process/require、npm 包、服务器文件系统、后台常驻进程或本地 shell。
需要跨页面动作时，在 Markdown 中指导 agent 拆成普通工具步骤；不要在脚本里直接点击/提交导致当前 frame 卸载。`,
    en: `Skills run in the qz Chrome extension, not in Node.js or on a server.
Markdown content should describe browser workflows: page observation, element targeting, and coordination among Network, Data, download, bookmark, and other Skill tools.
When Markdown content references files, templates, examples, or other resources, read individual files as needed with load_skill_resource(name,path).
load_skill_resource automatically parses DOCX, XLSX, and PDF resources into document models. If the result is truncated, load qingzhou-documents and continue with document_read_chunk.
Script resources and run_script.code use the same source form: normally an async () => { ... } function expression, invoked automatically by qz. Available APIs include document/window/Web APIs, input/args, tabId, and tools/tool. Do not use fs/path/process/require, npm packages, server filesystems, persistent background processes, or a local shell.
For actions spanning page navigation, guide the agent through ordinary tool steps in Markdown. Do not click or submit from a script if that would unload its current frame.`,
  },
});

export const modelT = createTranslator(messages);
