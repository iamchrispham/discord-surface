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

test('15: duplicate delivery with a different second context retains the first persisted context', async t => {
  const { dir, state } = fixture();
  t.after(() => cleanup(state, dir));
  const consumer = consumerFor(state);
  const first = await consumer.handleMessage(gm({
    id: '1000',
    reference: { messageId: '900' },
    restGet: async () => validRaw('900', { content: 'first context' })
  }));
  const second = await consumer.handleMessage(gm({
    id: '1000',
    reference: { messageId: '901' },
    restGet: async () => validRaw('901', { content: 'second context' })
  }));
  assertAccepted(first, state);
  assert.equal(second.duplicate, true);
  assert.equal(state.getMessage('1000').replyContext.messageId, '900');
  assert.equal(state.getMessage('1000').replyContext.excerpt, 'first context');
  assert.doesNotMatch(messageRequest(state.getMessage('1000')), /second context/);
});

test('16: an earliest malformed accepted receipt is never replaced by a forged later one', async t => {
  const { dir, state } = fixture();
  t.after(() => cleanup(state, dir));
  const consumer = consumerFor(state);
  await consumer.handleMessage(gm({
    id: '1000',
    reference: { messageId: '900' },
    restGet: async () => validRaw('900', { content: 'original context' })
  }));
  const earliest = state.db.prepare("SELECT id FROM receipts WHERE discord_id='1000' AND kind='accepted' ORDER BY id LIMIT 1").get();
  state.db.prepare('UPDATE receipts SET detail=? WHERE id=?')
    .run(JSON.stringify({ channelId: '101', replyContext: '{malformed' }), earliest.id);
  state.receipt('1000', 'accepted', { channelId: '101', replyContext: JSON.stringify(validContext('901', { excerpt: 'forged later' })) });
  const stored = state.getMessage('1000');
  assert.equal(stored.replyContext, undefined);
  assert.doesNotMatch(messageRequest(stored), /forged later/);

  // A VALID context stored in the earliest accepted receipt under a channelId
  // that differs from the message's own channel is out of scope and must be
  // omitted by the hydration channel check (not by parse failure).
  const mismatched = await consumer.handleMessage(gm({
    id: '1001',
    reference: { messageId: '902' },
    restGet: async () => validRaw('902', { content: 'scoped context' })
  }));
  assertAccepted(mismatched, state);
  assert.equal(state.getMessage('1001').replyContext.messageId, '902');
  const scoped = state.db.prepare("SELECT id FROM receipts WHERE discord_id='1001' AND kind='accepted' ORDER BY id LIMIT 1").get();
  state.db.prepare('UPDATE receipts SET detail=? WHERE id=?')
    .run(JSON.stringify({ channelId: '777', replyContext: JSON.stringify(validContext('902', { channelId: '777', excerpt: 'out of scope' })) }), scoped.id);
  const scopedMessage = state.getMessage('1001');
  assert.equal(scopedMessage.replyContext, undefined, 'valid context under a mismatched channelId must be omitted');
  assert.doesNotMatch(messageRequest(scopedMessage), /out of scope/);
});

test('17: agent, watcher, and decision kinds never read reply context and render byte-identical', async t => {
  const { dir, state } = fixture();
  t.after(() => cleanup(state, dir));
  const context = validContext('900');
  const base = { id: 'x', channelId: '101', guildId: '100', provider: 'codex', nativeId: CODEX_ID, generation: 1, workspace: dir, content: 'carrier', attachments: [], state: 'accepted' };
  const agentMessage = {
    id: 'agent-request', kind: KINDS.REQUEST,
    source: { guildId: '100', channelId: '111', provider: 'claude', nativeId: CLAUDE_ID, generation: 1 },
    target: { guildId: '100', channelId: '101', provider: 'codex', nativeId: CODEX_ID, generation: 1 },
    replyTo: null, text: 'inspect the implementation'
  };
  const watcherNotice = createWatcherNotice({
    armKey: 'arm-1', triggerKey: 'trigger-1',
    source: { guildId: '100', channelId: '101', provider: 'claude', nativeId: CLAUDE_ID, generation: 1 },
    target: { guildId: '100', channelId: '102', provider: 'claude', nativeId: CLAUDE_ID, generation: 1 },
    text: 'watcher data'
  });
  const decisionResult = {
    qid: 'qid:1', questionGeneration: 'generation:1', target: 'discord:100/101', canonicalSource: 'history',
    canonicalReference: 'history://answer/1', answer: 'promote', questionMessageId: 'question-1',
    interactionId: 'interaction-1', selectedKey: 'yes'
  };
  const twins = [
    [{ ...base, agentMessage }, { ...base, agentMessage, replyContext: context }],
    [{ ...base, watcherNotice }, { ...base, watcherNotice, replyContext: context }],
    [{ ...base, decisionResult }, { ...base, decisionResult, replyContext: context }]
  ];
  for (const [plain, withContext] of twins) {
    assert.equal(messageRequest(plain), messageRequest(withContext));
    assert.equal(codexPrompt(plain), codexPrompt(withContext));
    assert.deepEqual(claudeEvent(plain), claudeEvent(withContext));
    assert.doesNotMatch(messageRequest(withContext), /Discord reply context/);
  }

  // A persisted agent message with a context-shaped accepted receipt still omits it.
  const agentTargetId = '33333333-3333-3333-3333-333333333333';
  state.bind({ channelId: '102', guildId: '100', provider: 'codex', nativeId: agentTargetId, workspace: dir }, { intakeCutoff: '100' });
  let binding = state.getBinding('102');
  binding = state.setBindingReadiness('102', 'ready', 'fixture', binding) || binding;
  state.enrollThread({ threadId: '103', parentChannelId: '102', guildId: '100', adoptionCutoff: '100' }, binding);
  state.setThreadBaseline('103', '50', binding);
  state.markThreadBoundary('103', THREAD_STATES.READY, 'fixture', null, null, binding);
  const destination = { guildId: '100', channelId: '103', provider: 'codex', nativeId: agentTargetId, generation: binding.generation };
  const wire = encodeAgentMessage({ ...agentMessage, target: destination }, AGENT_TOKEN);
  const accepted = state.acceptDiscordMessage({
    id: '9001', guildId: '100', channelId: '103', authorId: '901', isBot: true, attachments: [], content: wire
  }, { agentToken: AGENT_TOKEN });
  assertAccepted(accepted, state);
  assert.ok(state.getMessage('9001').agentMessage);
  // The forged receipt must use the stored message's own durable channel
  // ('102', the authority channel for the enrolled thread), otherwise the
  // getMessage channel-scope guard — not the agent/notice skip guard — is what
  // makes this assertion pass.
  assert.equal(state.getMessage('9001').channelId, '102');
  const earliest = state.db.prepare("SELECT id FROM receipts WHERE discord_id='9001' AND kind='accepted' ORDER BY id LIMIT 1").get();
  state.db.prepare('UPDATE receipts SET detail=? WHERE id=?')
    .run(JSON.stringify({ channelId: '102', replyContext: JSON.stringify(validContext('900', { channelId: '102' })) }), earliest.id);
  assert.equal(state.getMessage('9001').replyContext, undefined);
});

test('18: both entrypoints preserve context, and a stale expected binding refuses in both', async t => {
  const { dir, state } = fixture();
  t.after(() => cleanup(state, dir));
  const consumer = consumerFor(state);
  const viaHandle = await consumer.handleMessage(gm({
    id: '1000',
    reference: { messageId: '900' },
    cacheGet: id => cacheEntry(id)
  }));
  const viaIntake = await consumer.intakeMessage(gm({
    id: '1001',
    reference: { messageId: '901' },
    cacheGet: id => cacheEntry(id, { content: 'intake context' })
  }), true, null, null, false);
  assertAccepted(viaHandle, state);
  assertAccepted(viaIntake, state);
  assert.equal(state.getMessage('1000').replyContext.messageId, '900');
  assert.equal(state.getMessage('1001').replyContext.messageId, '901');

  const expected = { ...state.getBinding('101'), generation: state.getBinding('101').generation + 7 };
  const handleStale = await consumer.handleMessage(gm({
    id: '1002', reference: { messageId: '902' }, cacheGet: id => cacheEntry(id)
  }), undefined, expected);
  const intakeStale = await consumer.intakeMessage(gm({
    id: '1003', reference: { messageId: '903' }, cacheGet: id => cacheEntry(id)
  }), true, null, expected, false);
  assert.equal(handleStale.reason, 'stale-binding');
  assert.equal(handleStale.stale, true);
  assert.equal(intakeStale.reason, 'stale-binding');
  assert.equal(intakeStale.stale, true);
  assert.equal(state.getMessage('1002'), null);
  assert.equal(state.getMessage('1003'), null);
  assert.equal(state.listMessages().length, 2);
});
