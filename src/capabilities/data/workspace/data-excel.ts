import { t } from "../i18n.js";
import type XLSX from "xlsx/dist/xlsx.mini.min.js";

let pending: Promise<typeof XLSX> | undefined;

/** Load the mini distribution only for spreadsheet I/O, never for plain-text parsing. */
export function loadExcel() {
  return pending ||= import("xlsx/dist/xlsx.mini.min.js").then(module => module.default).catch(error => {
    pending = undefined;
    throw new Error(t("couldNotLoadExcelSupportReopenTheSidePanel"), { cause: error });
  });
}
