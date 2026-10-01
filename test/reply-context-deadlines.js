'use strict';

// Reply-context behavior: normalization/persistence/hydration (T3) plus the
// bounded optional Discord lookup (T2), driven only through public entrypoints
// with disposable SQLite files and simulated Gateway/REST objects.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { SurfaceState } = require('../src/state');
const { messageRequest, codexPrompt, claudeEvent } = require('../src/native');
const { createSurfaceConsumer } = require('../src/discord');
const { createMonitorMcp } = require('../src/claude-monitor');
const { THREAD_STATES } = require('../src/state/thread-enrollment');
const { WATCHER_NOTICE_PREFIX, createWatcherNotice } = require('../src/watcher-notice');
const { encodeAgentMessage, KINDS } = require('../src/agent-message');
const { Routes } = require('discord.js');

const { CODEX_ID, CLAUDE_ID, AGENT_TOKEN, fixture, cleanup, providers, consumerFor, gm, cacheEntry, validRaw, validContext, assertAccepted, waitFor, withTimeout, tick } = require('./reply-context-fixture');

test('10: a pre-aborted signal and an already-past deadline degrade with zero lookups', async t => {
  const { dir, state } = fixture();
  t.after(() => cleanup(state, dir));
  let cacheCalls = 0;
  let restCalls = 0;
  const abort = new AbortController();
  abort.abort();
  const consumer = consumerFor(state);
  const aborted = await consumer.handleMessage(gm({
    id: '1000',
    reference: { messageId: '900' },
    cacheGet: () => { cacheCalls += 1; return undefined; },
    restGet: async () => { restCalls += 1; }
  }), abort.signal);
  const expired = await consumer.intakeMessage(gm({
    id: '1001',
    reference: { messageId: '901' },
    cacheGet: () => { cacheCalls += 1; return undefined; },
    restGet: async () => { restCalls += 1; }
  }), true, null, null, false, undefined, Date.now() - 1);
  assertAccepted(aborted, state);
  assertAccepted(expired, state);
  assert.equal(cacheCalls, 0);
  assert.equal(restCalls, 0);
  assert.deepEqual(state.getMessage('1000').replyContext, { messageId: '900', channelId: '101', guildId: '100', excerpt: '', isBotAuthor: null });
  assert.deepEqual(state.getMessage('1001').replyContext, { messageId: '901', channelId: '101', guildId: '100', excerpt: '', isBotAuthor: null });
});

test('11: parent abort settles degraded, aborts the private signal, and swallows the late rejection', { timeout: 5000 }, async t => {
  const { dir, state } = fixture();
  t.after(() => cleanup(state, dir));
  const unhandled = [];
  const onUnhandled = error => unhandled.push(error);
  process.on('unhandledRejection', onUnhandled);
  t.after(() => process.off('unhandledRejection', onUnhandled));
  let privateSignal;
  let rejectRest;
  const consumer = consumerFor(state);
  const controller = new AbortController();
  const pending = consumer.handleMessage(gm({
    reference: { messageId: '900' },
    restGet: async (route, options) => { privateSignal = options.signal; return new Promise((_, reject) => { rejectRest = reject; }); }
  }), controller.signal);
  await waitFor(() => privateSignal !== undefined && rejectRest !== undefined);
  controller.abort();
  const result = await withTimeout(pending, 2000, 'intake hung after parent abort');
  assertAccepted(result, state);
  assert.equal(privateSignal.aborted, true);
  assert.deepEqual(state.getMessage('1000').replyContext, { messageId: '900', channelId: '101', guildId: '100', excerpt: '', isBotAuthor: null });
  rejectRest(Object.assign(new Error('late rest failure'), { status: 500 }));
  await tick();
  await tick();
  assert.deepEqual(unhandled, []);
});

test('12: budget expiry while REST hangs aborts the private signal without a hang', { timeout: 5000 }, async t => {
  const { dir, state } = fixture();
  t.after(() => cleanup(state, dir));
  let privateSignal;
  let rejectRest;
  const consumer = consumerFor(state, { agentAttachmentTimeoutMs: 80 });
  const started = Date.now();
  const result = await withTimeout(consumer.handleMessage(gm({
    reference: { messageId: '900' },
    restGet: async (route, options) => { privateSignal = options.signal; return new Promise((_, reject) => { rejectRest = reject; }); }
  })), 2000, 'intake hung past the fixture budget');
  const elapsed = Date.now() - started;
  assertAccepted(result, state);
  assert.ok(elapsed >= 40 && elapsed < 1000, `unexpected settle latency ${elapsed}ms`);
  assert.equal(privateSignal.aborted, true);
  assert.equal(state.getMessage('1000').replyContext.excerpt, '');
  rejectRest(Object.assign(new Error('late rest failure'), { code: 'ECONNRESET' }));
  await tick();
});

test('13: a deadline shorter than timeoutMs settles at the deadline and removes listeners', { timeout: 5000 }, async t => {
  const { dir, state } = fixture();
  t.after(() => cleanup(state, dir));
  let privateSignal;
  let rejectRest;
  const consumer = consumerFor(state, { agentAttachmentTimeoutMs: 5000 });
  const controller = new AbortController();
  let adds = 0;
  let removes = 0;
  const originalAdd = controller.signal.addEventListener.bind(controller.signal);
  const originalRemove = controller.signal.removeEventListener.bind(controller.signal);
  Object.defineProperty(controller.signal, 'addEventListener', {
    value: (...args) => { adds += 1; return originalAdd(...args); }
  });
  Object.defineProperty(controller.signal, 'removeEventListener', {
    value: (...args) => { removes += 1; return originalRemove(...args); }
  });
  const started = Date.now();
  // Capture the budget timer the production lookup schedules and the
  // clearTimeout calls made while settling. Only bounded-delay handles are the
  // reply-context budget timer; withTimeout's own 2000ms guard is excluded.
  const realSetTimeout = global.setTimeout;
  const realClearTimeout = global.clearTimeout;
  const budgetTimers = [];
  const clearedTimers = new Set();
  global.setTimeout = (callback, delay, ...args) => {
    const handle = realSetTimeout(callback, delay, ...args);
    if (typeof delay === 'number' && delay >= 1 && delay <= 500) budgetTimers.push(handle);
    return handle;
  };
  global.clearTimeout = handle => {
    clearedTimers.add(handle);
    return realClearTimeout(handle);
  };
  let result;
  try {
    result = await withTimeout(consumer.intakeMessage(gm({
      reference: { messageId: '900' },
      restGet: async (route, options) => { privateSignal = options.signal; return new Promise((_, reject) => { rejectRest = reject; }); }
    }), true, null, null, false, controller.signal, Date.now() + 80), 2000, 'intake hung past the deadline');
  } finally {
    global.setTimeout = realSetTimeout;
    global.clearTimeout = realClearTimeout;
  }
  const elapsed = Date.now() - started;
  assertAccepted(result, state);
  assert.ok(elapsed >= 40 && elapsed < 1000, `unexpected settle latency ${elapsed}ms`);
  assert.equal(privateSignal.aborted, true);
  assert.ok(adds >= 1, 'relay listener was never registered');
  assert.equal(removes, adds, 'relay listener was not removed');
  assert.ok(budgetTimers.length >= 1, 'the budget timer was never scheduled');
  for (const handle of budgetTimers) {
    assert.ok(clearedTimers.has(handle), 'budget timer handle was not cleared after settlement');
  }
  rejectRest(Object.assign(new Error('late rest failure'), { status: 503 }));
  await tick();
});

test('14: an invalid reference id and non-positive or non-finite budgets make no network call', async t => {
  const { dir, state } = fixture();
  t.after(() => cleanup(state, dir));
  let cacheCalls = 0;
  let restCalls = 0;
  const lookups = {
    cacheGet: () => { cacheCalls += 1; return undefined; },
    restGet: async () => { restCalls += 1; }
  };
  const consumer = consumerFor(state, { agentAttachmentTimeoutMs: 0 });
  const invalidId = await consumer.handleMessage(gm({ id: '1000', reference: { messageId: 'abc' }, ...lookups }));
  assertAccepted(invalidId, state);
  assert.equal(state.getMessage('1000').replyContext, undefined);

  const started = Date.now();
  const zero = await consumerFor(state, { agentAttachmentTimeoutMs: 0 }).handleMessage(gm({ id: '1001', reference: { messageId: '900' }, ...lookups }));
  const negative = await consumerFor(state, { agentAttachmentTimeoutMs: -5 }).handleMessage(gm({ id: '1002', reference: { messageId: '901' }, ...lookups }));
  const nonFinite = await consumerFor(state, { agentAttachmentTimeoutMs: NaN }).handleMessage(gm({ id: '1003', reference: { messageId: '902' }, ...lookups }));
  assertAccepted(zero, state);
  assertAccepted(negative, state);
  assertAccepted(nonFinite, state);
  assert.ok(Date.now() - started < 1000, 'degenerate budgets should not wait');
  assert.equal(cacheCalls, 0);
  assert.equal(restCalls, 0);
  for (const id of ['1001', '1002', '1003']) assert.equal(state.getMessage(id).replyContext.excerpt, '');
});

