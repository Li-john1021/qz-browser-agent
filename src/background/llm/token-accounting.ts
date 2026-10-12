/** Shared request-token estimates and provider-usage normalization. */

export function estimateTokens(messages: unknown): number {
  if (!Array.isArray(messages)) return 0;
  let chars = 0;
  for (const value of messages as unknown[]) {
    const msg = record(value);
    if (typeof msg.role !== "string") continue;
    if (typeof msg.content === "string") {
      chars += msg.content.length;
    } else if (Array.isArray(msg.content)) {
      for (const value of msg.content as unknown[]) {
        const part = record(value);
        if (part.type === "text") chars += String(part.text ?? "").length;
        else if (part.type === "image_url") chars += 1000;
      }
    }
    if (Array.isArray(msg.tool_calls)) {
      for (const value of msg.tool_calls as unknown[]) {
        const call = record(record(value).function);
        chars += (typeof call.name === "string" ? call.name.length : 0) + (typeof call.arguments === "string" ? call.arguments.length : 0);
      }
    }
    chars += providerStateTextLength(msg._providerState);
  }
  return Math.ceil(chars * 0.7);
}

export function estimateToolSchemaTokens(tools: unknown): number {
  if (!Array.isArray(tools) || tools.length === 0) return 0;
  try {
    const json = JSON.stringify(tools);
    return Math.ceil(json.length * 0.7);
  } catch (_err) {
    return Math.ceil(String(tools).length * 0.7);
  }
}

export function contextTokensFromUsage(value: unknown): number {
  const usage = record(value);
  const total = firstFiniteNumber(
    usage.total_tokens,
    usage.totalTokens,
    usage.total,
  );
  if (total > 0) return total;

  const input = firstFiniteNumber(
    usage.input_tokens,
    usage.prompt_tokens,
    usage.total_prompt_tokens,
    usage.input,
  );
  const output = firstFiniteNumber(
    usage.output_tokens,
    usage.completion_tokens,
    usage.total_completion_tokens,
    usage.output,
  );
  const cacheRead = firstFiniteNumber(
    usage.cache_read_input_tokens,
    usage.cached_tokens,
    usage.cacheRead,
  );
  const cacheWrite = firstFiniteNumber(
    usage.cache_creation_input_tokens,
    usage.cacheWrite,
  );
  return Math.max(0, Math.ceil(input + output + cacheRead + cacheWrite));
}

function providerStateTextLength(value: unknown): number {
  const state = record(value);
  if (typeof state.reasoningText === "string") return state.reasoningText.length;
  if (Array.isArray(state.thinkingBlocks)) {
    return (state.thinkingBlocks as unknown[]).reduce<number>((sum, value) => {
      const block = record(value);
      return sum + String(block.thinking || "").length + String(block.data || "").length;
    }, 0);
  }
  if (Array.isArray(state.reasoningItems)) {
    try {
      return JSON.stringify(state.reasoningItems).length;
    } catch (_err) {
      return (state.reasoningItems as unknown[]).reduce<number>((sum, item) => sum + String(record(item).id || "").length, 0);
    }
  }
  return 0;
}

function firstFiniteNumber(...values: unknown[]): number {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number) && number > 0) return number;
  }
  return 0;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
}
