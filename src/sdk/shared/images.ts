/** Image budgets and normalization shared by producers and model admission. */
export { normalizeImage, readImageInput, readImageResponse } from '../../shared/images/normalize.js';
export type { ImageSource, ImageNormalizeOptions, NormalizedImage } from '../../shared/images/normalize.js';
export { IMAGE_MAX_EDGE, IMAGE_MAX_BYTES, IMAGE_INPUT_MAX_BYTES, IMAGE_INPUT_MAX_PIXELS, MODEL_IMAGE_MAX_BYTES,
  MODEL_REQUEST_MAX_BYTES, ImageLimitError, assertImageBytes, assertImageDataUrl, assertImageDimensions,
  inspectImageDataUrl, parseImageDataUrlHeader, compactImageSource } from '../../shared/images/policy.js';
