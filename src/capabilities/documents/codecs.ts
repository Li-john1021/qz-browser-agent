import { t } from "./i18n.js";
import * as utilities from "./document-utils.js";
import { BUILTIN_DOCUMENT_CODEC_DEFINITIONS } from "./definitions.js";
import { DocumentCodecError } from "#sdk/shared/documents";
import type { DocumentCodec } from "#sdk/shared/documents";

const printPdf: NonNullable<DocumentCodec["encode"]> = (content, services) => {
  if (!services.printPdf) throw new DocumentCodecError("DOCUMENT_PRINT_UNAVAILABLE", t("pdfExportRequiresAHostPrintService"));
  return services.printPdf(content, services.signal);
};
const handlers = { ...utilities, printPdf };

/** Static bindings work in MV3; UI metadata imports never reach these algorithms. */
const codecs: readonly DocumentCodec[] = Object.freeze(BUILTIN_DOCUMENT_CODEC_DEFINITIONS.map(codec => ({
  ...codec,
  parse: "parse" in codec ? utilities[codec.parse] : undefined,
  encode: "encode" in codec ? handlers[codec.encode] : undefined,
})));

export default codecs;
