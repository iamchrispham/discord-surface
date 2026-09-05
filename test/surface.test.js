const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { postUnixJson } = require('../src/native');
const { SurfaceState, StateCorruptError, StaleGenerationError, UnresolvedWorkError, MESSAGE_STATES } = require('../src/state');
const { CodexProvider, dispatchAndObserve, finalText, observeCodexReply, observeSubmitted, readInitialCursor, runCodex } = require('../src/native');
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

test('simulated: provisioning rejects a marker outside the configured vendor category', async () => {
  const channels = new Map([['wrong', { id: 'wrong', parentId: 'claude-category', topic: provisionMarker('codex', CODEX_ID) }]]);
  const guild = { channels: { cache: { values: () => channels.values() }, async fetch() {}, async create() { throw new Error('must not create a duplicate'); } } };
  await assert.rejects(() => ensureProvisionedChannel({ guild, provider: 'codex', nativeId: CODEX_ID, categoryId: 'codex-category' }), /wrong category/);
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

test('simulated: Claude dispatch rechecks authorization after intake', async () => {
  const { dir, state } = fixture();
  const socketDir = fs.mkdtempSync(path.join('/tmp', 'discord-surface-auth-'));
  fs.chmodSync(socketDir, 0o700);
  const socket = path.join(socketDir, 'channel.sock');
  state.bind({ channelId: 'channel-claude', guildId: 'guild-1', provider: 'claude', nativeId: CLAUDE_ID, workspace: dir, endpoint: socket });
  state.acceptDiscordMessage({ id: 'claude-revoked', guildId: 'guild-1', channelId: 'channel-claude', authorId: 'operator-1', isBot: false, content: 'x' });
  state.claimDispatch('claude-revoked');
  state.setConfig({ operatorId: 'operator-revoked', guildId: 'guild-1', secretFile: path.join(dir, 'discord.secret') });
  const events = [];
  const channel = new ClaudeChannel({ state, nativeId: CLAUDE_ID, socketPath: socket, mcp: { notification: async event => events.push(event) } });
  await channel.start();
  const response = await postUnixJson(socket, { nativeId: CLAUDE_ID, messageId: 'claude-revoked', generation: 1, content: 'x' });
  assert.equal(response.statusCode, 409);
  assert.equal(events.length, 0);
  assert.ok(state.listReceipts().some(receipt => receipt.kind === 'native-dispatch-rejected-auth'));
  await channel.stop();
  state.close();
});

test('simulated: Claude transport close stops its HTTP and socket resources', async () => {
  const { dir, state } = fixture();
  const socketDir = fs.mkdtempSync(path.join('/tmp', 'discord-surface-close-'));
  fs.chmodSync(socketDir, 0o700);
  const socket = path.join(socketDir, 'channel.sock');
  state.bind({ channelId: 'channel-claude', guildId: 'guild-1', provider: 'claude', nativeId: CLAUDE_ID, workspace: dir, endpoint: socket });
  const mcp = { notification: async () => {}, close: async () => {} };
  let databaseClosed = false;
  const channel = new ClaudeChannel({ state, nativeId: CLAUDE_ID, socketPath: socket, mcp, onTransportClose: () => { databaseClosed = true; state.close(); } });
  await channel.start();
  mcp.onclose();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(channel.started, false);
  assert.equal(fs.existsSync(socket), false);
  assert.equal(databaseClosed, true);
});

test('simulated: Claude start failure closes MCP and stop retries a close failure', async () => {
  const { dir, state } = fixture();
  const socketDir = fs.mkdtempSync(path.join('/tmp', 'discord-surface-start-'));
  fs.chmodSync(socketDir, 0o700);
  const socket = path.join(socketDir, 'channel.sock');
  state.bind({ channelId: 'channel-claude', guildId: 'guild-1', provider: 'claude', nativeId: CLAUDE_ID, workspace: dir, endpoint: socket });
  let closes = 0;
  const failedMcp = { connect: async () => { throw new Error('connect failed'); }, transportFactory: () => ({}), close: async () => { closes += 1; } };
  const failed = new ClaudeChannel({ state, nativeId: CLAUDE_ID, socketPath: socket, mcp: failedMcp });
  await assert.rejects(() => failed.start(), /connect failed/);
  assert.equal(closes, 1);
  assert.equal(fs.existsSync(socket), false);

  const retrySocket = path.join(socketDir, 'retry.sock');
  state.rebind({ channelId: 'channel-claude', guildId: 'guild-1', provider: 'claude', nativeId: CLAUDE_ID, workspace: dir, endpoint: retrySocket });
  let retryCloses = 0;
  const retryMcp = { close: async () => { retryCloses += 1; if (retryCloses === 1) throw new Error('close failed'); } };
  const retry = new ClaudeChannel({ state, nativeId: CLAUDE_ID, socketPath: retrySocket, mcp: retryMcp });
  await retry.start();
  await assert.rejects(() => retry.stop(), error => error instanceof AggregateError && error.errors.some(item => /close failed/.test(item.message)));
  await retry.stop();
  assert.equal(retryCloses, 2);
  assert.equal(fs.existsSync(retrySocket), false);
  state.close();
});

test('simulated: secret reader parses the owner-only dotenv assignment without returning the assignment', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-surface-secret-assignment-'));
  const file = path.join(dir, 'discord.env');
  fs.writeFileSync(file, "# local\nDISCORD_TOKEN='fake-fixture-token'\n", { mode: 0o600 });
  assert.equal(readSecret(file), 'fake-fixture-token');
  assert.notEqual(readSecret(file), fs.readFileSync(file, 'utf8').trim());
});

test('simulated: long replies use durable Discord-sized parts and bounded enforced nonces', async () => {
  const { dir, state } = fixture();
  state.bind({ channelId: 'channel-codex', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir });
  state.acceptDiscordMessage({ id: 'long-reply', guildId: 'guild-1', channelId: 'channel-codex', authorId: 'operator-1', isBot: false, content: 'long' });
  state.claimDispatch('long-reply');
  state.markSubmitted('long-reply');
  state.recordNativeReply({ messageId: 'long-reply', nativeId: CODEX_ID, generation: 1, text: 'x'.repeat(4500) });
  const payloads = [];
  const client = { on() {}, off() {}, async destroy() {} };
  const gateway = new DiscordGateway({ state, client });
  const source = discordMessage({ id: 'long-reply', channelId: 'channel-codex', sends: payloads });
  const result = await gateway.consumer.deliverReply(source, { status: 'reply_ready', message: state.getMessage('long-reply') });
  assert.equal(result.message.state, MESSAGE_STATES.REPLIED);
  assert.equal(payloads.length, 3);
  assert.ok(payloads.every(payload => payload.content.length <= 2000));
  assert.ok(payloads.every(payload => payload.nonce.length <= 25 && payload.enforceNonce === true));
  assert.equal(new Set(payloads.map(payload => payload.nonce)).size, payloads.length);
  await gateway.stop();
  state.close();
});

test('simulated: reply chunking preserves a surrogate pair at the Discord boundary', () => {
  const { dir, state } = fixture();
  state.bind({ channelId: 'channel-codex', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir });
  state.acceptDiscordMessage({ id: 'surrogate-boundary', guildId: 'guild-1', channelId: 'channel-codex', authorId: 'operator-1', isBot: false, content: 'boundary' });
  state.claimDispatch('surrogate-boundary');
  state.markSubmitted('surrogate-boundary');
  const text = `${'x'.repeat(1999)}🙂y`;
  state.recordNativeReply({ messageId: 'surrogate-boundary', nativeId: CODEX_ID, generation: 1, text });
  const parts = state.listReplyParts('surrogate-boundary');
  assert.equal(parts.length, 2);
  assert.equal(parts.map(part => part.content).join(''), text);
  assert.ok(parts.every(part => part.content.length <= 2000));
  state.close();
});

test('simulated: operator revocation after intake prevents dispatch and native reply acceptance', async () => {
  const { dir, state } = fixture();
  state.bind({ channelId: 'channel-codex', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir });
  state.acceptDiscordMessage({ id: 'revoked', guildId: 'guild-1', channelId: 'channel-codex', authorId: 'operator-1', isBot: false, content: 'x' });
  state.setConfig({ operatorId: 'operator-revoked', guildId: 'guild-1', secretFile: path.join(dir, 'discord.secret') });
  const claim = state.claimDispatch('revoked');
  assert.equal(claim.claimed, false);
  assert.equal(claim.reason, 'authorization-revoked');
  assert.equal(state.getMessage('revoked').state, MESSAGE_STATES.ACCEPTED);
  state.setConfig({ operatorId: 'operator-1', guildId: 'guild-1', secretFile: path.join(dir, 'discord.secret') });
  state.acceptDiscordMessage({ id: 'reply-revoked', guildId: 'guild-1', channelId: 'channel-codex', authorId: 'operator-1', isBot: false, content: 'x' });
  state.claimDispatch('reply-revoked');
  state.markSubmitted('reply-revoked');
  state.setConfig({ operatorId: 'operator-revoked', guildId: 'guild-1', secretFile: path.join(dir, 'discord.secret') });
  assert.throws(() => state.recordNativeReply({ messageId: 'reply-revoked', nativeId: CODEX_ID, generation: 1, text: 'late' }), /authorization/);
  assert.ok(state.listReceipts().some(receipt => receipt.kind === 'dispatch-rejected-auth'));
  state.close();
});

test('simulated: credential rotation preserves provider UUID binding generation and custody', () => {
  const { dir, state } = fixture();
  const binding = state.bind({ channelId: 'channel-codex', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir });
  state.acceptDiscordMessage({ id: 'credential-rotation', guildId: 'guild-1', channelId: 'channel-codex', authorId: 'operator-1', isBot: false, content: 'x' });
  state.setConfig({ operatorId: 'operator-1', guildId: 'guild-1', secretFile: path.join(dir, 'rotated-discord.env') });
  assert.deepEqual(state.getBinding('channel-codex'), binding);
  assert.equal(state.getMessage('credential-rotation').state, MESSAGE_STATES.ACCEPTED);
  assert.equal(state.listReceipts().some(receipt => receipt.kind === 'rebound' || receipt.kind === 'unbound'), false);
  state.close();
});

test('simulated: unbind tombstones history and rebind increments the generation', () => {
  const { dir, state } = fixture();
  state.bind({ channelId: 'channel-codex', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir });
  state.acceptDiscordMessage({ id: 'history', guildId: 'guild-1', channelId: 'channel-codex', authorId: 'operator-1', isBot: false, content: 'x' });
  state.claimDispatch('history');
  state.markSubmitted('history');
  state.recordNativeReply({ messageId: 'history', nativeId: CODEX_ID, generation: 1, text: 'done' });
  state.beginReply('history');
  state.markReplySent('history', 'reply-history');
  state.unbind('channel-codex');
  assert.equal(state.getMessage('history').state, MESSAGE_STATES.REPLIED);
  assert.equal(state.getBinding('channel-codex').active, false);
  const rebound = state.rebind({ channelId: 'channel-codex', guildId: 'guild-1', provider: 'codex', nativeId: CLAUDE_ID, workspace: dir });
  assert.equal(rebound.generation, 2);
  assert.equal(rebound.active, true);
  state.close();
});

test('simulated: exact native rollout rejection is definitely not submitted', async () => {
  const result = await runCodex(process.execPath, ['-e', "console.error('no rollout found for thread id 9caa5d21-2169-429d-918b-5f08651b5dbd (code -32603)'); process.exit(1)"]);
  assert.equal(result.status, 'not_submitted');
});

test('simulated: Unicode and split JSONL observation keeps a byte cursor and finds only the exact final marker', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-surface-jsonl-'));
  const file = path.join(root, `${CODEX_ID}.jsonl`);
  const meta = JSON.stringify({ type: 'session_meta', payload: { session_id: CODEX_ID }, timestamp: new Date().toISOString() });
  const prior = JSON.stringify({ type: 'event_msg', payload: { type: 'item_completed', item: { phase: 'final_answer', content: [{ type: 'Text', text: '古い応答' }] } }, timestamp: new Date().toISOString() });
  fs.writeFileSync(file, `${meta}\n${prior}\n`, { mode: 0o600 });
  const cursor = readInitialCursor(CODEX_ID, root);
  const marker = `[[discord-surface:late-unicode]]`;
  const row = JSON.stringify({ type: 'event_msg', payload: { type: 'item_completed', item: { phase: 'final_answer', content: [{ type: 'Text', text: `${marker}\n返信🙂` }] } }, timestamp: new Date().toISOString() });
  const observation = observeCodexReply(CODEX_ID, cursor, { marker, root, timeoutMs: 1000, pollMs: 5 });
  const encoded = Buffer.from(`${row}\n`);
  const emojiOffset = encoded.indexOf(Buffer.from('🙂'));
  const splitOffset = emojiOffset + 2;
  setTimeout(() => fs.appendFileSync(file, encoded.subarray(0, splitOffset)), 20);
  setTimeout(() => fs.appendFileSync(file, encoded.subarray(splitOffset)), 40);
  const result = await observation;
  assert.equal(result.text, '返信🙂');
  assert.equal(result.cursor.offset, fs.statSync(file).size);
  assert.equal(finalText(JSON.parse(prior), marker), null);
});

test('simulated: unmatched Claude IPC custody is rejected and notification failure is uncertain', async () => {
  const { dir, state } = fixture();
  const socketDir = fs.mkdtempSync(path.join('/tmp', 'discord-surface-uncertain-'));
  fs.chmodSync(socketDir, 0o700);
  const socket = path.join(socketDir, 'channel.sock');
  state.bind({ channelId: 'channel-claude', guildId: 'guild-1', provider: 'claude', nativeId: CLAUDE_ID, workspace: dir, endpoint: socket });
  state.acceptDiscordMessage({ id: 'claude-safe', guildId: 'guild-1', channelId: 'channel-claude', authorId: 'operator-1', isBot: false, content: 'x' });
  state.claimDispatch('claude-safe');
  state.markSubmitted('claude-safe');
  const channel = new ClaudeChannel({ state, nativeId: CLAUDE_ID, socketPath: socket, mcp: { notification: async () => { throw new Error('delivery uncertain'); }, close: async () => {} } });
  await channel.start();
  const unknown = await postUnixJson(socket, { nativeId: CLAUDE_ID, messageId: 'unknown-message', generation: 1, content: 'x' });
  assert.equal(unknown.statusCode, 409);
  const uncertain = await postUnixJson(socket, { nativeId: CLAUDE_ID, messageId: 'claude-safe', generation: 1, content: 'x' });
  assert.equal(uncertain.statusCode, 503);
  await channel.stop();
  await channel.stop();
  state.close();
});

test('simulated: persisted Codex cursor resumes a late reply after state restart without redispatch', async () => {
  const fixtureState = fixture();
  const root = path.join(fixtureState.dir, 'sessions');
  fs.mkdirSync(root, { mode: 0o700 });
  const file = path.join(root, `${CODEX_ID}.jsonl`);
  fs.writeFileSync(file, `${JSON.stringify({ type: 'session_meta', payload: { session_id: CODEX_ID }, timestamp: new Date().toISOString() })}\n`, { mode: 0o600 });
  fixtureState.state.bind({ channelId: 'channel-codex', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: fixtureState.dir });
  fixtureState.state.acceptDiscordMessage({ id: 'late-after-restart', guildId: 'guild-1', channelId: 'channel-codex', authorId: 'operator-1', isBot: false, content: 'x' });
  fixtureState.state.claimDispatch('late-after-restart');
  const cursor = readInitialCursor(CODEX_ID, root);
  fixtureState.state.markSubmitted('late-after-restart', cursor, '[[discord-surface:late-after-restart]]');
  fixtureState.state.close();
  const restarted = new SurfaceState(fixtureState.db);
  const marker = '[[discord-surface:late-after-restart]]';
  fs.appendFileSync(file, `${JSON.stringify({ type: 'event_msg', payload: { type: 'item_completed', item: { phase: 'final_answer', content: [{ type: 'Text', text: `${marker}\nlate reply` }] } }, timestamp: new Date().toISOString() })}\n`);
  const provider = new CodexProvider({ root, run: async () => ({ status: 'submitted' }) });
  const result = await observeSubmitted(restarted, restarted.getMessage('late-after-restart'), provider, { timeoutMs: 500, pollMs: 5 });
  assert.equal(result.message.state, MESSAGE_STATES.REPLY_READY);
  assert.equal(result.message.replyText, 'late reply');
  restarted.close();
});

test('simulated: malformed required columns fail closed even with a known schema version', () => {
  const { db, state } = fixture();
  state.db.exec('ALTER TABLE bindings RENAME COLUMN active TO malformed_active');
  state.close();
  assert.throws(() => new SurfaceState(db), StateCorruptError);
});

test('simulated: status readiness labels live permission and quota gates as unverified', () => {
  const { dir, state } = fixture();
  const readiness = state.getReadiness();
  assert.equal(readiness.configured, true);
  assert.equal(readiness.limits.permission, 'unverified-live');
  assert.equal(readiness.limits.nativeApproval, 'unverified-live');
  assert.equal(readiness.limits.quota, 'unverified-live');
  assert.equal(readiness.limits.billing, 'unverified-live');
  assert.equal(readiness.limits.connectionBackfill, 'bounded-by-observer-cursor');
  state.close();
});

test('simulated: ambiguous network reply failure is unknown and is never retried by the consumer', async () => {
  const { dir, state } = fixture();
  state.bind({ channelId: 'channel-codex', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir });
  let sends = 0;
  const consumer = createSurfaceConsumer({
    state,
    providers: providers({ calls: { codex: 0, claude: 0 } }),
    sendReply: async () => { sends += 1; const error = new Error('connection reset after send'); error.code = 'ECONNRESET'; throw error; }
  });
  const first = await consumer.handleMessage(discordMessage({ id: 'reply-unknown', channelId: 'channel-codex' }));
  const second = await consumer.handleMessage(discordMessage({ id: 'reply-unknown', channelId: 'channel-codex' }));
  assert.equal(first.message.state, MESSAGE_STATES.REPLY_UNKNOWN);
  assert.equal(second.duplicate, true);
  assert.equal(sends, 1);
  state.close();
});

test('simulated: Discord permission denial is definite and preserves reply custody', async () => {
  const { dir, state } = fixture();
  state.bind({ channelId: 'channel-codex', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir });
  const consumer = createSurfaceConsumer({
    state,
    providers: providers({ calls: { codex: 0, claude: 0 } }),
    sendReply: async () => { const error = new Error('missing send permission'); error.status = 403; throw error; }
  });
  const result = await consumer.handleMessage(discordMessage({ id: 'reply-permission', channelId: 'channel-codex' }));
  assert.equal(result.message.state, MESSAGE_STATES.REPLY_FAILED);
  assert.equal(state.getMessage('reply-permission').replyText, '4');
  assert.ok(state.listReceipts().some(receipt => receipt.kind === 'reply-failed'));
  state.close();
});

test('simulated: recovery keeps uncertain dispatch explicit and resumes only reconciled custody', () => {
  const { dir, state } = fixture();
  state.bind({ channelId: 'channel-codex', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir });
  state.acceptDiscordMessage({ id: 'uncertain-recovery', guildId: 'guild-1', channelId: 'channel-codex', authorId: 'operator-1', isBot: false, content: 'x' });
  state.claimDispatch('uncertain-recovery');
  state.recoverAfterRestart();
  assert.equal(state.recoveryCandidates().length, 0);
  assert.equal(state.getMessage('uncertain-recovery').state, MESSAGE_STATES.UNCERTAIN);
  state.reconcileUncertain('uncertain-recovery', 'submitted');
  assert.equal(state.recoveryCandidates()[0].state, MESSAGE_STATES.SUBMITTED);
  assert.ok(state.listReceipts().some(receipt => receipt.kind === 'uncertain-reconciled-submitted'));
  state.close();
});

test('simulated: gateway stop surfaces a native client stop failure and can be retried', async () => {
  const { state } = fixture();
  let destroys = 0;
  const client = {
    on() {},
    off() {},
    async destroy() { destroys += 1; if (destroys === 1) throw new Error('stop failed'); }
  };
  const gateway = new DiscordGateway({ state, client });
  await assert.rejects(() => gateway.stop(), /stop failed/);
  await gateway.stop();
  assert.equal(destroys, 2);
  state.close();
});
