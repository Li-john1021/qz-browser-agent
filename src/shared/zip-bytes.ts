import { t } from "./i18n/backend.js";
/** ZIP bytes only. Callers own filenames, selection, resource budgets and Web API adapters. */
export interface ZipSignal {
  readonly aborted: boolean;
  addEventListener(type: "abort", listener: () => void, options: { once: boolean }): void;
  removeEventListener(type: "abort", listener: () => void): void;
}
interface ByteReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel(): Promise<unknown>;
  releaseLock(): void;
}
interface ZipEntry {
  readonly name: string;
  readonly method: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly localOffset: number;
  readonly checksum: number;
  readonly flags: number;
}
interface ZipOptions {
  decode(bytes: Uint8Array): string;
  inflate?: (bytes: Uint8Array) => ByteReader;
  maxArchiveBytes?: number;
  maxEntries?: number;
  signal?: ZipSignal;
}

export function openZip(bytes: Uint8Array, options: ZipOptions) {
  assertActive(options.signal);
  if (bytes.length > (options.maxArchiveBytes ?? Infinity)) throw new Error(t("zip.packageTooLargeRejected"));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = bytes.length - 22;
  for (; end >= Math.max(0, bytes.length - 65557); end--) {
    if (view.getUint32(end, true) === 0x06054b50 && end + 22 + view.getUint16(end + 20, true) === bytes.length) break;
  }
  if (end < Math.max(0, bytes.length - 65557)) throw new Error(t("zip.invalid"));
  const count = view.getUint16(end + 10, true);
  if (view.getUint16(end + 4, true) || view.getUint16(end + 6, true) || view.getUint16(end + 8, true) !== count || count === 65535) throw new Error(t("zip.multipartUnsupported"));
  if (count > (options.maxEntries ?? 10000)) throw new Error(t("zip.tooManyFilesRejected"));
  let offset = view.getUint32(end + 16, true);
  const centralEnd = offset + view.getUint32(end + 12, true);
  if (centralEnd > end) throw new Error(t("zip.centralDirectoryDamaged"));
  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (offset + 46 > centralEnd || view.getUint32(offset, true) !== 0x02014b50) throw new Error(t("zip.centralDirectoryDamaged"));
    const nameLength = view.getUint16(offset + 28, true);
    const next = offset + 46 + nameLength + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true);
    if (next > centralEnd || view.getUint16(offset + 34, true)) throw new Error(t("zip.centralDirectoryDamaged"));
    const entry = Object.freeze({
      name: options.decode(bytes.subarray(offset + 46, offset + 46 + nameLength)),
      flags: view.getUint16(offset + 8, true), method: view.getUint16(offset + 10, true),
      checksum: view.getUint32(offset + 16, true), compressedSize: view.getUint32(offset + 20, true),
      uncompressedSize: view.getUint32(offset + 24, true), localOffset: view.getUint32(offset + 42, true),
    });
    if ([entry.compressedSize, entry.uncompressedSize, entry.localOffset].includes(0xffffffff)) throw new Error(t("zip.zip64Unsupported"));
    entries.push(entry);
    offset = next;
  }
  if (offset !== centralEnd) throw new Error(t("zip.centralDirectoryDamaged"));
  const ownedEntries = new Set(entries);
  return {
    entries: Object.freeze(entries),
    async read(entry: ZipEntry, maxBytes: number): Promise<Uint8Array> {
      assertActive(options.signal);
      if (!ownedEntries.has(entry)) throw new Error(t("zip.foreignEntry"));
      if (!Number.isFinite(maxBytes) || maxBytes < 0 || entry.uncompressedSize > maxBytes) throw new Error(t("skill.importFileTooLarge", { path: String(entry.name) }));
      const local = entry.localOffset;
      if (local + 30 > view.getUint32(end + 16, true) || view.getUint32(local, true) !== 0x04034b50) throw new Error(t("zip.directoryDamaged"));
      const flags = view.getUint16(local + 6, true);
      if (flags !== entry.flags || (flags & 1) || view.getUint16(local + 8, true) !== entry.method) throw new Error(t("zip.unsupportedOrInconsistent"));
      const nameLength = view.getUint16(local + 26, true);
      const start = local + 30 + nameLength + view.getUint16(local + 28, true);
      if (start + entry.compressedSize > view.getUint32(end + 16, true)) throw new Error(t("zip.dataDamaged"));
      if (options.decode(bytes.subarray(local + 30, local + 30 + nameLength)) !== entry.name) throw new Error(t("zip.filenameVerification"));
      if (entry.method === 0 && entry.compressedSize !== entry.uncompressedSize) throw new Error(t("zip.sizeMismatch", { path: String(entry.name) }));
      if (entry.method === 8 && !options.inflate) throw new Error(t("zip.deflateUnavailable"));
      const compressed = bytes.subarray(start, start + entry.compressedSize);
      const output = entry.method === 0 ? compressed.slice()
        : entry.method === 8 ? await inflateBounded(options.inflate!(compressed), maxBytes, options.signal)
        : null;
      if (!output) throw new Error(t("zip.compressionUnsupported", { method: String(entry.method) }));
      assertActive(options.signal);
      if (output.length !== entry.uncompressedSize) throw new Error(t("zip.sizeMismatch", { path: String(entry.name) }));
      if (crc32(output) !== entry.checksum) throw new Error(t("zip.contentMismatch", { path: String(entry.name) }));
      return output;
    },
  };
}

async function inflateBounded(reader: ByteReader, maxBytes: number, signal?: ZipSignal) {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    assertActive(signal);
    while (true) {
      const { done, value } = await reader.read();
      assertActive(signal);
      if (done) break;
      if (!value) throw new Error(t("zip.invalidDecompressedData"));
      total += value.length;
      if (total > maxBytes) throw new Error(t("zip.decompressedTooLarge"));
      chunks.push(value);
    }
    return concatBytes(chunks);
  } finally {
    signal?.removeEventListener("abort", cancel);
    cancel();
    reader.releaseLock();
  }
}

export function createZipBytes(files: readonly { name: string; data: string | Uint8Array }[], encode: (text: string) => Uint8Array, modifiedAt?: Date): Uint8Array<ArrayBuffer> {
  if (files.length >= 65535) throw new Error(t("zip.tooManyFiles"));
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  const timestamp = modifiedAt ? dosDateTime(modifiedAt) : 0;
  let offset = 0;
  for (const file of files) {
    const name = encode(file.name);
    const data = typeof file.data === "string" ? encode(file.data) : file.data;
    if (name.length > 65535 || data.length >= 0xffffffff) throw new Error(t("zip.fileTooLarge"));
    const checksum = crc32(data);
    const local = new Uint8Array(30 + name.length);
    const view = new DataView(local.buffer);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, 0x0800, true);
    view.setUint32(10, timestamp, true);
    view.setUint32(14, checksum, true);
    view.setUint32(18, data.length, true);
    view.setUint32(22, data.length, true);
    view.setUint16(26, name.length, true);
    local.set(name, 30);
    chunks.push(local, data);
    const header = new Uint8Array(46 + name.length);
    const cview = new DataView(header.buffer);
    cview.setUint32(0, 0x02014b50, true);
    cview.setUint16(4, 20, true);
    cview.setUint16(6, 20, true);
    cview.setUint16(8, 0x0800, true);
    cview.setUint32(12, timestamp, true);
    cview.setUint32(16, checksum, true);
    cview.setUint32(20, data.length, true);
    cview.setUint32(24, data.length, true);
    cview.setUint16(28, name.length, true);
    cview.setUint32(42, offset, true);
    header.set(name, 46);
    central.push(header);
    offset += local.length + data.length;
  }
  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  if (offset + centralSize >= 0xffffffff) throw new Error(t("zip.packageTooLarge"));
  const end = new Uint8Array(22);
  const view = new DataView(end.buffer);
  view.setUint32(0, 0x06054b50, true);
  view.setUint16(8, files.length, true);
  view.setUint16(10, files.length, true);
  view.setUint32(12, centralSize, true);
  view.setUint32(16, offset, true);
  return concatBytes([...chunks, ...central, end]);
}

function assertActive(signal?: ZipSignal) {
  if (signal?.aborted) throw Object.assign(new Error("ZIP operation cancelled"), { name: "AbortError" });
}
function dosDateTime(date: Date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((Math.max(1980, Math.min(2107, date.getFullYear())) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return ((day << 16) | time) >>> 0;
}
function concatBytes(parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { output.set(part, offset); offset += part.length; }
  return output;
}
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
