import { t } from "./i18n.js";
import { ensureOffscreenDocument } from "#sdk/background/browser";
import { ImageLimitError } from "#sdk/shared/images";
import type { ImageNormalizeOptions, NormalizedImage } from "#sdk/shared/images";

// SVG needs a DOM image decoder; service-worker createImageBitmap cannot decode it.
export async function rasterizeSvg(dataUrl: string, { signal, ...options }: Omit<ImageNormalizeOptions, 'decode'> = {}): Promise<NormalizedImage> {
  signal?.throwIfAborted();
  await ensureOffscreenDocument();
  // createDocument may resolve before the module has registered its listener.
  let ready = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    signal?.throwIfAborted();
    const response = await chrome.runtime.sendMessage<Record<string, unknown>, { imageConverterReady?: boolean }>({ type: "convert_svg_image_ping" });
    if (response?.imageConverterReady) { ready = true; break; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  signal?.throwIfAborted();
  if (!ready) throw new Error(t("imageConverterIsUnavailable"));
  const result = await chrome.runtime.sendMessage<Record<string, unknown>, { ok?: boolean; error?: string; code?: string; details?: Record<string, unknown>; image?: NormalizedImage }>({ type: "convert_svg_image", dataUrl, options });
  signal?.throwIfAborted();
  if (!result?.ok || !result.image?.dataUrl) throw new ImageLimitError(result?.code || 'IMAGE_DECODE_FAILED', result?.error || "SVG conversion failed", result?.details);
  return result.image;
}
