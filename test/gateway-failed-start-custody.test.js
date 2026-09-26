const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { MESSAGE_STATES } = require('../src/state');
const { DiscordGateway } = require('../src/discord');
const { CODEX_ID, fixture, discordMessage, historyPermissions, providers, waitForCondition } = require('./surface-fixtures');

// T1 documents a known custody gap: a rejected DiscordGateway.start() currently
// leaves gateway.ready=true (set by recoverTransport before it threw) and later
// live input is natively dispatched and stored as REPLIED. 3 of the 5 T1
// assertions are pinned as { todo } sibling subtests pending the
// start-failure-cleanup fix; they stay TODO until a rejected start() clears
// ready. The other 2 already hold and stay hard. test.todo() at whole-test level
// is deliberately not used: it would skip the shared setup and hard assertions.

test('simulated: rejected gateway start must fence later live native dispatch', async t => {
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
  t.after(async () => {
    await gateway.stop().catch(() => {});
    state.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const bindingBefore = state.getBinding('channel-codex');
  gateway.recoverTransport = async () => {
    gateway.ready = true;
    throw new Error('fixture startup recovery refused');
  };
  await assert.rejects(gateway.start(secret), /fixture startup recovery refused/);

  listeners.get('messageCreate')({ ...discordMessage({ id: '900', channelId: 'channel-codex' }), channel });
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setTimeout(resolve, 50));

  await t.test('live input is not natively dispatched after failed start', { todo: 'TODO F1: failed startup must fence native dispatch' }, async () => {
    assert.equal(dispatchCount, 0);
  });

  await t.test('live input after failed start stays in custody', { todo: 'TODO F1: failed startup must fence native dispatch' }, async () => {
    assert.equal(state.getMessage('900').state, MESSAGE_STATES.ACCEPTED);
  });

  await t.test('failed start leaves the gateway not live-ready', { todo: 'TODO F1: failed startup must fence native dispatch' }, async () => {
    assert.equal(gateway.ready, false);
  });

  await t.test('failed start leaves the binding identity and generation unchanged', async () => {
    assert.deepEqual(state.getBinding('channel-codex'), bindingBefore);
  });

  await t.test('failed start leaves the transport not ready', async () => {
    assert.equal(gateway.transportReady, false);
  });
});

test('simulated: successful gateway start dispatches live native input to completion', async t => {
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
  t.after(async () => {
    await gateway.stop().catch(() => {});
    state.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  gateway.recoverTransport = async () => {
    gateway.ready = true;
    return { ready: true, state: 'ready' };
  };
  await gateway.start(secret);

  listeners.get('messageCreate')({ ...discordMessage({ id: '902', channelId: 'channel-codex' }), channel });
  await waitForCondition(() => dispatchCount === 1 && state.getMessage('902')?.state === MESSAGE_STATES.REPLIED, 2000);

  assert.equal(dispatchCount, 1);
  assert.equal(state.getMessage('902').state, MESSAGE_STATES.REPLIED);
});
