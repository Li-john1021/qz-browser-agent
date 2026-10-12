import type { ToolSessionCommands, UserWaitRuntime } from '../../src/sdk/background.js';

declare const sessions: ToolSessionCommands;
declare const wait: UserWaitRuntime;
declare const signal: AbortSignal;
const identity = { sessionId: 'session', runId: 'run' };
void sessions.clearWorkingTab({ ...identity, tabId: 7, source: 'tool:close', signal });
void sessions.clearWorkingTab({ sessionId: 'session' });
// @ts-expect-error A mutation cannot fall back to an implicit Session.
void sessions.clearWorkingTab({ tabId: 7 });
// @ts-expect-error Misspelled known fields are not accepted as arbitrary metadata.
void sessions.clearWorkingTab({ sessionId: 'session', tabID: 7 });
// @ts-expect-error Tab identity is numeric at the SDK boundary.
void sessions.clearWorkingTab({ sessionId: 'session', tabId: '7' });

void sessions.updateGoal({ ...identity, action: 'create', objective: 'Collect rows', criteria: 'Rows saved', signal });
void sessions.updateGoal({ ...identity, action: 'checkpoint', progress: 'Saved page 1', next: 'Read page 2' });
void sessions.updateGoal({ ...identity, action: 'get' });
// @ts-expect-error Goal updates require explicit Session identity.
void sessions.updateGoal({ runId: 'run', action: 'clear' });
// @ts-expect-error Tool writes retain the owning run identity.
void sessions.updateGoal({ sessionId: 'session', action: 'clear' });
// @ts-expect-error Actions are a finite set.
void sessions.updateGoal({ ...identity, action: 'compelete' });
// @ts-expect-error Content field typos cannot enter the request.
void sessions.updateGoal({ ...identity, action: 'update', objetive: 'Collect rows' });
// @ts-expect-error Goal content is a short text field, not an opaque payload.
void sessions.updateGoal({ ...identity, action: 'checkpoint', progress: { rows: [] } });
// @ts-expect-error Storage version and status are host-owned.
void sessions.updateGoal({ ...identity, action: 'update', version: 100 });

void sessions.saveAutomation({ sourceSessionId: 'session', automation: {
  title: 'Daily task', instruction: 'Collect rows', schedule: { type: 'daily', time: '09:00' },
  missedPolicy: 'run_once', notifyPolicy: 'failure', enabled: true,
} });
void sessions.saveAutomation({ sourceSessionId: 'session', automation: { id: 'automation', enabled: false } });
void sessions.saveAutomation({ sourceSessionId: 'session', automation: { id: 'automation', schedule: { type: 'once', date: '2026-10-01', time: '09:00' } } });
// @ts-expect-error Saving identifies the caller even when editing an existing definition.
void sessions.saveAutomation({ automation: { id: 'automation', enabled: false } });
// @ts-expect-error A new definition needs both title and instruction.
void sessions.saveAutomation({ sourceSessionId: 'session', automation: { title: 'Incomplete' } });
// @ts-expect-error An edit without creation content needs the target automation id.
void sessions.saveAutomation({ sourceSessionId: 'session', automation: { enabled: false } });
// @ts-expect-error Policy names are closed.
void sessions.saveAutomation({ sourceSessionId: 'session', automation: { id: 'automation', notifyPolicy: 'silentt' } });
// @ts-expect-error Nested schedule field typos are rejected.
void sessions.saveAutomation({ sourceSessionId: 'session', automation: { id: 'automation', schedule: { runAT: '2026-10-01T09:00:00+08:00' } } });
// @ts-expect-error Run bookkeeping cannot be forged by an extension.
void sessions.saveAutomation({ sourceSessionId: 'session', automation: { id: 'automation', runningRunId: 'fake-run' } });

void wait.beginUserWait('session', { waitId: 'wait', runId: 'run', signal, onSettled() {} });
void wait.resolveUserWait({ sessionId: 'session', waitId: 'wait', payload: { answers: { custom: [1, 2] } } });
void wait.rejectUserWait({ sessionId: 'session', waitId: 'wait' });
void wait.isWaitingForUser('session');
// @ts-expect-error A bare wait id must not search other Sessions through the SDK.
void wait.resolveUserWait({ waitId: 'wait' });
// @ts-expect-error A late response must identify the intended wait, not whichever wait is active.
void wait.resolveUserWait({ sessionId: 'session' });
// @ts-expect-error Cancellation requires complete wait identity too.
void wait.rejectUserWait({ sessionId: 'session' });
// @ts-expect-error No implicit global waiting query is exposed to extensions.
void wait.isWaitingForUser();
