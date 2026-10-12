import assert from 'node:assert/strict';
import test from 'node:test';
import { createSkillToolCatalog } from '../../src/sidepanel/features/app/skill-tool-catalog.js';
import { getSkillToolUiMeta, setSkillToolUiCatalog } from '../../src/sidepanel/tools/skill-tool-ui-registry.js';

const snapshot = title => ({ plugins: [{ id: 'example', tools: [{ name: 'example_tool', title }] }], version: 1 });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('workspace catalog loads and refreshes Skill renderer metadata without mounting the Skills page', async () => {
  const lifetime = new AbortController();
  const requests = []; let refreshes = 0;
  const catalog = createSkillToolCatalog({ signal: lifetime.signal, getCurrentSessionId: () => 'session',
    request: async (...args) => { requests.push(args); return snapshot('Loaded'); },
    refreshReferences: () => { refreshes += 1; },
  });
  await catalog.load();
  assert.equal(getSkillToolUiMeta('example_tool').tool.title, 'Loaded');
  assert.deepEqual(requests, [['list_plugin_contributions', { sessionId: 'session' }, 5000]]);
  assert.equal(refreshes, 1);
  lifetime.abort(); setSkillToolUiCatalog();
});

test('accepted updates and unmount prevent late catalog reads from overwriting newer identities', async () => {
  const lifetime = new AbortController();
  const stale = deferred(), refreshed = deferred();
  const replies = [stale.promise, refreshed.promise];
  const catalog = createSkillToolCatalog({ signal: lifetime.signal, getCurrentSessionId: () => null,
    request: () => replies.shift(), refreshReferences() {},
  });
  const initial = catalog.load();
  catalog.handleUpdate({ snapshot: snapshot('Accepted') });
  stale.resolve(snapshot('Stale reconnect')); await initial;
  assert.equal(getSkillToolUiMeta('example_tool').tool.title, 'Accepted');
  lifetime.abort(); refreshed.resolve(snapshot('Unloaded'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(getSkillToolUiMeta('example_tool').tool.title, 'Accepted');
  await assert.rejects(catalog.load(), { name: 'AbortError' });
  setSkillToolUiCatalog();
});

test('catalog read failures preserve the accepted projection and recover on reconnect', async () => {
  const lifetime = new AbortController(); let fail = true;
  const catalog = createSkillToolCatalog({ signal: lifetime.signal, getCurrentSessionId: () => null,
    request: async () => { if (fail) throw new Error('disconnected'); return snapshot('Recovered'); },
    refreshReferences() {},
  });
  setSkillToolUiCatalog(snapshot('Previous'));
  await assert.rejects(catalog.load(), /disconnected/);
  assert.equal(getSkillToolUiMeta('example_tool').tool.title, 'Previous');
  fail = false; await catalog.load();
  assert.equal(getSkillToolUiMeta('example_tool').tool.title, 'Recovered');
  lifetime.abort(); setSkillToolUiCatalog();
});
