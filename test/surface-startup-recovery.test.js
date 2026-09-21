const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { MESSAGE_STATES, READINESS } = require('../src/state');
const { DiscordGateway } = require('../src/discord');
const { CODEX_ID, fixture, discordMessage, historyPermissions, waitForCondition, providers } = require('./surface-fixtures');

test('simulated: gateway stop waits for abortable startup recovery before state close', async () => {
  const { dir, state } = fixture();
  state.bind({ channelId: 'channel-codex', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir });
  const secret = path.join(dir, 'discord.env');
  fs.writeFileSync(secret, 'DISCORD_TOKEN=fake-token\n', { mode: 0o600 });
  const listeners = new Map();
  let destroyed = false;
  const client = {
    user: { id: 'bot-1' },
    on(name, fn) { listeners.set(name, fn); },
    off(name, fn) { if (listeners.get(name) === fn) listeners.delete(name); },
    async login() {},
    channels: { fetch: async () => ({ id: 'channel-codex', permissionsFor: () => historyPermissions() }) },
    async destroy() { destroyed = true; }
  };
  const fetchHistory = async (_channel, { signal }) => new Promise(resolve => {
    signal.addEventListener('abort', () => resolve([]), { once: true });
  });
  const gateway = new DiscordGateway({ state, client, fetchHistory });
  const starting = gateway.start(secret);
  await new Promise(resolve => setImmediate(resolve));
  await gateway.stop();
  await assert.rejects(starting, /startup was stopped/);
  assert.equal(destroyed, true);
  state.close();
});

test('simulated: login-time input is durably held and backfill closes before dispatch', async () => {
  const { dir, state } = fixture();
  state.bind({ channelId: 'channel-codex', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir });
  const secret = path.join(dir, 'discord.env');
  fs.writeFileSync(secret, 'DISCORD_TOKEN=fake-token\n', { mode: 0o600 });
  const listeners = new Map();
  const channel = {
    id: 'channel-codex',
    guildId: 'guild-1',
    topic: '',
    permissionsFor: () => historyPermissions(),
    messages: { fetch: async () => ({ react: async () => {} }) },
    async send() { return { id: 'reply-login-input' }; }
  };
  const client = {
    user: { id: 'bot-1' },
    on(name, fn) { listeners.set(name, fn); },
    off(name, fn) { if (listeners.get(name) === fn) listeners.delete(name); },
    async login() { await listeners.get('messageCreate')({ ...discordMessage({ id: '101', channelId: 'channel-codex' }), channel }); },
    channels: { fetch: async () => channel },
    async destroy() {}
  };
  const history = [];
  const gateway = new DiscordGateway({
    state,
    client,
    fetchHistory: async (_channel, options) => {
      history.push(options);
      if (options.limit === 1) return [{ id: '100', guildId: 'guild-1', channelId: 'channel-codex', author: { id: 'old', bot: false }, content: 'before adoption' }];
      if (options.after === '100') return [{ id: '101', guildId: 'guild-1', channelId: 'channel-codex', author: { id: 'operator-1', bot: false }, content: 'held live input' }];
      if (options.after === '101') return [];
      throw new Error(`unexpected history cursor ${options.after}`);
    },
    providers: {
      codex: { async dispatch() { return { status: 'submitted' }; }, async observe() { return { text: 'answer after recovery' }; } }
    }
  });
  await gateway.start(secret);
  assert.equal(state.getMessage('101').state, MESSAGE_STATES.ACCEPTED);
  assert.equal(state.getBinding('channel-codex').readiness, READINESS.READY);
  assert.equal(state.getIntakeWatermark('channel-codex').last_seen_id, '101');
  assert.equal(channel.topic, '');
  await gateway.reconcilePending();
  await waitForCondition(() => state.getMessage('101').state === MESSAGE_STATES.REPLIED);
  assert.equal(state.getMessage('101').state, MESSAGE_STATES.REPLIED);
  await listeners.get('resume')();
  assert.equal(state.getBinding('channel-codex').readiness, READINESS.READY);
  assert.equal(history.length, 3);
  await gateway.stop();
  state.close();
});

test('simulated: bounded intake recovery records a visible gap and requires explicit reconciliation', async () => {
  const { dir, state } = fixture();
  state.bind({ channelId: 'channel-codex', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir });
  const secret = path.join(dir, 'discord.env');
  fs.writeFileSync(secret, 'DISCORD_TOKEN=fake-token\n', { mode: 0o600 });
  const client = { user: { id: 'bot-1' }, on() {}, off() {}, async login() {}, channels: { fetch: async () => ({ id: 'channel-codex', permissionsFor: () => historyPermissions() }) }, async destroy() {} };
  const gateway = new DiscordGateway({
    state,
    client,
    recoveryOptions: { pageLimit: 2, maxPages: 1 },
    fetchHistory: async (_channel, options) => options.limit === 1
      ? [{ id: '100', guildId: 'guild-1', channelId: 'channel-codex', author: { id: 'old', bot: false }, content: 'before adoption' }]
      : [
        { id: '101', guildId: 'guild-1', channelId: 'channel-codex', author: { id: 'operator-1', bot: false }, content: 'one' },
        { id: '102', guildId: 'guild-1', channelId: 'channel-codex', author: { id: 'operator-1', bot: false }, content: 'two' }
      ]
  });
  await assert.rejects(() => gateway.start(secret), /intake recovery is gap/);
  assert.equal(state.getBinding('channel-codex').readiness, READINESS.GAP);
  assert.equal(state.getReadiness().limits.connectionBackfill, 'unrecoverable-gap');
  assert.equal(state.getIntakeWatermark('channel-codex').state, 'gap');
  state.reconcileIntake('channel-codex');
  assert.equal(state.getBinding('channel-codex').readiness, READINESS.PENDING);
  await gateway.stop();
  state.close();
});

test('simulated: stop fences a client login that resolves after state close', async () => {
  const { dir, state } = fixture();
  state.bind({ channelId: 'channel-codex', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir });
  const secret = path.join(dir, 'discord.env');
  fs.writeFileSync(secret, 'DISCORD_TOKEN=fake-token\n', { mode: 0o600 });
  const listeners = new Map();
  let releaseLogin;
  let destroyed = false;
  const client = {
    user: { id: 'bot-1' },
    on(name, fn) { listeners.set(name, fn); },
    off(name, fn) { if (listeners.get(name) === fn) listeners.delete(name); },
    login: async () => new Promise(resolve => { releaseLogin = resolve; }),
    channels: { fetch: async () => ({ id: 'channel-codex', permissionsFor: () => historyPermissions() }) },
    async destroy() { destroyed = true; }
  };
  const gateway = new DiscordGateway({ state, client, fetchHistory: async () => [] });
  const starting = gateway.start(secret);
  await new Promise(resolve => setImmediate(resolve));
  await gateway.stop();
  state.close();
  releaseLogin();
  await assert.rejects(starting, /startup was stopped during login/);
  assert.equal(destroyed, true);
  assert.equal(listeners.has('messageCreate'), false);
});

test('simulated: live custody stays ahead of confirmed history coverage without losing older input', async () => {
  const { dir, state } = fixture();
  state.bind({ channelId: 'channel-codex', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir });
  state.setIntakeBaseline('channel-codex', '100', 'previous completed recovery');
  state.markIntakeBoundary('channel-codex', 'ready');
  const secret = path.join(dir, 'discord.env');
  fs.writeFileSync(secret, 'DISCORD_TOKEN=fake-token\n', { mode: 0o600 });
  const listeners = new Map();
  const channel = { id: 'channel-codex', guildId: 'guild-1', topic: '', permissionsFor: () => historyPermissions() };
  const client = {
    user: { id: 'bot-1' },
    on(name, fn) { listeners.set(name, fn); },
    off(name, fn) { if (listeners.get(name) === fn) listeners.delete(name); },
    async login() { listeners.get('messageCreate')(discordMessage({ id: '200', channelId: 'channel-codex' })); },
    channels: { fetch: async () => channel },
    async destroy() {}
  };
  const requestedAfters = [];
  const gateway = new DiscordGateway({
    state,
    client,
    fetchHistory: async (_channel, options) => {
      requestedAfters.push(options.after || null);
      if (options.after === '100') return [
        { id: '200', guildId: 'guild-1', channelId: 'channel-codex', author: { id: 'operator-1', bot: false }, content: 'live duplicate' },
        { id: '101', guildId: 'guild-1', channelId: 'channel-codex', author: { id: 'operator-1', bot: false }, content: 'older history' }
      ];
      return [];
    }
  });
  await gateway.start(secret);
  assert.ok(state.getMessage('101'));
  assert.ok(state.getMessage('200'));
  assert.deepEqual(requestedAfters, ['100']);
  assert.equal(state.getIntakeWatermark('channel-codex').last_seen_id, '200');
  assert.equal(state.getIntakeWatermark('channel-codex').recovered_through_id, '200');
  assert.equal(gateway.ready, true);
  await gateway.stop();
  state.close();
});

test('simulated: live custody recovery never patches the static address topic', async () => {
  const { dir, state } = fixture();
  state.bind({ channelId: 'channel-codex', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir });
  state.setIntakeBaseline('channel-codex', '100', 'previous completed recovery');
  state.markIntakeBoundary('channel-codex', 'ready');
  const secret = path.join(dir, 'discord.env');
  fs.writeFileSync(secret, 'DISCORD_TOKEN=fake-token\n', { mode: 0o600 });
  const listeners = new Map();
  let topicWrites = 0;
  const channel = {
    id: 'channel-codex',
    guildId: 'guild-1',
    topic: '',
    permissionsFor: () => historyPermissions(),
    async setTopic() { topicWrites += 1; throw new Error('static D6 topic must not be patched'); }
  };
  const client = {
    user: { id: 'bot-1' },
    on(name, fn) { listeners.set(name, fn); },
    off(name, fn) { if (listeners.get(name) === fn) listeners.delete(name); },
    async login() {},
    channels: { fetch: async () => channel },
    async destroy() {}
  };
  const gateway = new DiscordGateway({ state, client, fetchHistory: async () => [] });
  await gateway.start(secret);
  assert.equal(topicWrites, 0);
  assert.equal(state.getIntakeWatermark('channel-codex').recovered_through_id, '100');
  assert.equal(state.getIntakeWatermark('channel-codex').state, 'ready');
  await gateway.stop();
  state.close();
});

test('simulated: noncooperative history fetch is fenced by the recovery deadline and stop', async () => {
  const { dir, state } = fixture();
  state.bind({ channelId: 'channel-codex', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir });
  state.setIntakeBaseline('channel-codex', '100', 'previous completed recovery');
  state.markIntakeBoundary('channel-codex', 'ready');
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const client = {
    user: { id: 'bot-1' },
    on() {},
    off() {},
    channels: { fetch: async () => ({ id: 'channel-codex', permissionsFor: () => historyPermissions() }) },
    async destroy() {}
  };
  const gateway = new DiscordGateway({ state, client, recoveryOptions: { timeoutMs: 1000 }, fetchHistory: async () => blocked });
  const started = performance.now();
  const recovery = gateway.recoverTransport('startup');
  await assert.doesNotReject(async () => {
    const result = await recovery;
    assert.equal(result.ready, false);
    assert.equal(result.state, 'gap');
  });
  const elapsed = performance.now() - started;
  await gateway.stop();
  release([]);
  assert.ok(elapsed < 1500, `recovery exceeded bounded wait: ${elapsed}ms`);
  assert.equal(state.getIntakeWatermark('channel-codex').state, 'gap');
  state.close();
});
