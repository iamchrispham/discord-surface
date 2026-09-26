const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { MESSAGE_STATES } = require('../src/state');
const { DiscordGateway } = require('../src/discord');
const { CODEX_ID, SUCCESSOR_ID, fixture, discordMessage, historyPermissions, providers } = require('./surface-fixtures');

function setupGateway() {
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
    async send() { return { id: 'reply-manual' }; }
  };
  const client = {
    user: { id: 'bot-1' },
    on(name, fn) { listeners.set(name, fn); },
    off(name, fn) { if (listeners.get(name) === fn) listeners.delete(name); },
    async login() {},
    channels: { fetch: async () => channel },
    async destroy() {}
  };
  const calls = { codex: 0, claude: 0 };
  let dispatchCount = 0;
  const gateway = new DiscordGateway({ state, client, fetchHistory: async () => [], providers: providers({ calls }) });
  gateway.providers.codex.dispatch = async () => { dispatchCount += 1; return { status: 'submitted' }; };
  return { dir, state, secret, listeners, channel, gateway, dispatchCount: () => dispatchCount };
}

function cleanup(t, { dir, state, gateway }) {
  t.after(async () => {
    await gateway.stop().catch(() => {});
    state.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

test('simulated: rejected gateway start must fence later live native dispatch', { timeout: 8000 }, async t => {
  const env = setupGateway();
  cleanup(t, env);
  const { state, secret, listeners, channel, gateway } = env;
  const bindingBefore = state.getBinding('channel-codex');
  gateway.recoverTransport = async () => {
    gateway.ready = true;
    throw new Error('fixture startup recovery refused');
  };
  await assert.rejects(gateway.start(secret), /fixture startup recovery refused/);

  listeners.get('messageCreate')({ ...discordMessage({ id: '900', channelId: 'channel-codex' }), channel });
  await Promise.all([...gateway.inFlight]);

  await t.test('live input is not natively dispatched after failed start', async () => {
    assert.equal(env.dispatchCount(), 0);
  });

  await t.test('live input after failed start stays in custody', async () => {
    assert.equal(state.getMessage('900').state, MESSAGE_STATES.ACCEPTED);
  });

  await t.test('failed start leaves the gateway not live-ready', async () => {
    assert.equal(gateway.ready, false);
  });

  await t.test('failed start leaves the binding identity and generation unchanged', async () => {
    assert.deepEqual(state.getBinding('channel-codex'), bindingBefore);
  });

  await t.test('failed start leaves the transport not ready', async () => {
    assert.equal(gateway.transportReady, false);
  });
});

test('simulated: successful gateway start dispatches live native input to completion', { timeout: 8000 }, async t => {
  const env = setupGateway();
  cleanup(t, env);
  const { state, secret, listeners, channel, gateway } = env;
  gateway.recoverTransport = async () => {
    gateway.ready = true;
    return { ready: true, state: 'ready' };
  };
  await gateway.start(secret);

  listeners.get('messageCreate')({ ...discordMessage({ id: '902', channelId: 'channel-codex' }), channel });
  await Promise.all([...gateway.inFlight]);

  assert.equal(env.dispatchCount(), 1);
  assert.equal(state.getMessage('902').state, MESSAGE_STATES.REPLIED);
});

test('simulated: a throw after a start became ready leaves no live dispatch and restart dispatches once', { timeout: 8000 }, async t => {
  const env = setupGateway();
  cleanup(t, env);
  const { state, secret, listeners, channel, gateway } = env;
  gateway.recoverTransport = async () => {
    gateway.ready = true;
    return { ready: true, state: 'ready' };
  };
  let reachedLive = null;
  gateway.schedulePendingHandoffRecoveryPoll = () => {
    reachedLive = { ready: gateway.ready, transportReady: gateway.transportReady, started: gateway.started };
    throw new Error('fixture poll setup refused');
  };

  await assert.rejects(gateway.start(secret), /fixture poll setup refused/);

  assert.deepEqual(reachedLive, { ready: true, transportReady: true, started: true });
  assert.equal(gateway.ready, false);
  assert.equal(gateway.transportReady, false);
  assert.equal(gateway.started, false);

  listeners.get('messageCreate')({ ...discordMessage({ id: '900', channelId: 'channel-codex' }), channel });
  await Promise.all([...gateway.inFlight]);
  assert.equal(env.dispatchCount(), 0);
  assert.equal(state.getMessage('900').state, MESSAGE_STATES.ACCEPTED);
  assert.equal(state.hasNativeAcknowledgment(state.getMessage('900')), false);

  delete gateway.schedulePendingHandoffRecoveryPoll;
  await gateway.start(secret);

  state.bind({ channelId: 'channel-successor', guildId: 'guild-1', provider: 'codex', nativeId: SUCCESSOR_ID, workspace: env.dir });
  const successorChannel = { ...channel, id: 'channel-successor' };
  listeners.get('messageCreate')({ ...discordMessage({ id: '903', channelId: 'channel-successor' }), channel: successorChannel });
  await Promise.all([...gateway.inFlight]);
  assert.equal(env.dispatchCount(), 1);
  assert.equal(state.getMessage('903').state, MESSAGE_STATES.REPLIED);
});
