const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MESSAGE_STATES, SurfaceState } = require('../src/state');
const { DiscordGateway, readSecret } = require('../src/discord');
const { CODEX_ID, CLAUDE_ID, fixture, discordMessage } = require('./surface-fixtures');

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
  const client = {
    on() {},
    off() {},
    channels: { fetch: async () => ({ messages: { fetch: async () => ({ react: async () => {} }) } }) },
    async destroy() {}
  };
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


test('reply facade reads caller properties only once', () => {
  const stop = new Error('transaction boundary');
  const receiver = { transaction() { throw stop; } };
  let providerReads = 0;
  assert.throws(() => SurfaceState.prototype.recordNativeReply.call(receiver, {
    get provider() { providerReads++; return 'codex'; },
    messageId: 'getter-reply', nativeId: CODEX_ID, generation: 1, text: 'reply'
  }), error => error === stop);
  assert.equal(providerReads, 1);
  let partReads = 0;
  assert.throws(() => SurfaceState.prototype.reconcileReplyDelivery.call(receiver, 'getter-reply', 'sent', {
    get partIndex() { partReads++; return 0; }, replyMessageId: 'sent-reply'
  }), error => error === stop);
  assert.equal(partReads, 1);
});
