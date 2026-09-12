const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SurfaceState, MESSAGE_STATES } = require('../src/state');
const { DiscordGateway, createSurfaceConsumer } = require('../src/discord');
const {
  CS_COMMAND,
  INTERACTION_OUTCOMES,
  SAVED_CALLBACK_CONTENT,
  parseCsInteraction,
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

const NATIVE_ID = '9caa5d21-2169-429d-918b-5f08651b5dbd';

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-cs-interaction-'));
  const state = new SurfaceState(path.join(dir, 'surface.sqlite'));
  state.setConfig({ operatorId: 'operator', guildId: 'guild', secretFile: path.join(dir, 'discord.secret') });
  state.bind({
    channelId: 'channel', guildId: 'guild', provider: 'codex', nativeId: NATIVE_ID, workspace: dir
  });
  return { dir, state };
}

function interaction(id = 'interaction-1', full = false, overrides = {}) {
  return {
    type: 2,
    id,
    applicationId: 'application',
    guildId: 'guild',
    channelId: 'channel',
    commandName: 'cs',
    token: `token-${id}`,
    user: { id: 'operator' },
    options: { data: full ? [{ name: 'full', type: 5, value: true }] : [] },
    ...overrides
  };
}

function latestDetail(state, messageId, kind) {
  const row = state.listReceipts().filter(item => item.discord_id === messageId && item.kind === kind).at(-1);
  return row ? JSON.parse(row.detail) : null;
}

function callbackOutcome(state, messageId) {
  return latestDetail(state, messageId, 'transport-receipt-outcome');
}

function acceptWithCallback(state, id = 'interaction-1', responseMessageId = 'response-1') {
  const parsed = parseCsInteraction(interaction(id), 'application');
  const accepted = state.acceptInteraction(parsed, state.getBinding('channel'));
  assert.equal(accepted.accepted, true);
  assert.equal(state.beginInteractionCallback(id).started, true);
  state.recordInteractionCallbackOutcome(id, INTERACTION_OUTCOMES.SENT, {
    responseMessageId,
    visibility: 'available'
  });
  return state.getMessage(id);
}

function closeFixture(fixtureState) {
  try { fixtureState.state.close(); } catch {}
}

test('strict /cs parser and single-command guild upsert preserve command scope', async () => {
  const parsed = parseCsInteraction(interaction('parse-full', true), 'application');
  assert.equal(parsed.content, '/cs full');
  assert.equal(parsed.full, true);
  assert.equal(CS_COMMAND.type, 1);
  assert.equal(parseCsInteraction(interaction('parse-string', false, {
    options: { data: [{ name: 'full', type: 5, value: 'true' }] }
  }), 'application'), null);
  assert.equal(parseCsInteraction(interaction('parse-extra', false, {
    options: { data: [{ name: 'full', type: 5, value: true }, { name: 'other', type: 5, value: false }] }
  }), 'application'), null);
  assert.equal(parseCsInteraction(interaction('parse-dm', false, { guildId: null }), 'application'), null);

  const edited = [];
  const manager = {
    async fetch() { return [{ id: 'other-id', name: 'other' }, { id: 'user-cs-id', name: 'cs', type: 2 }, { id: 'cs-id', name: 'cs', type: 1, async edit(command) { edited.push(command); } }]; },
    async create() { throw new Error('create must not replace an existing command'); }
  };
  await upsertGuildCsCommand(manager, 'guild');
  assert.deepEqual(edited, [CS_COMMAND]);

  let created;
  await upsertGuildCsCommand({
    async fetch() { return [{ id: 'other-id', name: 'other' }]; },
    async create(command, guildId) { created = { command, guildId }; return created; }
  }, 'guild');
  assert.deepEqual(created, { command: CS_COMMAND, guildId: 'guild' });
});

test('interaction admission is atomic, duplicate-safe, and outside history evidence', () => {
  const fixtureState = fixture();
  const { state } = fixtureState;
  try {
    const before = state.getIntakeWatermark('channel');
    const parsed = parseCsInteraction(interaction('custody-1'), 'application');
    const accepted = state.acceptInteraction(parsed, state.getBinding('channel'));
    assert.equal(accepted.accepted, true);
    assert.equal(state.getMessage('custody-1').content, '/cs');
    assert.equal(state.getMessage('custody-1').state, MESSAGE_STATES.ACCEPTED);
    assert.equal(state.getIntakeWatermark('channel'), before);
    assert.equal(state.hasIntakeEvidence('custody-1'), false);
    assert.equal(state.listReceipts().filter(row => row.discord_id === 'custody-1' && row.kind === 'interaction-origin').length, 1);
    assert.equal(state.beginInteractionCallback('custody-1').started, true);
    state.recordInteractionCallbackOutcome('custody-1', INTERACTION_OUTCOMES.SENT, {
      responseMessageId: 'response-custody-1', visibility: 'available'
    });
    assert.equal(state.hasIntakeEvidence('custody-1'), false);
    assert.equal(state.hasIntakeEvidence('response-custody-1'), true);

    const duplicate = state.acceptInteraction(parsed, state.getBinding('channel'));
    assert.equal(duplicate.accepted, false);
    assert.equal(duplicate.duplicate, true);
    assert.equal(state.listMessages().length, 1);
    assert.equal(state.listReceipts().filter(row => row.discord_id === 'custody-1' && row.kind === 'interaction-origin').length, 1);
  } finally {
    closeFixture(fixtureState);
  }
});

test('type-4 callback is one-shot, non-ephemeral, and records the documented response ID shape', async () => {
  let captured;
  const result = await sendInteractionCallback(parseCsInteraction(interaction('callback-1'), 'application'), {
    fetchImpl: async (url, init) => {
      captured = { url, init };
      return {
        ok: true,
        status: 200,
        async json() {
          return { interaction: { id: 'callback-1', response_message_id: 'response-1' }, resource: { type: 0, message: { id: 'ignored-by-first-candidate' } } };
        }
      };
    }
  });
  assert.equal(result.outcome, INTERACTION_OUTCOMES.SENT);
  assert.equal(result.responseMessageId, 'response-1');
  assert.equal(captured.init.method, 'POST');
  assert.match(captured.url, /\/interactions\/callback-1\/token-callback-1\/callback\?with_response=true$/);
  const body = JSON.parse(captured.init.body);
  assert.deepEqual(body, { type: 4, data: { content: SAVED_CALLBACK_CONTENT, allowed_mentions: { parse: [] } } });
  assert.equal('flags' in body.data, false);
});

test('Gateway claims callback before HTTP, preserves accepted work on visibility failure, and deduplicates callback', async () => {
  const fixtureState = fixture();
  const { state } = fixtureState;
  const listeners = new Map();
  let callbacks = 0;
  let processed = 0;
  const client = {
    application: { id: 'application', commands: null },
    on(name, listener) { listeners.set(name, listener); },
    off(name, listener) { if (listeners.get(name) === listener) listeners.delete(name); },
    async destroy() {}
  };
  const gateway = new DiscordGateway({
    state,
    client,
    providers: {},
    interactionFetch: async () => {
      callbacks += 1;
      return { ok: true, status: 200, async json() { return {}; } };
    }
  });
  gateway.consumer.processAccepted = async message => {
    processed += 1;
    return { message };
  };
  try {
    const first = await gateway.handleInteraction(interaction('gateway-1'), new AbortController().signal);
    const duplicate = await gateway.handleInteraction(interaction('gateway-1'), new AbortController().signal);
    assert.equal(first.message.content, '/cs');
    assert.equal(callbacks, 1);
    assert.equal(processed, 1);
    assert.equal(duplicate.duplicate, true);
    assert.equal(state.getMessage('gateway-1').state, MESSAGE_STATES.ACCEPTED);
    assert.equal(callbackOutcome(state, 'gateway-1').terminal, true);
    assert.equal(state.interactionResponseTarget('gateway-1'), null);
  } finally {
    await gateway.stop();
    closeFixture(fixtureState);
  }
});

test('expired callback token settles once and native custody continues without token recovery', async () => {
  const fixtureState = fixture();
  const { state } = fixtureState;
  let callbacks = 0;
  let processed = 0;
  const client = {
    application: { id: 'application', commands: null },
    on() {},
    off() {},
    async destroy() {}
  };
  const gateway = new DiscordGateway({
    state,
    client,
    providers: {},
    interactionFetch: async () => {
      callbacks += 1;
      return { ok: false, status: 404, body: { async cancel() {} } };
    }
  });
  gateway.consumer.processAccepted = async message => {
    processed += 1;
    return { message };
  };
  try {
    const first = await gateway.handleInteraction(interaction('expired-token'), new AbortController().signal);
    const duplicate = await gateway.handleInteraction(interaction('expired-token'), new AbortController().signal);
    assert.equal(first.message.id, 'expired-token');
    assert.equal(duplicate.duplicate, true);
    assert.equal(callbacks, 1);
    assert.equal(processed, 1);
    assert.equal(callbackOutcome(state, 'expired-token').outcome, 'rejected');
    assert.equal(callbackOutcome(state, 'expired-token').statusCode, 404);
    assert.equal(state.interactionResponseTarget('expired-token'), null);
    assert.equal(state.recoverAfterRestart(() => false).interactionCallbacks, 0);
  } finally {
    await gateway.stop();
    closeFixture(fixtureState);
  }
});

test('remote callback crash leaves one orphan outcome after live owner exits, with no resend or token recovery', async () => {
  const first = fixture();
  let remoteCalls = 0;
  try {
    const parsed = parseCsInteraction(interaction('crash-1'), 'application');
    assert.equal(first.state.acceptInteraction(parsed, first.state.getBinding('channel')).accepted, true);
    assert.equal(first.state.beginInteractionCallback('crash-1').started, true);
    const remote = await sendInteractionCallback(parsed, {
      fetchImpl: async () => {
        remoteCalls += 1;
        return { ok: true, status: 200, async json() { return { interaction: { response_message_id: 'remote-response' } }; } };
      }
    });
    assert.equal(remote.responseMessageId, 'remote-response');
    first.state.close();

    const state = new SurfaceState(first.state.dbPath || first.dir + '/surface.sqlite');
    assert.equal(state.recoverAfterRestart(() => true).interactionCallbacks, 0);
    assert.equal(state.getTransportReceipt('crash-1', 'interaction-callback').outcome, null);
    const recovered = state.recoverAfterRestart(() => false);
    assert.equal(recovered.interactionCallbacks, 1);
    assert.equal(remoteCalls, 1);
    assert.equal(callbackOutcome(state, 'crash-1').outcome, 'unknown');
    assert.equal(callbackOutcome(state, 'crash-1').terminal, true);
    assert.equal(state.interactionResponseTarget('crash-1'), null);
    assert.equal(state.beginInteractionCallback('crash-1').started, false);
    state.close();
  } finally {
    try { first.state.close(); } catch {}
  }
});

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

test('native ACK is recorded before final channel send and callback target does not satisfy the ACK gate', async () => {
  const fixtureState = fixture();
  const { state } = fixtureState;
  const events = [];
  try {
    const parsed = parseCsInteraction(interaction('ack-order', true), 'application');
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
    assert.equal(state.getIntakeWatermark('channel'), null);
    assert.equal(state.interactionResponseTarget('ack-order'), 'response-ack-order');
  } finally {
    closeFixture(fixtureState);
  }
});
