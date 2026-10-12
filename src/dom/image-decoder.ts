import { assertImageDimensions, ImageLimitError } from '../shared/images/policy.js';
import { imageT } from '../shared/images/messages.js';

/** SVG uses the image-only DOM decoder, which disables scripts and subresources. */
export async function decodeImageInDom(blob: Blob): Promise<ImageBitmap> {
  if (blob.type !== 'image/svg+xml') return createImageBitmap(blob);
  const url = URL.createObjectURL(blob);
  const image = new Image();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new ImageLimitError('IMAGE_DECODE_FAILED', imageT('decode')));
      timer = setTimeout(() => reject(new ImageLimitError('IMAGE_DECODE_FAILED', imageT('decode'))), 10000);
      image.src = url;
    });
    assertImageDimensions(image.naturalWidth, image.naturalHeight);
    return await createImageBitmap(image);
  } finally { clearTimeout(timer); image.src = ''; URL.revokeObjectURL(url); }
}
