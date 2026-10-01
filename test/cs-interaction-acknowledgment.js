const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SurfaceState, MESSAGE_STATES } = require('../src/state');
const { DiscordGateway, createSurfaceConsumer } = require('../src/discord');
const {
  COMPONENT_TYPES,
  CS_COMMAND,
  DEFERRED_UPDATE_CALLBACK_TYPE,
  INTERACTION_OUTCOMES,
  SAVED_CALLBACK_CONTENT,
  decodeDecisionCustomId,
  encodeDecisionCustomId,
  parseComponentInteraction,
  parseCsInteraction,
  sendComponentCallback,
  sendInteractionCallback,
  upsertGuildCsCommand
} = require('../src/discord-interaction');
const {
  ACK,
  ACK_WAITING,
  createAcknowledgmentDelivery,
  isAcknowledgmentPending,
  recordNativeAcknowledgment
} = require('../src/acknowledgment');

const { NATIVE_ID, fixture, interaction, componentInteraction, latestDetail, callbackOutcome, acceptWithCallback, closeFixture } = require('./cs-interaction-fixture');

test('known callback target records the real reaction target and keeps ACK retry-after bounded', async () => {
  const fixtureState = fixture();
  const { state } = fixtureState;
  try {
    const message = acceptWithCallback(state, 'target-1', 'response-target-1');
    assert.equal(state.claimDispatch(message.id).claimed, true);
    recordNativeAcknowledgment(state, { provider: 'codex', messageId: message.id, nativeId: NATIVE_ID, generation: 1 });
    const calls = [];
    const delivery = createAcknowledgmentDelivery({
      state,
      send: async (source, reaction) => {
        calls.push({ id: source.id, reaction });
        return { targetMessageId: 'response-target-1' };
      }
    });
    await delivery(message.id);
    assert.deepEqual(calls, [{ id: message.id, reaction: '👀' }]);
    assert.equal(latestDetail(state, message.id, ACK.OUTCOME).targetMessageId, 'response-target-1');

    const retryMessage = acceptWithCallback(state, 'target-429', 'response-target-429');
    assert.equal(state.claimDispatch(retryMessage.id).claimed, true);
    recordNativeAcknowledgment(state, { provider: 'codex', messageId: retryMessage.id, nativeId: NATIVE_ID, generation: 1 });
    const before = Date.now();
    const retryDelivery = createAcknowledgmentDelivery({
      state,
      send: async () => { throw Object.assign(new Error('Discord rate limit'), { status: 429, retryAfterMs: 120000 }); }
    });
    await retryDelivery(retryMessage.id);
    const retry = latestDetail(state, retryMessage.id, ACK.OUTCOME);
    assert.equal(retry.outcome, 'unknown');
    assert.equal(retry.retryAfterMs, 120000);
    assert.ok(retry.retryAt >= before + 120000);
    assert.equal(retry.terminal, undefined);
    assert.equal(isAcknowledgmentPending(state, retryMessage.id, before + 119999), false);
  } finally {
    closeFixture(fixtureState);
  }
});

test('missing or deleted callback target becomes terminal local visibility failure without target lookup', async () => {
  const missing = fixture();
  const missingClient = {
    on() {},
    off() {},
    channels: { fetch: async () => { throw new Error('must not fetch missing target'); } },
    async destroy() {}
  };
  const missingGateway = new DiscordGateway({ state: missing.state, client: missingClient, providers: {} });
  try {
    const parsed = parseCsInteraction(interaction('target-missing'), 'application');
    assert.equal(missing.state.acceptInteraction(parsed, missing.state.getBinding('channel')).accepted, true);
    assert.equal(missing.state.beginInteractionCallback('target-missing').started, true);
    missing.state.recordInteractionCallbackOutcome('target-missing', 'unknown', { terminal: true, visibility: 'unknown' });
    const message = missing.state.getMessage('target-missing');
    assert.equal(missing.state.claimDispatch(message.id).claimed, true);
    recordNativeAcknowledgment(missing.state, { provider: 'codex', messageId: message.id, nativeId: NATIVE_ID, generation: 1 });
    await missingGateway.deliverAcknowledgment(message.id);
    const outcome = latestDetail(missing.state, message.id, ACK.OUTCOME);
    assert.equal(outcome.outcome, 'failed');
    assert.equal(outcome.visibility, 'local');
    assert.equal(outcome.terminal, true);
    assert.equal(outcome.targetMessageId, undefined);
  } finally {
    await missingGateway.stop();
    closeFixture(missing);
  }

  const deleted = fixture();
  let fetchedTarget = null;
  const deletedClient = {
    on() {},
    off() {},
    channels: { fetch: async () => ({ messages: { fetch: async id => { fetchedTarget = id; throw Object.assign(new Error('deleted'), { status: 404 }); } } }) },
    async destroy() {}
  };
  const deletedGateway = new DiscordGateway({ state: deleted.state, client: deletedClient, providers: {} });
  try {
    const message = acceptWithCallback(deleted.state, 'target-deleted', 'response-deleted');
    assert.equal(deleted.state.claimDispatch(message.id).claimed, true);
    recordNativeAcknowledgment(deleted.state, { provider: 'codex', messageId: message.id, nativeId: NATIVE_ID, generation: 1 });
    await deletedGateway.deliverAcknowledgment(message.id);
    const outcome = latestDetail(deleted.state, message.id, ACK.OUTCOME);
    assert.equal(fetchedTarget, 'response-deleted');
    assert.equal(outcome.outcome, 'failed');
    assert.equal(outcome.visibility, 'local');
    assert.equal(outcome.targetMessageId, 'response-deleted');
  } finally {
    await deletedGateway.stop();
    closeFixture(deleted);
  }
});

test('successful Gateway start dispatches one interactionCreate through native exactly once', { timeout: 8000 }, async t => {
  const fixtureState = fixture();
  const { state, dir } = fixtureState;
  const secretFile = path.join(dir, 'discord.secret');
  fs.writeFileSync(secretFile, 'DISCORD_TOKEN=fixture-token\n', { mode: 0o600 });
  state.setBindingReadiness('channel', 'ready');
  const listeners = new Map();
  let callbacks = 0;
  let dispatchCount = 0;
  const client = {
    application: { id: 'application', commands: null },
    user: { id: 'bot-1' },
    on(name, listener) { listeners.set(name, listener); },
    off(name, listener) { if (listeners.get(name) === listener) listeners.delete(name); },
    async login() {},
    channels: { fetch: async () => ({ id: 'channel', messages: { fetch: async () => ({ react: async () => {} }) }, send: async () => ({ id: 'reply-1' }) }) },
    async destroy() {}
  };
  const gateway = new DiscordGateway({
    state,
    client,
    providers: {
      codex: {
        async dispatch() { dispatchCount += 1; return { status: 'submitted' }; },
        async observe() { return { text: 'status board' }; }
      }
    },
    interactionFetch: async () => {
      callbacks += 1;
      return { ok: true, status: 200, async json() { return { interaction: { response_message_id: 'response-1' } }; } };
    }
  });
  gateway.recoverTransport = async () => {
    gateway.ready = true;
    return { ready: true, state: 'ready' };
  };
  try {
    await gateway.start(secretFile);
    assert.equal(gateway.started, true);
    assert.equal(typeof listeners.get('interactionCreate'), 'function');

    listeners.get('interactionCreate')(interaction('successful-start'));
    await Promise.all([...gateway.inFlight]);

    assert.equal(callbacks, 1);
    assert.equal(dispatchCount, 1);
    assert.equal(state.getMessage('successful-start').state, MESSAGE_STATES.REPLIED);
  } finally {
    await gateway.stop();
    closeFixture(fixtureState);
  }
});

test('native ACK is recorded before final channel send and callback target does not satisfy the ACK gate', async () => {
  const fixtureState = fixture();
  const { state } = fixtureState;
  const events = [];
  try {
    const parsed = parseCsInteraction(interaction('ack-order', true), 'application');
    const beforeWatermark = state.getIntakeWatermark('channel');
    assert.equal(state.acceptInteraction(parsed, state.getBinding('channel')).accepted, true);
    assert.equal(state.beginInteractionCallback('ack-order').started, true);
    state.recordInteractionCallbackOutcome('ack-order', 'sent', { responseMessageId: 'response-ack-order', visibility: 'available' });
    const consumer = createSurfaceConsumer({
      state,
      providers: {
        codex: {
          async dispatch() { events.push('dispatch'); return { status: 'submitted' }; },
          async observe() { events.push('native-observe'); return { text: 'status board' }; }
        }
      },
      prepareReply: async messageId => {
        const message = state.getMessage(messageId);
        events.push(`prepare:${state.hasNativeAcknowledgment(message)}`);
        return state.hasNativeAcknowledgment(message) ? null : ACK_WAITING;
      },
      sendReply: async (_message, reply) => {
        events.push(`channel-send:${state.hasNativeAcknowledgment(state.getMessage(reply.id))}`);
        return { id: 'final-channel-message' };
      }
    });
    const result = await consumer.processAccepted(state.getMessage('ack-order'));
    assert.equal(result.message.state, MESSAGE_STATES.REPLIED);
    assert.deepEqual(events, ['dispatch', 'native-observe', 'prepare:true', 'channel-send:true']);
    assert.deepEqual(state.getIntakeWatermark('channel'), beforeWatermark);
    assert.equal(state.interactionResponseTarget('ack-order'), 'response-ack-order');
  } finally {
    closeFixture(fixtureState);
  }
});
