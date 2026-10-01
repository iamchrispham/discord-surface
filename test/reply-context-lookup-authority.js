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

test('5: 404 and 403 shaped REST rejections degrade to the preserved id', async t => {
  const { dir, state } = fixture();
  t.after(() => cleanup(state, dir));
  const consumer = consumerFor(state);
  const errors = [Object.assign(new Error('not found'), { status: 404 }), Object.assign(new Error('forbidden'), { status: 403 })];
  let calls = 0;
  for (const id of ['1000', '1001']) {
    const result = await consumer.handleMessage(gm({
      id,
      reference: { messageId: id === '1000' ? '900' : '901' },
      restGet: async () => { const error = errors[calls]; calls += 1; throw error; }
    }));
    assertAccepted(result, state);
    const context = state.getMessage(id).replyContext;
    assert.equal(context.messageId, id === '1000' ? '900' : '901');
    assert.equal(context.excerpt, '');
    assert.equal(context.isBotAuthor, null);
  }
  assert.equal(calls, 2);
});

test('6: ECONNRESET-shaped rejection degrades without throwing into intake', async t => {
  const { dir, state } = fixture();
  t.after(() => cleanup(state, dir));
  const consumer = consumerFor(state);
  const result = await consumer.handleMessage(gm({
    reference: { messageId: '900' },
    restGet: async () => { throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }); }
  }));
  assertAccepted(result, state);
  assert.deepEqual(state.getMessage('1000').replyContext, { messageId: '900', channelId: '101', guildId: '100', excerpt: '', isBotAuthor: null });
});

test('7: foreign guild and foreign channel preserve declared ids with zero lookups', async t => {
  const { dir, state } = fixture();
  t.after(() => cleanup(state, dir));
  let cacheCalls = 0;
  let restCalls = 0;
  const consumer = consumerFor(state);
  const foreignGuild = await consumer.handleMessage(gm({
    id: '1000',
    reference: { messageId: '900', guildId: '200' },
    cacheGet: () => { cacheCalls += 1; return undefined; },
    restGet: async () => { restCalls += 1; }
  }));
  const foreignChannel = await consumer.handleMessage(gm({
    id: '1001',
    reference: { messageId: '901', channelId: '202' },
    cacheGet: () => { cacheCalls += 1; return undefined; },
    restGet: async () => { restCalls += 1; }
  }));
  assertAccepted(foreignGuild, state);
  assertAccepted(foreignChannel, state);
  assert.equal(cacheCalls, 0);
  assert.equal(restCalls, 0);
  assert.deepEqual(state.getMessage('1000').replyContext, { messageId: '900', channelId: '101', guildId: '200', excerpt: '', isBotAuthor: null });
  assert.deepEqual(state.getMessage('1001').replyContext, { messageId: '901', channelId: '202', guildId: '100', excerpt: '', isBotAuthor: null });
});

test('8: a stale cache entry is not quoted and falls through to REST', async t => {
  const { dir, state } = fixture();
  t.after(() => cleanup(state, dir));
  let restCalls = 0;
  const consumer = consumerFor(state);
  const result = await consumer.handleMessage(gm({
    reference: { messageId: '900' },
    cacheGet: () => ({ id: '999', channelId: '101', guildId: '100', content: 'stale cached text', author: { id: '900', bot: false } }),
    restGet: async () => { restCalls += 1; throw Object.assign(new Error('gone'), { status: 404 }); }
  }));
  assertAccepted(result, state);
  assert.equal(restCalls, 1);
  const stored = state.getMessage('1000');
  assert.equal(stored.replyContext.excerpt, '');
  assert.doesNotMatch(messageRequest(stored), /stale cached text/);
});

test('9: excerpt truncates on code-point boundaries and bot authorship needs the exact id', async t => {
  const { dir, state } = fixture();
  t.after(() => cleanup(state, dir));
  const long = 'a'.repeat(299) + '😀' + 'tail';
  const consumer = consumerFor(state, { agentBotId: '77' });
  const result = await consumer.handleMessage(gm({
    reference: { messageId: '900' },
    cacheGet: id => cacheEntry(id, { content: long, author: { id: '123', bot: true } })
  }));
  assertAccepted(result, state);
  const context = state.getMessage('1000').replyContext;
  assert.equal(Array.from(context.excerpt).length, 300);
  assert.equal(context.excerpt.endsWith('😀'), true);
  assert.equal(context.excerpt.includes('\uFFFD'), false);
  assert.doesNotMatch(context.excerpt, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  assert.equal(context.isBotAuthor, false);
});

