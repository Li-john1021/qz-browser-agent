import type { CapabilityMetadata } from "#sdk/shared/metadata";
import { defineToolMetadata } from "#sdk/shared/metadata";
import { t } from "./i18n.js";

export default {
  get tools() { return { example_table: defineToolMetadata(t("dataTitle"), [], { resultFamily: "table",
    titleRule: { field: "title", values: { "浏览器调研示例": t("researchTitle") } },
  }) }; },
  documentFormats: [{ id: "json-note", mimeType: "application/vnd.qingzhou.note+json" }],
} satisfies CapabilityMetadata;
