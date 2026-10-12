import assert from 'node:assert/strict';
import test from 'node:test';
import { createSkillHostResources } from '../../src/sdk/shared/skill-definition.js';
import { getCoreToolMetadata } from '../../src/shared/tools/tool-metadata.js';
import { createEmbeddedSkillRegistry } from '../../src/shared/skills/embedded-skill-registry.js';
import { createSkillHostRegistry, resolveSkillHostTarget } from '../../src/background/skills/skill-host-registry.js';
import { findBuiltinSkill, listBuiltinSkills } from '../../src/shared/skills/builtin-skills.js';
import { findSkillManifestResource, parseSkillManifest, skillMatchesContext } from '../../src/shared/skills/skill-manifest.js';
import { prepareSkillToolRegistryFromSkills, getHostCoreToolTarget, executeSkillTool } from '../../src/background/skills/skill-tool-runtime.js';

const record = (name, extra = {}) => ({ name, description: `Use ${name}`, content: `# ${name}`, ...extra });
const register = definition => qz => qz.registerSkill(definition);
const manifest = skill => parseSkillManifest(findSkillManifestResource(skill.resources).content, skill).plugin;

test('a Skill-only contribution is ordered, immutable at the boundary, removable, and supports site activation', () => {
  const definition = record('independent-guide', { displayName: 'Independent Guide', scope: 'site', domains: ['example.test'],
    urlPatterns: ['https://example.test/*'], excludePatterns: ['https://example.test/private/*'], resources: [{path:'notes.txt',type:'text',content:'Original'}] });
  const registry = createEmbeddedSkillRegistry([register(record('last-guide', {order: 2})), register(definition)]);
  definition.content = 'mutated';
  definition.resources[0].content = 'mutated';
  const first = registry.list();
  assert.deepEqual(first.map(skill => skill.name), ['independent-guide', 'last-guide']);
  assert.equal(first[0].content, '# independent-guide');
  assert.equal(first[0].resources[0].content, 'Original');
  assert.deepEqual([first[0].scope, first[0].domains, first[0].urlPatterns, first[0].excludePatterns],
    ['site', ['example.test'], ['https://example.test/*'], ['https://example.test/private/*']]);
  assert.deepEqual([first[0].builtin, first[0].readOnly, first[0].source, first[0].status], [true,true,'system','active']);
  first[0].resources[0].content = 'changed returned record';
  assert.equal(registry.list()[0].resources[0].content, 'Original');
  assert.deepEqual(createEmbeddedSkillRegistry([]).list(), []);
});

test('embedded registration rejects duplicate names and normalized display aliases across all contributions', () => {
  for (const duplicate of [record('first-guide'), record('another-guide', {displayName:'FIRST_GUIDE'}),
    record('another-guide', {displayName:'Readable Title'}), record('readable-title')]) {
    assert.throws(() => createEmbeddedSkillRegistry([register(record('first-guide', {displayName:'Readable_Title'})), register(duplicate)]), /Duplicate embedded Skill/);
  }
  assert.throws(() => createEmbeddedSkillRegistry([register(record('../bad'))]), /Invalid embedded Skill name/);
  assert.throws(() => createEmbeddedSkillRegistry([register(record('bad-order', {order:NaN}))]), /Invalid embedded Skill order/);
});

test('trusted host bindings require the actual registered Skill, unchanged manifest, and exact tool identity', () => {
  const skill = findBuiltinSkill('qingzhou-management');
  const binding = {skillName:skill.name, manifestId:'qingzhou-management', toolName:'manage_settings', target:'manage_settings'};
  const registry = createSkillHostRegistry([qz => qz.registerSkillHost(binding)], [skill]);
  const plugin = manifest(skill);
  const tool = plugin.tools.find(item => item.localName === 'manage_settings');
  assert.equal(registry.resolve(plugin, tool).target, 'manage_settings');
  assert.equal(registry.resolve(plugin, {...tool}), null, 'a copied tool is not the manifest-owned tool');
  assert.equal(registry.resolve(structuredClone(plugin), tool), null, 'serialized system flags cannot establish provenance');
  for (const forged of [structuredClone(skill), {...skill}, {...skill, name:'other-skill'}]) {
    const parsed = manifest(forged);
    assert.equal(registry.resolve(parsed, parsed.tools.find(item => item.localName === 'manage_settings')), null);
  }
  const changed = findBuiltinSkill(skill.name);
  changed.resources.find(item => item.path === 'plugin.json').content += ' ';
  assert.equal(manifest(changed).tools.find(item => item.localName === 'manage_settings').capabilityId, 'qingzhou_management__manage_settings');
  const substituted = JSON.parse(findSkillManifestResource(skill.resources).content);
  substituted.tools[0].description = 'another manifest';
  const other = parseSkillManifest(JSON.stringify(substituted), skill).plugin;
  assert.equal(registry.resolve(other, other.tools[0]), null);
  tool.parameters = {type:'object',properties:{changed:{type:'string'}}};
  assert.equal(registry.resolve(plugin, tool), null, 'mutating a normalized trusted manifest revokes authority');
});

test('host registration validates manifest identity, runtime, target, and duplicate bindings', () => {
  const skill = findBuiltinSkill('qingzhou-management');
  const definition = {skillName:skill.name, manifestId:'qingzhou-management', toolName:'manage_settings', target:'manage_settings'};
  for (const changed of [{skillName:'missing'}, {manifestId:'wrong'}, {toolName:'missing'}, {target:'navigate'}, {target:''},
    {execute:async()=>({})}, {target:undefined}]) {
    assert.throws(() => createSkillHostRegistry([qz => qz.registerSkillHost({...definition,...changed})], [skill]), /binding|implementation/);
  }
  assert.throws(() => createSkillHostRegistry([qz => {qz.registerSkillHost(definition);qz.registerSkillHost(definition);}], [skill]), /Duplicate Skill host identity/);
  assert.throws(() => createSkillHostRegistry([qz => qz.registerSkillHost(definition)], [structuredClone(skill)]), /registered embedded manifest/);
  const custom = async args => ({received:args});
  const registry = createSkillHostRegistry([qz => qz.registerSkillHost({...definition,target:undefined,execute:custom})], [skill]);
  const plugin = manifest(skill);
  assert.equal(registry.resolve(plugin, plugin.tools.find(item => item.localName==='manage_settings')).execute, custom);
  assert.equal(createSkillHostRegistry([], []).target('manage_settings'), null);
});

test('runtime projection preserves trusted host policy, while forged stored workbench identities remain denied', async () => {
  assert.deepEqual(listBuiltinSkills().map(skill => skill.name), ['skill-workbench','site-skill-author','qingzhou-management','qingzhou-documents','qingzhou-mcp']);
  const candidate = prepareSkillToolRegistryFromSkills(listBuiltinSkills());
  const entry = candidate.toolIndex.get('qingzhou_management__manage_settings');
  assert.equal(getHostCoreToolTarget(entry.plugin,entry.tool),'manage_settings');
  assert.deepEqual(resolveSkillHostTarget('document_read_chunk'), {skillName:'qingzhou-documents',toolName:'qingzhou_documents__document_read_chunk'});
  const ordinary = prepareSkillToolRegistryFromSkills([structuredClone(findBuiltinSkill('skill-workbench'))]);
  const forged = [...ordinary.toolIndex.values()].find(item=>item.tool.runtime==='host');
  assert.ok(forged);
  assert.equal(getHostCoreToolTarget(forged.plugin,forged.tool),'');
  await assert.rejects(executeSkillTool(forged.tool.name, {timeout:30}, undefined,
    {skillToolRegistrySnapshot:ordinary,sessionId:'isolated',runId:'forged'},
    async () => assert.fail('forged stored system fields must never call a host tool')), {code:'PLUGIN_HOST_ACTION_UNAVAILABLE'});
});

const plainHostDefinition = (name, extra = {}) => record(name, {...extra, resources:createSkillHostResources({
  id:name,displayName:'Independent host',version:'1',description:'Independent operation',category:{id:'example',label:'Example'},
  manifestTitle:'Manifest',manifestDescription:'Independent host',scriptDescription:'Dispatch',
  tools:{independent_operation:{description:'A tool without display metadata',parameters:{type:'object',properties:{}}}},
})});

test('registered host targets do not require an optional display metadata contribution', () => {
  const [skill] = createEmbeddedSkillRegistry([register(plainHostDefinition('independent-host'))]).list();
  assert.equal(getCoreToolMetadata('independent_operation'),null);
  const definition = {skillName:skill.name,manifestId:skill.name,toolName:'independent_operation',target:'independent_operation'};
  const registry = createSkillHostRegistry([qz=>qz.registerSkillHost(definition)], [skill]);
  const plugin = manifest(skill);
  assert.equal(plugin.tools[0].name,'independent_host__independent_operation','legacy runtime names retain their namespace');
  assert.equal(plugin.tools[0].capabilityId,'independent_operation');
  assert.equal(registry.resolve(plugin,plugin.tools[0]).target,'independent_operation');
  assert.deepEqual(registry.target('independent_operation'), {skillName:skill.name,toolName:'independent_host__independent_operation'});
  const untrusted = manifest(structuredClone(skill));
  assert.equal(untrusted.tools[0].capabilityId,'independent_host__independent_operation');
  assert.equal(registry.resolve(untrusted,untrusted.tools[0]),null);
});

test('site exclusions restrict automatic activation while explicit loading remains authoritative', () => {
  const make = (scope, extra = {}) => manifest(createEmbeddedSkillRegistry([register(plainHostDefinition('scoped-host', {
    scope,domains:['example.test'],urlPatterns:['https://example.test/*'],excludePatterns:['https://example.test/private/*'],...extra,
  }))]).list()[0]);
  const plugin = make('site');
  assert.equal(skillMatchesContext(plugin,{pageUrl:'https://example.test/public'}),true);
  assert.equal(skillMatchesContext(plugin,{pageUrl:'https://example.test/private/secret'}),false);
  assert.equal(skillMatchesContext(plugin,{pageUrl:'https://other.test/public'}),false);
  assert.equal(skillMatchesContext(plugin,{}),false);
  assert.equal(skillMatchesContext(plugin,{pageUrl:'https://example.test/private/secret',loadedPluginSkillNames:[plugin.skillName]}),true);
  assert.equal(skillMatchesContext(plugin,{pageUrl:'https://example.test/private/secret',taskSiteTabs:[{url:'https://example.test/public'}]}),true);
  assert.equal(skillMatchesContext({...plugin,status:'disabled'},{loadedPluginSkillNames:[plugin.skillName]}),false);
  assert.equal(skillMatchesContext(make('global'),{pageUrl:'https://example.test/public'}),false,'builtin flags cannot activate a global Skill');
  assert.equal(skillMatchesContext(make('resident'),{}),true,'resident activation follows scope');
});
