import { defineMessages } from "../../../shared/i18n/definition.js";

/** Product-owned UI and host messages; page scripts and external content remain unchanged. */
export default defineMessages("product-public", {
  "thisProductHasNoGitPublishingAdapterExportThe": { "zh-CN": "当前产品未配置 Git 发布适配器，可导出 Skill 后提交到仓库。", en: "Direct Git publishing is not available in this version. Export the skill and commit it to your repository." },
  "configureModelEndpoint": { "zh-CN": "配置模型接口", en: "Connect a model" },
  "connectingToGpt": { "zh-CN": "GPT 正在连接…", en: "Connecting to the model…" },
});
