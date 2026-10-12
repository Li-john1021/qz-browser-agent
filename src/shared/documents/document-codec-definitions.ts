import contributions from "#capabilities/metadata";
import { mergeCapabilityRecords } from "../capabilities.js";

// This module must remain metadata-only: input forms must not load PDF/DOCX engines.
const formats = mergeCapabilityRecords(contributions.flatMap(item => item.documentFormats || [])
  .map(format => ({ [format.id]: format })));
export const DOCUMENT_OUTPUT_FORMATS: readonly string[] = Object.freeze(Object.values(formats)
  .filter(format => format.output).map(format => format.id));
