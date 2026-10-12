import test from 'node:test';
import assert from 'node:assert/strict';
import { getToolCallArgumentsValue, normalizeToolCallName } from '../../src/background/llm/protocol-shared.js';

test('streaming whitespace fragments stay intact while completed calls use the next meaningful argument', () => {
  const call = { function: { name: ' collect ', arguments: '  ', input: { selector: 'main' } }, name: 'fallback' };
  assert.equal(normalizeToolCallName(call), 'collect');
  assert.deepEqual(getToolCallArgumentsValue(call), { selector: 'main' });
  assert.equal(getToolCallArgumentsValue(call, { allowWhitespaceOnly: true }), '  ');
  assert.deepEqual(getToolCallArgumentsValue({ function: { arguments: '' }, args: { limit: 0 } }, { allowWhitespaceOnly: true }), { limit: 0 });
});

test('compatibility spellings keep nested argument priority and preserve nonstring values', () => {
  assert.equal(normalizeToolCallName({ tool_name: ' read_file ' }), 'read_file');
  assert.equal(normalizeToolCallName(null), '');
  assert.equal(getToolCallArgumentsValue({ function: { arguments: null, arguments_json: false }, input: { ignored: true } }), false);
  assert.equal(getToolCallArgumentsValue({ parameters: 0 }), 0);
  assert.equal(getToolCallArgumentsValue({ arguments: ' \n ' }), undefined);
});
