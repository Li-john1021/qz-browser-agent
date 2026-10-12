import { defineMessages } from "#sdk/shared/i18n-definition";
import { createTranslator } from "#sdk/shared/i18n";

// Model instructions are read through pure getters, not added to the DOM message catalog.
export const modelT = createTranslator(defineMessages("example-model", {
  description: { "zh-CN": "展示一组带标签的数值，返回可复制的表格。", en: "Display labeled values as a table that can be copied." },
  title: { "zh-CN": "表格标题；省略时使用示例标题。", en: "Table title. Omit to use the example title." },
  rows: { "zh-CN": "待展示的行，每行包含标签和数值。", en: "Rows to display, each with a label and a numeric value." },
  rowLabel: { "zh-CN": "此行的标签。", en: "Label for this row." },
  rowValue: { "zh-CN": "此行的数值。", en: "Numeric value for this row." },
  skillName: { "zh-CN": "示例阅读指南", en: "Example reading guide" },
  skillDescription: { "zh-CN": "整理页面阅读笔记时，按主题归纳并保留来源。", en: "Organize reading notes by topic and keep the sources." },
  skillContent: {
    "zh-CN": "# 整理阅读笔记\n先读取页面，记录可核验的事实，再按主题归纳。参考 references/outline.md 的结构。",
    en: "# Organize reading notes\nRead the page, record verifiable facts, then group them by topic. Follow the structure in references/outline.md.",
  },
  skillOutline: { "zh-CN": "# 阅读笔记\n## 主题\n## 已核验事实\n## 来源链接", en: "# Reading notes\n## Topic\n## Verified facts\n## Sources" },
}));
