/** Public observer contracts; immutable delivery and queue ownership stay in the host. */
export interface LifecycleEvent {
  readonly type: string;
  readonly phase: "emitted" | "committed";
  readonly sessionId: string;
  readonly runId: string;
  readonly timestamp: number;
  readonly epoch?: number;
  readonly eventSeq?: number;
  readonly toolCallId?: string;
  readonly status?: string;
  readonly code?: string;
  readonly message?: Readonly<{ role: string; _origin: string }>;
}
export interface LifecycleObserver {
  readonly id: string;
  readonly capacity?: number;
  readonly timeoutMs?: number;
  readonly accepts?: (event: LifecycleEvent) => boolean;
  onEvent(event: LifecycleEvent, signal: AbortSignal): unknown | Promise<unknown>;
}
