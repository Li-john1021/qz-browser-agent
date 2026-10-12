import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

test('cancelled settings reads cannot start a custom embedded host, and a later run can recover', async t => {
  const manifest = {
    format: 'qingzhou.plugin', schemaVersion: 1, id: 'cancellation-guide',
    settings: { fields: [{ key: 'token', type: 'secret' }] },
    tools: [{ name: 'inspect', runtime: 'host', script: 'scripts/inspect.js',
      parameters: { type: 'object', properties: { value: { type: 'string' } } } }],
  };
  const definition = { name: 'cancellation-guide', description: 'Cancellation fixture', content: '# Cancellation',
    resources: [{ path: 'plugin.json', type: 'json', content: JSON.stringify(manifest) },
      { path: 'scripts/inspect.js', type: 'script', content: 'return null;' }] };
  const moduleUrl = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
  const catalogs = {
    '#capabilities/skills': moduleUrl(`export default [qz => qz.registerSkill(${JSON.stringify(definition)})];`),
    '#capabilities/skillHosts': moduleUrl(`
      export const calls = [];
      export default [qz => qz.registerSkillHost({
        skillName: 'cancellation-guide', manifestId: 'cancellation-guide', toolName: 'inspect',
        execute: async (args, { signal }) => { calls.push({ args, aborted: signal?.aborted }); return { ok: true }; },
      })];
    `),
  };
  // Replace only discovery inputs; provenance, host binding and execution use their real modules.
  const hooks = registerHooks({ resolve(specifier, context, next) {
    return Object.hasOwn(catalogs, specifier) ? { url: catalogs[specifier], shortCircuit: true } : next(specifier, context);
  } });
  t.after(() => hooks.deregister());
  const { listBuiltinSkills } = await import('../../src/shared/skills/builtin-skills.js');
  const { prepareSkillToolRegistryFromSkills, executeSkillTool } = await import('../../src/background/skills/skill-tool-runtime.js');
  const { calls } = await import(catalogs['#capabilities/skillHosts']);
  const candidate = prepareSkillToolRegistryFromSkills(listBuiltinSkills());
  const context = { sessionId: 'isolated', runId: 'cancelled', skillToolRegistrySnapshot: candidate };
  const controller = new AbortController();
  const pendingConfig = Promise.withResolvers();
  let reads = 0;
  const runtime = { skillSettings: { getExecutionConfig: () => { reads += 1; return pendingConfig.promise; } } };
  const dispatch = () => assert.fail('this custom host does not dispatch nested tools');
  const pending = executeSkillTool('cancellation_guide__inspect', { timeout: 30 }, controller.signal, context, dispatch, runtime);
  assert.equal(reads, 1, 'the settings read is in flight before cancellation');
  controller.abort();
  pendingConfig.resolve({ token: 'fixture-value' });
  await assert.rejects(pending, { code: 'OPERATION_ABORTED' });
  assert.deepEqual(calls, [], 'late settings must not enter user-provided host code');

  await assert.rejects(executeSkillTool('cancellation_guide__inspect', { timeout: 30 }, controller.signal, context, dispatch, runtime),
    { code: 'OPERATION_ABORTED' });
  assert.equal(reads, 1, 'already cancelled invocations do not begin another settings read');

  const result = await executeSkillTool('cancellation_guide__inspect', { timeout: 30, value: 'retry' }, new AbortController().signal,
    { ...context, runId: 'recovered' }, dispatch, runtime);
  assert.equal(result.ok, true);
  assert.deepEqual(calls, [{ args: { value: 'retry' }, aborted: false }]);
  assert.equal(reads, 2);
});
