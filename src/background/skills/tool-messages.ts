import { defineMessages } from "../../shared/i18n/definition.js";
import { createTranslator } from "../../shared/i18n/index.js";

/** Host-authored instructions wrap Skill content without rewriting the installed package. */
const messages = defineMessages("skill-tools", {
  "toolTimeout": {
    "zh-CN": "本次 Skill 工具硬超时，单位秒。不填时使用该工具类型的默认策略。",
    "en": "Hard timeout for this Skill tool call, in seconds. If omitted, uses the default policy for this tool type."
  },
  "scriptTimeout": {
    "zh-CN": "必填。Skill 脚本硬超时，单位秒；<= 0 表示无限等待，> 0 表示最多等待对应秒数。",
    "en": "Required. Hard timeout for the Skill script, in seconds. A value <=0 means no time limit; a positive value limits execution to that many seconds."
  },
  "tabId": {
    "zh-CN": "本次调用的目标网页标签页 ID；省略时使用当前任务 workingTabId。",
    "en": "Target web tab ID for this call. If omitted, uses the current task's workingTabId."
  },
  "source": {
    "zh-CN": "来源扩展: {name}",
    "en": "Source Skill: {name}"
  },
  "category": {
    "zh-CN": "分类: {label}",
    "en": "Category: {label}"
  },
  "loadInstructions": {
    "zh-CN": "若任务需要前置导航、多步流程或页面上下文，先调用 load_skill({name:{name}}) 读取完整过程知识；Skill 脚本只封装稳定可执行步骤，不替代 SKILL.md。",
    "en": "If the task needs prior navigation, multiple steps, or page context, first call load_skill({name:{name}}) for the full workflow. Skill scripts provide stable executable steps; they do not replace SKILL.md."
  },
  "mcpRuntime": {
    "zh-CN": "MCP: {server} / {tool}；该工具通过 Skill 绑定的远程 HTTP MCP 服务执行，不需要网页 tab。",
    "en": "MCP: {server} / {tool}. Runs through the remote HTTP MCP server bound to this Skill; no web tab is needed."
  },
  "innerRuntime": {
    "zh-CN": "该 Skill 工具运行在轻舟内部 Worker，不需要网页 tab；脚本可通过 $plugin.config 读取该 Skill 声明的设置，并使用标准 fetch 访问 manifest 允许的来源。",
    "en": "This Skill tool runs in qz's internal Worker and needs no web tab. Scripts can read declared settings through $plugin.config and use standard fetch for origins allowed by the manifest."
  },
  "pageTarget": {
    "zh-CN": "页面目标: 该 Skill 工具使用显式的当前任务拥有 tabId，或当前任务 workingTabId。",
    "en": "Page target: this Skill tool uses an explicit tabId owned by the current task, or the current task's workingTabId."
  },
  "requiredTimeout": {
    "zh-CN": "必须传入 timeout（秒）让模型主动判断本次 Skill 脚本执行上限；<= 0 表示无限等待，> 0 表示最多等待对应秒数。",
    "en": "You must supply timeout in seconds after deciding how long this Skill script may run. A value <=0 means no time limit; a positive value limits execution to that many seconds."
  },
  "optionalTimeout": {
    "zh-CN": "可选传入 timeout（秒）控制本次 Skill 工具硬超时。",
    "en": "Optionally supply timeout in seconds to set a hard limit for this Skill tool call."
  }
});

export const skillToolT = createTranslator(messages);
