import { defineMessages } from "../../shared/i18n/definition.js";
import { createTranslator } from "../../shared/i18n/index.js";

export const promptT = createTranslator(defineMessages("automation-prompts", {
  manual: { "zh-CN": "手动立即运行", en: "Run now (manual)" },
  catchup: { "zh-CN": "本地恢复后补跑", en: "Catch-up run after this device resumed" },
  scheduled: { "zh-CN": "本地定时触发", en: "Scheduled on this device" },
  introduction: { "zh-CN": "这是一次轻舟本地定时任务运行。", en: "This is a qz scheduled task running on this device." },
  title: { "zh-CN": "任务名称：{value}", en: "Task: {value}" },
  trigger: { "zh-CN": "触发方式：{value}", en: "Trigger: {value}" },
  planned: { "zh-CN": "计划时间：{value}", en: "Scheduled time: {value}" },
  unknown: { "zh-CN": "未记录", en: "Not recorded" },
  started: { "zh-CN": "实际开始：{value}", en: "Actual start: {value}" },
  schedule: { "zh-CN": "调度规则：{value}", en: "Schedule: {value}" },
  delayed: { "zh-CN": "说明：本次由本机恢复后延后执行。", en: "Note: this run was delayed until the device resumed." },
  requirements: { "zh-CN": "执行要求：", en: "Execution requirements:" },
  start: { "zh-CN": "- 按用户配置完成任务，不要询问是否开始。", en: "- Complete the task as configured by the user. Do not ask whether to start." },
  restricted: { "zh-CN": "- 当前定时任务运行是受限 session，不能创建、管理、等待或删除其他 session。", en: "- This scheduled run is a restricted session. Do not create, manage, wait for, or delete other sessions." },
  data: { "zh-CN": "- 如果需要采集结构化结果，优先写入 Data 表。", en: "- Prefer saving structured results to Data tables." },
  blocked: { "zh-CN": "- 如果页面需要登录、验证码或人工介入，使用等待用户的能力并说明原因。", en: "- If a page requires login, CAPTCHA, or human intervention, wait for the user and explain why." },
  finish: { "zh-CN": "- 结束时用简短结论说明结果、异常或下一步建议。", en: "- Finish with a brief summary of the result, any problems, and suggested next steps." },
  user: { "zh-CN": "用户配置：", en: "User instructions:" },
}));
