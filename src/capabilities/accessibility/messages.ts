import { defineMessages } from "#sdk/shared/i18n-definition";

/** Package-owned interface text. Identifiers and user content remain untranslated. */
export default defineMessages("accessibility", {
  "inspectPageTree": { "zh-CN": "解析页面树", en: "Inspect page structure" },
  "inspectPageTreeShort": { "zh-CN": "解析页面树", en: "Inspect page" },
  "pageInspection": { "zh-CN": "页面检查", en: "Page inspection" },
  "pageStructure": { "zh-CN": "页面结构", en: "Page structure" },
  "element": { "zh-CN": "元素", en: "Element" },
  "editable": { "zh-CN": "可编辑", en: "Editable" },
  "outsideViewport": { "zh-CN": "不在视口", en: "Outside the viewport" },
  "interactiveElements": { "zh-CN": "可操作元素", en: "Interactive elements" },
  "items": { "zh-CN": "个", en: "items" },
  "attributes": { "zh-CN": "属性", en: "Attributes" },
  "showingTheFirst": { "zh-CN": "显示前", en: "Showing the first" },
  "cannotResolveAxRoot": { "zh-CN": "无法找到页面结构根节点：{selector}", en: "Could not find the page structure root: {selector}" },
  "pageOverviewResponseIsInvalid": { "zh-CN": "页面概览响应无效。", en: "The page overview returned an invalid response." },
}, { historicalLabels: [
  "inspectPageTree",
] });
