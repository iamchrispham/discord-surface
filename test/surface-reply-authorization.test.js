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
  state.bind({ channelId: 'channel-codex', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir }, { intakeCutoff: '100' });
  state.acceptDiscordMessage({ id: '101', guildId: 'guild-1', channelId: 'channel-codex', authorId: 'operator-1', isBot: false, content: 'long' });
  state.claimDispatch('101');
  state.markSubmitted('101');
  state.recordNativeReply({ provider: 'codex', messageId: '101', nativeId: CODEX_ID, generation: 1, text: 'x'.repeat(4500) });
  const payloads = [];
  const client = {
    on() {},
    off() {},
    channels: { fetch: async () => ({ messages: { fetch: async () => ({ react: async () => {} }) } }) },
    async destroy() {}
  };
  const gateway = new DiscordGateway({ state, client });
  const source = discordMessage({ id: '101', channelId: 'channel-codex', sends: payloads });
  const result = await gateway.consumer.deliverReply(source, { status: 'reply_ready', message: state.getMessage('101') });
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
  state.bind({ channelId: 'channel-codex', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir }, { intakeCutoff: '100' });
  state.acceptDiscordMessage({ id: '102', guildId: 'guild-1', channelId: 'channel-codex', authorId: 'operator-1', isBot: false, content: 'boundary' });
  state.claimDispatch('102');
  state.markSubmitted('102');
  const text = `${'x'.repeat(1999)}🙂y`;
  state.recordNativeReply({ provider: 'codex', messageId: '102', nativeId: CODEX_ID, generation: 1, text });
  const parts = state.listReplyParts('102');
  assert.equal(parts.length, 2);
  assert.equal(parts.map(part => part.content).join(''), text);
  assert.ok(parts.every(part => part.content.length <= 2000));
  state.close();
});

test('simulated: operator revocation after intake prevents dispatch and native reply acceptance', async () => {
  const { dir, state } = fixture();
  state.bind({ channelId: 'channel-codex', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir }, { intakeCutoff: '100' });
  state.acceptDiscordMessage({ id: '103', guildId: 'guild-1', channelId: 'channel-codex', authorId: 'operator-1', isBot: false, content: 'x' });
  state.setConfig({ operatorId: 'operator-revoked', guildId: 'guild-1', secretFile: path.join(dir, 'discord.secret') });
  const claim = state.claimDispatch('103');
  assert.equal(claim.claimed, false);
  assert.equal(claim.reason, 'authorization-revoked');
  assert.equal(state.getMessage('103').state, MESSAGE_STATES.ACCEPTED);
  state.setConfig({ operatorId: 'operator-1', guildId: 'guild-1', secretFile: path.join(dir, 'discord.secret') });
  state.acceptDiscordMessage({ id: '104', guildId: 'guild-1', channelId: 'channel-codex', authorId: 'operator-1', isBot: false, content: 'x' });
  state.claimDispatch('104');
  state.markSubmitted('104');
  state.setConfig({ operatorId: 'operator-revoked', guildId: 'guild-1', secretFile: path.join(dir, 'discord.secret') });
  assert.throws(() => state.recordNativeReply({ provider: 'codex', messageId: '104', nativeId: CODEX_ID, generation: 1, text: 'late' }), /authorization/);
  assert.ok(state.listReceipts().some(receipt => receipt.kind === 'dispatch-rejected-auth'));
  state.close();
});

test('simulated: guild revocation after intake blocks dispatch and reply acceptance', () => {
  const { dir, state } = fixture();
  state.bind({ channelId: 'channel-codex', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir }, { intakeCutoff: '100' });
  state.acceptDiscordMessage({ id: '106', guildId: 'guild-1', channelId: 'channel-codex', authorId: 'operator-1', isBot: false, content: 'x' });
  state.setConfig({ operatorId: 'operator-1', guildId: 'guild-revoked', secretFile: path.join(dir, 'discord.secret') });
  assert.equal(state.claimDispatch('106').reason, 'authorization-revoked');
  state.setConfig({ operatorId: 'operator-1', guildId: 'guild-1', secretFile: path.join(dir, 'discord.secret') });
  state.claimDispatch('106');
  state.markSubmitted('106');
  state.setConfig({ operatorId: 'operator-1', guildId: 'guild-revoked', secretFile: path.join(dir, 'discord.secret') });
  assert.throws(() => state.recordNativeReply({ provider: 'codex', messageId: '106', nativeId: CODEX_ID, generation: 1, text: 'late' }), /authorization/);
  state.close();
});

test('simulated: credential rotation preserves provider UUID binding generation and custody', () => {
  const { dir, state } = fixture();
  const binding = state.bind({ channelId: 'channel-codex', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir }, { intakeCutoff: '100' });
  state.acceptDiscordMessage({ id: '107', guildId: 'guild-1', channelId: 'channel-codex', authorId: 'operator-1', isBot: false, content: 'x' });
  state.setConfig({ operatorId: 'operator-1', guildId: 'guild-1', secretFile: path.join(dir, 'rotated-discord.env') });
  assert.deepEqual(state.getBinding('channel-codex'), binding);
  assert.equal(state.getMessage('107').state, MESSAGE_STATES.ACCEPTED);
  assert.equal(state.listReceipts().some(receipt => receipt.kind === 'rebound' || receipt.kind === 'unbound'), false);
  state.close();
});

test('simulated: unbind tombstones history and rebind increments the generation', () => {
  const { dir, state } = fixture();
  state.bind({ channelId: 'channel-codex', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir }, { intakeCutoff: '100' });
  state.acceptDiscordMessage({ id: '108', guildId: 'guild-1', channelId: 'channel-codex', authorId: 'operator-1', isBot: false, content: 'x' });
  state.claimDispatch('108');
  state.markSubmitted('108');
  state.recordNativeReply({ provider: 'codex', messageId: '108', nativeId: CODEX_ID, generation: 1, text: 'done' });
  state.beginReply('108');
  state.markReplySent('108', '105');
  state.unbind('channel-codex');
  assert.equal(state.getMessage('108').state, MESSAGE_STATES.REPLIED);
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
    messageId: '109', nativeId: CODEX_ID, generation: 1, text: 'reply'
  }), error => error === stop);
  assert.equal(providerReads, 1);
  let partReads = 0;
  assert.throws(() => SurfaceState.prototype.reconcileReplyDelivery.call(receiver, '109', 'sent', {
    get partIndex() { partReads++; return 0; }, replyMessageId: '110'
  }), error => error === stop);
  assert.equal(partReads, 1);
});
