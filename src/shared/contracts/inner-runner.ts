/** Internal offscreen/sandbox/Worker wire protocol; task ownership stays in Background. */
export interface BridgeFailure { ok: false; error?: string; code?: string; details?: unknown; diagnostic?: unknown }
export type ToolBridgeResponse = BridgeFailure | { ok: true; result?: unknown; artifacts?: unknown; artifact?: unknown };
export interface FetchResult { status: number; statusText?: string; headers?: [string, string][]; bodyBase64?: string; url?: string; redirected?: boolean }
export type FetchBridgeResponse = BridgeFailure | { ok: true; result: FetchResult };
export interface FetchRequest { url: string; method: string; headers: [string, string][]; bodyBase64: string }
export interface TraceRow { time: string; level: string; message: string }
export interface ScriptFailure extends Error { code?: string; details?: unknown; diagnostic?: unknown }
export type MessageValue = undefined | null | string | boolean | number | MessageValue[] | { [key: string]: MessageValue };
export interface ScriptEnvelope {
  __runScriptEnvelope: true; ok: boolean; hasResult: boolean; result: MessageValue; resultType: string;
  engine: 'offscreen_inner'; execution_world: 'inner'; reason?: 'inner'; trace: MessageValue; elapsedMs: number;
  error?: string; code?: string; details?: MessageValue; diagnostic?: MessageValue; message?: string; artifacts?: MessageValue;
}
export interface WorkerExecute { type: 'execute'; requestId?: string; source?: string; scriptArgs?: Record<string, unknown>; securityGuardrails?: unknown; fetchBridge?: boolean }
export type InnerWorkerInput = WorkerExecute
  | { type: 'tool_response'; callId: string; response?: ToolBridgeResponse }
  | { type: 'fetch_response'; callId: string; response?: FetchBridgeResponse };
export type InnerWorkerOutput = { type: 'tool_call'; callId: string; toolName: string; args: MessageValue }
  | { type: 'fetch_call'; callId: string; request: FetchRequest }
  | { type: 'fetch_cancel'; callId: string }
  | { type: 'result'; result: ScriptEnvelope };
