const test = require('node:test');
const assert = require('node:assert/strict');
const { SurfaceState, MESSAGE_STATES, READINESS } = require('../src/state');
const { createSurfaceConsumer, DiscordGateway } = require('../src/discord');
const { ACK, recordNativeAcknowledgment } = require('../src/acknowledgment');
const { CODEX_ID, fixture, discordMessage, waitForCondition, providers } = require('./surface-fixtures');

test('simulated: same native owner dispatches its next message while the prior ACK is pending', async () => {
  const { dir, state } = fixture();
  state.bind({ channelId: 'channel-codex', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir });
  let ackStartedResolve;
  const ackStarted = new Promise(resolve => { ackStartedResolve = resolve; });
  let release;
  const priorAck = new Promise(resolve => { release = resolve; });
  const dispatches = [];
  const sends = [];
  const consumer = createSurfaceConsumer({
    state,
    providers: {
      codex: {
        async dispatch(message) { dispatches.push(message.id); return { status: 'submitted' }; },
        async observe(message) {
          recordNativeAcknowledgment(state, { provider: 'codex', messageId: message.id, nativeId: CODEX_ID, generation: 1 });
          return { text: `answer-${message.id}` };
        }
      }
    },
    prepareReply: messageId => {
      if (messageId !== 'same-owner-first') return null;
      ackStartedResolve();
      return priorAck;
    },
    sendTransportReceipt: async () => ({ id: 'receipt' }),
    sendReply: async (_message, reply) => { sends.push(reply.id); return { id: `sent-${reply.id}` }; }
  });
  const first = consumer.handleMessage(discordMessage({ id: 'same-owner-first', channelId: 'channel-codex' }));
  await ackStarted;
  const second = consumer.handleMessage(discordMessage({ id: 'same-owner-second', channelId: 'channel-codex' }));
  await waitForCondition(() => dispatches.includes('same-owner-second'));
  const secondResult = await second;
  assert.equal(secondResult.message.state, MESSAGE_STATES.REPLIED);
  assert.equal(state.getMessage('same-owner-first').state, MESSAGE_STATES.REPLY_READY);
  assert.deepEqual(dispatches, ['same-owner-first', 'same-owner-second']);
  release();
  const firstResult = await first;
  assert.equal(firstResult.message.state, MESSAGE_STATES.REPLIED);
  assert.deepEqual(sends, ['same-owner-second', 'same-owner-first']);
  await consumer.waitForReceipts();
  state.close();
});

test('simulated: readiness recovery releases a terminal owner blocker before a queued message is replayed', async () => {
  const { dir, state } = fixture();
  const binding = state.bind({ channelId: 'channel-codex', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir });
  const firstId = 'readiness-terminal-first';
  const secondId = 'readiness-terminal-second';
  const dispatches = [];
  let releaseFirst;
  const firstReply = new Promise(resolve => { releaseFirst = resolve; });
  const consumer = createSurfaceConsumer({
    state,
    providers: {
      codex: {
        async dispatch(message) {
          dispatches.push(message.id);
          return { status: 'submitted' };
        },
        async observe(message) {
          return message.id === firstId ? firstReply : { text: 'second answer' };
        }
      }
    },
    sendTransportReceipt: async () => ({ id: 'transport-receipt' }),
    sendReply: async (_message, reply) => ({ id: `reply-${reply.id}` })
  });

  const first = consumer.handleMessage(discordMessage({ id: firstId, channelId: binding.channelId }));
  await waitForCondition(() => dispatches.includes(firstId));
  const second = consumer.handleMessage(discordMessage({ id: secondId, channelId: binding.channelId }));
  await new Promise(resolve => setImmediate(resolve));
  state.setBindingReadiness(binding.channelId, READINESS.UNAVAILABLE, 'Claude Monitor stopped', binding);
  releaseFirst({ text: 'first answer' });
  await waitForCondition(() => state.getMessage(firstId).state === MESSAGE_STATES.REPLIED);
  assert.deepEqual(dispatches, [firstId]);
  assert.equal(state.getMessage(secondId).state, MESSAGE_STATES.ACCEPTED);

  const recoveredBinding = state.setBindingReadiness(binding.channelId, READINESS.READY, 'Claude Monitor recovered', state.getBinding(binding.channelId));
  assert.equal(recoveredBinding.readiness, READINESS.READY);
  await consumer.handleStoredMessage(state.getMessage(secondId));
  await waitForCondition(() => dispatches.includes(secondId));
  await second;
  assert.equal(state.getMessage(secondId).state, MESSAGE_STATES.REPLIED);
  assert.deepEqual(dispatches, [firstId, secondId]);
  await first;
  await consumer.waitForReceipts();
  state.close();
});

test('simulated: current native ACK releases a queued owner before the first reply', async () => {
  const { dir, state } = fixture();
  state.bind({ channelId: 'channel-codex', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir });
  const firstId = 'ack-queue-first';
  const secondId = 'ack-queue-second';
  const dispatches = [];
  const observations = [];
  const replies = [];
  let consumer;
  let dispatchStartedResolve;
  let releaseAckGate;
  let releaseDispatch;
  let firstObserveResolve;
  const dispatchStarted = new Promise(resolve => { dispatchStartedResolve = resolve; });
  const ackGate = new Promise(resolve => { releaseAckGate = resolve; });
  const dispatchGate = new Promise(resolve => { releaseDispatch = resolve; });
  const firstReply = new Promise(resolve => { firstObserveResolve = resolve; });
  consumer = createSurfaceConsumer({
    state,
    providers: {
      codex: {
        async dispatch(message) {
          dispatches.push(message.id);
          if (message.id === firstId) {
            dispatchStartedResolve();
            await ackGate;
            recordNativeAcknowledgment(state, { messageId: firstId, nativeId: CODEX_ID, generation: 1, provider: 'codex' });
            assert.equal(consumer.releaseAcknowledged(firstId), true);
            await dispatchGate;
            return { status: 'not_submitted', error: new Error('fixture outcome after native acknowledgment') };
          }
          return { status: 'submitted' };
        },
        async observe(message) {
          observations.push(message.id);
          if (message.id === firstId) return firstReply;
          return { text: 'second native answer' };
        }
      }
    },
    sendTransportReceipt: async () => ({ id: 'transport-receipt' }),
    sendReply: async (message, reply) => {
      replies.push({ messageId: message.id, nativeId: reply.nativeId, generation: reply.generation, text: reply.replyText });
      return { id: `reply-${replies.length}` };
    }
  });

  const first = consumer.handleMessage(discordMessage({ id: firstId, channelId: 'channel-codex' }));
  await dispatchStarted;
  const second = consumer.handleMessage(discordMessage({ id: secondId, channelId: 'channel-codex' }));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(dispatches, [firstId]);
  releaseAckGate();
  await waitForCondition(() => dispatches.includes(secondId));
  const secondResult = await second;
  assert.equal(secondResult.message.state, MESSAGE_STATES.REPLIED);
  assert.equal(state.getMessage(firstId).state, MESSAGE_STATES.SUBMITTED);
  assert.deepEqual(dispatches, [firstId, secondId]);
  assert.deepEqual(observations, [secondId]);
  assert.deepEqual(replies, [{ messageId: secondId, nativeId: CODEX_ID, generation: 1, text: 'second native answer' }]);
  releaseDispatch();
  await waitForCondition(() => observations.includes(firstId));
  firstObserveResolve({ text: 'first native answer' });
  const firstResult = await first;
  assert.equal(firstResult.message.state, MESSAGE_STATES.REPLIED);
  assert.deepEqual(replies, [
    { messageId: secondId, nativeId: CODEX_ID, generation: 1, text: 'second native answer' },
    { messageId: firstId, nativeId: CODEX_ID, generation: 1, text: 'first native answer' }
  ]);
  const acknowledgment = state.listReceipts().find(row => row.discord_id === firstId && row.kind === ACK.RECEIVED);
  assert.equal(JSON.parse(acknowledgment.detail).source, 'explicit-native-ack');
  await consumer.waitForReceipts();
  state.close();
});

test('simulated: restart releases persisted native ACK before same-owner successor', async () => {
  const { dir, db, state: initial } = fixture();
  const firstId = 'ack-restart-first';
  const secondId = 'ack-restart-second';
  initial.bind({ channelId: 'channel-codex', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir });
  initial.acceptDiscordMessage({ id: firstId, guildId: 'guild-1', channelId: 'channel-codex', authorId: 'operator-1', isBot: false, content: 'first' });
  await new Promise(resolve => setTimeout(resolve, 2));
  initial.acceptDiscordMessage({ id: secondId, guildId: 'guild-1', channelId: 'channel-codex', authorId: 'operator-1', isBot: false, content: 'second' });
  initial.claimDispatch(firstId);
  initial.markSubmitted(firstId);
  recordNativeAcknowledgment(initial, { messageId: firstId, nativeId: CODEX_ID, generation: 1, provider: 'codex' });
  initial.close();

  const state = new SurfaceState(db);
  state.recoverAfterRestart();
  const dispatches = [];
  const observations = [];
  const replies = [];
  let releaseFirst;
  const firstReply = new Promise(resolve => { releaseFirst = resolve; });
  const channel = {
    messages: { fetch: async () => ({ react: async () => {} }) },
    async send(payload) {
      if (payload.content !== 'Receipt: saved for this conductor.' && payload.content !== 'Receipt: saved. Delivery was paused when this receipt was prepared.') {
        const source = state.listMessages().find(message => message.replyText === payload.content);
        replies.push({ messageId: source?.id, nativeId: source?.nativeId, generation: source?.generation, text: payload.content });
      }
      return { id: `reply-${replies.length}` };
    }
  };
  const gateway = new DiscordGateway({
    state,
    client: { on() {}, off() {}, channels: { fetch: async () => channel }, async destroy() {} },
    providers: {
      codex: {
        async dispatch(message) {
          dispatches.push(message.id);
          return { status: 'submitted' };
        },
        async observe(message) {
          observations.push(message.id);
          if (message.id === firstId) return firstReply;
          return { text: 'second restart answer' };
        }
      }
    }
  });
  gateway.ready = true;
  const recovery = gateway.reconcilePending(new Date(Date.now() + 1).toISOString());
  await waitForCondition(() => observations.includes(firstId) && observations.includes(secondId));
  await recovery;
  await waitForCondition(() => state.getMessage(secondId).state === MESSAGE_STATES.REPLIED);
  assert.deepEqual(dispatches, [secondId]);
  assert.deepEqual(observations, [firstId, secondId]);
  assert.equal(state.getMessage(firstId).state, MESSAGE_STATES.SUBMITTED);
  assert.deepEqual(replies, [{ messageId: secondId, nativeId: CODEX_ID, generation: 1, text: 'second restart answer' }]);
  releaseFirst({ text: 'first restart answer' });
  await waitForCondition(() => state.getMessage(firstId).state === MESSAGE_STATES.REPLIED);
  assert.deepEqual(replies, [
    { messageId: secondId, nativeId: CODEX_ID, generation: 1, text: 'second restart answer' },
    { messageId: firstId, nativeId: CODEX_ID, generation: 1, text: 'first restart answer' }
  ]);
  await gateway.stop();
  state.close();
});
