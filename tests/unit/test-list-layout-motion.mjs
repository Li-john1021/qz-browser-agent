import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { createListLayoutMotion, createListExitTransition } from '../../src/sidepanel/ui/list-layout-motion.js';

function fixture() {
  const trace = [], timers = [], pending = [];
  globalThis.window = { setTimeout: callback => timers.push(callback) };
  const item = (id, top) => ({
    id, top, classes: new Set(),
    classList: { add(name) { this.owner.classes.add(name); }, remove(name) { this.owner.classes.delete(name); } },
    closest: () => null,
    getBoundingClientRect() { trace.push(`read:${id}`); return { left: 0, top: this.top }; },
    animate() {
      trace.push(`animate:${id}`);
      let resolve;
      const finished = new Promise(done => { resolve = done; });
      const animation = { finished, cancel() { resolve(); }, resolve };
      pending.push(animation);
      return animation;
    },
  });
  const items = [item('one', 10), item('two', 20)];
  for (const row of items) row.classList.owner = row;
  let reduced = false;
  const motion = createListLayoutMotion({ root: () => ({ querySelectorAll: () => items }), selector: '.row', key: row => row.id, reduceMotion: () => reduced });
  return { items, motion, trace, timers, pending, reduce: () => { reduced = true; } };
}

test('list motion measures all rows before any animation writes', () => {
  const { items, motion, trace } = fixture();
  const before = motion.capture();
  items.forEach(row => { row.top += 10; });
  trace.length = 0;
  motion.animate(before);
  assert.deepEqual(trace, ['read:one', 'read:two', 'animate:one', 'animate:two']);
});

test('late completion and fallback timer cannot clear a replacement animation', async () => {
  const { items, motion, timers, pending } = fixture();
  const before = motion.capture();
  items[0].top += 10;
  motion.animate(before);
  const middle = motion.capture();
  items[0].top += 10;
  motion.animate(middle);
  await setImmediate();
  timers[0]();
  assert.equal(items[0].classes.has('is-layout-moving'), true);
  pending.at(-1).resolve();
  await setImmediate();
  assert.equal(items[0].classes.has('is-layout-moving'), false);
});

test('settling cancels current animations; reduced motion performs no layout measurements', async () => {
  const { items, motion, trace, reduce } = fixture();
  const before = motion.capture();
  items[0].top += 10;
  motion.animate(before);
  motion.settle();
  await setImmediate();
  assert.equal(items[0].classes.size, 0);
  reduce();
  trace.length = 0;
  assert.equal(motion.capture().size, 0);
  motion.animate(before);
  assert.deepEqual(trace, []);
});

function exitFixture() {
  const timers = [], animations = [], classes = new Set();
  globalThis.window = {
    setTimeout(callback, delay) { timers.push({ callback, delay, cleared: false }); return timers.length; },
    clearTimeout(id) { if (timers[id - 1]) timers[id - 1].cleared = true; },
  };
  const node = {
    classList: { add: name => classes.add(name), remove: name => classes.delete(name) },
    animate(keyframes, options) {
      let resolve, reject;
      const finished = new Promise((done, fail) => { resolve = done; reject = fail; });
      const animation = { finished, keyframes, options, cancelled: false, resolve,
        cancel() { this.cancelled = true; reject(new Error('cancelled')); } };
      animations.push(animation);
      return animation;
    },
  };
  const create = () => createListExitTransition({ className: 'exiting', keyframes: [{ opacity: 1 }, { opacity: 0 }], duration: 160, easing: 'linear' });
  return { owner: create(), create, node, classes, animations, timers };
}

test('cancelled list exit cannot replace a repopulated list, even with a queued fallback', async () => {
  const { owner, node, classes, animations, timers } = exitFixture();
  let list = 'original';
  owner.start([node], () => { list = 'empty'; });
  assert.equal(classes.has('exiting'), true);
  owner.cancel();
  list = 'replacement';
  await setImmediate();
  timers[0].callback();
  assert.equal(list, 'replacement');
  assert.equal(animations[0].cancelled, true);
  assert.equal(timers[0].cleared, true);
  assert.equal(classes.has('exiting'), false);
});

test('old completion cannot finish a replacement exit; animation and timeout commit once', async () => {
  const { owner, node, animations, timers } = exitFixture();
  const commits = [];
  owner.start([node], () => commits.push('old'));
  owner.start([node], () => commits.push('new'));
  await setImmediate();
  timers[0].callback();
  assert.deepEqual(commits, []);
  animations[1].resolve();
  await setImmediate();
  timers[1].callback();
  assert.deepEqual(commits, ['new']);
  assert.equal(timers[1].cleared, true);
  assert.deepEqual(animations[1].options, { duration: 160, easing: 'linear', fill: 'forwards' });
});

test('independent list exits wait for all animations and recover through their own fallback', async () => {
  const { owner, create, node, animations, timers } = exitFixture();
  const second = create(), commits = [];
  owner.start([node, node], () => commits.push('first'));
  second.start([node], () => commits.push('second'));
  animations[0].resolve();
  await setImmediate();
  assert.deepEqual(commits, []);
  timers[1].callback();
  assert.deepEqual(commits, ['second']);
  animations[1].resolve();
  await setImmediate();
  assert.deepEqual(commits, ['second', 'first']);
  assert.equal(timers[0].delay, 260);
});

test('a list without WAAPI commits after preparation and clears its fallback', async () => {
  const { owner, node, timers } = exitFixture();
  delete node.animate;
  let committed = false;
  owner.start([node], () => { committed = true; });
  assert.equal(committed, false);
  await setImmediate();
  assert.equal(committed, true);
  assert.equal(timers[0].cleared, true);
});
