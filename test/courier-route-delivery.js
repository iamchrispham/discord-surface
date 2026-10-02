const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { encodeAgentMessage, KINDS } = require('../src/agent-message');
const { createWatcherNotice, encodeWatcherNotice } = require('../src/watcher-notice');
const { acknowledgmentCommand } = require('../src/acknowledgment');
const { agentCompletionCommand, codexPrompt, readInitialCursor, CodexProvider } = require('../src/native');
const { parseArgs, resolveCourierRoute, start } = require('../src/cli');
const {
  COURIER_OUTCOMES,
  COURIER_SOURCE_KINDS,
  MESSAGE_STATES,
  SurfaceState,
  THREAD_STATES
} = require('../src/state');
const { isCourierOriginAllowed } = require('../src/state/courier-route');
const { createSurfaceConsumer } = require('../src/discord');
const { persistGuardRefusal } = require('../src/courier-guard');
const { TOKEN, PARENT_NATIVE, SOURCE_NATIVE, COURIER_NATIVE, RECIPIENT_THREAD, WRONG_RECIPIENT_THREAD, fixture, humanMessage, interactionMessage, materializedDecisionMessage, parentPrompt, preparedInput, consumerFor } = require('./courier-route-fixture');
test('selected agent route uses exact parent prompt and existing native lifecycle', async t => {
  const f = fixture(t);
  const courierCalls = [];
  const parentCalls = [];
  const replies = [];
  const consumer = consumerFor(f, { courierCalls, parentCalls, replies });
  const expectedPrompt = parentPrompt(f.state, f.message);
  const result = await consumer.processAccepted(f.message);

  assert.equal(result.message.state, MESSAGE_STATES.REPLIED);
  assert.equal(f.state.getMessage(f.message.id).state, MESSAGE_STATES.REPLIED);
  assert.equal(parentCalls.length, 0);
  assert.equal(courierCalls.length, 1);
  assert.equal(courierCalls[0].envelope.prompt, expectedPrompt);
  assert.equal(Object.isFrozen(courierCalls[0].envelope), true);
  assert.equal(courierCalls[0].envelope.source.kind, COURIER_SOURCE_KINDS.AGENT);
  assert.deepEqual(courierCalls[0].envelope.packet, f.packet);
  assert.equal(courierCalls[0].envelope.parent.channelId, '1000');
  assert.equal(courierCalls[0].envelope.parent.nativeId, PARENT_NATIVE);
  assert.equal(courierCalls[0].envelope.observerCursor.file, f.sessionFile);
  assert.ok(courierCalls[0].envelope.observerCursor.offset > 0);
  assert.equal(f.state.getMessage(f.message.id).observerCursor.file, f.sessionFile);
  assert.equal(f.state.listReceipts().filter(row => row.kind === 'native-ack').length, 1);
  assert.deepEqual(replies, [{ messageId: f.message.id, channelId: '2000', content: `answer for ${f.message.id}` }]);
  assert.equal(f.state.getCourierAttempt(f.message.id).outcome.outcome, COURIER_OUTCOMES.SUBMITTED);

  const duplicate = await consumer.processAccepted(f.state.getMessage(f.message.id));
  assert.equal(duplicate.message.state, MESSAGE_STATES.REPLIED);
  assert.equal(courierCalls.length, 1);
  assert.equal(parentCalls.length, 0);
  assert.equal(replies.length, 1);
});

test('human parent route keeps authority and original Discord destination', async t => {
  const f = fixture(t, { includeInitialAgent: false });
  const message = humanMessage(f, '9010', 'approve the release', [{
    url: 'https://example.test/release.txt',
    filename: 'release.txt',
    contentType: 'text/plain',
    size: 12
  }]);
  const courierCalls = [];
  const parentCalls = [];
  const replies = [];
  const result = await consumerFor(f, { courierCalls, parentCalls, replies }).processAccepted(message);

  assert.equal(result.message.state, MESSAGE_STATES.REPLIED);
  assert.equal(parentCalls.length, 0);
  assert.equal(courierCalls.length, 1);
  const envelope = courierCalls[0].envelope;
  assert.equal(envelope.source.kind, COURIER_SOURCE_KINDS.HUMAN);
  assert.equal(envelope.source.authorId, 'operator');
  assert.equal(envelope.source.isBot, false);
  assert.equal(envelope.source.content, 'approve the release');
  assert.deepEqual(envelope.source.attachments, message.attachments);
  assert.deepEqual(envelope.sourceDestination, { guildId: '100', channelId: '1000' });
  assert.equal(envelope.deliveryChannelId, '1000');
  assert.equal(envelope.prompt, parentPrompt(f.state, message));
  assert.deepEqual(replies, [{ messageId: '9010', channelId: '1000', content: 'answer for 9010' }]);
  assert.equal(f.state.getMessage(message.id).authorId, 'operator');
  assert.equal(f.state.listReceipts().filter(row => row.kind === 'native-ack').length, 1);

  const childMessage = humanMessage(f, '9011', 'child instruction', [], '2000');
  const childResult = await consumerFor(f, { courierCalls, parentCalls, replies }).processAccepted(childMessage);
  assert.equal(childResult.message.state, MESSAGE_STATES.REPLIED);
  assert.equal(courierCalls.length, 2);
  assert.deepEqual(courierCalls[1].envelope.sourceDestination, { guildId: '100', channelId: '2000' });
  assert.equal(courierCalls[1].envelope.deliveryChannelId, '2000');
  assert.equal(parentCalls.length, 0);
  assert.deepEqual(replies.map(reply => ({ messageId: reply.messageId, channelId: reply.channelId })), [
    { messageId: '9010', channelId: '1000' },
    { messageId: '9011', channelId: '2000' }
  ]);
});

test('ordinary agent and human origins remain courier-eligible', async t => {
  const f = fixture(t);
  const human = humanMessage(f, '9012', 'ordinary human instruction');
  assert.equal(f.state.isInteractionMessage(human.id), false);
  assert.equal(human.decisionResult, undefined);
  const courierCalls = [];
  const parentCalls = [];
  const consumer = consumerFor(f, { courierCalls, parentCalls });

  await consumer.processAccepted(f.message);
  await consumer.processAccepted(human);

  assert.equal(courierCalls.length, 2);
  assert.deepEqual(courierCalls.map(call => call.envelope.source.kind === COURIER_SOURCE_KINDS.AGENT
    ? call.envelope.packet.id
    : call.envelope.messageId), ['request-1', human.id]);
  assert.equal(parentCalls.length, 0);
  assert.equal(f.state.getCourierAttempt(f.message.id).outcome.outcome, COURIER_OUTCOMES.SUBMITTED);
  assert.equal(f.state.getCourierAttempt(human.id).outcome.outcome, COURIER_OUTCOMES.SUBMITTED);
});

test('authenticated Codex watcher notices use courier custody and the one-consume command', async t => {
  const f = fixture(t, { includeInitialAgent: false });
  const armKey = 'courier-watcher-arm';
  const target = { ...f.route.target, channelId: '2000' };
  f.state.armWatcherNotice({
    armKey,
    parentChannelId: f.route.parentChannelId,
    childChannelId: f.route.deliveryChannelId,
    provider: 'codex',
    nativeId: PARENT_NATIVE,
    generation: f.binding.generation,
    caller: { harness: 'codex', sessionId: PARENT_NATIVE, threadId: PARENT_NATIVE }
  });
  const packet = createWatcherNotice({
    armKey,
    triggerKey: 'courier-trigger',
    source: { guildId: '100', channelId: f.route.parentChannelId, provider: 'codex', nativeId: PARENT_NATIVE, generation: f.binding.generation },
    target,
    text: 'Watcher completion is ready.'
  });
  const accepted = f.state.acceptDiscordMessage({
    id: '9013', guildId: '100', channelId: f.route.deliveryChannelId, authorId: 'watcher-bot', isBot: true,
    attachments: [], content: encodeWatcherNotice(packet, TOKEN)
  }, { ready: true, expectedBinding: f.binding, agentToken: TOKEN });
  assert.equal(accepted.accepted, true);
  const message = f.state.getMessage('9013');
  const courierCalls = [];
  const consumer = consumerFor(f, { courierCalls });
  await consumer.processAccepted(message);
  assert.equal(courierCalls.length, 1);
  assert.equal(courierCalls[0].envelope.source.kind, COURIER_SOURCE_KINDS.WATCHER_NOTICE);
  assert.deepEqual(courierCalls[0].envelope.source.packet, packet);
  assert.match(courierCalls[0].envelope.prompt, /watcher-consume/);
  await consumer.processAccepted(f.state.getMessage('9013'));
  assert.equal(courierCalls.length, 1);
});

test('unproved Codex watcher provenance cannot enter courier custody', async t => {
  const f = fixture(t, { includeInitialAgent: false });
  const armKey = 'courier-watcher-refusal-arm';
  f.state.armWatcherNotice({
    armKey,
    parentChannelId: f.route.parentChannelId,
    childChannelId: f.route.deliveryChannelId,
    provider: 'codex',
    nativeId: PARENT_NATIVE,
    generation: f.binding.generation,
    caller: { harness: 'codex', sessionId: PARENT_NATIVE, threadId: PARENT_NATIVE }
  });
  const packet = createWatcherNotice({
    armKey,
    triggerKey: 'courier-refusal-trigger',
    source: { guildId: '100', channelId: f.route.parentChannelId, provider: 'codex', nativeId: PARENT_NATIVE, generation: f.binding.generation },
    target: { ...f.route.target, channelId: f.route.deliveryChannelId },
    text: 'Unproved watcher data.'
  });
  const accepted = f.state.acceptDiscordMessage({
    id: '9014', guildId: '100', channelId: f.route.deliveryChannelId, authorId: 'watcher-bot', isBot: true,
    attachments: [], content: encodeWatcherNotice(packet, TOKEN)
  }, { ready: true, expectedBinding: f.binding, agentToken: TOKEN });
  assert.equal(accepted.accepted, true);
  const message = f.state.getMessage('9014');
  assert.equal(isCourierOriginAllowed(f.state, { ...message, watcherNoticeProvenance: null }), false);
  f.state.db.prepare("DELETE FROM receipts WHERE discord_id=? AND kind='watcher-notice'").run('9014');
  const unproved = f.state.getMessage('9014');
  assert.equal(f.state.beginCourierAttempt('9014', {
    routeId: f.route.routeId,
    prompt: 'unproved watcher prompt',
    observerCursor: null
  }).accepted, false);
  assert.equal(unproved.watcherNotice, undefined);
  assert.equal(f.state.getCourierAttempt('9014'), null);
});

test('interaction-origin and materialized decision messages cannot mint courier custody', async t => {
  const f = fixture(t, { includeInitialAgent: false });
  const interaction = interactionMessage(f);
  const decision = materializedDecisionMessage(f);
  assert.equal(f.state.isInteractionMessage(interaction.id), true);
  assert.equal(f.state.isInteractionMessage(decision.id), true);

  for (const message of [interaction, decision]) {
    const rejected = f.state.beginCourierAttempt(message.id, preparedInput(f, message));
    assert.equal(rejected.accepted, false);
    assert.equal(rejected.status, 'no_route');
    assert.equal(f.state.getCourierAttempt(message.id), null);
  }

  const courierCalls = [];
  const parentCalls = [];
  const consumer = consumerFor(f, { courierCalls, parentCalls });
  await consumer.processAccepted(interaction);
  await consumer.processAccepted(decision);

  assert.equal(courierCalls.length, 0);
  assert.deepEqual(parentCalls, [interaction.id, decision.id]);
  assert.equal(f.state.listReceipts().filter(row => row.kind === 'courier-attempt').length, 0);
});

test('selected and unselected messages share parent owner FIFO', async t => {
  const f = fixture(t);
  const binding = f.state.getBinding('1000');
  f.state.enrollThread({ threadId: '2001', parentChannelId: '1000', guildId: '100', adoptionCutoff: '100'}, binding);
  f.state.setThreadBaseline('2001', null, binding);
  f.state.markThreadBoundary('2001', THREAD_STATES.READY, 'second child fixture', null, null, binding);
  const otherTarget = { ...f.route.target, channelId: '2001' };
  const otherPacket = { ...f.packet, id: 'request-2', target: otherTarget };
  const otherAccepted = f.state.acceptDiscordMessage({
    id: '9004', guildId: '100', channelId: '2001', authorId: 'agent-bot', isBot: true, attachments: [],
    content: encodeAgentMessage(otherPacket, TOKEN)
  }, { ready: true, expectedBinding: binding, agentToken: TOKEN });
  assert.equal(otherAccepted.accepted, true);
  const parent = humanMessage(f, '9005', 'human parent work');
  const courierCalls = [];
  const parentCalls = [];
  const replies = [];
  const consumer = consumerFor(f, {
    courierCalls,
    parentCalls,
    replies,
    dispatchCourier: async envelope => {
      await new Promise(resolve => setImmediate(resolve));
      return { status: COURIER_OUTCOMES.SUBMITTED };
    }
  });
  const results = await Promise.all([
    consumer.processAccepted(f.message),
    consumer.processAccepted(f.state.getMessage(otherAccepted.message.id)),
    consumer.processAccepted(parent)
  ]);

  assert.deepEqual(courierCalls.map(call => call.envelope.source.kind === COURIER_SOURCE_KINDS.AGENT
    ? call.envelope.packet.id
    : call.envelope.messageId), ['request-1', '9005']);
  assert.deepEqual(parentCalls, ['9004']);
  assert.deepEqual(replies.map(reply => reply.messageId), ['9000', '9004', '9005']);
  assert.equal(results[0].message.state, MESSAGE_STATES.REPLIED);
  assert.equal(f.state.getMessage(otherAccepted.message.id).state, MESSAGE_STATES.REPLIED);
  assert.equal(f.state.getMessage(parent.id).state, MESSAGE_STATES.REPLIED);
});
