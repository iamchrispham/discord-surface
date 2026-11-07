'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { waitForFileAsync } = require('./helpers/claude-terminal-election.cjs');

function fixture(t, expectedTimerCount = 1) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'election-gate-'));
  const originalClear = globalThis.clearTimeout;
  const scheduled = t.mock.method(globalThis, 'setTimeout');
  const cleared = t.mock.method(globalThis, 'clearTimeout');
  t.after(() => {
    const timers = scheduled.mock.calls.filter(call => call.arguments[1] === 20);
    try {
      assert.equal(timers.length, expectedTimerCount);
      for (const call of timers) {
        assert.ok(cleared.mock.calls.some(clear => clear.arguments[0] === call.result));
      }
    } finally {
      for (const call of timers) originalClear(call.result);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  const watcher = new EventEmitter();
  let closes = 0;
  watcher.close = () => { closes += 1; };
  return { dir, file: path.join(dir, 'release'), watcher, closes: () => closes };
}

test('an existing release needs no watcher', { timeout: 1000 }, async t => {
  const f = fixture(t, 0);
  fs.writeFileSync(f.file, '1');
  t.mock.method(fs, 'watch', () => assert.fail('existing release must not arm a watcher'));
  await waitForFileAsync(f.dir, 'release', 20);
});

test('release publication survives missing watch callbacks', { timeout: 1000 }, async t => {
  const f = fixture(t);
  t.mock.method(fs, 'watch', () => f.watcher);
  const pending = waitForFileAsync(f.dir, 'release', 20);
  fs.writeFileSync(f.file, '1');
  await pending;
  assert.equal(f.closes(), 1);
});

test('publication during watcher registration resolves immediately', { timeout: 1000 }, async t => {
  const f = fixture(t);
  t.mock.method(fs, 'watch', () => { fs.writeFileSync(f.file, '1'); return f.watcher; });
  const pending = waitForFileAsync(f.dir, 'release', 20);
  try {
    assert.equal(f.closes(), 1);
    await pending;
  } finally {
    await pending.catch(() => {});
  }
});

test('an absent release rejects and closes its watcher', { timeout: 1000 }, async t => {
  const f = fixture(t);
  t.mock.method(fs, 'watch', () => f.watcher);
  await assert.rejects(waitForFileAsync(f.dir, 'release', 20), /gate timeout/);
  assert.equal(fs.existsSync(f.file), false);
  assert.equal(f.closes(), 1);
});

test('watcher creation failure rejects without a surviving timer', { timeout: 1000 }, async t => {
  const f = fixture(t);
  const error = new Error('watch unavailable');
  t.mock.method(fs, 'watch', () => { throw error; });
  await assert.rejects(waitForFileAsync(f.dir, 'release', 20), value => value === error);
});

test('watcher errors reject and close the active watcher', { timeout: 1000 }, async t => {
  const f = fixture(t);
  const error = new Error('watch failed');
  t.mock.method(fs, 'watch', () => f.watcher);
  const pending = waitForFileAsync(f.dir, 'release', 20);
  f.watcher.emit('error', error);
  await assert.rejects(pending, value => value === error);
  assert.equal(f.closes(), 1);
});

test('watcher close failures reject instead of claiming completion', { timeout: 1000 }, async t => {
  const f = fixture(t);
  const error = new Error('watch close failed');
  f.watcher.close = () => { throw error; };
  t.mock.method(fs, 'watch', () => { fs.writeFileSync(f.file, '1'); return f.watcher; });
  await assert.rejects(waitForFileAsync(f.dir, 'release', 20), value => value === error);
});

test('watcher close failures preserve the asynchronous error', { timeout: 1000 }, async t => {
  const f = fixture(t);
  const error = new Error('watch failed');
  f.watcher.close = () => { throw new Error('watch close failed'); };
  t.mock.method(fs, 'watch', () => f.watcher);
  const pending = waitForFileAsync(f.dir, 'release', 20);
  f.watcher.emit('error', error);
  await assert.rejects(pending, value => value === error);
});

test('watcher close failures reject asynchronous publication', { timeout: 1000 }, async t => {
  const f = fixture(t);
  const error = new Error('watch close failed');
  let onEvent;
  f.watcher.close = () => { throw error; };
  t.mock.method(fs, 'watch', (dir, callback) => { onEvent = callback; return f.watcher; });
  const pending = waitForFileAsync(f.dir, 'release', 20);
  fs.writeFileSync(f.file, '1');
  onEvent();
  await assert.rejects(pending, value => value === error);
});
