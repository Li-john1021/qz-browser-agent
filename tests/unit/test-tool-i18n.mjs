import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createEmbeddedSkillRegistry } from '../../src/shared/skills/embedded-skill-registry.js';

const fixture = fileURLToPath(new URL('../fixtures/i18n/model-catalog.mjs', import.meta.url));
const snapshot = locale => JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', '--import', './tests/support/typescript-loader.mjs', fixture, locale], {
  cwd: fileURLToPath(new URL('../../', import.meta.url)), encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
}));
const chinese = snapshot('zh-CN');
const english = snapshot('en-US');

function withoutDocumentation(value) {
  if (Array.isArray(value)) return value.map(withoutDocumentation);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key, item]) => !(['description', 'title'].includes(key) && typeof item === 'string'))
    .map(([key, item]) => [key, ['default', 'const', 'enum', 'examples'].includes(key) ? item : withoutDocumentation(item)]));
}
function documentation(value, path = '') {
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, item]) => ['description', 'title', 'imagePrompt'].includes(key) && typeof item === 'string'
    ? [[`${path}.${key}`, item]] : documentation(item, `${path}.${key}`));
}

test('all registered tool names and recursive argument contracts are identical across languages', () => {
  assert.ok(english.registered.length > 50, 'exercise actual core registrations, including hidden Skill hosts');
  assert.deepEqual(withoutDocumentation(english.registered.map(({ imagePrompt, ...item }) => item)), withoutDocumentation(chinese.registered.map(({ imagePrompt, ...item }) => item)));
  for (const key of ['schemas', 'textOnlySchemas', 'restrictedSchemas']) {
    assert.deepEqual(withoutDocumentation(english[key]), withoutDocumentation(chinese[key]), key);
  }
  assert.ok(english.schemas.length > english.registered.length, 'include loaded builtin Skill tools');
  for (const entry of english.registered) for (const [path, text] of documentation(entry, entry.name)) {
    assert.doesNotMatch(text, /\p{Script=Han}/u, `${path} must provide English documentation`);
    assert.ok(text.trim(), path);
  }
  for (const key of ['schemas', 'textOnlySchemas', 'restrictedSchemas']) for (const schema of english[key]) {
    if (schema.function.name.startsWith('foreign_guide__')) continue;
    for (const [path, text] of documentation(schema, schema.function.name)) assert.doesNotMatch(text, /\p{Script=Han}/u, path);
  }
  assert.match(chinese.registered.find(tool => tool.name === 'open_tab').description, /[\p{Script=Han}]/u);
  assert.match(english.schemas.find(tool => tool.function.name === 'list_tabs').function.parameters.properties.timeout.description, /seconds/);
  assert.ok(!english.textOnlySchemas.some(tool => tool.function.name === 'screenshot'));
  assert.ok(!english.restrictedSchemas.some(tool => tool.function.name === 'manage_sessions'));
});

test('builtin guidance and manifest documentation are localized, executable resources and examples remain valid', () => {
  assert.equal(english.skills.length, chinese.skills.length);
  for (const skill of english.skills) {
    const original = chinese.skills.find(item => item.name === skill.name);
    assert.ok(original, skill.name);
    for (const key of ['displayName', 'description', 'content']) assert.doesNotMatch(skill[key], /\p{Script=Han}/u, `${skill.name}.${key}`);
    const resources = new Map(original.resources.map(resource => [resource.path, resource]));
    for (const resource of skill.resources) {
      const previous = resources.get(resource.path);
      assert.ok(previous, resource.path);
      if (resource.path === 'plugin.json') {
        const manifest = JSON.parse(resource.content);
        for (const [path, text] of documentation(manifest, skill.name)) assert.doesNotMatch(text, /\p{Script=Han}/u, path);
        assert.deepEqual(withoutDocumentation(manifest.tools), withoutDocumentation(JSON.parse(previous.content).tools), skill.name);
      } else assert.equal(resource.content, previous.content, `${skill.name}/${resource.path}: executable bytes`);
    }
    for (const [, json] of skill.content.matchAll(/```json\n([\s\S]*?)```/g)) assert.doesNotThrow(() => JSON.parse(json), `${skill.name}: JSON example`);
  }
});

test('external Skill documentation remains authored content, with localized host timeout guidance', () => {
  const tool = english.schemas.find(item => item.function.name === 'foreign_guide__echo').function;
  assert.ok(tool.description.startsWith('用户定义的工具说明'));
  assert.equal(tool.parameters.properties.text.description, '用户的参数说明');
  assert.match(tool.parameters.properties.timeout.description, /seconds/);
  assert.equal(english.aliases['技能工作台'], 'skill-workbench');
  assert.equal(chinese.aliases['Skill workbench'], 'skill-workbench');
  assert.equal(english.aliases['文档处理'], 'qingzhou-documents');
  assert.deepEqual(english.aliases, chinese.aliases);
  assert.ok(Object.values(english.aliases).every(Boolean), 'all historical and translated display aliases still resolve');
});

test('embedded aliases are registration-only, immutable and collision checked', () => {
  const definition = { name: 'sample-guide', displayName: 'Example', aliases: ['示例指南'], description: 'Guide', content: '# Guide' };
  const registry = createEmbeddedSkillRegistry([qz => qz.registerSkill(definition)]);
  definition.aliases[0] = 'changed';
  const result = registry.get('示例指南');
  assert.equal(result.name, 'sample-guide');
  assert.equal(result.aliases, undefined, 'no extra wire/storage field');
  result.content = 'changed returned record';
  assert.equal(registry.get('Example').content, '# Guide');
  assert.equal(registry.get('Example!').name, 'sample-guide', 'preserve legacy display-name slug matching');
  assert.equal(registry.get('sample.guide').name, 'sample-guide', 'preserve legacy canonical-name slug matching');
  assert.equal(registry.get('changed'), null);
  assert.equal(registry.get(''), null);
  assert.equal(registry.get(' -_ '), null);
  assert.throws(() => createEmbeddedSkillRegistry([qz => {
    qz.registerSkill(definition);
    qz.registerSkill({ ...definition, name: 'second-guide', displayName: 'Second', aliases: ['EX_AM PLE'] });
  }]), /Duplicate embedded Skill/);
  assert.throws(() => createEmbeddedSkillRegistry([qz => qz.registerSkill({ ...definition, aliases: [''] })]), /Invalid embedded Skill aliases/);
  assert.throws(() => createEmbeddedSkillRegistry([qz => qz.registerSkill({ ...definition, aliases: [' -_ '] })]), /Invalid embedded Skill aliases/);
});
