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

test('23: rejected intake skips optional reply lookup before the transaction', async t => {
  const { dir, state } = fixture();
  t.after(() => cleanup(state, dir));
  const consumer = consumerFor(state);
  let restCalls = 0;

  const unauthorized = await consumer.handleMessage(gm({
    id: '1000', authorId: '901', reference: { messageId: '900' },
    restGet: async () => { restCalls += 1; return validRaw('900'); }
  }));
  assert.equal(unauthorized.reason, 'unauthorized-sender');
  assert.equal(restCalls, 0);

  const binding = state.getBinding('101');
  const staleBinding = { ...binding, generation: binding.generation + 1 };
  const stale = await consumer.handleMessage(gm({
    id: '1001', reference: { messageId: '901' },
    restGet: async () => { restCalls += 1; return validRaw('901'); }
  }), undefined, staleBinding);
  assert.equal(stale.reason, 'stale-binding');
  assert.equal(restCalls, 0);

  const beforeCutoff = await consumer.handleMessage(gm({
    id: '40', reference: { messageId: '902' },
    restGet: async () => { restCalls += 1; return validRaw('902'); }
  }));
  assert.equal(beforeCutoff.reason, 'before-intake-cutoff');
  assert.equal(restCalls, 0);

  const accepted = await consumer.intakeMessage(gm({ id: '1002' }), true);
  assertAccepted(accepted, state);
  const duplicate = await consumer.intakeMessage(gm({
    id: '1002', reference: { messageId: '903' },
    restGet: async () => { restCalls += 1; return validRaw('903'); }
  }), true);
  assert.equal(duplicate.reason, 'duplicate-message');
  assert.equal(restCalls, 0);
});

test('ordinary handoff pause preserves reply context for an accepted enrolled reply', async t => {
  const { dir, state } = fixture();
  t.after(() => cleanup(state, dir));
  const childNativeId = '33333333-3333-3333-3333-333333333333';
  state.bind({ channelId: '102', guildId: '100', provider: 'codex', nativeId: childNativeId, workspace: dir }, { intakeCutoff: '100' });
  let parent = state.getBinding('102');
  parent = state.setBindingReadiness('102', 'ready', 'fixture', parent) || parent;
  state.enrollThread({ threadId: '103', parentChannelId: '102', guildId: '100', adoptionCutoff: '100' }, parent);
  state.setThreadBaseline('103', '100', parent);
  state.markThreadBoundary('103', THREAD_STATES.READY, 'fixture', null, null, parent);
  state.pauseOrdinaryHandoffIntake('102', parent);

  const consumer = consumerFor(state);
  let cacheCalls = 0;
  const pausedParent = await consumer.intakeMessage(gm({
    id: '150', channelId: '102', reference: { messageId: '900' },
    cacheGet: () => { cacheCalls += 1; return cacheEntry('900', { channelId: '102' }); }
  }), true);
  assert.equal(pausedParent.reason, 'handoff-intake-paused');
  assert.equal(cacheCalls, 0);

  const heldChild = await consumer.intakeMessage(gm({
    id: '151', channelId: '103', reference: { messageId: '901' },
    cacheGet: id => {
      cacheCalls += 1;
      return cacheEntry(id, { channelId: '103', content: 'child question' });
    }
  }), true);
  assert.equal(heldChild.accepted, true);
  assert.equal(heldChild.message.channelId, '102');
  assert.equal(heldChild.message.deliveryChannelId, '103');
  assert.deepEqual(state.getMessage('151').replyContext, {
    messageId: '901', channelId: '103', guildId: '100', excerpt: 'child question', isBotAuthor: null
  });
  assert.equal(cacheCalls, 1);
});

test('an enrolled child without a recovery cursor ignores the parent watermark', async t => {
  const { dir, state } = fixture();
  t.after(() => cleanup(state, dir));
  const childNativeId = '33333333-3333-3333-3333-333333333333';
  state.bind({ channelId: '102', guildId: '100', provider: 'codex', nativeId: childNativeId, workspace: dir }, { intakeCutoff: '100' });
  let parent = state.getBinding('102');
  parent = state.setBindingReadiness('102', 'ready', 'fixture', parent) || parent;
  state.enrollThread({ threadId: '103', parentChannelId: '102', guildId: '100', adoptionCutoff: '100' }, parent);
  state.setThreadBaseline('103', '100', parent);
  state.markThreadBoundary('103', THREAD_STATES.READY, 'fixture', null, null, parent);
  state.db.prepare('UPDATE thread_enrollments SET recovered_through_id=NULL WHERE thread_id=?').run('103');
  assert.equal(state.getThreadEnrollment('103').recoveredThroughId, null);

  const consumer = consumerFor(state, { readyForLiveIntake: () => false });
  let cacheCalls = 0;
  const accepted = await consumer.handleMessage(gm({
    id: '100', channelId: '103', reference: { messageId: '901' },
    cacheGet: id => {
      cacheCalls += 1;
      return cacheEntry(id, { channelId: '103', content: 'child question' });
    }
  }));
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.held, true);
  assert.deepEqual(state.getMessage('100').replyContext, {
    messageId: '901', channelId: '103', guildId: '100', excerpt: 'child question', isBotAuthor: null
  });
  assert.equal(cacheCalls, 1);
});

test('24: an authorized human watcher-looking reply keeps its context', async t => {
  const { dir, state } = fixture();
  t.after(() => cleanup(state, dir));
  const consumer = consumerFor(state);
  const result = await consumer.handleMessage(gm({
    content: `${WATCHER_NOTICE_PREFIX}raw watcher payload`,
    reference: { messageId: '900' },
    cacheGet: id => cacheEntry(id, { content: 'quoted watcher discussion' }),
    restGet: async () => { throw new Error('cache hit must not reach REST'); }
  }));
  assertAccepted(result, state);
  assert.equal(state.getMessage('1000').replyContext.excerpt, 'quoted watcher discussion');
});
