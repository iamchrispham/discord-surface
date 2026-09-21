const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { SurfaceState, MESSAGE_STATES } = require('../src/state');
const { createSurfaceConsumer, DiscordGateway } = require('../src/discord');
const { CODEX_ID, fixture, discordMessage, waitForCondition, providers } = require('./surface-fixtures');

test('simulated: gateway owner queue orders recovered and live inputs during recovery', async () => {
  const { dir, db, state: initial } = fixture();
  let state = initial;
  state.bind({ channelId: 'channel-codex', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir });
  state.acceptDiscordMessage({ id: 'old-A', guildId: 'guild-1', channelId: 'channel-codex', authorId: 'operator-1', isBot: false, content: 'old A' });
  await new Promise(resolve => setTimeout(resolve, 2));
  state.acceptDiscordMessage({ id: 'old-B', guildId: 'guild-1', channelId: 'channel-codex', authorId: 'operator-1', isBot: false, content: 'old B' });
  state.close();
  state = new SurfaceState(db);

  const dispatches = [];
  const observations = [];
  const releases = new Map();
  const sends = [];
  let fetchCount = 0;
  let releaseSecondFetch;
  const secondFetch = new Promise(resolve => { releaseSecondFetch = resolve; });
  const channel = {
    messages: { fetch: async () => ({ react: async () => {} }) },
    async send(payload) {
      sends.push(payload);
      return { id: `sent-${sends.length}` };
    }
  };
  const client = new EventEmitter();
  client.channels = {
    fetch: async () => {
      fetchCount += 1;
      if (fetchCount === 2) await secondFetch;
      return channel;
    }
  };
  client.destroy = async () => {};
  const gateway = new DiscordGateway({
    state,
    client,
    providers: {
      codex: {
        async dispatch(message) {
          dispatches.push(message.id);
          return { status: 'submitted' };
        },
        async observe(message) {
          observations.push(message.id);
          return new Promise(resolve => releases.set(message.id, resolve));
        }
      }
    }
  });
  gateway.ready = true;

  const recovery = gateway.reconcilePending(new Date(Date.now() + 1).toISOString());
  await waitForCondition(() => observations.includes('old-A'));
  client.emit('messageCreate', discordMessage({ id: 'live-C', channelId: 'channel-codex', content: 'live C', sends }));
  await waitForCondition(() => state.getMessage('live-C')?.state === MESSAGE_STATES.ACCEPTED);
  assert.deepEqual(dispatches, ['old-A']);
  releaseSecondFetch();
  await recovery;
  assert.deepEqual(dispatches, ['old-A']);

  releases.get('old-A')({ text: 'answer A' });
  await waitForCondition(() => observations.includes('old-B'));
  assert.deepEqual(dispatches, ['old-A', 'old-B']);
  releases.get('old-B')({ text: 'answer B' });
  await waitForCondition(() => observations.includes('live-C'));
  assert.deepEqual(dispatches, ['old-A', 'old-B', 'live-C']);
  releases.get('live-C')({ text: 'answer C' });
  await waitForCondition(() => state.getMessage('live-C').state === MESSAGE_STATES.REPLIED);
  assert.deepEqual(observations, ['old-A', 'old-B', 'live-C']);
  assert.deepEqual(sends.filter(payload => ['answer A', 'answer B', 'answer C'].includes(payload.content)).map(payload => payload.content), ['answer A', 'answer B', 'answer C']);
  await gateway.stop();
  state.close();
});

test('simulated: live same-owner inputs keep durable FIFO order', async () => {
  const { dir, state } = fixture();
  state.bind({ channelId: 'channel-codex', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir });
  const dispatches = [];
  const observations = [];
  const releases = new Map();
  const client = new EventEmitter();
  client.destroy = async () => {};
  client.channels = { fetch: async () => ({ messages: { fetch: async () => ({ react: async () => {} }) }, async send() { return { id: 'unused' }; } }) };
  const gateway = new DiscordGateway({
    state,
    client,
    providers: {
      codex: {
        async dispatch(message) {
          dispatches.push(message.id);
          return { status: 'submitted' };
        },
        async observe(message) {
          observations.push(message.id);
          return new Promise(resolve => releases.set(message.id, resolve));
        }
      }
    }
  });
  gateway.ready = true;

  client.emit('messageCreate', discordMessage({ id: 'live-one', channelId: 'channel-codex' }));
  await waitForCondition(() => observations.includes('live-one'));
  await new Promise(resolve => setTimeout(resolve, 2));
  client.emit('messageCreate', discordMessage({ id: 'live-two', channelId: 'channel-codex' }));
  await new Promise(resolve => setTimeout(resolve, 2));
  client.emit('messageCreate', discordMessage({ id: 'live-three', channelId: 'channel-codex' }));
  await waitForCondition(() => state.getMessage('live-three')?.state === MESSAGE_STATES.ACCEPTED);
  assert.deepEqual(dispatches, ['live-one']);

  releases.get('live-one')({ text: 'one' });
  await waitForCondition(() => observations.includes('live-two'));
  releases.get('live-two')({ text: 'two' });
  await waitForCondition(() => observations.includes('live-three'));
  releases.get('live-three')({ text: 'three' });
  await waitForCondition(() => state.getMessage('live-three').state === MESSAGE_STATES.REPLIED);
  assert.deepEqual(dispatches, ['live-one', 'live-two', 'live-three']);
  assert.deepEqual(observations, ['live-one', 'live-two', 'live-three']);
  await gateway.stop();
  state.close();
});

test('simulated: same-owner retry keeps equal-time admission order', async () => {
  const { dir, state } = fixture();
  state.bind({ channelId: 'channel-codex', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir });
  const firstId = 'retry-order-first';
  const secondId = 'retry-order-second';
  const thirdId = 'retry-order-third';
  for (const id of [firstId, secondId, thirdId]) {
    state.acceptDiscordMessage({ id, guildId: 'guild-1', channelId: 'channel-codex', authorId: 'operator-1', isBot: false, content: id });
  }
  const createdAt = '2026-01-01T00:00:00.000Z';
  for (const id of [firstId, secondId, thirdId]) state.db.prepare('UPDATE messages SET created_at=? WHERE discord_id=?').run(createdAt, id);
  const dispatches = [];
  let firstAttempt = true;
  const consumer = createSurfaceConsumer({
    state,
    providers: {
      codex: {
        async dispatch(message) {
          dispatches.push(message.id);
          if (message.id === firstId && firstAttempt) {
            firstAttempt = false;
            return { status: 'not_submitted', error: new Error('temporary native outage') };
          }
          return { status: 'submitted' };
        },
        async observe() { return { text: 'answer' }; }
      }
    },
    sendReply: async () => ({ id: 'reply' })
  });

  await consumer.processAccepted(state.getMessage(firstId));
  const second = consumer.processAccepted(state.getMessage(secondId));
  const third = consumer.processAccepted(state.getMessage(thirdId));
  const firstRetry = consumer.processAccepted(state.getMessage(firstId));
  await Promise.all([firstRetry, second, third]);
  assert.deepEqual(dispatches, [firstId, firstId, secondId, thirdId]);
  await consumer.waitForReceipts();
  state.close();
});

test('surface state keeps equal-time admission and recovery order under another query plan', () => {
  const { dir, db, state: initialState } = fixture();
  let state = initialState;
  const ids = ['z-equal-time-first', 'a-equal-time-second', 'm-equal-time-third'];
  try {
    state.bind({ channelId: 'channel-codex', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir });
    state.markIntakeBoundary('channel-codex', 'ready');
    for (const id of ids) {
      const result = state.acceptDiscordMessage({
        id, guildId: 'guild-1', channelId: 'channel-codex', authorId: 'operator-1', isBot: false, content: id
      }, { ready: true });
      assert.equal(result.accepted, true);
    }
    state.db.prepare('UPDATE messages SET created_at=?, updated_at=?').run('2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    state.close();
    state = new SurfaceState(db);
    state.setConfig({ operatorId: 'operator-1', guildId: 'guild-1', secretFile: path.join(dir, 'discord.secret') });
    state.db.exec('CREATE INDEX equal_time_desc ON messages(created_at DESC, discord_id DESC)');
    state.db.exec('ANALYZE');
    assert.deepEqual(state.listMessages().map(message => message.id), ids);
    assert.deepEqual(state.recoveryCandidates().map(message => message.id), ids);
  } finally {
    try { state.close(); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('simulated: recovered observer stop cancels custody without native redispatch', async () => {
  const { dir, state } = fixture();
  state.bind({ channelId: 'channel-codex', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir });
  state.acceptDiscordMessage({ id: 'submitted-recovery-stop', guildId: 'guild-1', channelId: 'channel-codex', authorId: 'operator-1', isBot: false, content: 'stop me' });
  state.claimDispatch('submitted-recovery-stop');
  state.markSubmitted('submitted-recovery-stop');
  let observations = 0;
  let stopped = 0;
  const client = {
    on() {},
    off() {},
    channels: { fetch: async () => ({ async send() { return { id: 'receipt-stop' }; } }) },
    async destroy() {}
  };
  const gateway = new DiscordGateway({
    state,
    client,
    providers: {
      codex: {
        async dispatch() { throw new Error('recovery stop must not redispatch'); },
        async observe(_message, _outcome, { signal }) {
          observations += 1;
          return new Promise(resolve => signal.addEventListener('abort', () => { stopped += 1; resolve({ stopped: true }); }, { once: true }));
        }
      }
    }
  });
  gateway.ready = true;
  await gateway.reconcilePending(new Date(Date.now() + 1).toISOString());
  assert.equal(observations, 1);
  await gateway.stop();
  assert.equal(stopped, 1);
  assert.equal(state.getMessage('submitted-recovery-stop').state, MESSAGE_STATES.SUBMITTED);
  state.close();
});

test('simulated: recovered observer rejects a late reply after owner revocation', async () => {
  const { dir, state } = fixture();
  state.bind({ channelId: 'channel-codex', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir });
  state.acceptDiscordMessage({ id: 'submitted-recovery-owner', guildId: 'guild-1', channelId: 'channel-codex', authorId: 'operator-1', isBot: false, content: 'owner fence' });
  state.claimDispatch('submitted-recovery-owner');
  state.markSubmitted('submitted-recovery-owner');
  let release;
  let sends = 0;
  const client = {
    on() {},
    off() {},
    channels: { fetch: async () => ({ async send() { sends += 1; return { id: 'unexpected-reply' }; } }) },
    async destroy() {}
  };
  const gateway = new DiscordGateway({
    state,
    client,
    providers: {
      codex: {
        async dispatch() { throw new Error('owner fence must not redispatch'); },
        async observe() { return new Promise(resolve => { release = resolve; }); }
      }
    }
  });
  gateway.ready = true;
  await gateway.reconcilePending(new Date(Date.now() + 1).toISOString());
  state.setConfig({ operatorId: 'revoked-owner', guildId: 'guild-1', secretFile: path.join(dir, 'discord.env') });
  release({ text: 'late after owner change' });
  for (let attempt = 0; attempt < 100 && state.getMessage('submitted-recovery-owner').state === MESSAGE_STATES.SUBMITTED; attempt += 1) await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal(state.getMessage('submitted-recovery-owner').state, MESSAGE_STATES.SUBMITTED);
  assert.equal(sends, 0);
  await gateway.stop();
  state.close();
});
