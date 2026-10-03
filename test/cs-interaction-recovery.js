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

test('accepted interaction waits for Gateway recovery before native processing', async () => {
  const fixtureState = fixture();
  const { state } = fixtureState;
  state.setBindingReadiness('channel', 'ready');
  let releaseRecovery;
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
    interactionFetch: async () => ({ ok: true, status: 200, async json() { return { interaction: { response_message_id: 'recovery-response' } }; } })
  });
  gateway.started = true;
  gateway.transportReady = false;
  gateway.ready = false;
  gateway.recoveryPromise = new Promise(resolve => {
    releaseRecovery = () => {
      gateway.ready = true;
      gateway.transportReady = true;
      resolve({ ready: true, state: 'ready' });
    };
  });
  gateway.consumer.processAccepted = async message => {
    processed += 1;
    return { message };
  };
  try {
    const work = gateway.handleInteraction(interaction('recovery-order'), new AbortController().signal);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(processed, 0);
    releaseRecovery();
    const result = await work;
    assert.equal(result.message.id, 'recovery-order');
    assert.equal(processed, 1);
  } finally {
    await gateway.stop();
    closeFixture(fixtureState);
  }
});

test('restart recovery settles an interaction origin that predates callback claiming', () => {
  const fixtureState = fixture();
  const { state } = fixtureState;
  try {
    const parsed = parseCsInteraction(interaction('legacy-missing-attempt'), 'application');
    assert.equal(state.acceptInteraction(parsed, state.getBinding('channel')).accepted, true);
    const recovered = state.recoverAfterRestart(() => false);
    assert.equal(recovered.interactionCallbacks, 1);
    assert.equal(callbackOutcome(state, 'legacy-missing-attempt').outcome, 'unknown');
    assert.equal(callbackOutcome(state, 'legacy-missing-attempt').terminal, true);
  } finally {
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
  gateway.started = true;
  gateway.transportReady = true;
  gateway.ready = true;
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
    assert.equal(state.recoverAfterRestart(() => false).interactionCallbacks, 0);
    assert.equal(state.getTransportReceipt('crash-1', 'interaction-callback').outcome, null);
    const recovered = state.recoverAfterRestart(() => ({ status: 'absent', reason: 'probe-absent' }));
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
