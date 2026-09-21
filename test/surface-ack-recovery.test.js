const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { SurfaceState, StaleGenerationError, MESSAGE_STATES } = require('../src/state');
const { DiscordGateway } = require('../src/discord');
const { ACK, recordNativeAcknowledgment } = require('../src/acknowledgment');
const { CODEX_ID, CLAUDE_ID, fixture, waitForCondition, providers } = require('./surface-fixtures');

test('simulated: explicit native ACK survives restart without entering reply custody', async () => {
  const { dir, db, state } = fixture('ack-reply-boundary.sqlite');
  state.bind({ channelId: 'channel-codex', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir });
  state.acceptDiscordMessage({ id: 'ack-reply-boundary', guildId: 'guild-1', channelId: 'channel-codex', authorId: 'operator-1', isBot: false, content: 'answer' });
  state.claimDispatch('ack-reply-boundary');
  state.markSubmitted('ack-reply-boundary');
  recordNativeAcknowledgment(state, { provider: 'codex', messageId: 'ack-reply-boundary', nativeId: CODEX_ID, generation: 1 });
  state.recordNativeReply({ provider: 'codex', messageId: 'ack-reply-boundary', nativeId: CODEX_ID, generation: 1, text: 'native answer' });
  let started = false;
  let release;
  const reactionPending = new Promise(resolve => { release = resolve; });
  let sends = 0;
  const channel = {
    messages: { fetch: async () => ({ react: async () => { started = true; await reactionPending; } }) },
    async send() { sends += 1; return { id: 'reply-after-ack' }; }
  };
  const gateway = new DiscordGateway({ state, client: { on() {}, off() {}, channels: { fetch: async () => channel }, async destroy() {} } });
  const delivery = gateway.consumer.deliverReply({ id: 'ack-reply-boundary', guildId: 'guild-1', channelId: 'channel-codex', channel }, {
    status: 'reply_ready', message: state.getMessage('ack-reply-boundary')
  });
  await waitForCondition(() => started);
  assert.equal(state.getMessage('ack-reply-boundary').state, MESSAGE_STATES.REPLY_READY);
  assert.equal(state.listReceipts().some(row => row.discord_id === 'ack-reply-boundary' && row.kind === 'reply-attempt'), false);
  const recovered = new SurfaceState(db);
  recovered.recoverAfterRestart();
  assert.equal(recovered.getMessage('ack-reply-boundary').state, MESSAGE_STATES.REPLY_READY);
  assert.equal(recovered.listReceipts().some(row => row.discord_id === 'ack-reply-boundary' && row.kind === 'reply-unknown-after-restart'), false);
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
  state.bind({ channelId: 'channel-codex', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir });
  state.acceptDiscordMessage({ id: 'ack-reply-missing', guildId: 'guild-1', channelId: 'channel-codex', authorId: 'operator-1', isBot: false, content: 'answer' });
  state.claimDispatch('ack-reply-missing');
  state.markSubmitted('ack-reply-missing');
  state.recordNativeReply({ provider: 'codex', messageId: 'ack-reply-missing', nativeId: CODEX_ID, generation: 1, text: 'native answer' });
  const acknowledgments = state.listReceipts().filter(row => row.discord_id === 'ack-reply-missing' && row.kind === ACK.RECEIVED);
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
  const source = { id: 'ack-reply-missing', guildId: 'guild-1', channelId: 'channel-codex', channel };
  const delivery = gateway.consumer.deliverReply(source, {
    status: 'reply_ready', message: state.getMessage('ack-reply-missing')
  });
  const result = await delivery;
  assert.equal(result.message.state, MESSAGE_STATES.REPLIED);
  assert.deepEqual(events, ['👀', 'reply']);
  await gateway.stop();
  state.close();
});

test('simulated: authenticated Claude reply supplies omitted native acknowledgment', async () => {
  const { dir, state } = fixture('claude-reply-missing.sqlite');
  state.bind({ channelId: 'channel-claude', guildId: 'guild-1', provider: 'claude', nativeId: CLAUDE_ID, workspace: dir, endpoint: path.join(dir, 'claude.sock') });
  state.acceptDiscordMessage({ id: 'claude-reply-missing', guildId: 'guild-1', channelId: 'channel-claude', authorId: 'operator-1', isBot: false, content: 'answer' });
  state.claimDispatch('claude-reply-missing');
  state.markSubmitted('claude-reply-missing');
  state.recordNativeReply({ provider: 'claude', messageId: 'claude-reply-missing', nativeId: CLAUDE_ID, generation: 1, text: 'native answer' });
  const acknowledgments = state.listReceipts().filter(row => row.discord_id === 'claude-reply-missing' && row.kind === ACK.RECEIVED);
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
  const result = await gateway.consumer.deliverReply({ id: 'claude-reply-missing', guildId: 'guild-1', channelId: 'channel-claude', channel }, {
    status: 'reply_ready', message: state.getMessage('claude-reply-missing')
  });
  assert.equal(result.message.state, MESSAGE_STATES.REPLIED);
  assert.deepEqual(events, ['👀', 'reply']);
  await gateway.stop();
  state.close();
});

test('simulated: native reply ACK is idempotent and rejects stale ownership', () => {
  const { dir, state } = fixture('native-reply-ack-fence.sqlite');
  state.bind({ channelId: 'channel-codex', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir });
  state.acceptDiscordMessage({ id: 'native-reply-ack-fence', guildId: 'guild-1', channelId: 'channel-codex', authorId: 'operator-1', isBot: false, content: 'answer' });
  state.claimDispatch('native-reply-ack-fence');
  state.markSubmitted('native-reply-ack-fence');
  const first = state.recordNativeReply({ provider: 'codex', messageId: 'native-reply-ack-fence', nativeId: CODEX_ID, generation: 1, text: 'native answer' });
  assert.equal(first.duplicate, false);
  const duplicate = state.recordNativeReply({ provider: 'codex', messageId: 'native-reply-ack-fence', nativeId: CODEX_ID, generation: 1, text: 'native answer' });
  assert.equal(duplicate.duplicate, true);
  const acknowledgments = () => state.listReceipts().filter(row => row.discord_id === 'native-reply-ack-fence' && row.kind === ACK.RECEIVED);
  assert.equal(acknowledgments().length, 1);
  assert.throws(() => state.recordNativeReply({ provider: 'codex', messageId: 'native-reply-ack-fence', nativeId: CODEX_ID, generation: 2, text: 'stale generation' }), StaleGenerationError);
  assert.equal(acknowledgments().length, 1);
  state.close();
});

test('simulated: omitted native ACK survives restart with one reply and no redispatch', async () => {
  const first = fixture('native-reply-ack-restart.sqlite');
  first.state.bind({ channelId: 'channel-codex', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: first.dir });
  first.state.acceptDiscordMessage({ id: 'native-reply-ack-restart', guildId: 'guild-1', channelId: 'channel-codex', authorId: 'operator-1', isBot: false, content: 'answer' });
  first.state.claimDispatch('native-reply-ack-restart');
  first.state.markSubmitted('native-reply-ack-restart');
  first.state.recordNativeReply({ provider: 'codex', messageId: 'native-reply-ack-restart', nativeId: CODEX_ID, generation: 1, text: 'native answer' });
  assert.equal(first.state.listReceipts().filter(row => row.discord_id === 'native-reply-ack-restart' && row.kind === ACK.RECEIVED).length, 1);
  first.state.close();

  const state = new SurfaceState(first.db);
  state.recoverAfterRestart();
  let dispatches = 0;
  let observations = 0;
  const events = [];
  const channel = {
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
    client: { on() {}, off() {}, channels: { fetch: async () => channel }, async destroy() {} }
  });
  gateway.ready = true;
  await gateway.reconcilePending();
  assert.equal(state.getMessage('native-reply-ack-restart').state, MESSAGE_STATES.REPLIED);
  assert.deepEqual(events, ['👀', 'reply']);
  assert.equal(dispatches, 0);
  assert.equal(observations, 0);
  assert.equal(state.listReceipts().filter(row => row.discord_id === 'native-reply-ack-restart' && row.kind === ACK.RECEIVED).length, 1);
  await gateway.stop();
  state.close();
});

test('simulated: legacy REPLY_READY with native reply provenance recovers omitted ACK', async () => {
  const first = fixture('native-reply-ack-legacy.sqlite');
  first.state.bind({ channelId: 'channel-codex', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: first.dir });
  first.state.acceptDiscordMessage({ id: 'native-reply-ack-legacy', guildId: 'guild-1', channelId: 'channel-codex', authorId: 'operator-1', isBot: false, content: 'answer' });
  first.state.claimDispatch('native-reply-ack-legacy');
  first.state.markSubmitted('native-reply-ack-legacy');
  first.state.recordNativeReply({ provider: 'codex', messageId: 'native-reply-ack-legacy', nativeId: CODEX_ID, generation: 1, text: 'native answer' });
  first.state.db.prepare('DELETE FROM receipts WHERE discord_id=? AND kind=?').run('native-reply-ack-legacy', ACK.RECEIVED);
  first.state.close();

  const state = new SurfaceState(first.db);
  state.recoverAfterRestart();
  const events = [];
  const channel = {
    messages: { fetch: async () => ({ react: async reaction => { events.push(reaction); } }) },
    async send() { events.push('reply'); return { id: 'legacy-reply' }; }
  };
  const gateway = new DiscordGateway({
    state,
    client: { on() {}, off() {}, channels: { fetch: async () => channel }, async destroy() {} }
  });
  gateway.ready = true;
  await gateway.reconcilePending();
  assert.equal(state.getMessage('native-reply-ack-legacy').state, MESSAGE_STATES.REPLIED);
  assert.deepEqual(events, ['👀', 'reply']);
  const acknowledgments = state.listReceipts().filter(row => row.discord_id === 'native-reply-ack-legacy' && row.kind === ACK.RECEIVED);
  assert.equal(acknowledgments.length, 1);
  assert.equal(JSON.parse(acknowledgments[0].detail).source, 'native-reply');
  await gateway.stop();
  state.close();
});

test('simulated: legacy REPLY_READY with pre-submit reply provenance recovers omitted ACK', async () => {
  const first = fixture('native-reply-ack-before-submit.sqlite');
  first.state.bind({ channelId: 'channel-codex', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: first.dir });
  first.state.acceptDiscordMessage({ id: 'native-reply-ack-before-submit', guildId: 'guild-1', channelId: 'channel-codex', authorId: 'operator-1', isBot: false, content: 'answer' });
  first.state.claimDispatch('native-reply-ack-before-submit');
  first.state.recordNativeReply({ provider: 'codex', messageId: 'native-reply-ack-before-submit', nativeId: CODEX_ID, generation: 1, text: 'native answer' });
  assert.equal(first.state.listReceipts().filter(row => row.discord_id === 'native-reply-ack-before-submit' && row.kind === 'native-reply-before-submit').length, 1);
  first.state.db.prepare('DELETE FROM receipts WHERE discord_id=? AND kind=?').run('native-reply-ack-before-submit', ACK.RECEIVED);
  first.state.close();

  const state = new SurfaceState(first.db);
  state.recoverAfterRestart();
  const events = [];
  const channel = {
    messages: { fetch: async () => ({ react: async reaction => { events.push(reaction); } }) },
    async send() { events.push('reply'); return { id: 'before-submit-reply' }; }
  };
  const gateway = new DiscordGateway({
    state,
    client: { on() {}, off() {}, channels: { fetch: async () => channel }, async destroy() {} }
  });
  gateway.ready = true;
  await gateway.reconcilePending();
  assert.equal(state.getMessage('native-reply-ack-before-submit').state, MESSAGE_STATES.REPLIED);
  assert.deepEqual(events, ['👀', 'reply']);
  assert.equal(state.listReceipts().filter(row => row.discord_id === 'native-reply-ack-before-submit' && row.kind === ACK.RECEIVED).length, 1);
  await gateway.stop();
  state.close();
});

test('simulated: legacy REPLY_READY without native reply provenance stays held', async () => {
  const first = fixture('native-reply-ack-no-provenance.sqlite');
  first.state.bind({ channelId: 'channel-codex', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: first.dir });
  first.state.acceptDiscordMessage({ id: 'native-reply-ack-no-provenance', guildId: 'guild-1', channelId: 'channel-codex', authorId: 'operator-1', isBot: false, content: 'answer' });
  first.state.claimDispatch('native-reply-ack-no-provenance');
  first.state.markSubmitted('native-reply-ack-no-provenance');
  first.state.recordNativeReply({ provider: 'codex', messageId: 'native-reply-ack-no-provenance', nativeId: CODEX_ID, generation: 1, text: 'native answer' });
  first.state.db.prepare('DELETE FROM receipts WHERE discord_id=? AND kind IN (?, ?)').run('native-reply-ack-no-provenance', ACK.RECEIVED, 'native-reply');
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
    client: { on() {}, off() {}, channels: { fetch: async () => channel }, async destroy() {} }
  });
  gateway.ready = true;
  await gateway.reconcilePending();
  assert.equal(state.getMessage('native-reply-ack-no-provenance').state, MESSAGE_STATES.REPLY_READY);
  assert.equal(state.listReceipts().filter(row => row.discord_id === 'native-reply-ack-no-provenance' && row.kind === ACK.RECEIVED).length, 0);
  assert.deepEqual(events, []);
  await gateway.stop();
  state.close();
});

test('simulated: legacy REPLY_READY with mismatched native reply provenance stays held', async () => {
  const first = fixture('native-reply-ack-mismatched-provenance.sqlite');
  first.state.bind({ channelId: 'channel-codex', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: first.dir });
  first.state.acceptDiscordMessage({ id: 'native-reply-ack-mismatched-provenance', guildId: 'guild-1', channelId: 'channel-codex', authorId: 'operator-1', isBot: false, content: 'answer' });
  first.state.claimDispatch('native-reply-ack-mismatched-provenance');
  first.state.markSubmitted('native-reply-ack-mismatched-provenance');
  first.state.recordNativeReply({ provider: 'codex', messageId: 'native-reply-ack-mismatched-provenance', nativeId: CODEX_ID, generation: 1, text: 'native answer' });
  first.state.db.prepare('DELETE FROM receipts WHERE discord_id=? AND kind IN (?, ?)').run('native-reply-ack-mismatched-provenance', ACK.RECEIVED, 'native-reply');
  first.state.receipt('native-reply-ack-mismatched-provenance', 'native-reply', { generation: 2, parts: 1 });
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
    client: { on() {}, off() {}, channels: { fetch: async () => channel }, async destroy() {} }
  });
  gateway.ready = true;
  await gateway.reconcilePending();
  assert.equal(state.getMessage('native-reply-ack-mismatched-provenance').state, MESSAGE_STATES.REPLY_READY);
  assert.equal(state.listReceipts().filter(row => row.discord_id === 'native-reply-ack-mismatched-provenance' && row.kind === ACK.RECEIVED).length, 0);
  assert.deepEqual(events, []);
  await gateway.stop();
  state.close();
});
