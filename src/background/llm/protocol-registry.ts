import { t } from "../../shared/i18n/backend.js";
import type { RateWaitEvent } from './provider-rate-governor.js';
import type { LlmTransportOptions } from './transport.js';
import type { RuntimeConfig } from "../../sdk/background/providers.js";
import type { ProviderRecovery } from './provider-recovery.js';
import type { CustomProviderProtocol } from '../../shared/contracts/settings.js';

import type { ModelMessage } from '../../shared/contracts/model-message.js';
export type { ModelMessage } from '../../shared/contracts/model-message.js';

export interface RawModelExchange {
  requestBody?: string; requestModel?: string; responseBody?: string; finishReason?: string;
  responseId?: string; requestId?: string;
}

export interface ModelOptions extends LlmTransportOptions {
  config?: RuntimeConfig | null;
  /** Resolved by the gateway for this request; adapters never query product registries. */
  providerDefinition?: Readonly<import("./provider-types.js").ProviderDefinition>;
  baseHeaders?: Readonly<Record<string, string>>;
  rawExchange?: RawModelExchange;
  headers?: Record<string, string>;
  onRateWait?: (event: RateWaitEvent) => unknown;
  sessionId?: string;
  runId?: string;
  spanId?: string;
  maxTokens?: number;
  rateLimit?: boolean;
  inputTokensEstimate?: number;
  traceparent?: string;
  baggage?: string;
  retry?: { maxRetries?: number; baseDelayMs?: number; maxDelayMs?: number; jitterRatio?: number };
  maxRetries?: number;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
  retryJitterRatio?: number;
}

interface EventMeta { streamTraceId?: string; contentIndex?: number; outputIndex?: number | null; itemId?: string; phase?: string; }
export type ModelEvent = EventMeta & (
  | { type: 'text_start' | 'thinking_start' }
  | { type: 'text_end' | 'thinking_end'; content: string }
  | { type: 'text_delta' | 'thinking_delta'; delta: string }
  | { type: 'tool_call_update'; index?: number; toolCallId?: string; toolName?: string; delta?: string; arguments?: string; argsComplete?: boolean; isStart?: boolean }
  | { type: 'usage'; usage: Record<string, unknown> }
  | { type: 'done'; message: ModelMessage; usage?: Record<string, unknown> }
);

export interface ProviderAdapter {
  label?: string;
  /** Login-only protocols opt out of the generic endpoint/API-key form. */
  customProvider?: boolean;
  recovery?(failure: Error & { kind?: string; code?: string }, config: RuntimeConfig): ProviderRecovery | null;
  chat(messages: ModelMessage[], tools: object[], signal: AbortSignal | undefined, options: ModelOptions, config: RuntimeConfig): Promise<{ message: ModelMessage; usage?: Record<string, unknown> }>;
  chatStream(messages: ModelMessage[], tools: object[], signal: AbortSignal | undefined, options: ModelOptions, config: RuntimeConfig): AsyncIterable<ModelEvent>;
}

/** Immutable per-gateway lookup. Extending a native protocol never changes routing. */
export function createProviderRegistry(definitions: Readonly<Record<string, ProviderAdapter>>) {
  const protocols = new Map<string, Readonly<ProviderAdapter>>();
  for (const [name, adapter] of Object.entries(definitions)) {
    const protocol = name.trim().toLowerCase();
    if (!protocol || protocols.has(protocol)) throw new Error(`Duplicate or empty provider protocol: ${name}`);
    if (typeof adapter?.chat !== 'function' || typeof adapter?.chatStream !== 'function') {
      throw new Error(`Provider protocol requires chat and chatStream: ${protocol}`);
    }
    protocols.set(protocol, Object.freeze({ ...adapter }));
  }
  return Object.freeze({
    protocols: Object.freeze([...protocols.keys()]),
    customProtocols: Object.freeze([...protocols].filter(([, adapter]) => adapter.customProvider !== false)
      .map(([id, adapter]): Readonly<CustomProviderProtocol> => Object.freeze({ id, label: adapter.label || id }))),
    get(protocol: string): Readonly<ProviderAdapter> {
      const adapter = protocols.get(String(protocol).trim().toLowerCase());
      if (adapter) return adapter;
      const error = Object.assign(new Error(t("settings.protocolUnregistered", { protocol: String(protocol) })), {
        code: 'LLM_UNSUPPORTED_PROTOCOL', kind: 'invalid_request',
      });
      throw error;
    },
  });
}
