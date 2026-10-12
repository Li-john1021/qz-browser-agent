import { t } from "./i18n.js";
import type { CapabilityMetadata } from "#sdk/shared/metadata";

const families = () => Object.freeze({
  arrival: Object.freeze({ id: "arrival", title: t("navigateToPage"), shortTitle: t("navigateToPageShort") }),
  collect: Object.freeze({ id: "collect", title: t("collectInformation"), shortTitle: t("collectInformationShort") }),
  operate: Object.freeze({ id: "operate", title: t("operatePage"), shortTitle: t("operatePageShort") }),
  process: Object.freeze({ id: "process", title: t("processData"), shortTitle: t("processDataShort") }),
  artifact: Object.freeze({ id: "artifact", title: t("createArtifacts"), shortTitle: t("createArtifactsShort") }),
  document: Object.freeze({ id: "document", title: t("readDocuments"), shortTitle: t("readDocumentsShort") }),
  mcp: Object.freeze({ id: "mcp", title: "MCP", shortTitle: "MCP" }),
  settings: Object.freeze({ id: "settings", title: t("manageSettings"), shortTitle: t("manageSettingsShort") }),
  confirm: Object.freeze({ id: "confirm", title: t("waitingForConfirmation"), shortTitle: t("waitingForConfirmationShort") }),
  alert: Object.freeze({ id: "confirm", title: t("notifyUser"), shortTitle: t("notifyUserShort") }),
  other: Object.freeze({ id: "other", title: t("otherTools"), shortTitle: t("otherToolsShort") }),
});

const actionLabels = () => Object.freeze({
  append: t("append"),
  clear: t("clear"),
  click: t("click"),
  close: t("close"),
  create: t("create"),
  delete: t("delete"),
  diff: "Diff",
  edit: t("edit"),
  fill: t("fill"),
  get: t("read"),
  insert: t("insert"),
  list: t("list"),
  move: t("move"),
  press: t("pressKey"),
  prepend: t("prepend"),
  recent: t("recent"),
  replace: t("replace"),
  search: t("search"),
  update: t("update"),
  upsert: t("writeUpdate"),
  wait: t("wait"),
});

export default { get actionLabels() { return actionLabels(); }, get families() { return families(); } } satisfies CapabilityMetadata;
