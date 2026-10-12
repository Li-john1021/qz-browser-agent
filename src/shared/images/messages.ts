import { defineMessages } from '../i18n/definition.js';
import { createTranslator } from '../i18n/index.js';

export const imageT = createTranslator(defineMessages('image-limits', {
  invalid: { 'zh-CN': '图片数据无效，请重新选择图片。', en: 'Invalid image data. Select the image again.' },
  inputTooLarge: { 'zh-CN': '原始图片超过读取上限（{maxBytes} 字节），请先缩小图片。', en: 'The source image exceeds the read limit ({maxBytes} bytes). Resize it first.' },
  tooLarge: { 'zh-CN': '图片超过大小上限（{maxBytes} 字节），请缩小图片后重试。', en: 'The image exceeds the size limit ({maxBytes} bytes). Resize it and try again.' },
  dimensions: { 'zh-CN': '原始图片尺寸过大，无法安全解码，请先缩小图片。', en: 'The source image is too large to decode. Resize it first.' },
  decode: { 'zh-CN': '图片无法解码，请重新选择图片或使用截图。', en: 'The image could not be decoded. Select another image or use a screenshot.' },
  encode: { 'zh-CN': '图片无法压缩到大小上限，请选择更小的图片。', en: 'The image could not be reduced to the size limit. Select a smaller image.' },
}));
