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
  assert.equal(body.data.content, '/cs received');
  assert.deepEqual(body, { type: 4, data: { content: SAVED_CALLBACK_CONTENT, allowed_mentions: { parse: [] } } });
  assert.equal('flags' in body.data, false);
});

test('type-6 component callback accepts an empty response without a message ID', async () => {
  const parsed = parseComponentInteraction(componentInteraction('callback-component'), 'application');
  let captured;
  const result = await sendComponentCallback(parsed, {
    fetchImpl: async (url, init) => {
      captured = { url, init };
      return {
        ok: true,
        status: 204,
        body: { async cancel() {} },
        async json() { throw new Error('type-6 callback must not parse a response body'); }
      };
    }
  });
  assert.equal(result.outcome, INTERACTION_OUTCOMES.SENT);
  assert.equal(result.statusCode, 204);
  assert.equal(result.responseMessageId, undefined);
  assert.match(captured.url, /\/interactions\/callback-component\/token-callback-component\/callback$/);
  assert.equal(captured.init.method, 'POST');
  assert.deepEqual(JSON.parse(captured.init.body), { type: DEFERRED_UPDATE_CALLBACK_TYPE });
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
  gateway.started = true;
  gateway.transportReady = true;
  gateway.ready = true;
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

test('Gateway admission persists the callback claim with accepted custody', async () => {
  const fixtureState = fixture();
  const { state } = fixtureState;
  let callbackAttempt;
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
      callbackAttempt = state.getTransportReceipt('atomic-claim', 'interaction-callback')?.attempt;
      return { ok: true, status: 200, async json() { return { interaction: { response_message_id: 'atomic-response' } }; } };
    }
  });
  gateway.consumer.processAccepted = async message => ({ message });
  gateway.started = true;
  gateway.transportReady = true;
  gateway.ready = true;
  try {
    const result = await gateway.handleInteraction(interaction('atomic-claim'), new AbortController().signal);
    assert.equal(result.message.id, 'atomic-claim');
    assert.equal(callbackAttempt.transport, 'interaction-callback');
    assert.equal(state.getTransportReceipt('atomic-claim', 'interaction-callback').outcome.responseMessageId, 'atomic-response');
  } finally {
    await gateway.stop();
    closeFixture(fixtureState);
  }
});

test('valid rejected interaction receives a non-custodial ephemeral callback', async () => {
  const fixtureState = fixture();
  const { state } = fixtureState;
  state.unbind('channel');
  let body;
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
    interactionFetch: async (_url, init) => {
      body = JSON.parse(init.body);
      return { ok: true, status: 200, async json() { return { interaction: { response_message_id: 'rejection-response' } }; } };
    }
  });
  try {
    const result = await gateway.handleInteraction(interaction('rejected-callback'), new AbortController().signal);
    assert.equal(result.accepted, false);
    assert.equal(result.reason, 'inactive-binding');
    assert.equal(body.data.flags, 64);
    assert.match(body.data.content, /status session/i);
    assert.equal(state.getMessage('rejected-callback'), null);
    assert.equal(state.listReceipts().some(row => row.discord_id === 'rejected-callback'), false);
  } finally {
    await gateway.stop();
    closeFixture(fixtureState);
  }
});

test('callback deadline records unknown and still processes accepted custody', async () => {
  const fixtureState = fixture();
  const { state } = fixtureState;
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
    recoveryOptions: { interactionCallbackTimeoutMs: 10 },
    interactionFetch: async (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted by deadline'), { name: 'AbortError' })), { once: true });
    })
  });
  gateway.consumer.processAccepted = async message => {
    processed += 1;
    return { message };
  };
  gateway.started = true;
  gateway.transportReady = true;
  gateway.ready = true;
  try {
    const startedAt = Date.now();
    const result = await gateway.handleInteraction(interaction('deadline-callback'), new AbortController().signal);
    assert.ok(Date.now() - startedAt < 1000);
    assert.equal(result.message.id, 'deadline-callback');
    assert.equal(processed, 1);
    assert.equal(callbackOutcome(state, 'deadline-callback').outcome, 'unknown');
    assert.match(callbackOutcome(state, 'deadline-callback').reason, /deadline/);
  } finally {
    await gateway.stop();
    closeFixture(fixtureState);
  }
});
