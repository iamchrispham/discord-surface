const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { postUnixJson } = require('../src/native');
const { SurfaceState, StateCorruptError, StaleGenerationError, UnresolvedWorkError, MESSAGE_STATES } = require('../src/state');
const { CodexProvider, dispatchAndObserve } = require('../src/native');
const { createSurfaceConsumer, DiscordGateway, readSecret } = require('../src/discord');
const { ensureProvisionedChannel, provisionMarker } = require('../src/cli');
const { ClaudeChannel } = require('../src/claude-channel');

const CODEX_ID = '9caa5d21-2169-429d-918b-5f08651b5dbd';
const CLAUDE_ID = '01a0701c-5714-7671-a455-db7d67f9fa78';

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-surface-test-'));
  const db = path.join(dir, 'surface.sqlite');
  const state = new SurfaceState(db);
  state.setConfig({ operatorId: 'operator-1', guildId: 'guild-1', secretFile: path.join(dir, 'discord.secret') });
  return { dir, db, state };
}

function bindBoth(state, dir) {
  state.bind({ channelId: 'channel-codex', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir });
  state.bind({ channelId: 'channel-claude', guildId: 'guild-1', provider: 'claude', nativeId: CLAUDE_ID, workspace: dir, endpoint: '/tmp/discord-surface-test.sock' });
}

function discordMessage({ id, channelId, authorId = 'operator-1', bot = false, content = 'calculate 2 + 2', sends } = {}) {
  return {
    id,
    guildId: 'guild-1',
    channelId,
    content,
    author: { id: authorId, bot },
    channel: { send: async payload => {
      sends?.push(payload);
      return { id: `reply-${id}` };
    } }
  };
}

function providers({ calls, reply = '4' } = {}) {
  return {
    codex: {
      async dispatch() { calls.codex += 1; return { status: 'submitted' }; },
      async observe() { return { text: reply }; }
    },
    claude: {
      async dispatch() { calls.claude += 1; return { status: 'submitted' }; },
      async observe() { return { text: reply }; }
    }
  };
}

test('simulated: two provider bindings route and persist attributable replies', async () => {
  const { dir, state } = fixture();
  bindBoth(state, dir);
  const calls = { codex: 0, claude: 0 };
  const sends = [];
  const consumer = createSurfaceConsumer({ state, providers: providers({ calls }), sendReply: async (_message, reply) => {
    sends.push(reply.replyText);
    return { id: `sent-${reply.id}` };
  } });
  const codex = await consumer.handleMessage(discordMessage({ id: 'm-codex', channelId: 'channel-codex' }));
  const claude = await consumer.handleMessage(discordMessage({ id: 'm-claude', channelId: 'channel-claude' }));
  assert.equal(codex.message.state, MESSAGE_STATES.REPLIED);
  assert.equal(claude.message.state, MESSAGE_STATES.REPLIED);
  assert.deepEqual(calls, { codex: 1, claude: 1 });
  assert.deepEqual(sends, ['4', '4']);
  state.close();
});

test('simulated: sender, guild, binding, and bot guards reject without dispatcher calls', async () => {
  const { dir, state } = fixture();
  state.bind({ channelId: 'channel-codex', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir });
  const calls = { codex: 0, claude: 0 };
  const consumer = createSurfaceConsumer({ state, providers: providers({ calls }), sendReply: async () => ({ id: 'unused' }) });
  assert.equal((await consumer.handleMessage(discordMessage({ id: 'bad-user', channelId: 'channel-codex', authorId: 'intruder' }))).reason, 'unauthorized-sender');
  assert.equal((await consumer.handleMessage({ ...discordMessage({ id: 'bad-guild', channelId: 'channel-codex' }), guildId: 'other-guild' })).reason, 'unauthorized-sender');
  assert.equal((await consumer.handleMessage(discordMessage({ id: 'bot', channelId: 'channel-codex', bot: true }))).reason, 'bot-source');
  assert.equal((await consumer.handleMessage(discordMessage({ id: 'unknown', channelId: 'no-binding' }))).reason, 'unknown-binding');
  assert.deepEqual(calls, { codex: 0, claude: 0 });
  assert.equal(state.listMessages().length, 0);
  state.close();
});

test('simulated: duplicate Discord ID is a durable dedupe guard', async () => {
  const { dir, state } = fixture();
  state.bind({ channelId: 'channel-codex', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir });
  const calls = { codex: 0, claude: 0 };
  let sends = 0;
  const consumer = createSurfaceConsumer({ state, providers: providers({ calls }), sendReply: async () => { sends += 1; return { id: 'reply' }; } });
  const first = await consumer.handleMessage(discordMessage({ id: 'duplicate', channelId: 'channel-codex' }));
  const second = await consumer.handleMessage(discordMessage({ id: 'duplicate', channelId: 'channel-codex', content: 'different' }));
  assert.equal(first.message.state, MESSAGE_STATES.REPLIED);
  assert.equal(second.duplicate, true);
  assert.equal(calls.codex, 1);
  assert.equal(sends, 1);
  state.close();
});

test('simulated: intake transaction failure leaves no accepted row or receipt', () => {
  const { dir, state } = fixture();
  state.bind({ channelId: 'channel-codex', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir });
  state.failNextIntake();
  assert.throws(() => state.acceptDiscordMessage({ id: 'intake-fails', guildId: 'guild-1', channelId: 'channel-codex', authorId: 'operator-1', isBot: false, content: 'x' }), /injected intake/);
  assert.equal(state.getMessage('intake-fails'), null);
  assert.equal(state.listReceipts().some(receipt => receipt.discord_id === 'intake-fails'), false);
  state.close();
});

test('simulated: restart preserves pending intake and fences dispatching as uncertain', () => {
  const first = fixture();
  first.state.bind({ channelId: 'channel-codex', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: first.dir });
  first.state.acceptDiscordMessage({ id: 'pending', guildId: 'guild-1', channelId: 'channel-codex', authorId: 'operator-1', isBot: false, content: 'pending' });
  first.state.acceptDiscordMessage({ id: 'dispatching', guildId: 'guild-1', channelId: 'channel-codex', authorId: 'operator-1', isBot: false, content: 'dispatching' });
  first.state.claimDispatch('dispatching');
  first.state.close();
  const state = new SurfaceState(first.db);
  state.recoverAfterRestart();
  assert.equal(state.getMessage('pending').state, MESSAGE_STATES.ACCEPTED);
  assert.equal(state.getMessage('dispatching').state, MESSAGE_STATES.UNCERTAIN);
  state.close();
});

test('simulated: rebind is blocked by in-flight work and stale reply is rejected after a drained rebind', () => {
  const { dir, state } = fixture();
  state.bind({ channelId: 'channel-codex', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir });
  state.acceptDiscordMessage({ id: 'in-flight', guildId: 'guild-1', channelId: 'channel-codex', authorId: 'operator-1', isBot: false, content: 'x' });
  state.claimDispatch('in-flight');
  assert.throws(() => state.rebind({ channelId: 'channel-codex', guildId: 'guild-1', provider: 'codex', nativeId: CLAUDE_ID, workspace: dir }), UnresolvedWorkError);
  state.markSubmitted('in-flight');
  state.recordNativeReply({ messageId: 'in-flight', nativeId: CODEX_ID, generation: 1, text: 'done' });
  state.beginReply('in-flight');
  state.markReplySent('in-flight', 'reply-in-flight');
  const rebound = state.rebind({ channelId: 'channel-codex', guildId: 'guild-1', provider: 'codex', nativeId: CLAUDE_ID, workspace: dir });
  assert.equal(rebound.generation, 2);
  assert.throws(() => state.recordNativeReply({ messageId: 'in-flight', nativeId: CODEX_ID, generation: 1, text: 'stale' }), StaleGenerationError);
  state.close();
});

test('simulated: reply delivery failure keeps custody and records the failure', async () => {
  const { dir, state } = fixture();
  state.bind({ channelId: 'channel-codex', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir });
  const calls = { codex: 0, claude: 0 };
  const consumer = createSurfaceConsumer({ state, providers: providers({ calls }), sendReply: async () => { throw new Error('Discord send failed'); } });
  const result = await consumer.handleMessage(discordMessage({ id: 'reply-fails', channelId: 'channel-codex' }));
  assert.equal(result.message.state, MESSAGE_STATES.REPLY_FAILED);
  assert.equal(state.getMessage('reply-fails').replyText, '4');
  assert.ok(state.listReceipts().some(receipt => receipt.kind === 'reply-failed'));
  state.close();
});

test('simulated: unavailable Claude owner holds accepted input without execution acknowledgement', async () => {
  const { dir, state } = fixture();
  state.bind({ channelId: 'channel-claude', guildId: 'guild-1', provider: 'claude', nativeId: CLAUDE_ID, workspace: dir, endpoint: path.join(dir, 'offline.sock') });
  let sends = 0;
  const consumer = createSurfaceConsumer({
    state,
    providers: { claude: { async dispatch() { return { status: 'not_submitted', error: new Error('channel unavailable') }; } } },
    sendReply: async () => { sends += 1; return { id: 'unexpected' }; }
  });
  const result = await consumer.handleMessage(discordMessage({ id: 'claude-offline', channelId: 'channel-claude' }));
  assert.equal(result.status, 'not_submitted');
  assert.equal(result.message.state, MESSAGE_STATES.ACCEPTED);
  assert.equal(sends, 0);
  assert.ok(state.listReceipts().some(receipt => receipt.kind === 'dispatch-not-submitted'));
  state.close();
});

test('simulated: invalid native target is rejected before invoking Codex', async () => {
  let invoked = false;
  const provider = new CodexProvider({ run: async () => { invoked = true; return { status: 'submitted' }; } });
  const result = await provider.dispatch({ nativeId: 'not-a-uuid', id: 'm', generation: 1, workspace: '/', content: 'x' });
  assert.equal(result.status, 'not_submitted');
  assert.equal(invoked, false);
});

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

test('simulated: secret reader refuses group-readable token files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-surface-secret-'));
  const file = path.join(dir, 'secret');
  fs.writeFileSync(file, 'test-token\n', { mode: 0o644 });
  assert.throws(() => readSecret(file), /owner-only/);
});

test('simulated: vendor provisioning is idempotent by topic marker and exact UUID', async () => {
  const channels = new Map();
  let creates = 0;
  const guild = {
    channels: {
      cache: { values: () => channels.values() },
      async fetch() {},
      async create(options) {
        creates += 1;
        const channel = { id: `created-${creates}`, parentId: options.parent, topic: options.topic };
        channels.set(channel.id, channel);
        return channel;
      }
    }
  };
  const first = await ensureProvisionedChannel({ guild, provider: 'codex', nativeId: CODEX_ID, categoryId: 'codex-category' });
  const second = await ensureProvisionedChannel({ guild, provider: 'codex', nativeId: CODEX_ID, categoryId: 'codex-category' });
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.channel.id, first.channel.id);
  assert.equal(first.marker, provisionMarker('codex', CODEX_ID));
  assert.equal(creates, 1);
});

test('simulated: Claude channel forwards only the bound generation and closes its socket', async () => {
  const { dir, state } = fixture();
  const socket = path.join(dir, 'claude.sock');
  state.bind({ channelId: 'channel-claude', guildId: 'guild-1', provider: 'claude', nativeId: CLAUDE_ID, workspace: dir, endpoint: socket });
  state.acceptDiscordMessage({ id: 'claude-event', guildId: 'guild-1', channelId: 'channel-claude', authorId: 'operator-1', isBot: false, content: 'reply' });
  state.claimDispatch('claude-event');
  state.markSubmitted('claude-event');
  const events = [];
  const channel = new ClaudeChannel({ state, nativeId: CLAUDE_ID, socketPath: socket, mcp: { notification: async event => events.push(event) } });
  await channel.start();
  const response = await postUnixJson(socket, { nativeId: CLAUDE_ID, messageId: 'claude-event', generation: 1, content: 'reply' });
  assert.equal(response.statusCode, 202);
  assert.equal(events[0].params.meta.messageId, 'claude-event');
  assert.equal(events[0].params.meta.generation, 1);
  await channel.stop();
  assert.equal(fs.existsSync(socket), false);
  state.close();
});
