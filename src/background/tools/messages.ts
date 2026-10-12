import { defineMessages } from "../../shared/i18n/definition.js";
import { createTranslator } from "../../shared/i18n/index.js";

/** Shared model-facing documentation stays out of the panel's UI catalog. */
const messages = defineMessages("tool-runtime", {
  timeout: {
    "zh-CN": "工具硬超时，单位秒。不填时系统按工具类型给出默认值。",
    en: "Hard timeout in seconds. If omitted, the runtime uses the default for this tool type.",
  },
  elementReference: {
    "zh-CN": "元素机器引用，格式：{grammar}。element_uid 必须来自 get_ax_tree/find_elements/list_images 返回的 uid；css_selector 必须能被当前页面 querySelector/querySelectorAll 匹配。示例：{examples}。不要传按钮文案、页面标题、URL 或自然语言。",
    en: "Machine-readable element reference: {grammar}. element_uid must be a uid returned by get_ax_tree/find_elements/list_images; css_selector must match the current page via querySelector/querySelectorAll. Examples: {examples}. Do not pass button text, page titles, URLs, or natural-language descriptions.",
  },
  nextPageSelector: { "zh-CN": "下一页", en: "Next page" },
  commentSelector: { "zh-CN": "评论", en: "Comment" },
});

export const t = createTranslator(messages);
