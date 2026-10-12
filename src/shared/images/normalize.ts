import { bytesToBase64 } from '../bytes.js';
import { imageT } from './messages.js';
import { assertImageBytes, assertImageDimensions, boundedImageValue, IMAGE_INPUT_MAX_BYTES, IMAGE_MAX_BYTES, IMAGE_MAX_EDGE, ImageLimitError, inspectImageDataUrl, parseImageDataUrlHeader } from './policy.js';

export interface ImageNormalizeOptions {
  maxWidth?: number; maxHeight?: number; maxBytes?: number;
  format?: 'jpeg' | 'png' | 'webp'; quality?: number; signal?: AbortSignal;
  decode?: (blob: Blob) => Promise<ImageBitmap>;
}
/** Lazy decoders run inside the queue; normalization owns and closes their returned bitmap. */
export type ImageSource = Blob | string | (() => Promise<ImageBitmap>);
export interface NormalizedImage {
  dataUrl: string; mimeType: string; width: number; height: number;
  sourceWidth: number; sourceHeight: number; bytes: number; resized: boolean;
  animatedSource?: boolean; animationFlattened?: boolean;
}

let decoding = false;
const decodeWaiters: Array<() => void> = [];

async function withDecodeSlot<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  checkAbort(signal);
  await new Promise<void>((resolve, reject) => {
    const acquire = () => { signal?.removeEventListener('abort', cancel); decoding = true; resolve(); };
    const cancel = () => {
      const index = decodeWaiters.indexOf(acquire);
      if (index >= 0) decodeWaiters.splice(index, 1);
      reject(signal?.reason || new DOMException('Aborted', 'AbortError'));
    };
    if (!decoding) acquire();
    else { decodeWaiters.push(acquire); signal?.addEventListener('abort', cancel, { once: true }); }
  });
  try { checkAbort(signal); return await operation(); }
  finally { decoding = false; decodeWaiters.shift()?.(); }
}

/** The same policy and encoder run in Side Panel, Content, offscreen and Background. */
export async function normalizeImage(input: ImageSource, options: ImageNormalizeOptions = {}): Promise<NormalizedImage> {
  try { return await withDecodeSlot(() => normalizeImageNow(input, options), options.signal); }
  catch (error) {
    checkAbort(options.signal);
    if (error instanceof ImageLimitError) throw error;
    throw new ImageLimitError('IMAGE_DECODE_FAILED', imageT('decode'));
  }
}

async function normalizeImageNow(input: ImageSource, options: ImageNormalizeOptions): Promise<NormalizedImage> {
  checkAbort(options.signal);
  let dataUrl = '';
  let blob: Blob | null = null;
  let bitmap: ImageBitmap;
  if (typeof input === 'function') bitmap = await input();
  else {
    ({ blob, dataUrl } = await readImageInput(input, options.signal));
    await inspectSourceDimensions(blob);
    checkAbort(options.signal);
    bitmap = await (options.decode || createImageBitmap)(blob);
  }
  try {
    checkAbort(options.signal);
    assertImageDimensions(bitmap.width, bitmap.height);
    const sourceMime = blob?.type.toLowerCase().split(';')[0] || '';
    const limit = limits(options);
    if (blob && ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(sourceMime)
      && (!options.format || sourceMime === `image/${options.format}` || sourceMime === 'image/gif')
      && bitmap.width <= limit.width && bitmap.height <= limit.height && blob.size <= limit.bytes) {
      const normalized = { dataUrl: dataUrl || await blobDataUrl(blob), mimeType: sourceMime, width: bitmap.width, height: bitmap.height,
        sourceWidth: bitmap.width, sourceHeight: bitmap.height, bytes: blob.size, resized: false,
        ...(sourceMime === 'image/gif' ? { animatedSource: true } : {}) };
      checkAbort(options.signal);
      return normalized;
    }
    const result = await encodeBitmap(bitmap, {
      ...options, format: sourceMime === 'image/gif' ? 'png' : options.format || (sourceMime === 'image/jpeg' ? 'jpeg' : 'png'),
    });
    return { ...result, ...(sourceMime === 'image/gif' ? { animatedSource: true, animationFlattened: true } : {}) };
  } finally { bitmap.close(); }
}

/** Preflight before decoding or handing image bytes to another extension context. */
export async function readImageInput(input: Blob | string, signal?: AbortSignal) {
  checkAbort(signal);
  let dataUrl = '';
  let blob: Blob;
  if (typeof input === 'string') {
    const header = parseImageDataUrlHeader(input);
    // Bound native decoding, allowing each base64 character to be percent-escaped.
    assertImageBytes(input.length - header.offset, header.base64 ? Math.ceil(IMAGE_INPUT_MAX_BYTES / 3) * 12 : IMAGE_INPUT_MAX_BYTES, true);
    if (header.base64) {
      try {
        assertImageBytes(inspectImageDataUrl(input).bytes, IMAGE_INPUT_MAX_BYTES, true);
        dataUrl = `data:${header.mimeType};base64,${input.slice(header.offset)}`;
      } catch (error) {
        // Native decoding accepts whitespace, omitted padding and percent escapes.
        // Only canonical input can reuse its original payload in normalized output.
        if (!(error instanceof ImageLimitError) || error.code !== 'INVALID_IMAGE_DATA') throw error;
      }
    }
    let response: Response;
    try { response = await fetch(input, { signal }); }
    catch {
      checkAbort(signal);
      throw new ImageLimitError('INVALID_IMAGE_DATA', imageT('invalid'));
    }
    blob = await readImageResponse(response, { signal });
  } else blob = input;
  checkAbort(signal);
  if (blob.type.includes(';')) blob = new Blob([blob], { type: blob.type.split(';')[0] });
  assertImageBytes(blob.size, IMAGE_INPUT_MAX_BYTES, true);
  return { blob, dataUrl };
}

async function encodeBitmap(bitmap: ImageBitmap, options: ImageNormalizeOptions): Promise<NormalizedImage> {
  const sourceWidth = bitmap.width;
  const sourceHeight = bitmap.height;
  const limit = limits(options);
  const scale = Math.min(1, limit.width / sourceWidth, limit.height / sourceHeight);
  let width = Math.max(1, Math.floor(sourceWidth * scale));
  let height = Math.max(1, Math.floor(sourceHeight * scale));
  const mimeType = `image/${options.format || 'png'}`;
  let quality = Math.max(0.1, Math.min(1, Number.isFinite(options.quality) ? Number(options.quality) : 0.88));
  const canvas = new OffscreenCanvas(width, height);
  try {
    for (let attempt = 0; attempt < 14; attempt++) {
      checkAbort(options.signal);
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d');
      if (!context) throw new ImageLimitError('IMAGE_ENCODE_FAILED', imageT('encode'));
      context.drawImage(bitmap, 0, 0, width, height);
      const blob = await canvas.convertToBlob({ type: mimeType, quality: mimeType === 'image/png' ? undefined : quality });
      checkAbort(options.signal);
      if (blob.size > 0 && blob.size <= limit.bytes) {
        const normalized = { dataUrl: await blobDataUrl(blob), mimeType: blob.type || mimeType, width, height, sourceWidth, sourceHeight,
          bytes: blob.size, resized: width !== sourceWidth || height !== sourceHeight };
        checkAbort(options.signal);
        return normalized;
      }
      if (mimeType !== 'image/png' && quality > 0.5) { quality = Math.max(0.5, quality - 0.18); continue; }
      const shrink = Math.min(0.8, Math.sqrt(limit.bytes / Math.max(1, blob.size)) * 0.9);
      const nextWidth = Math.max(1, Math.floor(width * shrink));
      const nextHeight = Math.max(1, Math.floor(height * shrink));
      if (nextWidth === width && nextHeight === height) break;
      width = nextWidth;
      height = nextHeight;
    }
    throw new ImageLimitError('IMAGE_ENCODE_FAILED', imageT('encode'), { maxBytes: limit.bytes });
  } finally { canvas.width = 1; canvas.height = 1; }
}

/** Consume downloads incrementally; Content-Length is only an early rejection hint. */
export async function readImageResponse(response: Response, { maxBytes = IMAGE_INPUT_MAX_BYTES, signal }: { maxBytes?: number; signal?: AbortSignal } = {}) {
  const limit = boundedImageValue(maxBytes, IMAGE_INPUT_MAX_BYTES);
  const length = Number(response.headers.get('content-length'));
  if (length > limit) { await response.body?.cancel(); assertImageBytes(length, limit, true); }
  const reader = response.body?.getReader();
  if (!reader) { const blob = await response.blob(); assertImageBytes(blob.size, limit, true); return blob; }
  const chunks: BlobPart[] = [];
  let bytes = 0;
  const abortRead = () => { void reader.cancel(signal?.reason).catch(() => {}); };
  signal?.addEventListener('abort', abortRead, { once: true });
  try {
    while (true) {
      checkAbort(signal);
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      assertImageBytes(bytes, limit, true);
      chunks.push(chunk.value);
    }
    checkAbort(signal);
    return new Blob(chunks, { type: response.headers.get('content-type') || '' });
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { signal?.removeEventListener('abort', abortRead); reader.releaseLock(); }
}

function limits(options: ImageNormalizeOptions) {
  return { width: boundedImageValue(options.maxWidth, IMAGE_MAX_EDGE), height: boundedImageValue(options.maxHeight, IMAGE_MAX_EDGE),
    bytes: boundedImageValue(options.maxBytes, IMAGE_MAX_BYTES) };
}
function checkAbort(signal?: AbortSignal) { signal?.throwIfAborted(); }
async function blobDataUrl(blob: Blob) { return `data:${blob.type};base64,${bytesToBase64(new Uint8Array(await blob.arrayBuffer()))}`; }

async function inspectSourceDimensions(blob: Blob) {
  const bytes = new Uint8Array(await blob.slice(0, 256 * 1024).arrayBuffer());
  const view = new DataView(bytes.buffer);
  if (bytes.length >= 24 && view.getUint32(0) === 0x89504e47 && view.getUint32(4) === 0x0d0a1a0a) {
    assertImageDimensions(view.getUint32(16), view.getUint32(20));
  } else if (bytes.length >= 10 && String.fromCharCode(...bytes.subarray(0, 3)) === 'GIF') {
    assertImageDimensions(view.getUint16(6, true), view.getUint16(8, true));
  } else if (bytes.length >= 30 && view.getUint32(0) === 0x52494646 && view.getUint32(8) === 0x57454250) {
    const type = view.getUint32(12);
    if (type === 0x56503858) {
      assertImageDimensions(1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16),
        1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16));
    } else if (type === 0x5650384c && bytes[20] === 0x2f) {
      const dimensions = view.getUint32(21, true);
      assertImageDimensions((dimensions & 0x3fff) + 1, ((dimensions >>> 14) & 0x3fff) + 1);
    } else if (type === 0x56503820 && bytes[23] === 0x9d && bytes[24] === 1 && bytes[25] === 0x2a) {
      assertImageDimensions(view.getUint16(26, true) & 0x3fff, view.getUint16(28, true) & 0x3fff);
    }
  } else if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < bytes.length && bytes[offset] === 0xff) {
      const marker = bytes[offset + 1];
      const size = view.getUint16(offset + 2);
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        assertImageDimensions(view.getUint16(offset + 7), view.getUint16(offset + 5)); break;
      }
      if (size < 2) break;
      offset += size + 2;
    }
  }
}
