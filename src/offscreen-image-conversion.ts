import { normalizeImage } from './shared/images/normalize.js';
import type { ImageNormalizeOptions } from './shared/images/normalize.js';
import { parseImageDataUrlHeader } from './shared/images/policy.js';
import { decodeImageInDom } from './dom/image-decoder.js';

// Loading SVG as an image disables scripts and external subresources.
export async function normalizeSvgImage(dataUrl: unknown, options: Omit<ImageNormalizeOptions, 'decode' | 'signal'> = {}) {
  if (typeof dataUrl !== 'string' || parseImageDataUrlHeader(dataUrl).mimeType !== 'image/svg+xml') throw new Error('Invalid SVG image input');
  return normalizeImage(dataUrl, { ...options, format: options.format || 'png', decode: decodeImageInDom });
}
