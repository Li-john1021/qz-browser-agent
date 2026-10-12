import { normalizeMessageDocuments } from '../../shared/documents/document-attachments.js';
import type { ModelMessage } from './protocol-registry.js';
import { t } from '../../shared/i18n/backend.js';

export const IMAGE_PLACEHOLDER = '[image omitted for context saving]';
const MAX_TOOL_RESULT_CHARS = 20000;
const MAX_TOOL_ARGUMENT_CHARS = 12000;

/** Project stored conversation facts onto the provider wire shape without mutating them. */
export function projectMessage(message: ModelMessage | null, trim: boolean, allowImages = true): ModelMessage | null {
  if (!message || message.role === 'system') return null;
  const out: ModelMessage = { role: message.role };
  if (message.role === 'assistant') {
    out.content = typeof message.content === 'string' && message.content ? message.content : null;
    if (message.tool_calls?.length) out.tool_calls = message.tool_calls.map(call => ({
      id: call.id, type: call.type || 'function',
      function: { name: call.function?.name || '', arguments: compactArguments(call.function?.arguments) },
    }));
    if (message._providerState && typeof message._providerState === 'object') {
      try { out._providerState = JSON.parse(JSON.stringify(message._providerState)); }
      catch { out._providerState = null; }
    }
    return out.content || out.tool_calls?.length || out._providerState ? out : null;
  }
  if (message.role === 'tool') {
    out.tool_call_id = message.tool_call_id;
    out.content = trim ? '[tool result omitted for context saving]' : clipMiddle(contentText(message.content), MAX_TOOL_RESULT_CHARS, 'tool result');
    return out.tool_call_id ? out : null;
  }
  if (message.role === 'user') {
    out.content = projectContent(message.content, trim || !allowImages);
    if (normalizeMessageDocuments(Array.isArray(message.documents) ? message.documents : []).length && !hasUserContent(out.content)) out.content = t('model.reviewAttachments');
    return out;
  }
  return null;
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  try { return JSON.stringify(content ?? '') ?? ''; }
  catch { return String(content ?? ''); }
}

function compactArguments(value: unknown): string {
  let text: string;
  try { text = typeof value === 'string' ? value : JSON.stringify(value ?? {}) ?? '{}'; }
  catch { text = '{}'; }
  return text.length <= MAX_TOOL_ARGUMENT_CHARS ? text : JSON.stringify({
    _truncated: true, originalChars: text.length, preview: clipMiddle(text, MAX_TOOL_ARGUMENT_CHARS, 'tool arguments'),
  });
}

function clipMiddle(text: string, limit: number, label: string): string {
  if (text.length <= limit) return text;
  const head = Math.floor(limit * 0.65);
  return [text.slice(0, head), `[${label} truncated: omitted ${text.length - limit} chars, original ${text.length} chars]`, text.slice(-(limit - head))].filter(Boolean).join('\n\n');
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function projectContent(content: unknown, omitImages: boolean): unknown {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: object[] = [];
  let omitted = 0;
  for (const item of content) {
    const part = record(item);
    if (part.type === 'text') {
      const text = String(part.text ?? '');
      if (text || !omitImages) parts.push({ type: 'text', text });
    } else if (part.type === 'image_url') {
      if (omitImages) omitted++;
      else {
        const image = record(part.image_url);
        parts.push({ type: 'image_url', image_url: { url: image.url || '', detail: image.detail || 'auto' } });
      }
    }
  }
  if (omitted) parts.push({ type: 'text', text: `${IMAGE_PLACEHOLDER} x${omitted}` });
  return omitImages && !parts.length ? IMAGE_PLACEHOLDER : parts;
}

function hasUserContent(content: unknown): boolean {
  if (typeof content === 'string') return Boolean(content.trim());
  return Array.isArray(content) && content.some(value => {
    const part = record(value);
    return part.type === 'image_url' || (part.type === 'text' && Boolean(String(part.text || '').trim()));
  });
}
