'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./helpers/intake-recovery-fixture');

const flush = () => new Promise(resolve => setImmediate(resolve));

function seedSubmitted(f, id = '101', channelId = '1000') {
  const message = f.message(id, channelId);
  assert.equal(f.state.acceptDiscordMessage({ ...message, authorId: 'operator', isBot: false }).accepted, true);
  assert.equal(f.state.claimDispatch(id).claimed, true);
  assert.equal(f.state.markSubmitted(id).state, 'submitted');
}

function recordSavedReply(f, id = '101') {
  const stored = f.state.getMessage(id);
  return f.state.recordNativeReply({
    provider: stored.provider,
    messageId: stored.id,
    nativeId: stored.nativeId,
    generation: stored.generation,
    text: 'saved reply'
  });
}

// Drives the real recovery pass to the first deferred observation and captures
// the exact predicate plus the single controlled unresolved channel lookup.
function deferredObservation(f) {
  seedSubmitted(f);
  f.gateway.recoveryTimeoutMs = 30;
  f.gateway.sendAcknowledgment = async () => {};
  const calls = [];
  const originalReconcile = f.gateway.reconcilePending.bind(f.gateway);
  f.gateway.reconcilePending = (before, options = {}) => {
    calls.push({ before, messageIds: options.messageIds ?? null });
    return originalReconcile(before, options);
  };
  const captured = {};
  f.gateway.consumer.resumeSubmitted = (message, signal, options = {}) => {
    captured.message = message;
    captured.signal = signal;
    captured.deferReply = options.deferReply;
    return { status: 'observing' };
  };
  let resolveFetch;
  const pending = new Promise(resolve => { resolveFetch = resolve; });
  let fetchCount = 0;
  const channel = f.channels.get('1000');
  f.gateway.client.channels.fetch = id => {
    fetchCount += 1;
    assert.equal(id, '1000');
    return pending;
  };
  const recovery = f.gateway.reconcilePending(undefined, { allowPaused: true, readyOnly: true });
  return { calls, captured, resolveFetch, channel, recovery, fetchCount: () => fetchCount };
}

test('deferred submitted observation waits for a genuine settlement', { timeout: 2000 }, async t => {
  const f = fixture(t);
  const d = deferredObservation(f);
  await flush();
  assert.equal(typeof d.captured.deferReply, 'function');
  assert.equal(typeof d.resolveFetch, 'function');
  assert.equal(d.calls.length, 1);

  // A still-SUBMITTED observation is deferred but must not schedule a continuation.
  assert.equal(d.captured.deferReply(), true);
  await flush();
  assert.equal(d.calls.length, 1, 'a submitted observation must not schedule a continuation');
  assert.equal(f.dispatched.length, 0);
  assert.equal(f.replies.length, 0);

  d.resolveFetch(d.channel);
  await d.recovery;
  await flush();
  if (f.gateway.recoveryPromise) await f.gateway.recoveryPromise.catch(() => {});
  assert.equal(f.state.getMessage('101').state, 'submitted');
  assert.equal(f.replies.length, 0);
  assert.equal(f.dispatched.length, 0);
});

test('deferred reply-ready observation schedules one continuation', { timeout: 2000 }, async t => {
  const f = fixture(t);
  const d = deferredObservation(f);
  await flush();
  assert.equal(typeof d.captured.deferReply, 'function');

  assert.equal(recordSavedReply(f).message.state, 'reply_ready');
  assert.equal(d.captured.deferReply(), true);
  await flush();
  assert.equal(d.calls.length, 2, 'reply custody must schedule exactly one continuation');
  assert.deepEqual(d.calls[1].messageIds, ['101']);

  d.resolveFetch(d.channel);
  await d.recovery;
  await flush();
  if (f.gateway.recoveryPromise) await f.gateway.recoveryPromise.catch(() => {});
  await flush();
  assert.equal(f.state.getMessage('101').state, 'replied');
  assert.equal(f.replies.length, 1, 'exactly one reply may be committed');
  assert.equal(f.dispatched.length, 0);
});

test('deferred observation cannot schedule after gateway stop', { timeout: 2000 }, async t => {
  const f = fixture(t);
  const d = deferredObservation(f);
  await flush();
  assert.equal(typeof d.captured.deferReply, 'function');

  assert.equal(recordSavedReply(f).message.state, 'reply_ready');
  await f.gateway.stop();
  const aborted = await d.recovery;
  assert.ok(Array.isArray(aborted));
  assert.equal(d.captured.signal.aborted, true, 'cancellation must be owned by the captured abort signal');

  assert.equal(d.captured.deferReply(), true);
  await flush();
  assert.equal(d.calls.length, 1, 'a stopped gateway must not start another pass');
  assert.equal(f.replies.length, 0);
  assert.equal(f.dispatched.length, 0);
  assert.equal(f.state.getMessage('101').state, 'reply_ready');

  d.resolveFetch(d.channel);
  await flush();
  assert.equal(d.fetchCount(), 1);
  assert.equal(d.calls.length, 1);
  assert.equal(f.replies.length, 0);
  assert.equal(f.dispatched.length, 0);
});
