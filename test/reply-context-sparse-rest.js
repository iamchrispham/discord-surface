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

test('19: REST response with author.bot absent keeps the excerpt across a close and reopen', async t => {
  const { dir, db, state } = fixture();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let restCalls = 0;
  const consumer = consumerFor(state);
  const result = await consumer.handleMessage(gm({
    reference: { messageId: '900' },
    restGet: async () => { restCalls += 1; return validRaw('900', { author: { id: '900' } }); }
  }));
  assertAccepted(result, state);
  assert.equal(restCalls, 1);
  assert.equal(state.getMessage('1000').replyContext.excerpt, 'quoted text');
  state.close();

  const reopened = new SurfaceState(db);
  try {
    assert.deepEqual(reopened.getMessage('1000').replyContext, { ...validContext('900'), isBotAuthor: null });
  } finally {
    reopened.close();
  }
});

test('20: REST response with guild_id absent keeps the excerpt', async t => {
  const { dir, state } = fixture();
  t.after(() => cleanup(state, dir));
  let restCalls = 0;
  const consumer = consumerFor(state);
  const result = await consumer.handleMessage(gm({
    reference: { messageId: '900' },
    restGet: async () => {
      restCalls += 1;
      const raw = validRaw('900');
      delete raw.guild_id;
      return raw;
    }
  }));
  assertAccepted(result, state);
  assert.equal(restCalls, 1);
  assert.deepEqual(state.getMessage('1000').replyContext, { ...validContext('900'), isBotAuthor: null });
});

test('21: author.bot and guild_id both absent keep the excerpt and isBotAuthor follows the connected id', async t => {
  const main = fixture();
  t.after(() => cleanup(main.state, main.dir));
  const mainConsumer = consumerFor(main.state);
  const mainRaw = validRaw('900', { author: { id: '900' } });
  delete mainRaw.guild_id;
  const mainResult = await mainConsumer.handleMessage(gm({
    reference: { messageId: '900' },
    restGet: async () => mainRaw
  }));
  assertAccepted(mainResult, main.state);
  assert.equal(main.state.getMessage('1000').replyContext.excerpt, 'quoted text');

  // Separate fixture subcase: with both optional fields absent, isBotAuthor is
  // still derived from the connected bot id (never from author.bot).
  const subcase = fixture();
  t.after(() => cleanup(subcase.state, subcase.dir));
  const botConsumer = consumerFor(subcase.state, { agentBotId: '77' });
  const sameAuthorRaw = validRaw('900', { author: { id: '77' } });
  delete sameAuthorRaw.guild_id;
  const sameAuthor = await botConsumer.handleMessage(gm({
    id: '1000',
    reference: { messageId: '900' },
    restGet: async () => sameAuthorRaw
  }));
  assertAccepted(sameAuthor, subcase.state);
  assert.equal(subcase.state.getMessage('1000').replyContext.excerpt, 'quoted text');
  assert.equal(subcase.state.getMessage('1000').replyContext.isBotAuthor, true);

  const otherAuthorRaw = validRaw('901', { author: { id: '900' } });
  delete otherAuthorRaw.guild_id;
  const otherAuthor = await botConsumer.handleMessage(gm({
    id: '1001',
    reference: { messageId: '901' },
    restGet: async () => otherAuthorRaw
  }));
  assertAccepted(otherAuthor, subcase.state);
  assert.equal(subcase.state.getMessage('1001').replyContext.isBotAuthor, false);
});

test('22: a mismatching guild_id or a non-boolean author.bot rejects the excerpt with one REST attempt', async t => {
  const { dir, state } = fixture();
  t.after(() => cleanup(state, dir));
  const consumer = consumerFor(state);
  let cacheCalls = 0;
  let restCalls = 0;

  // Variant A: guild_id is present but does not match the expected guild.
  const mismatchedGuild = await consumer.handleMessage(gm({
    id: '1000',
    reference: { messageId: '900' },
    cacheGet: () => { cacheCalls += 1; return undefined; },
    restGet: async () => { restCalls += 1; return validRaw('900', { guild_id: '200' }); }
  }));
  assertAccepted(mismatchedGuild, state);
  assert.deepEqual(state.getMessage('1000').replyContext, { messageId: '900', channelId: '101', guildId: '100', excerpt: '', isBotAuthor: null });
  assert.doesNotMatch(messageRequest(state.getMessage('1000')), /quoted text/);
  assert.equal(restCalls, 1);
  assert.equal(cacheCalls, 1);

  // Variant B: author.bot is present but not a boolean.
  const nonBooleanBot = await consumer.handleMessage(gm({
    id: '1001',
    reference: { messageId: '901' },
    cacheGet: () => { cacheCalls += 1; return undefined; },
    restGet: async () => { restCalls += 1; return validRaw('901', { author: { id: '900', bot: 'yes' } }); }
  }));
  assertAccepted(nonBooleanBot, state);
  assert.deepEqual(state.getMessage('1001').replyContext, { messageId: '901', channelId: '101', guildId: '100', excerpt: '', isBotAuthor: null });
  assert.doesNotMatch(messageRequest(state.getMessage('1001')), /quoted text/);
  assert.equal(restCalls, 2);

  // One normal cache probe and exactly one REST attempt per rejected response,
  // with no retry or second lookup after the validator rejects.
  assert.equal(cacheCalls, 2);
});

