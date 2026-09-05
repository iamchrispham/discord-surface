const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { EventEmitter } = require('node:events');
const { spawn, spawnSync } = require('node:child_process');
const { postUnixJson } = require('../src/native');
const { SurfaceState, StateCorruptError, StaleGenerationError, UnresolvedWorkError, MESSAGE_STATES, READINESS } = require('../src/state');
const { CodexProvider, dispatchAndObserve, finalText, observeCodexReply, observeSubmitted, readInitialCursor, runCodex } = require('../src/native');
const { createSurfaceConsumer, DiscordGateway, readSecret } = require('../src/discord');
const { bindingArgs, conductorMarker, ensureProvisionedChannel, provisionMarker, publishHandoffTopic } = require('../src/cli');
const { ClaudeChannel } = require('../src/claude-channel');
const { conductorMarkerMatches, topicWithReadiness } = require('../src/topic');

const CODEX_ID = '9caa5d21-2169-429d-918b-5f08651b5dbd';
const CLAUDE_ID = '01a0701c-5714-7671-a455-db7d67f9fa78';
const SUCCESSOR_ID = '7b7b7b7b-7b7b-4b7b-8b7b-7b7b7b7b7b7b';
const LOCKF = '/usr/bin/lockf';
const CLI_PATH = path.resolve(__dirname, '../src/cli.js');

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

function historyPermissions(allowed = true) {
  return { has: () => allowed };
}

function lockfRun(lockPath, script) {
  return spawnSync(LOCKF, ['-t', '0', '-k', lockPath, process.execPath, '-e', script], { encoding: 'utf8' });
}

async function waitForFile(file, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${file}`);
}

function waitForChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
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
  state.recordNativeReply({ provider: 'codex', messageId: 'in-flight', nativeId: CODEX_ID, generation: 1, text: 'done' });
  state.beginReply('in-flight');
  state.markReplySent('in-flight', 'reply-in-flight');
  const rebound = state.rebind({ channelId: 'channel-codex', guildId: 'guild-1', provider: 'codex', nativeId: CLAUDE_ID, workspace: dir });
  assert.equal(rebound.generation, 2);
  assert.throws(() => state.recordNativeReply({ provider: 'codex', messageId: 'in-flight', nativeId: CODEX_ID, generation: 1, text: 'stale' }), StaleGenerationError);
  state.close();
});

test('simulated: reply delivery failure keeps custody and records the failure', async () => {
  const { dir, state } = fixture();
  state.bind({ channelId: 'channel-codex', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir });
  const calls = { codex: 0, claude: 0 };
  const consumer = createSurfaceConsumer({ state, providers: providers({ calls }), sendReply: async () => { throw new Error('Discord send failed'); } });
  const result = await consumer.handleMessage(discordMessage({ id: 'reply-fails', channelId: 'channel-codex' }));
  assert.equal(result.message.state, MESSAGE_STATES.REPLY_UNKNOWN);
  assert.equal(state.getMessage('reply-fails').replyText, '4');
  assert.ok(state.listReceipts().some(receipt => receipt.kind === 'reply-unknown'));
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
  fs.writeFileSync(file, "# local\nUNRELATED=value\nDISCORD_TOKEN='fake-fixture-token'\n", { mode: 0o600 });
  assert.equal(readSecret(file), 'fake-fixture-token');
  assert.notEqual(readSecret(file), fs.readFileSync(file, 'utf8').trim());
});

test('simulated: long replies use durable Discord-sized parts and bounded enforced nonces', async () => {
  const { dir, state } = fixture();
  state.bind({ channelId: 'channel-codex', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir });
  state.acceptDiscordMessage({ id: 'long-reply', guildId: 'guild-1', channelId: 'channel-codex', authorId: 'operator-1', isBot: false, content: 'long' });
  state.claimDispatch('long-reply');
  state.markSubmitted('long-reply');
  state.recordNativeReply({ provider: 'codex', messageId: 'long-reply', nativeId: CODEX_ID, generation: 1, text: 'x'.repeat(4500) });
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
  state.recordNativeReply({ provider: 'codex', messageId: 'surrogate-boundary', nativeId: CODEX_ID, generation: 1, text });
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
  assert.throws(() => state.recordNativeReply({ provider: 'codex', messageId: 'reply-revoked', nativeId: CODEX_ID, generation: 1, text: 'late' }), /authorization/);
  assert.ok(state.listReceipts().some(receipt => receipt.kind === 'dispatch-rejected-auth'));
  state.close();
});

test('simulated: guild revocation after intake blocks dispatch and reply acceptance', () => {
  const { dir, state } = fixture();
  state.bind({ channelId: 'channel-codex', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir });
  state.acceptDiscordMessage({ id: 'guild-revoked', guildId: 'guild-1', channelId: 'channel-codex', authorId: 'operator-1', isBot: false, content: 'x' });
  state.setConfig({ operatorId: 'operator-1', guildId: 'guild-revoked', secretFile: path.join(dir, 'discord.secret') });
  assert.equal(state.claimDispatch('guild-revoked').reason, 'authorization-revoked');
  state.setConfig({ operatorId: 'operator-1', guildId: 'guild-1', secretFile: path.join(dir, 'discord.secret') });
  state.claimDispatch('guild-revoked');
  state.markSubmitted('guild-revoked');
  state.setConfig({ operatorId: 'operator-1', guildId: 'guild-revoked', secretFile: path.join(dir, 'discord.secret') });
  assert.throws(() => state.recordNativeReply({ provider: 'codex', messageId: 'guild-revoked', nativeId: CODEX_ID, generation: 1, text: 'late' }), /authorization/);
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
  state.recordNativeReply({ provider: 'codex', messageId: 'history', nativeId: CODEX_ID, generation: 1, text: 'done' });
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

test('simulated: v1.3 migration preserves a recorded cutoff and recovers older history after held live custody', async () => {
  const { dir, db, state } = fixture();
  state.bind({ channelId: 'channel-codex', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir });
  state.setIntakeBaseline('channel-codex', '100', 'recorded v1.3 cutoff');
  state.markIntakeBoundary('channel-codex', 'ready');
  state.acceptDiscordMessage({ id: '200', guildId: 'guild-1', channelId: 'channel-codex', authorId: 'operator-1', isBot: false, content: 'held live input' });
  state.close();
  const legacy = new DatabaseSync(db);
  legacy.exec("ALTER TABLE intake_watermarks DROP COLUMN recovered_through_id; UPDATE meta SET value='1.3' WHERE key='schema';");
  legacy.close();

  const migrated = new SurfaceState(db);
  assert.equal(migrated.getIntakeWatermark('channel-codex').recovered_through_id, '100');
  assert.equal(migrated.getBinding('channel-codex').readiness, READINESS.PENDING);
  const secret = path.join(dir, 'discord.env');
  fs.writeFileSync(secret, 'DISCORD_TOKEN=fake-token\n', { mode: 0o600 });
  const channel = { id: 'channel-codex', guildId: 'guild-1', topic: '', permissionsFor: () => historyPermissions() };
  const client = {
    user: { id: 'bot-1' },
    on() {}, off() {}, async login() {}, channels: { fetch: async () => channel }, async destroy() {}
  };
  const gateway = new DiscordGateway({ state: migrated, client, fetchHistory: async (_channel, options) => {
    assert.equal(options.after, '100');
    return [
      { id: '200', guildId: 'guild-1', channelId: 'channel-codex', author: { id: 'operator-1', bot: false }, content: 'held live input' },
      { id: '101', guildId: 'guild-1', channelId: 'channel-codex', author: { id: 'operator-1', bot: false }, content: 'older history' }
    ];
  } });
  await gateway.start(secret);
  assert.ok(migrated.getMessage('101'));
  assert.ok(migrated.getMessage('200'));
  assert.equal(migrated.getIntakeWatermark('channel-codex').recovered_through_id, '200');
  await gateway.stop();
  migrated.close();
});

test('simulated: status readiness labels live permission and quota gates as unverified', () => {
  const { dir, state } = fixture();
  const readiness = state.getReadiness();
  assert.equal(readiness.configured, true);
  assert.equal(readiness.limits.permission, 'unverified-live');
  assert.equal(readiness.limits.nativeApproval, 'unverified-live');
  assert.equal(readiness.limits.quota, 'unverified-live');
  assert.equal(readiness.limits.billing, 'unverified-live');
  assert.equal(readiness.limits.connectionBackfill, 'pending');
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

test('simulated: native observation holds scan cursor until reply custody commits', async () => {
  const { dir, state } = fixture();
  state.bind({ channelId: 'channel-codex', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir });
  state.acceptDiscordMessage({ id: 'cursor-custody', guildId: 'guild-1', channelId: 'channel-codex', authorId: 'operator-1', isBot: false, content: 'x' });
  state.claimDispatch('cursor-custody');
  state.markSubmitted('cursor-custody');
  const cursor = { file: '/tmp/session.jsonl', offset: 341, since: 1 };
  const result = await observeSubmitted(state, state.getMessage('cursor-custody'), {
    async observe(_message, _outcome, options) {
      options.onCursor(cursor);
      return { text: 'durable answer' };
    }
  });
  assert.equal(result.message.state, MESSAGE_STATES.REPLY_READY);
  assert.deepEqual(state.getMessage('cursor-custody').observerCursor, cursor);

  state.acceptDiscordMessage({ id: 'cursor-crash', guildId: 'guild-1', channelId: 'channel-codex', authorId: 'operator-1', isBot: false, content: 'y' });
  state.claimDispatch('cursor-crash');
  state.markSubmitted('cursor-crash', { file: '/tmp/session.jsonl', offset: 12 }, '[[discord-surface:cursor-crash]]');
  const crashed = await observeSubmitted(state, state.getMessage('cursor-crash'), {
    async observe(_message, _outcome, options) {
      options.onCursor({ file: '/tmp/session.jsonl', offset: 99 });
      throw new Error('observer crashed after scanning');
    }
  });
  assert.equal(crashed.message.state, MESSAGE_STATES.SUBMITTED);
  assert.equal(state.getMessage('cursor-crash').observerCursor.offset, 12);
  state.close();
});

test('simulated: provider identity fences same-UUID native replies', () => {
  const { dir, state } = fixture();
  state.bind({ channelId: 'channel-codex', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir });
  state.bind({ channelId: 'channel-claude', guildId: 'guild-1', provider: 'claude', nativeId: CODEX_ID, workspace: dir, endpoint: path.join(dir, 'claude.sock') });
  state.acceptDiscordMessage({ id: 'provider-fence', guildId: 'guild-1', channelId: 'channel-codex', authorId: 'operator-1', isBot: false, content: 'x' });
  state.claimDispatch('provider-fence');
  state.markSubmitted('provider-fence');
  assert.throws(() => state.recordNativeReply({ provider: 'claude', messageId: 'provider-fence', nativeId: CODEX_ID, generation: 1, text: 'wrong owner' }), StaleGenerationError);
  assert.equal(state.getMessage('provider-fence').state, MESSAGE_STATES.SUBMITTED);
  state.recordNativeReply({ provider: 'codex', messageId: 'provider-fence', nativeId: CODEX_ID, generation: 1, text: 'right owner' });
  assert.equal(state.getMessage('provider-fence').state, MESSAGE_STATES.REPLY_READY);
  state.close();
});

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
    permissionsFor: () => historyPermissions(),
    async send() { return { id: 'reply-login-input' }; }
  };
  const client = {
    user: { id: 'bot-1' },
    on(name, fn) { listeners.set(name, fn); },
    off(name, fn) { if (listeners.get(name) === fn) listeners.delete(name); },
    async login() { await listeners.get('messageCreate')(discordMessage({ id: '101', channelId: 'channel-codex' })); },
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
  assert.match(channel.topic, /readiness=ready/);
  await gateway.reconcilePending();
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

test('simulated: live custody during readiness topic close becomes an explicit recovery gap', async () => {
  const { dir, state } = fixture();
  state.bind({ channelId: 'channel-codex', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir });
  state.setIntakeBaseline('channel-codex', '100', 'previous completed recovery');
  state.markIntakeBoundary('channel-codex', 'ready');
  const secret = path.join(dir, 'discord.env');
  fs.writeFileSync(secret, 'DISCORD_TOKEN=fake-token\n', { mode: 0o600 });
  const listeners = new Map();
  let channel;
  channel = {
    id: 'channel-codex',
    guildId: 'guild-1',
    topic: '',
    permissionsFor: () => historyPermissions(),
    async setTopic(topic) {
      this.topic = topic;
      if (/\breadiness=ready\b/.test(topic)) listeners.get('messageCreate')?.(discordMessage({ id: '201', channelId: 'channel-codex' }));
    }
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
  await assert.rejects(() => gateway.start(secret), /intake recovery is gap/);
  assert.ok(state.getMessage('201'));
  assert.equal(state.getIntakeWatermark('channel-codex').recovered_through_id, '100');
  assert.equal(state.getIntakeWatermark('channel-codex').last_seen_id, '201');
  assert.equal(state.getIntakeWatermark('channel-codex').state, 'gap');
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

test('simulated: submitted recovery retains the Discord channel and never redispatches', async () => {
  const { dir, state } = fixture();
  state.bind({ channelId: 'channel-codex', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir });
  let sends = 0;
  let dispatches = 0;
  const channel = {
    async send() {
      sends += 1;
      return { id: 'reply-submitted-recovery' };
    }
  };
  const client = {
    on() {},
    off() {},
    channels: { fetch: async () => channel },
    async destroy() {}
  };
  const gateway = new DiscordGateway({
    state,
    client,
    providers: {
      codex: {
        async dispatch() {
          dispatches += 1;
          throw new Error('submitted recovery must not redispatch');
        },
        async observe() { return { text: 'recovered reply' }; }
      }
    }
  });
  await gateway.consumer.intakeMessage(discordMessage({ id: 'submitted-recovery', channelId: 'channel-codex', content: 'already sent' }), true);
  state.claimDispatch('submitted-recovery');
  state.markSubmitted('submitted-recovery');
  gateway.ready = true;
  await gateway.reconcilePending(new Date(Date.now() + 1).toISOString());
  assert.equal(sends, 1);
  assert.equal(dispatches, 0);
  assert.equal(state.getMessage('submitted-recovery').state, MESSAGE_STATES.REPLIED);
  await gateway.stop();
  state.close();
});

test('simulated: pending recovery channel fetch is bounded and stop settles without losing custody', async () => {
  const { dir, state } = fixture();
  state.bind({ channelId: 'channel-codex', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir });
  await createSurfaceConsumer({ state, providers: {}, sendReply: async () => ({ id: 'unused' }) })
    .intakeMessage(discordMessage({ id: 'pending-recovery', channelId: 'channel-codex' }), true);
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const client = {
    on() {},
    off() {},
    channels: { fetch: async () => blocked },
    async destroy() {}
  };
  const gateway = new DiscordGateway({ state, client, recoveryOptions: { timeoutMs: 1000 } });
  gateway.ready = true;
  let recoverySettled = false;
  const recovery = gateway.reconcilePending(new Date(Date.now() + 1).toISOString()).finally(() => { recoverySettled = true; });
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.equal(recoverySettled, true);
  let stopSettled = false;
  const stop = gateway.stop().finally(() => { stopSettled = true; });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(stopSettled, true);
  release(null);
  await Promise.all([recovery, stop]);
  assert.equal(state.getMessage('pending-recovery').state, MESSAGE_STATES.ACCEPTED);
  state.close();
});

test('simulated: stale handoff topic keeps recovery unavailable until exact repair', async () => {
  const { dir, state } = fixture();
  state.bind({ channelId: 'handoff-recovery', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir, conductorId: 'handoff-recovery-conductor', repoKey: 'repo:alpha' });
  state.markIntakeBoundary('handoff-recovery', 'ready');
  const oldMarker = conductorMarker({ provider: 'codex', nativeId: CODEX_ID, conductorId: 'handoff-recovery-conductor', repoKey: 'repo:alpha', generation: 1, readiness: READINESS.READY });
  const channel = {
    id: 'handoff-recovery',
    topic: oldMarker,
    permissionsFor: () => historyPermissions(),
    async setTopic(topic) { this.topic = topic; }
  };
  const client = {
    user: { id: 'bot-1' },
    on() {},
    off() {},
    channels: { fetch: async () => channel },
    async destroy() {}
  };
  state.handoffConductor({
    channelId: 'handoff-recovery',
    provider: 'codex',
    conductorId: 'handoff-recovery-conductor',
    repoKey: 'repo:alpha',
    fromNativeId: CODEX_ID,
    fromGeneration: 1,
    nativeId: SUCCESSOR_ID,
    workspace: dir,
    handoffId: 'handoff-recovery-1'
  });
  let historyCalls = 0;
  const gateway = new DiscordGateway({ state, client, fetchHistory: async () => { historyCalls += 1; return []; } });
  const result = await gateway.recoverTransport('restart');
  assert.equal(result.ready, false);
  assert.equal(result.state, 'unavailable');
  assert.equal(state.getBinding('handoff-recovery').readiness, READINESS.UNAVAILABLE);
  assert.equal(historyCalls, 0);
  assert.match(channel.topic, /native=9caa5d21-2169-429d-918b-5f08651b5dbd generation=1/);
  await gateway.stop();
  state.close();
});

test('simulated: handoff during history fetch cannot authorize the successor', async () => {
  const { dir, state } = fixture();
  state.bind({ channelId: 'mid-fetch-handoff', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir, conductorId: 'mid-fetch-conductor', repoKey: 'repo:alpha' });
  state.setIntakeBaseline('mid-fetch-handoff', '100', 'previous completed recovery');
  state.markIntakeBoundary('mid-fetch-handoff', 'ready');
  const old = state.getBinding('mid-fetch-handoff');
  let topicWrites = 0;
  const channel = {
    id: 'mid-fetch-handoff',
    topic: conductorMarker({ provider: 'codex', nativeId: CODEX_ID, conductorId: 'mid-fetch-conductor', repoKey: 'repo:alpha', generation: 1, readiness: READINESS.READY }),
    permissionsFor: () => historyPermissions(),
    async setTopic(topic) { topicWrites += 1; this.topic = topic; }
  };
  const client = {
    user: { id: 'bot-1' },
    on() {},
    off() {},
    channels: { fetch: async () => channel },
    async destroy() {}
  };
  let historyCalls = 0;
  const gateway = new DiscordGateway({
    state,
    client,
    fetchHistory: async () => {
      historyCalls += 1;
      state.handoffConductor({ ...old, fromNativeId: old.nativeId, fromGeneration: old.generation, nativeId: SUCCESSOR_ID, handoffId: 'mid-fetch-handoff-1' });
      return [];
    }
  });
  const result = await gateway.recoverTransport('restart');
  const current = state.getBinding('mid-fetch-handoff');
  assert.equal(result.ready, false);
  assert.equal(result.state, 'unavailable');
  assert.equal(current.nativeId, SUCCESSOR_ID);
  assert.equal(current.generation, 2);
  assert.equal(current.readiness, READINESS.PENDING);
  assert.equal(historyCalls, 1);
  assert.equal(topicWrites, 0);
  assert.equal(channel.topic, conductorMarker({ provider: 'codex', nativeId: CODEX_ID, conductorId: 'mid-fetch-conductor', repoKey: 'repo:alpha', generation: 1, readiness: READINESS.READY }));
  await gateway.stop();
  state.close();
});

test('simulated: publication custody refuses handoff during readiness topic write', async () => {
  const { dir, state } = fixture();
  state.bind({ channelId: 'mid-topic-handoff', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir, conductorId: 'mid-topic-conductor', repoKey: 'repo:alpha' });
  state.setIntakeBaseline('mid-topic-handoff', '100', 'previous completed recovery');
  state.markIntakeBoundary('mid-topic-handoff', 'ready');
  const old = state.getBinding('mid-topic-handoff');
  let handedOff = false;
  const channel = {
    id: 'mid-topic-handoff',
    topic: conductorMarker({ provider: 'codex', nativeId: CODEX_ID, conductorId: 'mid-topic-conductor', repoKey: 'repo:alpha', generation: 1, readiness: READINESS.READY }),
    permissionsFor: () => historyPermissions(),
    async setTopic(topic) {
      if (!handedOff) {
        handedOff = true;
        try {
          state.handoffConductor({ ...old, fromNativeId: old.nativeId, fromGeneration: old.generation, nativeId: SUCCESSOR_ID, handoffId: 'mid-topic-handoff-1' });
        } catch (error) {
          assert.ok(error instanceof UnresolvedWorkError);
          throw error;
        }
      }
      this.topic = topic;
    }
  };
  const client = {
    user: { id: 'bot-1' },
    on() {},
    off() {},
    channels: { fetch: async () => channel },
    async destroy() {}
  };
  let historyCalls = 0;
  const gateway = new DiscordGateway({ state, client, fetchHistory: async () => { historyCalls += 1; return []; } });
  const result = await gateway.recoverTransport('restart');
  const current = state.getBinding('mid-topic-handoff');
  assert.equal(result.ready, false);
  assert.equal(result.state, 'unavailable');
  assert.equal(current.nativeId, CODEX_ID);
  assert.equal(current.generation, 1);
  assert.equal(current.readiness, READINESS.UNAVAILABLE);
  assert.equal(historyCalls, 1);
  assert.match(channel.topic, /native=9caa5d21-2169-429d-918b-5f08651b5dbd generation=1 readiness=ready/);
  assert.equal(conductorMarkerMatches(channel.topic, { provider: 'codex', nativeId: SUCCESSOR_ID, conductorId: 'mid-topic-conductor', repoKey: 'repo:alpha', generation: 2 }), false);
  await gateway.stop();
  state.close();
});

test('simulated: terminal publication custody blocks successor commit during write', async () => {
  const { dir, state } = fixture();
  state.bind({ channelId: 'terminal-topic-handoff', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir, conductorId: 'terminal-topic-conductor', repoKey: 'repo:alpha' });
  state.setIntakeBaseline('terminal-topic-handoff', '100', 'previous completed recovery');
  state.markIntakeBoundary('terminal-topic-handoff', 'ready');
  const old = state.getBinding('terminal-topic-handoff');
  let topicWrites = 0;
  const channel = {
    id: 'terminal-topic-handoff',
    topic: conductorMarker({ provider: 'codex', nativeId: CODEX_ID, conductorId: 'terminal-topic-conductor', repoKey: 'repo:alpha', generation: 1, readiness: READINESS.READY }),
    permissionsFor: () => historyPermissions(),
    async setTopic(topic) {
      topicWrites += 1;
      try {
        state.handoffConductor({ ...old, fromNativeId: old.nativeId, fromGeneration: old.generation, nativeId: SUCCESSOR_ID, handoffId: 'terminal-topic-handoff-1' });
      } catch (error) {
        assert.ok(error instanceof UnresolvedWorkError);
        throw error;
      }
      this.topic = topic;
    }
  };
  const client = {
    user: { id: 'bot-1' },
    on() {},
    off() {},
    channels: { fetch: async () => channel },
    async destroy() {}
  };
  const gateway = new DiscordGateway({ state, client, fetchHistory: async () => [] });
  const result = await gateway.recoverTransport('restart');
  const current = state.getBinding('terminal-topic-handoff');
  assert.equal(result.ready, false);
  assert.equal(result.state, 'unavailable');
  assert.equal(topicWrites, 1);
  assert.equal(current.nativeId, CODEX_ID);
  assert.equal(current.generation, 1);
  assert.equal(current.readiness, READINESS.UNAVAILABLE);
  assert.equal(conductorMarkerMatches(channel.topic, { provider: 'codex', nativeId: SUCCESSOR_ID, conductorId: 'terminal-topic-conductor', repoKey: 'repo:alpha', generation: 2 }), false);
  assert.equal(state.getReadiness().topicPublications.length, 1);
  await gateway.stop();
  state.close();
});

test('simulated: terminal topic rate limit keeps history custody and blocks dispatch', async () => {
  for (const [label, makeError, expectedOutcome] of [
    ['rate limit', () => Object.assign(new Error('RateLimitError[/channels/:id]'), { name: 'RateLimitError[/channels/:id]' }), 'rate_limited'],
    ['ambiguous send', () => Object.assign(new Error('socket closed after topic send'), { code: 'ECONNRESET' }), 'unknown']
  ]) {
    const { dir, state } = fixture();
    state.bind({ channelId: `topic-${label.replace(/\s/g, '-')}`, guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir, conductorId: `topic-${label}`, repoKey: 'repo:alpha' });
    const channelId = `topic-${label.replace(/\s/g, '-')}`;
    state.setIntakeBaseline(channelId, '100', 'previous completed recovery');
    state.markIntakeBoundary(channelId, 'ready');
    const marker = conductorMarker({ provider: 'codex', nativeId: CODEX_ID, conductorId: `topic-${label}`, repoKey: 'repo:alpha', generation: 1, readiness: READINESS.READY });
    const rest = { options: { rejectOnRateLimit: null }, async patch(route, options) {
      assert.equal(route, `/channels/${channelId}`);
      assert.equal(options.body.topic.includes('last-published-intake=ready'), true);
      assert.equal(rest.options.rejectOnRateLimit({ method: 'PATCH', route: '/channels/:id' }), true);
      throw makeError();
    } };
    const channel = { id: channelId, topic: marker, client: { rest }, permissionsFor: () => historyPermissions() };
    const client = { user: { id: 'bot-1' }, on() {}, off() {}, channels: { fetch: async () => channel }, async destroy() {} };
    let dispatches = 0;
    const gateway = new DiscordGateway({
      state,
      client,
      providers: { codex: { async dispatch() { dispatches += 1; return { status: 'submitted' }; }, async observe() { return { text: 'unused' }; } } },
      fetchHistory: async () => []
    });
    const result = await gateway.recoverTransport('restart');
    const watermark = state.getIntakeWatermark(channelId);
    const binding = state.getBinding(channelId);
    const publication = state.getReadiness().topicPublications.find(item => item.channelId === channelId);
    const custody = state.listTopicPublications().find(item => item.channelId === channelId);
    assert.equal(result.ready, false, label);
    assert.equal(result.state, 'unavailable', label);
    assert.equal(watermark.recovered_through_id, '100', label);
    assert.equal(watermark.state, READINESS.PENDING, label);
    assert.equal(binding.readiness, READINESS.UNAVAILABLE, label);
    assert.equal(publication.outcome, expectedOutcome, label);
    assert.equal(custody.status, expectedOutcome === 'rate_limited' ? 'not_published' : 'unknown', label);
    assert.equal(publication.desiredReadiness, READINESS.READY, label);
    assert.equal(rest.options.rejectOnRateLimit, null, label);
    const held = await gateway.consumer.handleMessage(discordMessage({ id: `held-${label}`, channelId }));
    assert.equal(dispatches, 0, label);
    assert.equal(held.status, 'binding-not-ready', label);
    assert.equal(state.getMessage(`held-${label}`).state, MESSAGE_STATES.ACCEPTED, label);
    await gateway.stop();
    state.close();
  }
});

test('simulated: uncooperative terminal topic request is deadline-fenced and leaves coverage durable', async () => {
  const { dir, state } = fixture();
  const channelId = 'topic-deadline';
  state.bind({ channelId, guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir, conductorId: 'topic-deadline-conductor', repoKey: 'repo:alpha' });
  state.setIntakeBaseline(channelId, '100', 'previous completed recovery');
  state.markIntakeBoundary(channelId, 'ready');
  let aborted = false;
  const rest = {
    options: { rejectOnRateLimit: null, retries: 3 },
    async patch(_route, { signal }) {
      signal.addEventListener('abort', () => { aborted = true; }, { once: true });
      return new Promise(() => {});
    }
  };
  const channel = {
    id: channelId,
    topic: conductorMarker({ provider: 'codex', nativeId: CODEX_ID, conductorId: 'topic-deadline-conductor', repoKey: 'repo:alpha', generation: 1, readiness: READINESS.READY }),
    client: { rest },
    permissionsFor: () => historyPermissions()
  };
  const client = { user: { id: 'bot-1' }, on() {}, off() {}, channels: { fetch: async () => channel }, async destroy() {} };
  const gateway = new DiscordGateway({ state, client, recoveryOptions: { timeoutMs: 1000 }, fetchHistory: async () => [] });
  const started = Date.now();
  const result = await gateway.recoverTransport('restart');
  assert.ok(Date.now() - started < 1400);
  assert.equal(result.ready, false);
  assert.equal(result.state, 'unavailable');
  assert.equal(aborted, true);
  assert.equal(rest.options.rejectOnRateLimit, null);
  assert.equal(rest.options.retries, 3);
  assert.equal(state.getIntakeWatermark(channelId).recovered_through_id, '100');
  assert.equal(state.getIntakeWatermark(channelId).state, READINESS.PENDING);
  assert.equal(state.getBinding(channelId).readiness, READINESS.UNAVAILABLE);
  await gateway.stop();
  state.close();
});

test('simulated: in-flight topic publication fences every binding ownership change', () => {
  const { dir, state } = fixture();
  state.bind({ channelId: 'topic-custody-guards', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir, conductorId: 'topic-custody-guards', repoKey: 'repo:alpha' });
  const binding = state.getBinding('topic-custody-guards');
  const custody = state.beginTopicPublication('topic-custody-guards', {
    desiredReadiness: READINESS.READY,
    desiredTopic: conductorMarker({ provider: 'codex', nativeId: CODEX_ID, conductorId: 'topic-custody-guards', repoKey: 'repo:alpha', generation: 1, readiness: READINESS.READY })
  }, binding);
  assert.equal(custody.status, 'in_flight');
  assert.throws(() => state.setBindingReadiness('topic-custody-guards', READINESS.READY), UnresolvedWorkError);
  assert.throws(() => state.markIntakeBoundary('topic-custody-guards', 'ready'), UnresolvedWorkError);
  assert.throws(() => state.rebind({ channelId: 'topic-custody-guards', guildId: 'guild-1', provider: 'codex', nativeId: SUCCESSOR_ID, workspace: dir }), UnresolvedWorkError);
  assert.throws(() => state.unbind('topic-custody-guards'), UnresolvedWorkError);
  assert.throws(() => state.handoffConductor({
    channelId: 'topic-custody-guards', provider: 'codex', conductorId: 'topic-custody-guards', repoKey: 'repo:alpha',
    fromNativeId: CODEX_ID, fromGeneration: 1, nativeId: SUCCESSOR_ID, workspace: dir, handoffId: 'topic-custody-guards-handoff'
  }), UnresolvedWorkError);
  state.close();
});

test('simulated: deferred topic request stays fenced until a definite server response', async () => {
  const { dir, db, state } = fixture();
  const channelId = 'topic-restart-reconcile';
  state.bind({ channelId, guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir, conductorId: 'topic-restart-conductor', repoKey: 'repo:alpha' });
  state.setIntakeBaseline(channelId, '100', 'previous completed recovery');
  state.markIntakeBoundary(channelId, 'ready');
  const marker = conductorMarker({ provider: 'codex', nativeId: CODEX_ID, conductorId: 'topic-restart-conductor', repoKey: 'repo:alpha', generation: 1, readiness: READINESS.READY });
  let rejectPatch;
  const blockedRest = { options: { rejectOnRateLimit: null, retries: 3 }, async patch() { return new Promise((_resolve, reject) => { rejectPatch = reject; }); } };
  const blockedChannel = { id: channelId, topic: marker, permissionsFor: () => historyPermissions(), client: { rest: blockedRest } };
  const blockedClient = { user: { id: 'bot-1' }, on() {}, off() {}, channels: { fetch: async () => blockedChannel }, async destroy() {} };
  const blockedGateway = new DiscordGateway({ state, client: blockedClient, recoveryOptions: { timeoutMs: 1000 }, fetchHistory: async () => [] });
  const blockedResult = await blockedGateway.recoverTransport('restart');
  assert.equal(blockedResult.ready, false);
  assert.equal(state.listTopicPublications().at(-1).status, 'unknown');
  const requestId = state.listTopicPublications().at(-1).requestId;
  assert.equal(state.getTopicPublication(requestId).operationEndedAt, null);
  assert.throws(() => state.reconcileTopicPublication(channelId, requestId, 'not_published', 'caller text', {
    topic: marker,
    observedAt: new Date().toISOString()
  }), UnresolvedWorkError);
  assert.throws(() => state.handoffConductor({
    channelId, provider: 'codex', conductorId: 'topic-restart-conductor', repoKey: 'repo:alpha',
    fromNativeId: CODEX_ID, fromGeneration: 1, nativeId: SUCCESSOR_ID, workspace: dir, handoffId: 'topic-restart-handoff'
  }), UnresolvedWorkError);
  rejectPatch(Object.assign(new Error('RateLimitError[/channels/:id]'), { name: 'RateLimitError[/channels/:id]', status: 429 }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(state.getTopicPublication(requestId).status, 'not_published');
  assert.ok(state.getTopicPublication(requestId).operationEndedAt);
  const successor = state.handoffConductor({
    channelId, provider: 'codex', conductorId: 'topic-restart-conductor', repoKey: 'repo:alpha',
    fromNativeId: CODEX_ID, fromGeneration: 1, nativeId: SUCCESSOR_ID, workspace: dir, handoffId: 'topic-restart-handoff'
  });
  assert.equal(successor.generation, 2);
  await blockedGateway.stop();
  state.close();
  const restarted = new SurfaceState(db);
  assert.equal(restarted.getTopicPublication(requestId).status, 'not_published');
  restarted.close();
});

test('simulated: topic reconciliation requires remote terminal evidence and fresh readback', () => {
  const { dir, state } = fixture();
  const channelId = 'topic-reconcile-proof';
  state.bind({ channelId, guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir, conductorId: 'topic-reconcile-proof', repoKey: 'repo:alpha' });
  const binding = state.getBinding(channelId);
  const oldTopic = conductorMarker({ provider: 'codex', nativeId: CODEX_ID, conductorId: 'topic-reconcile-proof', repoKey: 'repo:alpha', generation: 1, readiness: READINESS.PENDING });
  const desiredTopic = conductorMarker({ provider: 'codex', nativeId: CODEX_ID, conductorId: 'topic-reconcile-proof', repoKey: 'repo:alpha', generation: 1, readiness: READINESS.READY });
  const custody = state.beginTopicPublication(channelId, { desiredReadiness: READINESS.READY, desiredTopic }, binding);
  state.recordTopicPublication(channelId, { requestId: custody.requestId, desiredReadiness: READINESS.READY, outcome: 'unknown', remoteTerminal: true, observedTopic: oldTopic }, binding);
  const operationEndedAt = state.getTopicPublication(custody.requestId).operationEndedAt;
  assert.ok(operationEndedAt);
  assert.throws(() => state.reconcileTopicPublication(channelId, custody.requestId, 'not_published', 'caller text'), /fresh topic readback is required/);
  assert.throws(() => state.reconcileTopicPublication(channelId, custody.requestId, 'not_published', 'caller text', {
    topic: desiredTopic,
    observedAt: new Date(Date.parse(operationEndedAt) + 1).toISOString()
  }), /confirms the desired publication/);
  state.reconcileTopicPublication(channelId, custody.requestId, 'not_published', 'Discord GET readback after remote terminal evidence', {
    topic: oldTopic,
    observedAt: new Date(Date.parse(operationEndedAt) + 1).toISOString()
  });
  assert.equal(state.getTopicPublication(custody.requestId).status, 'not_published');
  state.close();
});

test('simulated: aborted topic request cannot authorize handoff after a late remote mutation', async () => {
  const { dir, state } = fixture();
  const channelId = 'topic-late-mutation';
  state.bind({ channelId, guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir, conductorId: 'topic-late-mutation', repoKey: 'repo:alpha' });
  const binding = state.getBinding(channelId);
  const oldTopic = conductorMarker({ provider: 'codex', nativeId: CODEX_ID, conductorId: 'topic-late-mutation', repoKey: 'repo:alpha', generation: 1, readiness: READINESS.PENDING });
  const channel = { id: channelId, topic: oldTopic, client: { rest: { options: { rejectOnRateLimit: null, retries: 2 }, async patch(_route, { signal }) {
    signal.addEventListener('abort', () => setTimeout(() => { channel.topic = oldTopic; }, 25), { once: true });
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => setTimeout(() => reject(new Error('AbortError')), 25), { once: true }));
  } } } };
  const gateway = new DiscordGateway({ state, client: { on() {}, off() {} } });
  const result = await gateway.recordBoundary(binding, channel, 'ready', 'late mutation test', null, null, new AbortController().signal, Date.now() + 20);
  assert.equal(result.topicPublished, false);
  const requestId = state.listTopicPublications().at(-1).requestId;
  assert.equal(state.getTopicPublication(requestId).status, 'unknown');
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(state.getTopicPublication(requestId).status, 'unknown');
  assert.equal(state.getTopicPublication(requestId).operationEndedAt, null);
  assert.throws(() => state.handoffConductor({
    channelId, provider: 'codex', conductorId: 'topic-late-mutation', repoKey: 'repo:alpha',
    fromNativeId: CODEX_ID, fromGeneration: 1, nativeId: SUCCESSOR_ID, workspace: dir, handoffId: 'topic-late-mutation-handoff'
  }), UnresolvedWorkError);
  await gateway.stop();
  state.close();
});

test('simulated: readiness transaction rejects a second-connection successor', () => {
  const { dir, db, state } = fixture();
  state.bind({ channelId: 'atomic-readiness', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir, conductorId: 'atomic-readiness-conductor', repoKey: 'repo:alpha' });
  const old = state.getBinding('atomic-readiness');
  const other = new SurfaceState(db);
  other.handoffConductor({ ...old, fromNativeId: old.nativeId, fromGeneration: old.generation, nativeId: SUCCESSOR_ID, handoffId: 'atomic-readiness-1' });
  assert.equal(state.setBindingReadiness('atomic-readiness', READINESS.RECOVERING, 'stale recovery', old), null);
  assert.equal(state.getBinding('atomic-readiness').readiness, READINESS.PENDING);
  other.close();
  state.close();
});

test('simulated: boundary transaction rejects a handoff committed by a second connection', async () => {
  const { dir, db, state } = fixture();
  state.bind({ channelId: 'atomic-boundary', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir, conductorId: 'atomic-boundary-conductor', repoKey: 'repo:alpha' });
  state.setIntakeBaseline('atomic-boundary', '100', 'previous completed recovery');
  state.markIntakeBoundary('atomic-boundary', 'ready');
  const old = state.getBinding('atomic-boundary');
  const other = new SurfaceState(db);
  const original = state.markIntakeBoundary.bind(state);
  let changed = false;
  state.markIntakeBoundary = (...args) => {
    if (args[1] === 'ready' && !changed) {
      changed = true;
      other.handoffConductor({ ...old, fromNativeId: old.nativeId, fromGeneration: old.generation, nativeId: SUCCESSOR_ID, handoffId: 'atomic-boundary-1' });
    }
    return original(...args);
  };
  const channel = {
    id: 'atomic-boundary',
    topic: conductorMarker({ provider: 'codex', nativeId: CODEX_ID, conductorId: 'atomic-boundary-conductor', repoKey: 'repo:alpha', generation: 1, readiness: READINESS.READY }),
    permissionsFor: () => historyPermissions(),
    async setTopic(topic) { this.topic = topic; }
  };
  const client = {
    user: { id: 'bot-1' },
    on() {},
    off() {},
    channels: { fetch: async () => channel },
    async destroy() {}
  };
  const gateway = new DiscordGateway({ state, client, fetchHistory: async () => [] });
  try {
    const result = await gateway.recoverTransport('restart');
    assert.equal(result.ready, false);
    assert.equal(result.state, 'unavailable');
    assert.equal(state.getBinding('atomic-boundary').readiness, READINESS.PENDING);
    assert.equal(state.getIntakeWatermark('atomic-boundary').state, 'ready');
  } finally {
    state.markIntakeBoundary = original;
    await gateway.stop();
    other.close();
    state.close();
  }
});

test('simulated: baseline transaction rejects a handoff before cutoff custody', async () => {
  const { dir, db, state } = fixture();
  state.bind({ channelId: 'atomic-baseline', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir, conductorId: 'atomic-baseline-conductor', repoKey: 'repo:alpha' });
  const old = state.getBinding('atomic-baseline');
  const other = new SurfaceState(db);
  const original = state.setIntakeBaseline.bind(state);
  let changed = false;
  state.setIntakeBaseline = (...args) => {
    if (args[3] && !changed) {
      changed = true;
      other.handoffConductor({ ...old, fromNativeId: old.nativeId, fromGeneration: old.generation, nativeId: SUCCESSOR_ID, handoffId: 'atomic-baseline-1' });
    }
    return original(...args);
  };
  const channel = {
    id: 'atomic-baseline',
    topic: conductorMarker({ provider: 'codex', nativeId: CODEX_ID, conductorId: 'atomic-baseline-conductor', repoKey: 'repo:alpha', generation: 1, readiness: READINESS.PENDING }),
    permissionsFor: () => historyPermissions(),
    async setTopic(topic) { this.topic = topic; }
  };
  const client = {
    user: { id: 'bot-1' },
    on() {},
    off() {},
    channels: { fetch: async () => channel },
    async destroy() {}
  };
  const gateway = new DiscordGateway({ state, client, fetchHistory: async () => [{ id: '101', guildId: 'guild-1', channelId: 'atomic-baseline', author: { id: 'operator-1', bot: false }, content: 'cutoff' }] });
  try {
    const result = await gateway.recoverTransport('restart');
    assert.equal(result.ready, false);
    assert.equal(result.state, 'unavailable');
    assert.equal(state.getBinding('atomic-baseline').readiness, READINESS.PENDING);
    assert.equal(state.getIntakeWatermark('atomic-baseline'), null);
  } finally {
    state.setIntakeBaseline = original;
    await gateway.stop();
    other.close();
    state.close();
  }
});

test('simulated: history admission transaction rejects a handoff before coverage custody', async () => {
  const { dir, db, state } = fixture();
  state.bind({ channelId: 'atomic-admission', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir, conductorId: 'atomic-admission-conductor', repoKey: 'repo:alpha' });
  state.setIntakeBaseline('atomic-admission', '100', 'previous completed recovery');
  state.markIntakeBoundary('atomic-admission', 'ready');
  const old = state.getBinding('atomic-admission');
  const other = new SurfaceState(db);
  const original = state.acceptDiscordMessage.bind(state);
  let changed = false;
  state.acceptDiscordMessage = (event, options) => {
    if (options?.expectedBinding && !changed) {
      changed = true;
      other.handoffConductor({ ...old, fromNativeId: old.nativeId, fromGeneration: old.generation, nativeId: SUCCESSOR_ID, handoffId: 'atomic-admission-1' });
    }
    return original(event, options);
  };
  const channel = {
    id: 'atomic-admission',
    topic: conductorMarker({ provider: 'codex', nativeId: CODEX_ID, conductorId: 'atomic-admission-conductor', repoKey: 'repo:alpha', generation: 1, readiness: READINESS.READY }),
    permissionsFor: () => historyPermissions(),
    async setTopic(topic) { this.topic = topic; }
  };
  const client = {
    user: { id: 'bot-1' },
    on() {},
    off() {},
    channels: { fetch: async () => channel },
    async destroy() {}
  };
  const gateway = new DiscordGateway({ state, client, fetchHistory: async () => [{ id: '101', guildId: 'guild-1', channelId: 'atomic-admission', author: { id: 'operator-1', bot: false }, content: 'history' }] });
  try {
    const result = await gateway.recoverTransport('restart');
    assert.equal(result.ready, false);
    assert.equal(result.state, 'unavailable');
    assert.equal(state.getBinding('atomic-admission').readiness, READINESS.PENDING);
    assert.equal(state.getIntakeWatermark('atomic-admission').recovered_through_id, '100');
    assert.equal(state.getMessage('101'), null);
  } finally {
    state.acceptDiscordMessage = original;
    await gateway.stop();
    other.close();
    state.close();
  }
});

test('simulated: disconnect pauses dispatch and shard ready performs fresh recovery', async () => {
  const { dir, state } = fixture();
  state.bind({ channelId: 'channel-codex', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir });
  state.setIntakeBaseline('channel-codex', '100', 'previous completed recovery');
  state.markIntakeBoundary('channel-codex', 'ready');
  const client = new EventEmitter();
  client.user = { id: 'bot-1' };
  client.channels = { fetch: async () => ({ id: 'channel-codex', permissionsFor: () => historyPermissions() }) };
  client.login = async () => {};
  client.destroy = async () => {};
  let scans = 0;
  const gateway = new DiscordGateway({ state, client, fetchHistory: async () => { scans += 1; return []; } });
  const secret = path.join(dir, 'discord.env');
  fs.writeFileSync(secret, 'DISCORD_TOKEN=fake-token\n', { mode: 0o600 });
  await gateway.start(secret);
  const scansBefore = scans;
  client.emit('shardDisconnect', new Error('socket lost'), 0);
  assert.equal(gateway.ready, false);
  client.emit('shardReconnecting', 0);
  client.emit('shardReady', 0, new Set());
  await gateway.reconnectPromise;
  assert.ok(scans > scansBefore);
  assert.equal(gateway.ready, true);
  await gateway.stop();
  state.close();
});

test('simulated: initial shard ready stays startup-owned and does not duplicate recovery', async () => {
  const { dir, state } = fixture();
  state.bind({ channelId: 'channel-codex', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir });
  const client = new EventEmitter();
  client.user = { id: 'bot-1' };
  client.channels = { fetch: async () => ({ id: 'channel-codex', topic: '', permissionsFor: () => historyPermissions() }) };
  client.login = async () => { client.emit('shardReady', 0, new Set()); };
  client.destroy = async () => {};
  const recoveries = [];
  let scans = 0;
  const gateway = new DiscordGateway({ state, client, fetchHistory: async () => { scans += 1; return []; } });
  const recoverTransport = gateway.recoverTransport.bind(gateway);
  gateway.recoverTransport = async (reason, epoch) => {
    recoveries.push(reason);
    return recoverTransport(reason, epoch);
  };
  const secret = path.join(dir, 'discord.env');
  fs.writeFileSync(secret, 'DISCORD_TOKEN=fake-token\n', { mode: 0o600 });
  await gateway.start(secret);
  assert.deepEqual(recoveries, ['startup']);
  assert.equal(scans, 1);
  assert.equal(gateway.ready, true);
  assert.equal(gateway.reconnectPromise, null);
  await gateway.stop();
  state.close();
});

test('simulated: pending successor custody stays accepted until readiness is restored', async () => {
  const { dir, state } = fixture();
  state.bind({ channelId: 'pending-successor', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir, conductorId: 'pending-conductor', repoKey: 'repo:alpha' });
  let dispatches = 0;
  const consumer = createSurfaceConsumer({
    state,
    providers: { codex: { async dispatch() { dispatches += 1; return { status: 'submitted' }; }, async observe() { return { text: 'answer' }; } } },
    sendReply: async () => ({ id: 'pending-successor-reply' })
  });
  const held = await consumer.handleMessage(discordMessage({ id: 'pending-successor-input', channelId: 'pending-successor' }));
  assert.equal(held.status, 'binding-not-ready');
  assert.equal(held.message.state, MESSAGE_STATES.ACCEPTED);
  assert.equal(dispatches, 0);
  state.markIntakeBoundary('pending-successor', 'ready');
  const resumed = await consumer.handleStoredMessage(discordMessage({ id: 'pending-successor-input', channelId: 'pending-successor' }));
  assert.equal(resumed.message.state, MESSAGE_STATES.REPLIED);
  assert.equal(dispatches, 1);
  state.close();
});

test('simulated: failed handoff topic write is repaired by the exact durable handoff', async () => {
  const { dir, state } = fixture();
  state.bind({ channelId: 'handoff-channel', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir, conductorId: 'handoff-conductor', repoKey: 'repo:alpha' });
  state.markIntakeBoundary('handoff-channel', 'ready');
  const channel = {
    parentId: 'codex-category',
    topic: conductorMarker({ provider: 'codex', nativeId: CODEX_ID, conductorId: 'handoff-conductor', repoKey: 'repo:alpha', generation: 1, readiness: READINESS.READY }),
    attempts: 0,
    async setTopic(topic) {
      this.attempts += 1;
      if (this.attempts === 1) throw Object.assign(new Error('RateLimitError[/channels/:id]'), { name: 'RateLimitError[/channels/:id]', status: 429 });
      this.topic = topic;
    }
  };
  const handoff = {
    channelId: 'handoff-channel', provider: 'codex', conductorId: 'handoff-conductor', repoKey: 'repo:alpha',
    fromNativeId: CODEX_ID, fromGeneration: 1, nativeId: SUCCESSOR_ID, workspace: dir, handoffId: 'handoff-repair-1'
  };
  const successor = state.handoffConductor(handoff);
  const marker = conductorMarker({ provider: 'codex', nativeId: SUCCESSOR_ID, conductorId: 'handoff-conductor', repoKey: 'repo:alpha', generation: successor.generation, readiness: successor.readiness });
  await assert.rejects(() => publishHandoffTopic(state, channel, marker, successor), /RateLimitError/);
  const requestId = state.listTopicPublications().at(-1).requestId;
  assert.equal(state.getTopicPublication(requestId).status, 'not_published');
  assert.ok(state.getTopicPublication(requestId).operationEndedAt);
  const repaired = state.handoffConductor(handoff);
  assert.equal(repaired.handoffReconciled, true);
  assert.equal(repaired.generation, 2);
  await publishHandoffTopic(state, channel, marker, repaired);
  assert.equal(channel.topic, marker);
  assert.throws(() => state.handoffConductor({ ...handoff, handoffId: 'handoff-repair-1', nativeId: CLAUDE_ID }), /already used/);
  state.close();
});

test('simulated: empty Discord history requires known effective read permission', async () => {
  for (const [label, allowed, known] of [['revoked', false, true], ['unknown', false, false]]) {
    const { dir, state } = fixture();
    state.bind({ channelId: 'channel-codex', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir });
    state.setIntakeBaseline('channel-codex', '100', 'previous completed recovery');
    state.markIntakeBoundary('channel-codex', 'ready');
    const secret = path.join(dir, `discord-${label}.env`);
    fs.writeFileSync(secret, 'DISCORD_TOKEN=fake-token\n', { mode: 0o600 });
    const channel = { id: 'channel-codex', permissionsFor: known ? () => historyPermissions(allowed) : undefined };
    const client = {
      user: known ? { id: 'bot-1' } : undefined,
      on() {}, off() {}, async login() {}, channels: { fetch: async () => channel }, async destroy() {}
    };
    const gateway = new DiscordGateway({ state, client, fetchHistory: async () => { throw new Error('history must not be fetched'); } });
    await assert.rejects(() => gateway.start(secret), /intake recovery is unavailable/);
    const watermark = state.getIntakeWatermark('channel-codex');
    assert.equal(watermark.recovered_through_id, '100');
    assert.equal(watermark.state, 'unavailable');
    state.acceptDiscordMessage({ id: `held-${label}`, guildId: 'guild-1', channelId: 'channel-codex', authorId: 'operator-1', isBot: false, content: 'held while permission is unavailable' }, { ready: false });
    assert.equal(state.getIntakeWatermark('channel-codex').state, 'unavailable');
    await gateway.stop();
    state.close();
  }
});

test('simulated: unknown Discord delivery is reconciled without native redispatch', async () => {
  const { dir, state } = fixture();
  state.bind({ channelId: 'channel-codex', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir });
  let dispatches = 0;
  let sends = 0;
  const consumer = createSurfaceConsumer({
    state,
    providers: { codex: { async dispatch() { dispatches += 1; return { status: 'submitted' }; }, async observe() { return { text: 'answer' }; } } },
    sendReply: async () => { sends += 1; if (sends === 1) throw new TypeError('send result was not returned'); return { id: 'reply-reconciled' }; }
  });
  const first = await consumer.handleMessage(discordMessage({ id: 'delivery-reconcile', channelId: 'channel-codex' }));
  assert.equal(first.message.state, MESSAGE_STATES.REPLY_UNKNOWN);
  state.reconcileReplyDelivery('delivery-reconcile', 'not_sent');
  const second = await consumer.deliverReply(discordMessage({ id: 'delivery-reconcile', channelId: 'channel-codex' }), {
    status: 'reply_ready',
    message: state.getMessage('delivery-reconcile')
  });
  assert.equal(second.message.state, MESSAGE_STATES.REPLIED);
  assert.equal(dispatches, 1);
  assert.equal(sends, 2);
  state.close();
});

test('simulated: stable conductor identity permits distinct IDs and explicit same-channel successor handoff', () => {
  const { dir, state } = fixture();
  state.bind({ channelId: 'conductor-a', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir, conductorId: 'conductor-a', repoKey: 'repo:alpha' });
  state.bind({ channelId: 'conductor-b', guildId: 'guild-1', provider: 'codex', nativeId: CLAUDE_ID, workspace: dir, conductorId: 'conductor-b', repoKey: 'repo:alpha' });
  state.markIntakeBoundary('conductor-a', 'ready');
  assert.throws(() => state.bind({ channelId: 'duplicate-conductor', guildId: 'guild-1', provider: 'codex', nativeId: SUCCESSOR_ID, workspace: dir, conductorId: 'conductor-a', repoKey: 'repo:alpha' }), /already bound/);

  state.acceptDiscordMessage({ id: 'drained', guildId: 'guild-1', channelId: 'conductor-a', authorId: 'operator-1', isBot: false, content: 'drain' });
  state.claimDispatch('drained');
  state.markSubmitted('drained');
  state.recordNativeReply({ provider: 'codex', messageId: 'drained', nativeId: CODEX_ID, generation: 1, text: 'done' });
  state.beginReply('drained');
  state.markReplySent('drained', 'reply-drained');
  const successor = state.handoffConductor({
    channelId: 'conductor-a',
    provider: 'codex',
    conductorId: 'conductor-a',
    repoKey: 'repo:alpha',
    fromNativeId: CODEX_ID,
    fromGeneration: 1,
    nativeId: SUCCESSOR_ID,
    workspace: dir,
    handoffId: 'handoff-1'
  });
  assert.equal(successor.channelId, 'conductor-a');
  assert.equal(successor.generation, 2);
  assert.equal(successor.conductorId, 'conductor-a');
  assert.throws(() => state.recordNativeReply({ provider: 'codex', messageId: 'drained', nativeId: CODEX_ID, generation: 1, text: 'late' }), StaleGenerationError);
  state.markIntakeBoundary('conductor-a', 'ready');
  state.acceptDiscordMessage({ id: 'successor-input', guildId: 'guild-1', channelId: 'conductor-a', authorId: 'operator-1', isBot: false, content: 'new owner' });
  state.claimDispatch('successor-input');
  state.markSubmitted('successor-input');
  state.recordNativeReply({ provider: 'codex', messageId: 'successor-input', nativeId: SUCCESSOR_ID, generation: 2, text: 'successor answer' });
  assert.equal(state.getMessage('successor-input').state, MESSAGE_STATES.REPLY_READY);
  state.close();
});

test('simulated: conductor generations remain monotonic after unbind and new-channel bind', () => {
  const { dir, state } = fixture();
  state.bind({ channelId: 'old-conductor', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir, conductorId: 'stable', repoKey: 'repo:alpha' });
  state.unbind('old-conductor');
  const rebound = state.bind({ channelId: 'new-conductor', guildId: 'guild-1', provider: 'codex', nativeId: SUCCESSOR_ID, workspace: dir, conductorId: 'stable', repoKey: 'repo:alpha' });
  assert.equal(rebound.generation, 2);
  state.close();
});

test('simulated: stable conductor markers repeat, adopt the existing setup channel, and never retry an unresolved create', async () => {
  const channels = new Map();
  let creates = 0;
  const guild = {
    channels: {
      cache: { values: () => channels.values() },
      async fetch() {},
      async create(options) {
        creates += 1;
        const channel = { id: `created-conductor-${creates}`, parentId: options.parent, topic: options.topic, async setTopic(topic) { this.topic = topic; } };
        channels.set(channel.id, channel);
        return channel;
      }
    }
  };
  const first = await ensureProvisionedChannel({ guild, provider: 'codex', nativeId: CODEX_ID, categoryId: 'codex-category', conductorId: 'stable-conductor', repoKey: 'repo:alpha', taskName: 'presentation only' });
  const second = await ensureProvisionedChannel({ guild, provider: 'codex', nativeId: CODEX_ID, categoryId: 'codex-category', conductorId: 'stable-conductor', repoKey: 'repo:alpha', taskName: 'renamed presentation' });
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.channel.id, first.channel.id);
  assert.match(first.marker, /conductor=stable-conductor/);
  assert.equal(creates, 1);

  const existingId = '1545716797217570847';
  const existing = { id: existingId, parentId: 'codex-category', topic: `Conductor task: codex/${CODEX_ID}`, async setTopic(topic) { this.topic = topic; } };
  const adoptionGuild = { channels: {
    cache: { values: () => [existing][Symbol.iterator]() },
    async fetch(id) { return id ? existing : undefined; },
    async create() { throw new Error('adoption must not create'); }
  } };
  const adopted = await ensureProvisionedChannel({ guild: adoptionGuild, provider: 'codex', nativeId: CODEX_ID, categoryId: 'codex-category', conductorId: 'stable-conductor', repoKey: 'repo:alpha', channelId: existingId });
  assert.equal(adopted.adopted, true);
  assert.equal(adopted.channel.id, existingId);
  assert.match(adopted.channel.topic, /conductor=stable-conductor/);

  const unresolvedGuild = { channels: { cache: { values: () => [][Symbol.iterator]() }, async fetch() {}, async create() { throw new Error('must not retry unknown create'); } } };
  await assert.rejects(() => ensureProvisionedChannel({ guild: unresolvedGuild, provider: 'codex', nativeId: CODEX_ID, categoryId: 'codex-category', conductorId: 'other-conductor', repoKey: 'repo:alpha', allowCreate: false }), /unresolved/);
});

test('simulated: intake topic qualifier is strict and repeated adoption preserves it', async () => {
  const marker = conductorMarker({ provider: 'codex', nativeId: CODEX_ID, categoryId: 'unused', conductorId: 'qualified-conductor', repoKey: 'repo:alpha', generation: 1, readiness: READINESS.READY });
  const publishedAt = '2026-09-05T12:00:00.000Z';
  const qualified = topicWithReadiness(marker, READINESS.READY, publishedAt);
  const expected = { provider: 'codex', nativeId: CODEX_ID, conductorId: 'qualified-conductor', repoKey: 'repo:alpha', generation: 1 };
  assert.equal(conductorMarkerMatches(qualified, expected), true);
  assert.equal(conductorMarkerMatches(`${qualified} trailing text`, expected), false);
  let writes = 0;
  const existing = { id: 'qualified-channel', parentId: 'codex-category', topic: qualified, async setTopic() { writes += 1; } };
  const guild = { channels: {
    cache: { values: () => [existing][Symbol.iterator]() },
    async fetch() { return existing; },
    async create() { throw new Error('qualified marker must reuse channel'); }
  } };
  const result = await ensureProvisionedChannel({ guild, provider: 'codex', nativeId: CODEX_ID, categoryId: 'codex-category', conductorId: 'qualified-conductor', repoKey: 'repo:alpha', channelId: existing.id });
  assert.equal(result.created, false);
  assert.equal(result.adopted, false);
  assert.equal(existing.topic, qualified);
  assert.equal(writes, 0);
});

test('simulated: durable provision intent rejects a second unresolved create attempt', () => {
  const { dir, state } = fixture();
  const intent = {
    provider: 'codex',
    nativeId: CODEX_ID,
    conductorId: 'intent-conductor',
    repoKey: 'repo:alpha',
    guildId: 'guild-1',
    categoryId: 'codex-category',
    workspace: dir,
    marker: conductorMarker({ provider: 'codex', nativeId: CODEX_ID, conductorId: 'intent-conductor', repoKey: 'repo:alpha' })
  };
  assert.equal(state.beginProvisionIntent(intent).fresh, true);
  assert.equal(state.beginProvisionIntent(intent).fresh, false);
  state.close();
});

test('simulated: ordinary worker binding requires explicit conductor identity', () => {
  assert.throws(() => bindingArgs({ 'channel-id': 'worker', 'guild-id': 'guild-1', provider: 'codex', 'native-id': CODEX_ID, workspace: process.cwd() }), /conductor-id/);
});

test('simulated: installed lockf creates, excludes, releases, and retains the lock inode', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-surface-lock-'));
  const lockPath = path.join(dir, 'surface.lock');
  const firstMarker = path.join(dir, 'first');
  const heldMarker = path.join(dir, 'held');
  const contenderMarker = path.join(dir, 'contender');
  const secondMarker = path.join(dir, 'second');
  const crashMarker = path.join(dir, 'crash');
  const afterCrashMarker = path.join(dir, 'after-crash');
  const write = file => `require('node:fs').writeFileSync(${JSON.stringify(file)}, 'written')`;
  const first = lockfRun(lockPath, write(firstMarker));
  assert.equal(first.status, 0, first.stderr);
  assert.equal(fs.existsSync(firstMarker), true);
  assert.equal(fs.existsSync(lockPath), true);
  const inode = fs.statSync(lockPath).ino;

  const holder = spawn(LOCKF, ['-t', '2', '-k', lockPath, process.execPath, '-e', `${write(heldMarker)}; setTimeout(() => {}, 500)`], { stdio: 'ignore' });
  let crashed = null;
  try {
    await waitForFile(heldMarker);
    const contender = lockfRun(lockPath, write(contenderMarker));
    assert.notEqual(contender.status, 0);
    assert.equal(fs.existsSync(contenderMarker), false);
    const holderResult = await waitForChild(holder);
    assert.equal(holderResult.code, 0);
    const second = lockfRun(lockPath, write(secondMarker));
    assert.equal(second.status, 0, second.stderr);
    assert.equal(fs.existsSync(secondMarker), true);
    assert.equal(fs.statSync(lockPath).ino, inode);
    crashed = spawn(LOCKF, ['-t', '2', '-k', lockPath, process.execPath, '-e', `${write(crashMarker)}; process.kill(process.pid, 'SIGKILL')`], { stdio: 'ignore' });
    await waitForFile(crashMarker);
    const crashResult = await waitForChild(crashed);
    assert.notEqual(crashResult.code, 0);
    const afterCrash = lockfRun(lockPath, write(afterCrashMarker));
    assert.equal(afterCrash.status, 0, afterCrash.stderr);
    assert.equal(fs.existsSync(afterCrashMarker), true);
    assert.equal(fs.statSync(lockPath).ino, inode);
  } finally {
    if (holder.exitCode === null) holder.kill('SIGTERM');
    if (holder.exitCode === null) await waitForChild(holder).catch(() => {});
    if (crashed?.exitCode === null) crashed.kill('SIGTERM');
    if (crashed?.exitCode === null) await waitForChild(crashed).catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('simulated: public provision lock reaches native validation on a fresh state directory', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-surface-cli-lock-'));
  try {
    const result = spawnSync(process.execPath, [CLI_PATH, 'provision', '--state-dir', dir, '--provider', 'codex', '--native-id', 'invalid-native-id', '--conductor-id', 'cli-lock-conductor', '--repo-key', 'repo:alpha', '--workspace', dir, '--category-id', 'codex-category'], { encoding: 'utf8' });
    const output = `${result.stdout}\n${result.stderr}`;
    assert.notEqual(result.status, 0);
    assert.match(output, /nativeId must be an exact UUID/);
    assert.doesNotMatch(output, /No such file or directory/);
    assert.equal(fs.existsSync(path.join(dir, 'provision.lock')), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
