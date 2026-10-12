/** Public format contracts and operations, independent of extension implementation paths. */
export { base64ToBytes, bytesToBase64 } from "../../shared/bytes.js";
export { compareBeijingDateTimeDesc, formatBeijingDateTime, formatDisplayDateTime, nowBeijingDateTime, parseBeijingDateTime } from "../../shared/time-utils.js";
export { stringifyJsonSafe } from "../../shared/unicode-utils.js";
export { createZipBytes, openZip } from "../../shared/zip-bytes.js";
export type { ZipSignal } from "../../shared/zip-bytes.js";
