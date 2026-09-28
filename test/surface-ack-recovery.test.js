const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { SurfaceState, StaleGenerationError, MESSAGE_STATES } = require('../src/state');
const { DiscordGateway } = require('../src/discord');
const { ACK, recordNativeAcknowledgment } = require('../src/acknowledgment');
const { CODEX_ID, CLAUDE_ID, fixture, historyPermissions, waitForCondition, providers } = require('./surface-fixtures');

test('simulated: explicit native ACK survives restart without entering reply custody', async () => {
  const { dir, db, state } = fixture('ack-reply-boundary.sqlite');
  state.bind({ channelId: 'channel-codex', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir }, { intakeCutoff: '100' });
  state.acceptDiscordMessage({ id: '101', guildId: 'guild-1', channelId: 'channel-codex', authorId: 'operator-1', isBot: false, content: 'answer' });
  state.claimDispatch('101');
  state.markSubmitted('101');
  recordNativeAcknowledgment(state, { provider: 'codex', messageId: '101', nativeId: CODEX_ID, generation: 1 });
  state.recordNativeReply({ provider: 'codex', messageId: '101', nativeId: CODEX_ID, generation: 1, text: 'native answer' });
  let started = false;
  let release;
  const reactionPending = new Promise(resolve => { release = resolve; });
  let sends = 0;
  const channel = {
    messages: { fetch: async () => ({ react: async () => { started = true; await reactionPending; } }) },
    async send() { sends += 1; return { id: 'reply-after-ack' }; }
  };
  const gateway = new DiscordGateway({ state, client: { on() {}, off() {}, channels: { fetch: async () => channel }, async destroy() {} } });
  const delivery = gateway.consumer.deliverReply({ id: '101', guildId: 'guild-1', channelId: 'channel-codex', channel }, {
    status: 'reply_ready', message: state.getMessage('101')
  });
  await waitForCondition(() => started);
  assert.equal(state.getMessage('101').state, MESSAGE_STATES.REPLY_READY);
  assert.equal(state.listReceipts().some(row => row.discord_id === '101' && row.kind === 'reply-attempt'), false);
  const recovered = new SurfaceState(db);
  recovered.recoverAfterRestart();
  assert.equal(recovered.getMessage('101').state, MESSAGE_STATES.REPLY_READY);
  assert.equal(recovered.listReceipts().some(row => row.discord_id === '101' && row.kind === 'reply-unknown-after-restart'), false);
  recovered.close();
  release();
  const result = await delivery;
  assert.equal(result.message.state, MESSAGE_STATES.REPLIED);
  assert.equal(sends, 1);
  await gateway.stop();
  state.close();
});

test('simulated: authenticated Codex reply supplies omitted native acknowledgment', async () => {
  const { dir, state } = fixture('ack-reply-missing.sqlite');
  state.bind({ channelId: 'channel-codex', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir }, { intakeCutoff: '100' });
  state.acceptDiscordMessage({ id: '102', guildId: 'guild-1', channelId: 'channel-codex', authorId: 'operator-1', isBot: false, content: 'answer' });
  state.claimDispatch('102');
  state.markSubmitted('102');
  state.recordNativeReply({ provider: 'codex', messageId: '102', nativeId: CODEX_ID, generation: 1, text: 'native answer' });
  const acknowledgments = state.listReceipts().filter(row => row.discord_id === '102' && row.kind === ACK.RECEIVED);
  assert.equal(acknowledgments.length, 1);
  assert.equal(JSON.parse(acknowledgments[0].detail).source, 'native-reply');
  const events = [];
  const channel = {
    messages: { fetch: async () => ({ react: async reaction => { events.push(reaction); } }) },
    async send() { events.push('reply'); return { id: 'reply-after-ack' }; }
  };
  const gateway = new DiscordGateway({
    state,
    client: { on() {}, off() {}, channels: { fetch: async () => channel }, async destroy() {} }
  });
  const source = { id: '102', guildId: 'guild-1', channelId: 'channel-codex', channel };
  const delivery = gateway.consumer.deliverReply(source, {
    status: 'reply_ready', message: state.getMessage('102')
  });
  const result = await delivery;
  assert.equal(result.message.state, MESSAGE_STATES.REPLIED);
  assert.deepEqual(events, ['👀', 'reply']);
  await gateway.stop();
  state.close();
});

test('simulated: authenticated Claude reply supplies omitted native acknowledgment', async () => {
  const { dir, state } = fixture('claude-reply-missing.sqlite');
  state.bind({ channelId: 'channel-claude', guildId: 'guild-1', provider: 'claude', nativeId: CLAUDE_ID, workspace: dir, endpoint: path.join(dir, 'claude.sock') }, { intakeCutoff: '100' });
  state.acceptDiscordMessage({ id: '103', guildId: 'guild-1', channelId: 'channel-claude', authorId: 'operator-1', isBot: false, content: 'answer' });
  state.claimDispatch('103');
  state.markSubmitted('103');
  state.recordNativeReply({ provider: 'claude', messageId: '103', nativeId: CLAUDE_ID, generation: 1, text: 'native answer' });
  const acknowledgments = state.listReceipts().filter(row => row.discord_id === '103' && row.kind === ACK.RECEIVED);
  assert.equal(acknowledgments.length, 1);
  assert.equal(JSON.parse(acknowledgments[0].detail).source, 'native-reply');
  const events = [];
  const channel = {
    messages: { fetch: async () => ({ react: async reaction => { events.push(reaction); } }) },
    async send() { events.push('reply'); return { id: 'claude-reply' }; }
  };
  const gateway = new DiscordGateway({
    state,
    client: { on() {}, off() {}, channels: { fetch: async () => channel }, async destroy() {} }
  });
  const result = await gateway.consumer.deliverReply({ id: '103', guildId: 'guild-1', channelId: 'channel-claude', channel }, {
    status: 'reply_ready', message: state.getMessage('103')
  });
  assert.equal(result.message.state, MESSAGE_STATES.REPLIED);
  assert.deepEqual(events, ['👀', 'reply']);
  await gateway.stop();
  state.close();
});

test('simulated: native reply ACK is idempotent and rejects stale ownership', () => {
  const { dir, state } = fixture('native-reply-ack-fence.sqlite');
  state.bind({ channelId: 'channel-codex', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir }, { intakeCutoff: '100' });
  state.acceptDiscordMessage({ id: '104', guildId: 'guild-1', channelId: 'channel-codex', authorId: 'operator-1', isBot: false, content: 'answer' });
  state.claimDispatch('104');
  state.markSubmitted('104');
  const first = state.recordNativeReply({ provider: 'codex', messageId: '104', nativeId: CODEX_ID, generation: 1, text: 'native answer' });
  assert.equal(first.duplicate, false);
  const duplicate = state.recordNativeReply({ provider: 'codex', messageId: '104', nativeId: CODEX_ID, generation: 1, text: 'native answer' });
  assert.equal(duplicate.duplicate, true);
  const acknowledgments = () => state.listReceipts().filter(row => row.discord_id === '104' && row.kind === ACK.RECEIVED);
  assert.equal(acknowledgments().length, 1);
  assert.throws(() => state.recordNativeReply({ provider: 'codex', messageId: '104', nativeId: CODEX_ID, generation: 2, text: 'stale generation' }), StaleGenerationError);
  assert.equal(acknowledgments().length, 1);
  state.close();
});

test('simulated: omitted native ACK survives restart with one reply and no redispatch', async () => {
  const first = fixture('native-reply-ack-restart.sqlite');
  first.state.bind({ channelId: 'channel-codex', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: first.dir }, { intakeCutoff: '100' });
  first.state.acceptDiscordMessage({ id: '105', guildId: 'guild-1', channelId: 'channel-codex', authorId: 'operator-1', isBot: false, content: 'answer' });
  first.state.claimDispatch('105');
  first.state.markSubmitted('105');
  first.state.recordNativeReply({ provider: 'codex', messageId: '105', nativeId: CODEX_ID, generation: 1, text: 'native answer' });
  assert.equal(first.state.listReceipts().filter(row => row.discord_id === '105' && row.kind === ACK.RECEIVED).length, 1);
  first.state.close();

  const state = new SurfaceState(first.db);
  state.recoverAfterRestart();
  let dispatches = 0;
  let observations = 0;
  const events = [];
  const channel = {
    permissionsFor: () => historyPermissions(),
    messages: { fetch: async () => ({ react: async reaction => { events.push(reaction); } }) },
    async send() { events.push('reply'); return { id: 'restart-reply' }; }
  };
  const gateway = new DiscordGateway({
    state,
    providers: {
      codex: {
        async dispatch() { dispatches += 1; return { status: 'submitted' }; },
        async observe() { observations += 1; return { text: 'unexpected redispatch' }; }
      }
    },
    client: { user: { id: 'bot-1' }, on() {}, off() {}, channels: { fetch: async () => channel }, async destroy() {} }
  });
  gateway.ready = true;
  await gateway.reconcilePending();
  assert.equal(state.getMessage('105').state, MESSAGE_STATES.REPLIED);
  assert.deepEqual(events, ['👀', 'reply']);
  assert.equal(dispatches, 0);
  assert.equal(observations, 0);
  assert.equal(state.listReceipts().filter(row => row.discord_id === '105' && row.kind === ACK.RECEIVED).length, 1);
  await gateway.stop();
  state.close();
});

test('simulated: legacy REPLY_READY with native reply provenance recovers omitted ACK', async () => {
  const first = fixture('native-reply-ack-legacy.sqlite');
  first.state.bind({ channelId: 'channel-codex', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: first.dir }, { intakeCutoff: '100' });
  first.state.acceptDiscordMessage({ id: '106', guildId: 'guild-1', channelId: 'channel-codex', authorId: 'operator-1', isBot: false, content: 'answer' });
  first.state.claimDispatch('106');
  first.state.markSubmitted('106');
  first.state.recordNativeReply({ provider: 'codex', messageId: '106', nativeId: CODEX_ID, generation: 1, text: 'native answer' });
  first.state.db.prepare('DELETE FROM receipts WHERE discord_id=? AND kind=?').run('106', ACK.RECEIVED);
  first.state.close();

  const state = new SurfaceState(first.db);
  state.recoverAfterRestart();
  const events = [];
  const channel = {
    permissionsFor: () => historyPermissions(),
    messages: { fetch: async () => ({ react: async reaction => { events.push(reaction); } }) },
    async send() { events.push('reply'); return { id: 'legacy-reply' }; }
  };
  const gateway = new DiscordGateway({
    state,
    client: { user: { id: 'bot-1' }, on() {}, off() {}, channels: { fetch: async () => channel }, async destroy() {} }
  });
  gateway.ready = true;
  await gateway.reconcilePending();
  assert.equal(state.getMessage('106').state, MESSAGE_STATES.REPLIED);
  assert.deepEqual(events, ['👀', 'reply']);
  const acknowledgments = state.listReceipts().filter(row => row.discord_id === '106' && row.kind === ACK.RECEIVED);
  assert.equal(acknowledgments.length, 1);
  assert.equal(JSON.parse(acknowledgments[0].detail).source, 'native-reply');
  await gateway.stop();
  state.close();
});

test('simulated: legacy REPLY_READY with pre-submit reply provenance recovers omitted ACK', async () => {
  const first = fixture('native-reply-ack-before-submit.sqlite');
  first.state.bind({ channelId: 'channel-codex', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: first.dir }, { intakeCutoff: '100' });
  first.state.acceptDiscordMessage({ id: '107', guildId: 'guild-1', channelId: 'channel-codex', authorId: 'operator-1', isBot: false, content: 'answer' });
  first.state.claimDispatch('107');
  first.state.recordNativeReply({ provider: 'codex', messageId: '107', nativeId: CODEX_ID, generation: 1, text: 'native answer' });
  assert.equal(first.state.listReceipts().filter(row => row.discord_id === '107' && row.kind === 'native-reply-before-submit').length, 1);
  first.state.db.prepare('DELETE FROM receipts WHERE discord_id=? AND kind=?').run('107', ACK.RECEIVED);
  first.state.close();

  const state = new SurfaceState(first.db);
  state.recoverAfterRestart();
  const events = [];
  const channel = {
    permissionsFor: () => historyPermissions(),
    messages: { fetch: async () => ({ react: async reaction => { events.push(reaction); } }) },
    async send() { events.push('reply'); return { id: 'before-submit-reply' }; }
  };
  const gateway = new DiscordGateway({
    state,
    client: { user: { id: 'bot-1' }, on() {}, off() {}, channels: { fetch: async () => channel }, async destroy() {} }
  });
  gateway.ready = true;
  await gateway.reconcilePending();
  assert.equal(state.getMessage('107').state, MESSAGE_STATES.REPLIED);
  assert.deepEqual(events, ['👀', 'reply']);
  assert.equal(state.listReceipts().filter(row => row.discord_id === '107' && row.kind === ACK.RECEIVED).length, 1);
  await gateway.stop();
  state.close();
});

test('simulated: legacy REPLY_READY without native reply provenance stays held', async () => {
  const first = fixture('native-reply-ack-no-provenance.sqlite');
  first.state.bind({ channelId: 'channel-codex', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: first.dir }, { intakeCutoff: '100' });
  first.state.acceptDiscordMessage({ id: '108', guildId: 'guild-1', channelId: 'channel-codex', authorId: 'operator-1', isBot: false, content: 'answer' });
  first.state.claimDispatch('108');
  first.state.markSubmitted('108');
  first.state.recordNativeReply({ provider: 'codex', messageId: '108', nativeId: CODEX_ID, generation: 1, text: 'native answer' });
  first.state.db.prepare('DELETE FROM receipts WHERE discord_id=? AND kind IN (?, ?)').run('108', ACK.RECEIVED, 'native-reply');
  first.state.close();

  const state = new SurfaceState(first.db);
  state.recoverAfterRestart();
  const events = [];
  const channel = {
    messages: { fetch: async () => ({ react: async reaction => { events.push(reaction); } }) },
    async send() { events.push('reply'); return { id: 'unexpected-reply' }; }
  };
  const gateway = new DiscordGateway({
    state,
    client: { user: { id: 'bot-1' }, on() {}, off() {}, channels: { fetch: async () => channel }, async destroy() {} }
  });
  gateway.ready = true;
  await gateway.reconcilePending();
  assert.equal(state.getMessage('108').state, MESSAGE_STATES.REPLY_READY);
  assert.equal(state.listReceipts().filter(row => row.discord_id === '108' && row.kind === ACK.RECEIVED).length, 0);
  assert.deepEqual(events, []);
  await gateway.stop();
  state.close();
});

test('simulated: legacy REPLY_READY with mismatched native reply provenance stays held', async () => {
  const first = fixture('native-reply-ack-mismatched-provenance.sqlite');
  first.state.bind({ channelId: 'channel-codex', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: first.dir }, { intakeCutoff: '100' });
  first.state.acceptDiscordMessage({ id: '109', guildId: 'guild-1', channelId: 'channel-codex', authorId: 'operator-1', isBot: false, content: 'answer' });
  first.state.claimDispatch('109');
  first.state.markSubmitted('109');
  first.state.recordNativeReply({ provider: 'codex', messageId: '109', nativeId: CODEX_ID, generation: 1, text: 'native answer' });
  first.state.db.prepare('DELETE FROM receipts WHERE discord_id=? AND kind IN (?, ?)').run('109', ACK.RECEIVED, 'native-reply');
  first.state.receipt('109', 'native-reply', { generation: 2, parts: 1 });
  first.state.close();

  const state = new SurfaceState(first.db);
  state.recoverAfterRestart();
  const events = [];
  const channel = {
    messages: { fetch: async () => ({ react: async reaction => { events.push(reaction); } }) },
    async send() { events.push('reply'); return { id: 'unexpected-reply' }; }
  };
  const gateway = new DiscordGateway({
    state,
    client: { user: { id: 'bot-1' }, on() {}, off() {}, channels: { fetch: async () => channel }, async destroy() {} }
  });
  gateway.ready = true;
  await gateway.reconcilePending();
  assert.equal(state.getMessage('109').state, MESSAGE_STATES.REPLY_READY);
  assert.equal(state.listReceipts().filter(row => row.discord_id === '109' && row.kind === ACK.RECEIVED).length, 0);
  assert.deepEqual(events, []);
  await gateway.stop();
  state.close();
});
