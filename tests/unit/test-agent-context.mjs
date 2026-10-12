import assert from 'node:assert/strict';
import test from 'node:test';
import { Agent } from '../../src/background/agent/agent.js';
import { collectDynamicContext, collectSiteSkillPreviewContext, collectToolRuntimeContext,
  normalizeDynamicContext, formatDynamicContext, buildContextCapsuleMessage } from '../../src/background/agent/context.js';
import { createTestAgentOptions } from '../support/agent-services.mjs';

const request = (signal, runId = 'run-1', reason = 'snapshot') => ({ signal, runId, reason });
const services = overrides => ({ getSecurityGuardrails: async () => ({ blockedDomains: [], blockedPatterns: [] }),
  readSelectedText: async id => `selection-${id}`, matchSiteSkillsForUrls: async () => [], ...overrides });
function deferred() { let resolve; let reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }

test('unknown context fields stay opaque while malformed known structures are excluded', () => {
  const custom = { nested: 'private' };
  const context = normalizeDynamicContext({ custom, workingTab: false, tabs: [null, 1, { id: '7', title: 'Page' }],
    pageTitle: {}, goal: { status: 'active', objective: 'Read', progress: {}, version: '2' },
    tracker: { steps: ['First', null, { label: 'Second' }], total: '2' },
    sources: [null, { id: 'bad', title: 'Bad', text: 1 }, { id: 'valid', title: 'Notes', text: 'read only' }],
    location: { latitude: '31.2', longitude: '121.5', accuracy: 'bad' } });
  assert.equal(context.custom, custom);
  assert.equal(context.workingTab, undefined);
  assert.deepEqual(context.tabs, [{ id: 7, title: 'Page' }]);
  assert.equal(context.pageTitle, undefined);
  assert.deepEqual(context.goal, { status: 'active', objective: 'Read', version: 2 });
  assert.deepEqual(context.sources, [{ id: 'valid', title: 'Notes', text: 'read only' }]);
  assert.match(formatDynamicContext(context), /read only/);
  assert.deepEqual(normalizeDynamicContext([]), {});
  assert.deepEqual(normalizeDynamicContext(null), {});
});

test('collection uses only task sites and the owned working page, preserving source input', async () => {
  const input = { workingTab: { id: 7, url: 'https://owned.test/page#anchor' },
    userVisibleTab: { id: 9, url: 'https://foreign.test/', ownerSessionId: 'other' },
    taskSiteTabs: [{ url: 'https://owned.test/page' }, { url: 'file:///private' }, { url: 'https://blocked.test/', contentAccess: 'blocked' }] };
  const before = structuredClone(input);
  let urls;
  const context = await collectDynamicContext(async () => input, request(), services({
    matchSiteSkillsForUrls: async value => { urls = value; return [{ name: 'reading', metadata: { displayName: '阅读' }, description: 'Read' }]; },
  }));
  assert.deepEqual(urls, ['https://owned.test/page']);
  assert.equal(context.selectionText, 'selection-7');
  assert.match(formatDynamicContext(context), /reading（阅读）/);
  assert.deepEqual(input, before);
  assert.equal(buildContextCapsuleMessage(context)._origin, 'context_capsule');
});

test('blocked working pages never read a selection or activate a site skill', async () => {
  let selections = 0;
  let matches = 0;
  const context = await collectDynamicContext(async () => ({ workingTab: { id: 7, url: 'https://blocked.test/' }, selectionText: 'old' }), request(), services({
    getSecurityGuardrails: async () => ({ blockedDomains: ['blocked.test'], blockedPatterns: [] }),
    readSelectedText: async () => { selections++; return 'secret'; },
    matchSiteSkillsForUrls: async () => { matches++; return []; },
  }));
  assert.equal(context.workingTab.securityGuardrailBlocked, true);
  assert.equal(context.selectionText, undefined);
  assert.equal(selections, 0);
  assert.equal(matches, 0);
});

test('optional source failure falls back only to this run’s working tab; required sources fail', async () => {
  const failure = async () => { throw new Error('optional offline'); };
  const fallback = { id: 6, url: 'https://owned.test/' };
  assert.equal((await collectDynamicContext(failure, request(), services())).workingTab, undefined);
  assert.equal(await collectSiteSkillPreviewContext(failure, request(undefined, 'run', 'site-skills')), null);
  assert.deepEqual(await collectToolRuntimeContext(failure, request(undefined, 'run', 'tool'), fallback), { workingTab: fallback, workingTabId: 6 });
  assert.equal((await collectToolRuntimeContext(async () => ({ userVisibleTab: { id: 99 } }), request(), null)).workingTabId, null);
  const required = Object.assign(new Error('required offline'), { code: 'CONTEXT_SOURCE_REQUIRED' });
  await assert.rejects(collectDynamicContext(async () => { throw required; }, request(), services()), error => error === required);
  assert.equal((await collectDynamicContext(async () => ({ workingTab: { id: 8 } }), request(), services())).workingTab.id, 8);
});

for (const stage of ['provider', 'guardrails', 'selection', 'skills']) test(`cancellation after ${stage} cannot return late context`, async () => {
  const controller = new AbortController();
  const called = [];
  const at = (name, value) => { called.push(name); if (stage === name) controller.abort(); return value; };
  await assert.rejects(collectDynamicContext(async received => {
    assert.equal(received.signal, controller.signal);
    assert.equal(received.runId, 'run-1');
    return at('provider', { workingTab: { id: 7, url: 'https://owned.test/' } });
  }, request(controller.signal), services({
    getSecurityGuardrails: async () => at('guardrails', { blockedDomains: [], blockedPatterns: [] }),
    readSelectedText: async () => at('selection', 'selected'),
    matchSiteSkillsForUrls: async () => at('skills', []),
  })), { name: 'AbortError' });
  assert.equal(called.at(-1), stage, 'no subsequent host operation may run after cancellation');
});

test('independent collectors do not share working pages or partially completed requests', async () => {
  const gate = deferred();
  const left = collectDynamicContext(async () => { await gate.promise; return { workingTab: { id: 1 } }; }, request(undefined, 'left'), services());
  const right = await collectDynamicContext(async () => ({ workingTab: { id: 2 } }), request(undefined, 'right'), services());
  gate.resolve();
  assert.equal((await left).selectionText, 'selection-1');
  assert.equal(right.selectionText, 'selection-2');
});

for (const invalidation of ['abort', 'lease', 'run']) test(`Agent retains its snapshot when ${invalidation} invalidates a late read`, async () => {
  const gate = deferred();
  let active = true;
  let writes = 0;
  const agent = new Agent('session', createTestAgentOptions({
    conversationLease: { sessionId: 'session', isActive: () => active },
    conversationRepository: { writeActiveConversation: async () => { writes++; } },
  }));
  const previous = { workingTab: { id: 1 }, sourceWindowId: 4 };
  agent._dynamicContextSnapshot = previous;
  agent._currentRunId = 'old';
  agent._abortCtrl = new AbortController();
  agent.setDynamicContextProvider(() => gate.promise);
  const pending = agent._refreshDynamicContextSnapshot(null, 'test');
  if (invalidation === 'abort') agent.abort();
  if (invalidation === 'lease') active = false;
  if (invalidation === 'run') agent._currentRunId = 'new';
  gate.resolve({ workingTab: { id: 99 } });
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(agent._dynamicContextSnapshot, previous);
  assert.equal(writes, 0);
});

test('failed snapshot collection can recover without losing the initiating window', async () => {
  const agent = new Agent('session', createTestAgentOptions());
  agent.setDynamicContextProvider(async () => { throw Object.assign(new Error('offline'), { code: 'CONTEXT_SOURCE_REQUIRED' }); });
  await assert.rejects(agent._refreshDynamicContextSnapshot({ sourceWindowId: 4 }), /offline/);
  assert.equal(agent._dynamicContextSnapshot, null);
  agent.setDynamicContextProvider(async () => ({ workingTab: { id: 2 } }));
  const next = await agent._refreshDynamicContextSnapshot({ sourceWindowId: '4' });
  assert.equal(next.sourceWindowId, 4);
  assert.equal(next.workingTab.id, 2);
});
