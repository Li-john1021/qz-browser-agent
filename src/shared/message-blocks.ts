export const MESSAGE_ORIGIN_USER = "user";
export const MESSAGE_ORIGIN_TOOL_IMAGE = "tool_image";
export const MESSAGE_ORIGIN_COMPACTION = "compaction";
export const MESSAGE_ORIGIN_CONTEXT_CAPSULE = "context_capsule";
export const MESSAGE_ORIGIN_CONTEXT_EVENT = "context_event";

export const MESSAGE_KIND_COMPACTION = "compaction";
export const MESSAGE_KIND_CONTEXT_CAPSULE = "context_capsule";
export const MESSAGE_KIND_CONTEXT_EVENT = "context_event";

export const USER_MESSAGE_ORIGINS = new Set([
  MESSAGE_ORIGIN_USER,
  MESSAGE_ORIGIN_TOOL_IMAGE,
  MESSAGE_ORIGIN_COMPACTION,
  MESSAGE_ORIGIN_CONTEXT_CAPSULE,
  MESSAGE_ORIGIN_CONTEXT_EVENT,
]);

export const USER_MESSAGE_KINDS = new Set([
  MESSAGE_KIND_COMPACTION,
  MESSAGE_KIND_CONTEXT_CAPSULE,
  MESSAGE_KIND_CONTEXT_EVENT,
]);

export function isHiddenContextUserMessage(msg: { _origin?: unknown } | null = {}) {
  return msg?._origin === MESSAGE_ORIGIN_CONTEXT_CAPSULE
    || msg?._origin === MESSAGE_ORIGIN_CONTEXT_EVENT;
}
