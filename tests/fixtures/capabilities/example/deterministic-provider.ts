import type { ModelMessage, ProviderAdapter } from '#sdk/background/providers';

/** Local adapter for exercising host integrations; it never calls a model service. */
export const deterministicProvider: ProviderAdapter = {
  async chat(messages, _tools, signal) {
    signal?.throwIfAborted();
    return { message: reply(messages) };
  },
  async *chatStream(messages, _tools, signal) {
    signal?.throwIfAborted();
    const message = reply(messages);
    yield { type: 'text_delta', delta: String(message.content) };
    signal?.throwIfAborted();
    yield { type: 'done', message };
  },
};

function reply(messages: ModelMessage[]): ModelMessage {
  const message = [...messages].reverse().find(item => item.role === 'user');
  return { role: 'assistant', content: `Example: ${typeof message?.content === 'string' ? message.content : '(structured input)'}` };
}
