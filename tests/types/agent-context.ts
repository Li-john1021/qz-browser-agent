import { normalizeDynamicContext } from '../../src/background/agent/context.js';
import type { DynamicContext, DynamicContextProvider } from '../../src/background/agent/context.js';
import { MessageQueue } from '../../src/background/agent/message-queue.js';

const context: DynamicContext = {
  workingTab: { id: 7, ownedByCurrentTask: true },
  goal: { status: 'active', objective: 'Read', version: 2 },
  tracker: { steps: ['First', { label: 'Second' }], stats: { complete: 1 } },
  customCapability: { value: 'opaque' },
};
// @ts-expect-error known browser facts cannot bypass normalization.
context.workingTab = { id: '7' };
// @ts-expect-error a provider's arbitrary goal data is not a validated goal snapshot.
context.goal = { progress: { raw: true } };
// @ts-expect-error unnamed capability data requires its owner's validation.
context.customCapability.value;

declare const provider: DynamicContextProvider;
async function readProvider() {
  const value = await provider({ reason: 'tool', runId: 'run-1' });
  // @ts-expect-error external provider results remain unknown until normalized.
  value.workingTab;
  const tabId: number | null | undefined = normalizeDynamicContext(value).workingTab?.id;
  return tabId;
}

const queue = new MessageQueue<{ clientMessageId: string; text: string }>();
queue.enqueue({ clientMessageId: 'first', text: 'continue' });
// @ts-expect-error queues preserve the caller's full message contract.
queue.enqueue({ clientMessageId: 'missing-text' });
const messages: { clientMessageId: string; text: string }[] = queue.drain();
void [context, readProvider, messages];
