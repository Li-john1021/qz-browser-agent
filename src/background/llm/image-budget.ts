import type { ModelMessage } from './protocol-registry.js';
import { normalizeImage } from '../../shared/images/normalize.js';
import { MODEL_IMAGE_MAX_BYTES, MODEL_REQUEST_MAX_BYTES } from '../../shared/images/policy.js';
import { defineMessages } from '../../shared/i18n/definition.js';
import { createTranslator } from '../../shared/i18n/index.js';
import { utf8ByteLength } from '../../shared/transport/message-codec.js';

const t = createTranslator(defineMessages('model-payload', {
  images: { 'zh-CN': '模型请求的图片总大小超出上限，请减少图片或压缩上下文后重试。', en: 'The model request contains too much image data. Remove images or compact the context and try again.' },
  remote: { 'zh-CN': '请先使用图片读取工具加载这张图片，再发送给模型。', en: 'Load this image with an image-reading tool before sending it to the model.' },
  request: { 'zh-CN': '模型请求过大，请压缩上下文或开始新任务。', en: 'The model request is too large. Compact the context or start a new task.' },
}));

function failure(code: string, message: string) {
  return Object.assign(new Error(message), { name: 'ModelPayloadError', kind: 'invalid_request', code, retryable: false });
}

/** Normalize model copies without changing stored history or dropping requested images. */
export async function prepareModelImages(messages: ModelMessage[], signal?: AbortSignal,
  normalize: typeof normalizeImage = normalizeImage): Promise<ModelMessage[]> {
  let bytes = 0;
  let result = messages;
  // Repeated references reuse the decode only within this request; nothing retains historical bitmaps.
  const normalized = new Map<string, Awaited<ReturnType<typeof normalizeImage>>>();
  for (let i = messages.length - 1; i >= 0; i--) {
    signal?.throwIfAborted();
    const content = messages[i].content;
    if (!Array.isArray(content)) continue;
    const parts = content.slice();
    for (let j = content.length - 1; j >= 0; j--) {
      const part = content[j];
      if (part?.type !== 'image_url' || typeof part.image_url?.url !== 'string') continue;
      const url: string = part.image_url.url;
      // Remote fetching belongs to the safety-checked image tool, not the provider adapter.
      if (!url.startsWith('data:')) throw failure('MODEL_IMAGE_NOT_LOADED', t('remote'));
      const image = normalized.get(url) || await normalize(url, { signal });
      normalized.set(url, image);
      if (bytes + image.bytes > MODEL_IMAGE_MAX_BYTES) {
        throw failure('MODEL_IMAGES_TOO_LARGE', t('images'));
      } else {
        bytes += image.bytes;
        parts[j] = { ...part, image_url: { ...part.image_url, url: image.dataUrl } };
      }
    }
    if (parts.some((part, index) => part !== content[index])) {
      if (result === messages) result = messages.slice();
      result[i] = { ...messages[i], content: parts };
    }
  }
  return result;
}

/** Check the final adapter body, including base64, text, schemas and protocol overhead. */
export function assertModelRequestSize(body: RequestInit['body']) {
  const bytes = typeof body === 'string' ? utf8ByteLength(body)
    : body instanceof Blob ? body.size
    : body instanceof ArrayBuffer ? body.byteLength
    : ArrayBuffer.isView(body) ? body.byteLength : 0;
  if (bytes > MODEL_REQUEST_MAX_BYTES) throw failure('MODEL_REQUEST_TOO_LARGE', t('request'));
}
