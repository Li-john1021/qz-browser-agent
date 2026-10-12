import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkspaceExtensions } from '../../src/sidepanel/features/app/workspace-extensions.js';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('independent packages contribute commands, references and transcript views through the same slots', async () => {
  const extensions = createWorkspaceExtensions();
  const lifetime = new AbortController();
  extensions.register({
    commands: [{ id: 'notebook.open', run: value => `opened:${value}` }],
    references: [{ id: 'notebook', label: '笔记', list: async () => [{ kind: 'notebook', name: 'one', title: 'One', label: 'One', priority: 0, subtitle: '', meta: '', search: 'one' }] }],
    transcript: [{ id: 'notebook-result', project: entries => [...entries, { type: 'notebook-result', text: 'Note' }], preview: entry => entry.text }],
  }, lifetime.signal);
  assert.equal(extensions.invoke('notebook.open', 'one'), 'opened:one');
  assert.equal((await extensions.listReferences())[0].kind, 'notebook');
  const projected = extensions.projectTranscript([{ type: 'assistant', content: 'Answer' }], 'session');
  assert.equal(extensions.previewTranscript(projected[1]), 'Note');
  lifetime.abort();
  assert.equal(extensions.invoke('notebook.open', 'one'), undefined);
  assert.deepEqual(await extensions.listReferences(), []);
  assert.deepEqual(extensions.projectTranscript([], 'session'), []);
});

test('duplicate registrations fail atomically and cannot remove the existing owner', () => {
  const extensions = createWorkspaceExtensions();
  const first = new AbortController();
  const second = new AbortController();
  extensions.register({ commands: [{ id: 'same', run: () => 'first' }] }, first.signal);
  assert.throws(() => extensions.register({
    commands: [{ id: 'different', run: () => 'second' }],
    references: [{ id: 'duplicate' }, { id: 'duplicate' }],
  }, second.signal), /Duplicate/);
  assert.equal(extensions.hasCommand('different'), false);
  assert.throws(() => extensions.register({ commands: [{ id: 'same', run: () => 'second' }] }, second.signal), /Duplicate/);
  second.abort();
  assert.equal(extensions.invoke('same'), 'first');
});

test('registry owns immutable identity and old disposal never removes a replacement', () => {
  const extensions = createWorkspaceExtensions();
  const lifetime = new AbortController();
  const command = { id: 'original', run: () => 'original' };
  const contribution = { commands: [command] };
  const dispose = extensions.register(contribution, lifetime.signal);
  command.id = 'changed'; command.run = () => 'changed'; contribution.commands.length = 0;
  assert.equal(extensions.invoke('original'), 'original');
  dispose();
  const next = new AbortController();
  extensions.register({ commands: [{ id: 'original', run: () => 'replacement' }] }, next.signal);
  lifetime.abort(); dispose();
  assert.equal(extensions.invoke('original'), 'replacement');
});

test('a late reference response from an unmounted package cannot replace the new source', async () => {
  const extensions = createWorkspaceExtensions();
  const pending = deferred();
  const old = new AbortController();
  extensions.register({ references: [{ id: 'notes', label: 'Old', list: () => pending.promise }] }, old.signal);
  const result = extensions.listReferences();
  old.abort();
  extensions.register({ references: [{ id: 'notes', label: 'New', list: async () => [{ name: 'new' }] }] }, new AbortController().signal);
  pending.resolve([{ name: 'stale' }]);
  assert.deepEqual(await result, []);
  assert.deepEqual(await extensions.listReferences(), [{ name: 'new' }]);
});

test('one rejected listener or renderer cannot block sibling UI contributions', async () => {
  const errors = [];
  const extensions = createWorkspaceExtensions(error => errors.push(error.message));
  const lifetime = new AbortController();
  const observed = [];
  extensions.onEvent(() => { throw new Error('sync'); }, lifetime.signal);
  extensions.onEvent(async () => { throw new Error('async'); }, lifetime.signal);
  extensions.onEvent(event => observed.push(event.type), lifetime.signal);
  extensions.register({ transcript: [{ id: 'broken', project() { throw new Error('projection'); } }] }, lifetime.signal);
  extensions.notify({ type: 'accepted' });
  assert.deepEqual(extensions.projectTranscript([{ type: 'assistant' }], 'session'), [{ type: 'assistant' }]);
  await Promise.resolve();
  assert.deepEqual(observed, ['accepted']);
  assert.deepEqual(errors.sort(), ['async', 'projection', 'sync']);
  lifetime.abort(); extensions.notify({ type: 'late' });
  assert.deepEqual(observed, ['accepted']);
});

test('local UI notifications isolate nested payloads and recover after invalid values', () => {
  const errors = [], observed = [];
  const extensions = createWorkspaceExtensions(error => errors.push(error));
  const lifetime = new AbortController();
  let first;
  extensions.onEvent(event => {
    first = event;
    event.detail.values.push('corrupted');
  }, lifetime.signal);
  extensions.onEvent(event => observed.push(event), lifetime.signal);
  const original = { type: 'ui_custom', detail: { values: ['retained'] } };
  extensions.notify(original);
  assert.equal(first, observed[0]);
  assert.notEqual(observed[0], original);
  assert.deepEqual(original.detail.values, ['retained']);
  assert.deepEqual(observed[0].detail.values, ['retained']);
  assert.equal(errors.length, 1);
  for (const invalid of [() => {}, new Map([['a', 1]]), new Uint8Array([1])]) {
    assert.doesNotThrow(() => extensions.notify({ type: 'ui_custom', detail: invalid }));
  }
  assert.equal(observed.length, 1, 'non-data payloads are not partially dispatched');
  extensions.notify(original);
  assert.equal(observed.length, 2);
  assert.equal(errors.length, 5);
  lifetime.abort();
});
