const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SurfaceState, StateCorruptError, MESSAGE_STATES } = require('../src/state');
const { dispatchAndObserve } = require('../src/native');
const { DiscordGateway, readSecret } = require('../src/discord');
const { conductorMarker, ensureProvisionedChannel } = require('../src/cli');
const { CODEX_ID, fixture, providers } = require('./surface-fixtures');

test('simulated: corrupted state fails closed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-surface-corrupt-'));
  const db = path.join(dir, 'surface.sqlite');
  fs.writeFileSync(db, 'this is not sqlite', { mode: 0o600 });
  assert.throws(() => new SurfaceState(db), StateCorruptError);
});

test('simulated: dispatch crash becomes uncertain and is never auto-repeated', async () => {
  const { dir, state } = fixture();
  state.bind({ channelId: 'channel-codex', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir });
  state.acceptDiscordMessage({ id: 'crash', guildId: 'guild-1', channelId: 'channel-codex', authorId: 'operator-1', isBot: false, content: 'x' });
  let dispatches = 0;
  const providersMap = { codex: { async dispatch() { dispatches += 1; throw new Error('crash after boundary'); } } };
  const first = await dispatchAndObserve(state, 'crash', providersMap);
  const second = await dispatchAndObserve(state, 'crash', providersMap);
  assert.equal(first.status, 'uncertain');
  assert.equal(second.status, MESSAGE_STATES.UNCERTAIN);
  assert.equal(dispatches, 1);
  state.close();
});

test('simulated: gateway stop detaches listener and destroys the native client', async () => {
  const { state } = fixture();
  const listeners = new Map();
  let destroyed = false;
  const client = {
    user: { id: 'bot-1' },
    on(name, fn) { listeners.set(name, fn); },
    off(name, fn) { if (listeners.get(name) === fn) listeners.delete(name); },
    async destroy() { destroyed = true; }
  };
  const gateway = new DiscordGateway({ state, client });
  await gateway.stop();
  assert.equal(destroyed, true);
  assert.equal(listeners.has('messageCreate'), false);
  state.close();
});

test('simulated: stopping the gateway settles an uncertain receipt without touching native custody', async () => {
  const { dir, state } = fixture();
  state.bind({ channelId: 'receipt-stop', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir, conductorId: 'receipt-stop-conductor', repoKey: 'repo:alpha' });
  state.markIntakeBoundary('receipt-stop', 'ready');
  const listeners = new Map();
  const channel = {
    async send(payload) {
      if (payload.content.startsWith('Receipt:')) return new Promise(() => {});
      return { id: 'native-reply' };
    }
  };
  const client = {
    user: { id: 'bot-1' },
    on(name, fn) { listeners.set(name, fn); },
    off(name, fn) { if (listeners.get(name) === fn) listeners.delete(name); },
    async destroy() {}
  };
  const gateway = new DiscordGateway({
    state,
    client,
    providers: { codex: { async dispatch() { return { status: 'submitted' }; }, async observe() { return { text: 'answer' }; } } }
  });
  gateway.ready = true;
  const message = { id: 'receipt-stop-input', guildId: 'guild-1', channelId: 'receipt-stop', content: 'hello', author: { id: 'operator-1', bot: false }, channel };
  const result = await gateway.consumer.handleMessage(message);
  assert.equal(result.message.state, MESSAGE_STATES.REPLIED);
  await gateway.stop();
  assert.equal(state.getTransportReceipt('receipt-stop-input').outcome.outcome, 'unknown');
  assert.equal(state.getMessage('receipt-stop-input').state, MESSAGE_STATES.REPLIED);
  state.close();
});

test('simulated: real-client receipt uses one abortable request without SDK send', async () => {
  const { dir, state } = fixture();
  state.bind({ channelId: 'receipt-http', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir, conductorId: 'receipt-http-conductor', repoKey: 'repo:alpha' });
  state.markIntakeBoundary('receipt-http', 'ready');
  const listeners = new Map();
  let fetchCalls = 0;
  let acknowledgmentFetches = 0;
  let capturedUrl;
  let capturedOptions;
  let capturedSignal;
  let channelSendCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (url, options) => {
    if (String(url).includes(encodeURIComponent('👀'))) {
      acknowledgmentFetches += 1;
      return Promise.resolve({ ok: true, status: 204 });
    }
    fetchCalls += 1;
    capturedUrl = url;
    capturedOptions = options;
    capturedSignal = options.signal;
    return new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(Object.assign(new Error('receipt request aborted'), { name: 'AbortError' })), { once: true });
    });
  };
  const channel = {
    id: 'receipt-http',
    async send() {
      channelSendCalls += 1;
      return { id: 'native-reply' };
    }
  };
  const client = {
    rest: {},
    user: { id: 'bot-1' },
    on(name, fn) { listeners.set(name, fn); },
    off(name, fn) { if (listeners.get(name) === fn) listeners.delete(name); },
    async destroy() {}
  };
  const gateway = new DiscordGateway({
    state,
    client,
    providers: { codex: { async dispatch() { return { status: 'submitted' }; }, async observe() { return { text: 'answer' }; } } }
  });
  gateway.discordToken = 'fake-token';
  gateway.ready = true;
  try {
    const result = await gateway.consumer.handleMessage({ id: 'receipt-http-input', guildId: 'guild-1', channelId: 'receipt-http', content: 'hello', author: { id: 'operator-1', bot: false }, channel });
    assert.equal(result.message.state, MESSAGE_STATES.REPLIED);
    await gateway.stop();
    assert.equal(fetchCalls, 1);
    assert.equal(capturedUrl, `https://discord.com/api/v10/channels/receipt-http/messages/receipt-http-input/reactions/${encodeURIComponent('📥')}/@me`);
    assert.equal(capturedOptions.method, 'PUT');
    assert.equal(capturedOptions.headers.Authorization, 'Bot fake-token');
    assert.equal(capturedOptions.body, undefined);
    assert.equal(capturedSignal.aborted, true);
    assert.equal(channelSendCalls, 1);
    assert.equal(state.getTransportReceipt('receipt-http-input').outcome.outcome, 'unknown');
    assert.equal(acknowledgmentFetches, 1);
  } finally {
    globalThis.fetch = originalFetch;
    if (!gateway.stopping) await gateway.stop();
    state.close();
  }
});

test('simulated: rejected receipt response cancels its body before dropping the request handle', async () => {
  const { dir, state } = fixture();
  state.bind({ channelId: 'receipt-body', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir, conductorId: 'receipt-body-conductor', repoKey: 'repo:alpha' });
  state.markIntakeBoundary('receipt-body', 'ready');
  const listeners = new Map();
  let fetchCalls = 0;
  let bodyCancelled = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async url => {
    if (String(url).includes(encodeURIComponent('👀'))) return { ok: true, status: 204 };
    fetchCalls += 1;
    return {
      ok: false,
      status: 500,
      body: { cancel() { bodyCancelled = true; return Promise.resolve(); } }
    };
  };
  const channel = { id: 'receipt-body', async send() { return { id: 'native-reply' }; } };
  const client = {
    rest: {},
    user: { id: 'bot-1' },
    on(name, fn) { listeners.set(name, fn); },
    off(name, fn) { if (listeners.get(name) === fn) listeners.delete(name); },
    async destroy() {}
  };
  const gateway = new DiscordGateway({
    state,
    client,
    providers: { codex: { async dispatch() { return { status: 'submitted' }; }, async observe() { return { text: 'answer' }; } } }
  });
  gateway.discordToken = 'fake-token';
  gateway.ready = true;
  try {
    const result = await gateway.consumer.handleMessage({ id: 'receipt-body-input', guildId: 'guild-1', channelId: 'receipt-body', content: 'hello', author: { id: 'operator-1', bot: false }, channel });
    assert.equal(result.message.state, MESSAGE_STATES.REPLIED);
    await gateway.consumer.waitForReceipts();
    assert.equal(fetchCalls, 1);
    assert.equal(bodyCancelled, true);
    assert.equal(state.getTransportReceipt('receipt-body-input').outcome.outcome, 'unknown');
  } finally {
    globalThis.fetch = originalFetch;
    await gateway.stop();
    state.close();
  }
});

test('simulated: native ACK reaction preserves Discord retry-after metadata', async () => {
  const { state } = fixture();
  const originalFetch = globalThis.fetch;
  let bodyCancelled = false;
  globalThis.fetch = async () => ({
    ok: false,
    status: 429,
    headers: { get(name) { return name.toLowerCase() === 'retry-after' ? '4.5' : null; } },
    body: { cancel() { bodyCancelled = true; return Promise.resolve(); } }
  });
  const gateway = new DiscordGateway({
    state,
    client: { rest: {}, on() {}, off() {}, async destroy() {} }
  });
  gateway.discordToken = 'fake-token';
  try {
    await assert.rejects(
      () => gateway.sendTransportReceipt({ id: 'ack-rate-limit-http', channelId: 'channel-codex' }, { reaction: '👀' }),
      error => {
        assert.equal(error.status, 429);
        assert.equal(error.retryAfterMs, 4500);
        return true;
      }
    );
    assert.equal(bodyCancelled, true);
  } finally {
    globalThis.fetch = originalFetch;
    await gateway.stop();
    state.close();
  }
});

test('simulated: secret reader refuses group-readable token files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-surface-secret-'));
  const file = path.join(dir, 'secret');
  fs.writeFileSync(file, 'test-token\n', { mode: 0o644 });
  assert.throws(() => readSecret(file), /owner-only/);
});

test('simulated: conductor provisioning is idempotent by static address marker', async () => {
  const channels = new Map();
  let creates = 0;
  const guild = {
    channels: {
      cache: { values: () => channels.values() },
      async fetch(id) { return id ? channels.get(id) : undefined; },
      async create(options) {
        creates += 1;
        const channel = { id: `created-${creates}`, parentId: options.parent, topic: options.topic };
        channels.set(channel.id, channel);
        return channel;
      }
    }
  };
  const first = await ensureProvisionedChannel({ guild, provider: 'codex', nativeId: CODEX_ID, categoryId: 'codex-category', conductorId: 'idempotent', repoKey: 'repo:alpha' });
  const second = await ensureProvisionedChannel({ guild, provider: 'codex', nativeId: CODEX_ID, categoryId: 'codex-category', conductorId: 'idempotent', repoKey: 'repo:alpha', channelId: first.channel.id });
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.channel.id, first.channel.id);
  assert.match(first.marker, /^discord-surface:v3 conductor=idempotent provider=codex repo=repo%3Aalpha \[address only, not live status\]$/);
  assert.equal(creates, 1);
});

test('simulated: fresh provisioning never adopts a remote static marker without explicit channel evidence', async () => {
  const channel = {
    id: 'remote-static',
    parentId: 'codex-category',
    topic: conductorMarker({ provider: 'codex', nativeId: CODEX_ID, conductorId: 'fresh-conductor', repoKey: 'repo:alpha' })
  };
  let creates = 0;
  const guild = {
    channels: {
      cache: { values: () => [channel][Symbol.iterator]() },
      async fetch() { return channel; },
      async create() { creates += 1; throw new Error('fresh marker must not create or adopt'); }
    }
  };
  const options = { guild, provider: 'codex', nativeId: CODEX_ID, categoryId: 'codex-category', conductorId: 'fresh-conductor', repoKey: 'repo:alpha' };
  await assert.rejects(() => ensureProvisionedChannel(options), /explicit --channel-id adoption/);
  await assert.rejects(() => ensureProvisionedChannel(options), /explicit --channel-id adoption/);
  const adopted = await ensureProvisionedChannel({ ...options, channelId: channel.id });
  assert.equal(adopted.channel.id, channel.id);
  assert.equal(creates, 0);
});

test('simulated: provisioning rejects a static marker outside the configured vendor category', async () => {
  const channels = new Map([['wrong', { id: 'wrong', parentId: 'claude-category', topic: conductorMarker({ provider: 'codex', nativeId: CODEX_ID, conductorId: 'wrong-category', repoKey: 'repo:alpha' }) }]]);
  const guild = { channels: { cache: { values: () => channels.values() }, async fetch() {}, async create() { throw new Error('must not create a duplicate'); } } };
  await assert.rejects(() => ensureProvisionedChannel({ guild, provider: 'codex', nativeId: CODEX_ID, categoryId: 'codex-category', conductorId: 'wrong-category', repoKey: 'repo:alpha' }), /wrong category/);
});
