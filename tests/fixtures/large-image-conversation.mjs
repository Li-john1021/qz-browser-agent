import { Readable } from 'node:stream';
import { createDeflate } from 'node:zlib';
import { createHash } from 'node:crypto';

export const COLLECTION_IMAGE_COUNT = 40;
export const COLLECTION_IMAGE_WIDTH = 3072;
export const COLLECTION_IMAGE_HEIGHT = 192;
export const COLLECTION_MARKER = 'QZ_IMAGE_COLLECT';

export function collectionToolCall(index, origin) {
  if (!Number.isInteger(index) || index < 1 || index > COLLECTION_IMAGE_COUNT + 1) throw new RangeError('Invalid collection index');
  return { id: `collect_image_${index}`, type: 'function', function: {
    name: 'read_image', arguments: JSON.stringify({ url: `${origin}/collect/image/${index}.png`, format: 'png' }),
  } };
}

/** Retain only bounded observations, never provider request bodies or image data. */
export function collectionRequestSummary(messages = []) {
  let toolIndex = 0;
  const results = [];
  const images = [];
  for (const message of messages) {
    if (message.role === 'tool') {
      toolIndex = Number(/^collect_image_(\d+)$/.exec(message.tool_call_id || '')?.[1] || 0);
      if (toolIndex) {
        let result;
        try { result = JSON.parse(message.content); } catch { result = {}; }
        results.push({ index: toolIndex, src: result.src, width: result.width, height: result.height,
          naturalWidth: result.naturalWidth, naturalHeight: result.naturalHeight,
          bytes: result.bytes, method: result.method, resized: result.resized, error: result.error || result.code || null });
      }
    } else if (toolIndex && message.role === 'user' && Array.isArray(message.content)) {
      const data = message.content.filter(part => part.type === 'image_url').map(part => part.image_url?.url || '');
      const placeholders = message.content.filter(part => part.type === 'text' && part.text?.startsWith('[image omitted for context saving]')).map(part => part.text);
      if (data.length || placeholders.length) images.push({ index: toolIndex, imageCount: data.length, placeholders,
        images: data.map(url => {
          if (!url.startsWith('data:image/png;base64,')) throw new Error('Collection must produce PNG images');
          const encoded = url.slice(url.indexOf(',') + 1);
          const header = Buffer.from(encoded.slice(0, 48), 'base64');
          return { width: header.readUInt32BE(16), height: header.readUInt32BE(20),
            bytes: encoded.length * 3 / 4 - (encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0),
            sha256: createHash('sha256').update(encoded).digest('hex') };
        }) });
    }
  }
  return { results, images };
}

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const SCANLINE_BUFFER_BYTES = 256 * 1024;
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, byte) => {
  let crc = byte;
  for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  return crc >>> 0;
});

/**
 * Generate a real, deterministic RGBA PNG without checked-in binary fixtures.
 * All four channels contain noise: unlike solid colors, larger dimensions also
 * produce larger encoded images. Scanlines are streamed; no full raw raster or
 * complete PNG Buffer is retained alongside the returned data URL.
 */
export async function generateLargeImage({ width = 512, height = width, seed = 1 } = {}) {
  assertPositiveInteger(width, 'width');
  assertPositiveInteger(height, 'height');
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) {
    throw new RangeError('seed must be an unsigned 32-bit integer');
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // Eight bits per channel.
  header[9] = 6; // RGBA, without interlacing.

  const fragments = [];
  let tail = Buffer.alloc(0);
  let encodedBytes = 0;
  const append = chunk => {
    encodedBytes += chunk.length;
    const bytes = tail.length ? Buffer.concat([tail, chunk]) : chunk;
    const complete = bytes.length - bytes.length % 3;
    if (complete) fragments.push(bytes.subarray(0, complete).toString('base64'));
    tail = Buffer.from(bytes.subarray(complete));
  };

  append(PNG_SIGNATURE);
  append(pngChunk('IHDR', header));
  const source = Readable.from(noiseScanlines(width, height, seed), {
    objectMode: false, highWaterMark: SCANLINE_BUFFER_BYTES,
  });
  const compressed = source.pipe(createDeflate());
  source.on('error', error => compressed.destroy(error));
  let pending = Buffer.alloc(0);
  try {
    for await (const bytes of compressed) {
      const chunk = pending.length ? Buffer.concat([pending, bytes]) : bytes;
      let offset = 0;
      // Stable IDAT boundaries make the PNG independent of stream scheduling.
      for (; offset + 16384 <= chunk.length; offset += 16384) {
        append(pngChunk('IDAT', chunk.subarray(offset, offset + 16384)));
      }
      pending = Buffer.from(chunk.subarray(offset));
    }
    if (pending.length) append(pngChunk('IDAT', pending));
  } finally {
    source.destroy();
    compressed.destroy();
  }
  append(pngChunk('IEND', Buffer.alloc(0)));
  if (tail.length) fragments.push(tail.toString('base64'));
  const dataUrl = `data:image/png;base64,${fragments.join('')}`;
  return { dataUrl, width, height, encodedBytes, dataUrlBytes: Buffer.byteLength(dataUrl) };
}

function* noiseScanlines(width, height, seed) {
  const rowBytes = width * 4 + 1;
  const rowsPerChunk = Math.max(1, Math.floor(SCANLINE_BUFFER_BYTES / rowBytes));
  let state = seed || 0x9e3779b9;
  for (let firstRow = 0; firstRow < height; firstRow += rowsPerChunk) {
    const rows = Math.min(rowsPerChunk, height - firstRow);
    const bytes = Buffer.allocUnsafe(rows * rowBytes);
    for (let row = 0; row < rows; row++) {
      let offset = row * rowBytes;
      bytes[offset++] = 0; // PNG filter type: None.
      for (let x = 0; x < width; x++) {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        bytes.writeUInt32LE(state >>> 0, offset);
        offset += 4;
      }
    }
    yield bytes;
  }
}

function pngChunk(type, data) {
  const bytes = Buffer.allocUnsafe(data.length + 12);
  bytes.writeUInt32BE(data.length, 0);
  bytes.write(type, 4, 4, 'ascii');
  data.copy(bytes, 8);
  let crc = 0xffffffff;
  for (let index = 4; index < bytes.length - 4; index++) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ bytes[index]) & 0xff];
  }
  bytes.writeUInt32BE((crc ^ 0xffffffff) >>> 0, bytes.length - 4);
  return bytes;
}

function assertPositiveInteger(value, name) {
  if (!Number.isInteger(value) || value < 1 || value > 0x7fffffff) {
    throw new RangeError(`${name} must be a positive 31-bit integer`);
  }
}
