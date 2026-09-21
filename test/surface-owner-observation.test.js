const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { SurfaceState, MESSAGE_STATES } = require('../src/state');
const { createSurfaceConsumer, DiscordGateway } = require('../src/discord');
const { recordNativeAcknowledgment } = require('../src/acknowledgment');
const { CODEX_ID, CLAUDE_ID, CLI_PATH, fixture, discordMessage, waitForCondition, providers } = require('./surface-fixtures');

test('simulated: queued acknowledged observer releases its owner slot when started', async () => {
  const { dir, state } = fixture();
  state.bind({ channelId: 'channel-codex', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir });
  const firstId = 'ack-queued-first';
  const secondId = 'ack-queued-active';
  const thirdId = 'ack-queued-successor';
  for (const [id, content] of [[firstId, 'first'], [secondId, 'second'], [thirdId, 'third']]) {
    state.acceptDiscordMessage({ id, guildId: 'guild-1', channelId: 'channel-codex', authorId: 'operator-1', isBot: false, content });
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  state.claimDispatch(firstId);
  state.markSubmitted(firstId);
  recordNativeAcknowledgment(state, { messageId: firstId, nativeId: CODEX_ID, generation: 1, provider: 'codex' });
  const dispatches = [];
  const observations = [];
  const replies = [];
  let releaseSecond;
  let releaseFirst;
  const secondReply = new Promise(resolve => { releaseSecond = resolve; });
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
          observations.push(message.id);
          if (message.id === secondId) return secondReply;
          if (message.id === firstId) return firstReply;
          return { text: 'third answer' };
        }
      }
    },
    sendTransportReceipt: async () => ({ id: 'transport-receipt' }),
    sendReply: async (message, reply) => {
      replies.push({ messageId: message.id, nativeId: reply.nativeId, generation: reply.generation, text: reply.replyText });
      return { id: `reply-${replies.length}` };
    }
  });

  const secondWork = consumer.processAccepted(state.getMessage(secondId));
  await waitForCondition(() => observations.includes(secondId));
  const firstWork = consumer.resumeSubmitted(state.getMessage(firstId), undefined, { awaitExisting: false, continueUntilFinal: true });
  assert.equal((await firstWork).status, 'observing');
  const thirdWork = consumer.processAccepted(state.getMessage(thirdId));
  releaseSecond({ text: 'second answer' });
  await secondWork;
  await waitForCondition(() => observations.includes(firstId) && observations.includes(thirdId) && dispatches.includes(thirdId));
  await thirdWork;
  assert.deepEqual(dispatches, [secondId, thirdId]);
  assert.ok(observations.indexOf(firstId) < observations.indexOf(thirdId));
  assert.equal(state.getMessage(firstId).state, MESSAGE_STATES.SUBMITTED);
  assert.deepEqual(replies, [
    { messageId: secondId, nativeId: CODEX_ID, generation: 1, text: 'second answer' },
    { messageId: thirdId, nativeId: CODEX_ID, generation: 1, text: 'third answer' }
  ]);
  releaseFirst({ text: 'first answer' });
  await consumer.waitForNativeWork();
  assert.equal(state.getMessage(firstId).state, MESSAGE_STATES.REPLIED);
  assert.deepEqual(replies, [
    { messageId: secondId, nativeId: CODEX_ID, generation: 1, text: 'second answer' },
    { messageId: thirdId, nativeId: CODEX_ID, generation: 1, text: 'third answer' },
    { messageId: firstId, nativeId: CODEX_ID, generation: 1, text: 'first answer' }
  ]);
  state.close();
});

test('simulated: Claude CLI ACK releases a queued observer and exact reply custody', async () => {
  const { dir, db, state: initial } = fixture('claude-ack-queue.sqlite');
  const firstId = 'claude-ack-first';
  const secondId = 'claude-ack-second';
  const endpoint = path.join(dir, 'claude.sock');
  initial.bind({ channelId: 'channel-claude', guildId: 'guild-1', provider: 'claude', nativeId: CLAUDE_ID, workspace: dir, endpoint });
  initial.acceptDiscordMessage({ id: firstId, guildId: 'guild-1', channelId: 'channel-claude', authorId: 'operator-1', isBot: false, content: 'first' });
  await new Promise(resolve => setTimeout(resolve, 2));
  initial.acceptDiscordMessage({ id: secondId, guildId: 'guild-1', channelId: 'channel-claude', authorId: 'operator-1', isBot: false, content: 'second' });
  initial.claimDispatch(firstId);
  initial.markSubmitted(firstId);
  initial.close();

  const acknowledged = spawnSync(process.execPath, [
    CLI_PATH, 'native-ack', '--state-dir', dir, '--db', db, '--provider', 'claude',
    '--message-id', firstId, '--native-id', CLAUDE_ID, '--generation', '1'
  ], { encoding: 'utf8' });
  assert.equal(acknowledged.status, 0, acknowledged.stderr);

  const state = new SurfaceState(db);
  const observations = [];
  const dispatches = [];
  const replies = [];
  let releaseSecond;
  let releaseFirst;
  const secondReply = new Promise(resolve => { releaseSecond = resolve; });
  const firstReply = new Promise(resolve => { releaseFirst = resolve; });
  const consumer = createSurfaceConsumer({
    state,
    providers: {
      claude: {
        async dispatch(message) {
          dispatches.push(message.id);
          return { status: 'submitted' };
        },
        async observe(message) {
          observations.push(message.id);
          if (message.id === firstId) return firstReply;
          return secondReply;
        }
      }
    },
    sendTransportReceipt: async () => ({ id: 'transport-receipt' }),
    sendReply: async (message, reply) => {
      replies.push({ messageId: message.id, nativeId: reply.nativeId, generation: reply.generation, text: reply.replyText });
      return { id: `reply-${replies.length}` };
    }
  });

  const secondWork = consumer.processAccepted(state.getMessage(secondId));
  await waitForCondition(() => observations.includes(secondId));
  const firstWork = consumer.resumeSubmitted(state.getMessage(firstId), undefined, { awaitExisting: false, continueUntilFinal: true });
  assert.equal((await firstWork).status, 'observing');
  releaseSecond({ text: 'second Claude answer' });
  await secondWork;
  await waitForCondition(() => observations.includes(firstId));

  const replyFile = path.join(dir, 'claude-answer.txt');
  fs.writeFileSync(replyFile, 'first Claude answer');
  const recorded = spawnSync(process.execPath, [
    CLI_PATH, 'claude-reply', '--state-dir', dir, '--db', db, '--message-id', firstId,
    '--native-id', CLAUDE_ID, '--generation', '1', '--text-file', replyFile
  ], { encoding: 'utf8' });
  assert.equal(recorded.status, 0, recorded.stderr);
  assert.deepEqual(JSON.parse(recorded.stdout), { messageId: firstId, recorded: true, duplicate: false, state: 'reply_ready' });
  releaseFirst({ text: 'first Claude answer' });
  await consumer.waitForNativeWork();
  assert.equal(state.getMessage(firstId).state, MESSAGE_STATES.REPLIED);
  assert.deepEqual(dispatches, [secondId]);
  assert.deepEqual(replies, [
    { messageId: secondId, nativeId: CLAUDE_ID, generation: 1, text: 'second Claude answer' },
    { messageId: firstId, nativeId: CLAUDE_ID, generation: 1, text: 'first Claude answer' }
  ]);
  state.close();
});

test('simulated: Gateway ACK watcher wires native ACK into owner queue release', async () => {
  async function runScenario(disconnectRelease) {
    const { dir, db, state } = fixture(disconnectRelease ? 'gateway-ack-disconnected.sqlite' : 'gateway-ack-wired.sqlite');
    const firstId = disconnectRelease ? 'gateway-ack-disconnected-first' : 'gateway-ack-wired-first';
    const secondId = disconnectRelease ? 'gateway-ack-disconnected-second' : 'gateway-ack-wired-second';
    const secretFile = path.join(dir, 'discord.secret');
    fs.writeFileSync(secretFile, 'DISCORD_TOKEN=fixture-token\n', { mode: 0o600 });
    state.bind({ channelId: 'channel-codex', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir });
    state.acceptDiscordMessage({ id: firstId, guildId: 'guild-1', channelId: 'channel-codex', authorId: 'operator-1', isBot: false, content: 'first' });
    await new Promise(resolve => setTimeout(resolve, 2));
    state.acceptDiscordMessage({ id: secondId, guildId: 'guild-1', channelId: 'channel-codex', authorId: 'operator-1', isBot: false, content: 'second' });
    state.claimDispatch(firstId);
    state.markSubmitted(firstId);
    const observations = [];
    const dispatches = [];
    const replies = [];
    let releaseFirst;
    const channel = {
      messages: { fetch: async () => ({ react: async () => {} }) },
      async send(payload) {
        if (!String(payload.content || '').startsWith('Receipt:')) replies.push({ content: payload.content });
        return { id: `gateway-reply-${replies.length}` };
      }
    };
    const listeners = new Map();
    const client = {
      user: { id: 'bot-1' },
      on(name, listener) { listeners.set(name, listener); },
      off(name, listener) { if (listeners.get(name) === listener) listeners.delete(name); },
      async login(token) { assert.equal(token, 'fixture-token'); },
      channels: { fetch: async () => channel },
      async destroy() {}
    };
    const gateway = new DiscordGateway({
      state,
      client,
      providers: {
        codex: {
          async dispatch(message) {
            dispatches.push(message.id);
            return { status: 'submitted' };
          },
          async observe(message, _outcome, { signal }) {
            observations.push(message.id);
            if (message.id === firstId) {
              return new Promise(resolve => {
                const finish = value => {
                  signal?.removeEventListener('abort', onAbort);
                  resolve(value);
                };
                const onAbort = () => finish({ stopped: true });
                if (signal?.aborted) onAbort();
                else {
                  signal?.addEventListener('abort', onAbort, { once: true });
                  releaseFirst = value => finish(value);
                }
              });
            }
            return { text: 'second Gateway answer' };
          }
        }
      }
    });
    gateway.recoverTransport = async () => {
      gateway.ready = true;
      return { ready: true, state: 'ready' };
    };
    let firstWork;
    let secondWork;
    try {
      await gateway.start(secretFile);
      await gateway.acknowledgments.drain();
      firstWork = gateway.consumer.resumeSubmitted(state.getMessage(firstId), undefined, { continueUntilFinal: false });
      await waitForCondition(() => observations.includes(firstId));
      secondWork = gateway.consumer.processAccepted(state.getMessage(secondId));
      await new Promise(resolve => setImmediate(resolve));
      if (disconnectRelease) {
        gateway.consumer.releaseAcknowledged = () => false;
        gateway.consumer.resumeSubmitted = () => Promise.resolve({ status: 'suppressed', message: state.getMessage(firstId) });
      }
      const acknowledged = spawnSync(process.execPath, [
        CLI_PATH, 'native-ack', '--state-dir', dir, '--db', db, '--provider', 'codex',
        '--message-id', firstId, '--native-id', CODEX_ID, '--generation', '1'
      ], { encoding: 'utf8' });
      assert.equal(acknowledged.status, 0, acknowledged.stderr);
      if (disconnectRelease) {
        await new Promise(resolve => setTimeout(resolve, 200));
        assert.deepEqual(dispatches, []);
        assert.equal(state.getMessage(secondId).state, MESSAGE_STATES.ACCEPTED);
        return { dispatches, secondState: state.getMessage(secondId).state, replies };
      }
      await waitForCondition(() => dispatches.includes(secondId), 2000);
      await secondWork;
      assert.equal(state.getMessage(firstId).state, MESSAGE_STATES.SUBMITTED);
      assert.equal(state.getMessage(secondId).state, MESSAGE_STATES.REPLIED);
      assert.deepEqual(replies, [{ content: 'second Gateway answer' }]);
      releaseFirst({ text: 'first Gateway answer' });
      await firstWork;
      assert.equal(state.getMessage(firstId).state, MESSAGE_STATES.REPLIED);
      return { dispatches, secondState: state.getMessage(secondId).state, replies };
    } finally {
      await gateway.stop();
      state.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  const wired = await runScenario(false);
  assert.deepEqual(wired.dispatches, ['gateway-ack-wired-second']);
  assert.equal(wired.secondState, MESSAGE_STATES.REPLIED);
  const disconnected = await runScenario(true);
  assert.deepEqual(disconnected.dispatches, []);
  assert.equal(disconnected.secondState, MESSAGE_STATES.ACCEPTED);
});

test('simulated: stopped owner queue ignores a late acknowledged release', async () => {
  const { dir, state } = fixture();
  state.bind({ channelId: 'channel-codex', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir });
  const firstId = 'ack-stop-first';
  const secondId = 'ack-stop-second';
  const dispatches = [];
  let consumer;
  let firstObserveStartedResolve;
  const firstObserveStarted = new Promise(resolve => { firstObserveStartedResolve = resolve; });
  consumer = createSurfaceConsumer({
    state,
    providers: {
      codex: {
        async dispatch(message) {
          dispatches.push(message.id);
          return { status: 'submitted' };
        },
        async observe(message, _outcome, { signal }) {
          if (message.id === firstId) {
            recordNativeAcknowledgment(state, { messageId: firstId, nativeId: CODEX_ID, generation: 1, provider: 'codex' });
            firstObserveStartedResolve();
            return new Promise(resolve => signal.addEventListener('abort', () => resolve({ stopped: true }), { once: true }));
          }
          return { text: 'unexpected successor answer' };
        }
      }
    },
    sendTransportReceipt: async () => ({ id: 'transport-receipt' }),
    sendReply: async () => ({ id: 'unexpected-reply' })
  });
  const first = consumer.handleMessage(discordMessage({ id: firstId, channelId: 'channel-codex' }));
  await firstObserveStarted;
  const second = consumer.handleMessage(discordMessage({ id: secondId, channelId: 'channel-codex' }));
  await new Promise(resolve => setImmediate(resolve));
  consumer.abortNativeWork();
  assert.equal(consumer.releaseAcknowledged(firstId), false);
  const secondResult = await second;
  const firstResult = await first;
  assert.equal(secondResult.status, 'stopped');
  assert.equal(firstResult.message.state, MESSAGE_STATES.SUBMITTED);
  assert.deepEqual(dispatches, [firstId]);
  state.close();
});
