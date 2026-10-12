import { imageT } from './messages.js';

export const IMAGE_MAX_EDGE = 2048;
export const IMAGE_MAX_BYTES = 2 * 1024 * 1024;
export const IMAGE_INPUT_MAX_BYTES = 32 * 1024 * 1024;
export const IMAGE_INPUT_MAX_PIXELS = 64 * 1024 * 1024;
export const MODEL_IMAGE_MAX_BYTES = 48 * 1024 * 1024;
export const MODEL_REQUEST_MAX_BYTES = 64 * 1024 * 1024;

export class ImageLimitError extends Error {
  readonly retryable = false;
  readonly kind = 'invalid_request' as const;
  constructor(readonly code: string, message: string, readonly details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ImageLimitError';
  }
}

/** Native data-URL decoding owns MIME parameters; callers share only this bounded header parse. */
export function parseImageDataUrlHeader(dataUrl: string) {
  const comma = dataUrl.indexOf(',');
  const header = dataUrl.slice(0, comma);
  const match = /^data:(image\/[a-z0-9.+-]+)(?:;.*)?$/i.exec(header);
  if (comma < 0 || comma > 128 || !match) throw invalidImage();
  return { mimeType: match[1].toLowerCase(), base64: /;base64$/i.test(header), offset: comma + 1 };
}

/** Inspect encoded bytes without allocating a second copy of the base64 payload. */
export function inspectImageDataUrl(dataUrl: string) {
  const { mimeType, base64, offset } = parseImageDataUrlHeader(dataUrl);
  if (!base64) throw invalidImage();
  const length = dataUrl.length - offset;
  if (!length || length % 4 !== 0) throw invalidImage();
  let padding = 0;
  if (dataUrl.endsWith('=')) padding++;
  if (dataUrl.endsWith('==')) padding++;
  for (let index = offset; index < dataUrl.length - padding; index++) {
    const char = dataUrl.charCodeAt(index);
    if (!(char >= 65 && char <= 90) && !(char >= 97 && char <= 122)
      && !(char >= 48 && char <= 57) && char !== 43 && char !== 47) throw invalidImage();
  }
  return { mimeType, bytes: length / 4 * 3 - padding, dataUrlBytes: dataUrl.length };
}

export function assertImageDataUrl(dataUrl: string, { maxBytes = IMAGE_MAX_BYTES } = {}) {
  const image = inspectImageDataUrl(dataUrl);
  assertImageBytes(image.bytes, boundedImageValue(maxBytes, IMAGE_MAX_BYTES));
  return image;
}

export function assertImageBytes(bytes: number, maxBytes = IMAGE_MAX_BYTES, input = false) {
  if (!Number.isFinite(bytes) || bytes <= 0) throw invalidImage();
  if (bytes > maxBytes) throw new ImageLimitError(input ? 'IMAGE_INPUT_TOO_LARGE' : 'IMAGE_TOO_LARGE',
    imageT(input ? 'inputTooLarge' : 'tooLarge', { maxBytes }), { bytes, maxBytes });
}

export function assertImageDimensions(width: number, height: number) {
  if (!(width > 0 && height > 0) || !Number.isFinite(width * height)) throw invalidImage();
  if (width * height > IMAGE_INPUT_MAX_PIXELS || width > 65536 || height > 65536) {
    throw new ImageLimitError('IMAGE_DIMENSIONS_TOO_LARGE', imageT('dimensions'), { width, height, maxPixels: IMAGE_INPUT_MAX_PIXELS });
  }
}

export function boundedImageValue(value: number | undefined, limit: number) {
  return Number.isFinite(value) && Number(value) > 0 ? Math.max(1, Math.min(limit, Math.floor(Number(value)))) : limit;
}

function invalidImage() { return new ImageLimitError('INVALID_IMAGE_DATA', imageT('invalid')); }

/** Keep embedded bytes out of image discovery, read metadata and error envelopes. */
export async function compactImageSource(source: string): Promise<string> {
  if (!/^data:/i.test(source) && source.length <= 8192) return source;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source));
  const hash = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  const mime = /^data:(image\/[a-z0-9.+-]+)/i.exec(source)?.[1] || 'image/unknown';
  return `data:${mime};sha256=${hash};chars=${source.length}`;
}
