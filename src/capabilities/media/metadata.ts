import { t } from "./i18n.js";
import { defineToolMetadata as toolMeta } from "#sdk/shared/metadata";
import type { ToolMetadata } from "#sdk/shared/metadata";
import type { CapabilityMetadata } from "#sdk/shared/metadata";

const tools = () => Object.freeze({
  act_on_screen: elementTool(t("operatePage"), { shortTitle: t("operatePageShort"), labelerId: "screenAction", actionLabels: { click: t("clickPageShort"), double_click: t("doubleClickPageShort"), long_press: t("longPressPageShort"), hover: t("hoverOverPageShort"), type: t("enterTextShort"), press: t("pressKeyShort"), scroll: t("scrollPageShort"), drag: t("dragOnPageShort") }, titleRule: { field: "action", normalize: "trim", values: {}, fallback: "action" } }),
  screenshot: imageTool(t("screenshotPage"), { shortTitle: t("screenshotPageShort"), mediaPresentation: "capture" }),
  list_images: imageTool(t("findImages"), { shortTitle: t("findImagesShort"), detailLayout: "wide" }),
  collect_images: imageTool(t("collectImages"), { familyId: "artifact", detailLayout: "wide" }),
  read_image_asset: imageTool(t("readImageAsset"), { shortTitle: t("readImageAssetShort"), mediaPresentation: "asset" }),
  read_image: imageTool(t("readImage"), { shortTitle: t("readImageShort"), mediaPresentation: "asset" }),
});

export default { get tools() { return tools(); } } satisfies CapabilityMetadata;

function elementTool(title: string, options: Partial<ToolMetadata> = {}) {
  return toolMeta(title, ["element"], {
    shortTitle: options.shortTitle,
    profileFamily: "element",
    resultFamily: "elements",
    familyId: "operate",
    pageContext: true,
    labelerId: options.labelerId, actionLabels: options.actionLabels, titleRule: options.titleRule,
  });
}
function imageTool(title: string, options: Partial<ToolMetadata> = {}) {
  return toolMeta(title, ["image"], {
    shortTitle: options.shortTitle,
    profileFamily: "image",
    resultFamily: "image",
    familyId: options.familyId || "collect",
    pageContext: true,
    detailLayout: options.detailLayout,
    mediaPresentation: options.mediaPresentation,
  });
}
