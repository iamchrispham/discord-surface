const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { SurfaceState, StateCorruptError, StaleGenerationError, UnresolvedWorkError, MESSAGE_STATES, READINESS } = require('../src/state');
const { CodexProvider, claudeEvent, codexPrompt } = require('../src/native');
const { createSurfaceConsumer } = require('../src/discord');
const { recordNativeAcknowledgment } = require('../src/acknowledgment');
const { CODEX_ID, CLAUDE_ID, fixture, bindBoth, discordMessage, attachmentMetadata, providers } = require('./surface-fixtures');

test('simulated: two provider bindings route and persist attributable replies', async () => {
  const { dir, state } = fixture();
  bindBoth(state, dir);
  const calls = { codex: 0, claude: 0 };
  const sends = [];
  const consumer = createSurfaceConsumer({ state, providers: providers({ calls }), sendReply: async (_message, reply) => {
    sends.push(reply.replyText);
    return { id: `sent-${reply.id}` };
  } });
  const codex = await consumer.handleMessage(discordMessage({ id: '101', channelId: 'channel-codex' }));
  const claude = await consumer.handleMessage(discordMessage({ id: '102', channelId: 'channel-claude' }));
  assert.equal(codex.message.state, MESSAGE_STATES.REPLIED);
  assert.equal(claude.message.state, MESSAGE_STATES.REPLIED);
  assert.deepEqual(calls, { codex: 1, claude: 1 });
  assert.deepEqual(sends, ['4', '4']);
  state.close();
});

test('simulated: attachment metadata survives intake, reopen, and native payload shaping', async () => {
  const { dir, db, state } = fixture('attachments.sqlite');
  state.bind({ channelId: 'channel-codex', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir }, { intakeCutoff: '100' });
  state.bind({ channelId: 'channel-claude', guildId: 'guild-1', provider: 'claude', nativeId: CLAUDE_ID, workspace: dir, endpoint: '/tmp/discord-surface-attachments.sock' }, { intakeCutoff: '100' });
  const attachment = attachmentMetadata();
  const text = state.acceptDiscordMessage({
    id: '103', guildId: 'guild-1', channelId: 'channel-codex', authorId: 'operator-1',
    isBot: false, content: 'inspect this image', attachments: [attachment]
  });
  const only = state.acceptDiscordMessage({
    id: '104', guildId: 'guild-1', channelId: 'channel-claude', authorId: 'operator-1',
    isBot: false, content: '', attachments: [attachment]
  });
  assert.equal(text.accepted, true);
  assert.equal(only.accepted, true);
  state.close();

  const reopened = new SurfaceState(db);
  const textMessage = reopened.getMessage('103');
  const onlyMessage = reopened.getMessage('104');
  assert.deepEqual(textMessage.attachments, [attachment]);
  assert.deepEqual(onlyMessage.attachments, [attachment]);

  const prompt = codexPrompt(textMessage);
  assert.match(prompt, /inspect this image/);
  assert.match(prompt, /Attachment references supplied by the user/);
  assert.match(prompt, new RegExp(attachment.url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  const event = claudeEvent(onlyMessage);
  assert.equal(event.content.endsWith('\n'), false);
  assert.match(event.content, /Attachment references supplied by the user/);
  assert.deepEqual(event.attachments, [attachment]);

  let codexArgs;
  let codexEnv;
  const provider = new CodexProvider({ root: path.join(dir, 'sessions'), run: async (_command, args, options) => {
    codexArgs = args;
    codexEnv = options.env;
    return { status: 'not_submitted', error: new Error('fixture') };
  } });
  const outcome = await provider.dispatch(textMessage);
  assert.equal(outcome.status, 'not_submitted');
  assert.equal(codexEnv.CODEX_HOME, dir);
  const messageIndex = codexArgs.indexOf('--message');
  assert.ok(messageIndex >= 0);
  assert.match(codexArgs[messageIndex + 1], /image\.png/);
  reopened.close();
});

test('simulated: attachment-only live intake reaches the provider and malformed metadata is rejected', async () => {
  const { dir, state } = fixture();
  state.bind({ channelId: 'channel-codex', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir }, { intakeCutoff: '100' });
  const attachment = attachmentMetadata({ filename: 'live.png', contentType: null });
  const sdkAttachment = { url: attachment.url, name: attachment.filename, contentType: null, size: attachment.size };
  let dispatched;
  const consumer = createSurfaceConsumer({
    state,
    providers: { codex: { async dispatch(message) { dispatched = message; return { status: 'not_submitted', error: new Error('fixture') }; } } },
    sendReply: async () => ({ id: 'unused' })
  });
  const accepted = await consumer.handleMessage(discordMessage({ id: '105', channelId: 'channel-codex', content: '', attachments: new Map([['attachment-id', sdkAttachment]]) }));
  assert.equal(accepted.status, 'not_submitted');
  assert.equal(state.getMessage('105').state, MESSAGE_STATES.ACCEPTED);
  assert.deepEqual(dispatched.attachments, [attachment]);
  assert.deepEqual(state.getMessage('105').attachments, [attachment]);
  const malformed = await consumer.handleMessage(discordMessage({
    id: '106', channelId: 'channel-codex', content: '',
    attachments: [attachmentMetadata({ url: 'file:///private/image.png' })]
  }));
  assert.equal(malformed.accepted, false);
  assert.equal(malformed.reason, 'invalid-event');
  assert.equal(state.getMessage('106'), null);
  state.db.prepare('UPDATE messages SET attachments=? WHERE discord_id=?').run('null', '105');
  assert.throws(() => state.getMessage('105'), StateCorruptError);
  state.close();
});

test('simulated: sender, guild, binding, and bot guards reject without dispatcher calls', async () => {
  const { dir, state } = fixture();
  state.bind({ channelId: 'channel-codex', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir }, { intakeCutoff: '100' });
  const calls = { codex: 0, claude: 0 };
  const consumer = createSurfaceConsumer({ state, providers: providers({ calls }), sendReply: async () => ({ id: 'unused' }) });
  assert.equal((await consumer.handleMessage(discordMessage({ id: '107', channelId: 'channel-codex', authorId: 'intruder' }))).reason, 'unauthorized-sender');
  assert.equal((await consumer.handleMessage({ ...discordMessage({ id: '108', channelId: 'channel-codex' }), guildId: 'other-guild' })).reason, 'unauthorized-sender');
  assert.equal((await consumer.handleMessage(discordMessage({ id: '109', channelId: 'channel-codex', bot: true }))).reason, 'bot-source');
  assert.equal((await consumer.handleMessage(discordMessage({ id: 'unknown', channelId: 'no-binding' }))).reason, 'unknown-binding');
  assert.deepEqual(calls, { codex: 0, claude: 0 });
  assert.equal(state.listMessages().length, 0);
  state.close();
});

test('simulated: duplicate Discord ID is a durable dedupe guard', async () => {
  const { dir, state } = fixture();
  state.bind({ channelId: 'channel-codex', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir }, { intakeCutoff: '100' });
  const calls = { codex: 0, claude: 0 };
  let sends = 0;
  const consumer = createSurfaceConsumer({ state, providers: providers({ calls }), sendReply: async () => { sends += 1; return { id: 'reply' }; } });
  const first = await consumer.handleMessage(discordMessage({ id: '111', channelId: 'channel-codex' }));
  const second = await consumer.handleMessage(discordMessage({ id: '111', channelId: 'channel-codex', content: 'different' }));
  assert.equal(first.message.state, MESSAGE_STATES.REPLIED);
  assert.equal(second.duplicate, true);
  assert.equal(calls.codex, 1);
  assert.equal(sends, 1);
  state.close();
});

test('simulated: deterministic saved receipt follows durable intake and does not delay native forwarding', async () => {
  const { dir, state } = fixture();
  state.bind({ channelId: 'receipt-codex', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir, conductorId: 'receipt-conductor', repoKey: 'repo:alpha' }, { intakeCutoff: '100' });
  state.markIntakeBoundary('receipt-codex', 'ready');
  let receiptPayload;
  let releaseReceipt;
  let dispatchStarted = false;
  const receiptBlocked = new Promise(resolve => { releaseReceipt = resolve; });
  const consumer = createSurfaceConsumer({
    state,
    providers: { codex: { async dispatch() { dispatchStarted = true; return { status: 'submitted' }; }, async observe() { return { text: 'answer' }; } } },
    sendReply: async () => ({ id: 'native-reply' }),
    sendTransportReceipt: async (_message, payload) => {
      receiptPayload = payload;
      assert.equal(state.getMessage('112').state, MESSAGE_STATES.ACCEPTED);
      await receiptBlocked;
      return { id: 'receipt-message' };
    }
  });
  const resultPromise = consumer.handleMessage(discordMessage({ id: '112', channelId: 'receipt-codex' }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(dispatchStarted, true);
  assert.equal(receiptPayload.reaction, '📥');
  assert.equal(receiptPayload.content, 'Receipt: saved for this conductor.');
  assert.equal(receiptPayload.enforceNonce, true);
  assert.ok(receiptPayload.nonce.length <= 25);
  assert.deepEqual(receiptPayload.reply, { messageReference: '112', failIfNotExists: false });
  assert.deepEqual(receiptPayload.allowedMentions, { parse: [], repliedUser: false });
  releaseReceipt();
  const result = await resultPromise;
  await consumer.waitForReceipts();
  const receiptOutcome = state.getTransportReceipt('112').outcome;
  assert.equal(receiptOutcome.outcome, 'sent');
  assert.equal(receiptOutcome.reaction, '📥');
  assert.equal(receiptOutcome.targetMessageId, '112');
  assert.equal(receiptOutcome.receiptMessageId, undefined);
  assert.equal(result.message.state, MESSAGE_STATES.REPLIED);
  state.close();
});

test('simulated: receipt failure is isolated from native dispatch and has no retry', async () => {
  const { dir, state } = fixture();
  state.bind({ channelId: 'receipt-failure', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir, conductorId: 'receipt-failure-conductor', repoKey: 'repo:alpha' }, { intakeCutoff: '100' });
  state.markIntakeBoundary('receipt-failure', 'ready');
  let dispatches = 0;
  const consumer = createSurfaceConsumer({
    state,
    providers: { codex: { async dispatch() { dispatches += 1; return { status: 'submitted' }; }, async observe() { return { text: 'answer' }; } } },
    sendReply: async () => ({ id: 'native-reply' }),
    sendTransportReceipt: async () => { throw Object.assign(new Error('Discord rate limit'), { status: 429 }); }
  });
  const result = await consumer.handleMessage(discordMessage({ id: '113', channelId: 'receipt-failure' }));
  await consumer.waitForReceipts();
  assert.equal(result.message.state, MESSAGE_STATES.REPLIED);
  assert.equal(dispatches, 1);
  assert.equal(state.getBinding('receipt-failure').readiness, READINESS.READY);
  assert.equal(state.getTransportReceipt('113').outcome.outcome, 'rate_limited');
  await consumer.issueTransportReceipt(discordMessage({ id: '113', channelId: 'receipt-failure' }));
  assert.equal(state.listReceipts().filter(item => item.kind === 'transport-receipt-attempt').length, 1);
  state.close();
});

test('simulated: restart settles an incomplete transport receipt as unknown without retry', async () => {
  const first = fixture();
  first.state.bind({ channelId: 'receipt-restart', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: first.dir, conductorId: 'receipt-restart-conductor', repoKey: 'repo:alpha' }, { intakeCutoff: '100' });
  first.state.acceptDiscordMessage({ id: '114', guildId: 'guild-1', channelId: 'receipt-restart', authorId: 'operator-1', isBot: false, content: 'x' });
  assert.equal(first.state.beginTransportReceipt('114').started, true);
  first.state.close();

  const state = new SurfaceState(first.db);
  state.recoverAfterRestart();
  const recovered = state.getTransportReceipt('114');
  assert.equal(recovered.outcome.outcome, 'unknown');
  assert.match(recovered.outcome.reason, /stopped before transport receipt outcome/);
  let sends = 0;
  const consumer = createSurfaceConsumer({
    state,
    providers: providers({ calls: { codex: 0, claude: 0 } }),
    sendReply: async () => ({ id: 'native-reply' }),
    sendTransportReceipt: async () => { sends += 1; return { id: 'must-not-send' }; }
  });
  const result = await consumer.issueTransportReceipt(discordMessage({ id: '114', channelId: 'receipt-restart' }));
  assert.equal(result.started, false);
  assert.equal(sends, 0);
  state.close();
});

test('simulated: accepted recovery creates the missing receipt without replaying intake', async () => {
  const { dir, state } = fixture();
  state.bind({ channelId: 'receipt-recovery', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir, conductorId: 'receipt-recovery-conductor', repoKey: 'repo:alpha' }, { intakeCutoff: '100' });
  state.markIntakeBoundary('receipt-recovery', 'ready');
  state.acceptDiscordMessage({ id: '115', guildId: 'guild-1', channelId: 'receipt-recovery', authorId: 'operator-1', isBot: false, content: 'x' });
  let receipts = 0;
  let dispatches = 0;
  const consumer = createSurfaceConsumer({
    state,
    providers: { codex: { async dispatch() { dispatches += 1; return { status: 'submitted' }; }, async observe() { return { text: 'answer' }; } } },
    sendReply: async () => ({ id: 'native-reply' }),
    sendTransportReceipt: async () => { receipts += 1; return { id: 'transport-receipt' }; }
  });
  const result = await consumer.handleStoredMessage(discordMessage({ id: '115', channelId: 'receipt-recovery' }));
  await consumer.waitForReceipts();
  assert.equal(result.message.state, MESSAGE_STATES.REPLIED);
  assert.equal(dispatches, 1);
  assert.equal(receipts, 1);
  assert.equal(state.getTransportReceipt('115').outcome.outcome, 'sent');
  state.close();
});

test('simulated: duplicate and rejected inputs create no transport receipt attempt', async () => {
  const { dir, state } = fixture();
  state.bind({ channelId: 'receipt-guards', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir, conductorId: 'receipt-guards-conductor', repoKey: 'repo:alpha' }, { intakeCutoff: '100' });
  state.markIntakeBoundary('receipt-guards', 'ready');
  let receipts = 0;
  const consumer = createSurfaceConsumer({
    state,
    providers: { codex: { async dispatch() { return { status: 'submitted' }; }, async observe() { return { text: 'answer' }; } } },
    sendReply: async () => ({ id: 'native-reply' }),
    sendTransportReceipt: async () => { receipts += 1; return { id: `receipt-${receipts}` }; }
  });
  await consumer.handleMessage(discordMessage({ id: '116', channelId: 'receipt-guards' }));
  await consumer.waitForReceipts();
  const duplicate = await consumer.handleMessage(discordMessage({ id: '116', channelId: 'receipt-guards' }));
  const rejected = await consumer.handleMessage(discordMessage({ id: '117', channelId: 'receipt-guards', authorId: 'intruder' }));
  assert.equal(duplicate.duplicate, true);
  assert.equal(rejected.reason, 'unauthorized-sender');
  assert.equal(receipts, 1);
  assert.equal(state.listReceipts().filter(item => item.kind === 'transport-receipt-attempt').length, 1);
  state.close();
});

test('simulated: intake transaction failure leaves no accepted row or receipt', () => {
  const { dir, state } = fixture();
  state.bind({ channelId: 'channel-codex', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir }, { intakeCutoff: '100' });
  state.failNextIntake();
  assert.throws(() => state.acceptDiscordMessage({ id: '118', guildId: 'guild-1', channelId: 'channel-codex', authorId: 'operator-1', isBot: false, content: 'x' }), /injected intake/);
  assert.equal(state.getMessage('118'), null);
  assert.equal(state.listReceipts().some(receipt => receipt.discord_id === '118'), false);
  state.close();
});

test('simulated: restart preserves pending intake and fences dispatching as uncertain', () => {
  const first = fixture();
  first.state.bind({ channelId: 'channel-codex', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: first.dir }, { intakeCutoff: '100' });
  first.state.acceptDiscordMessage({ id: '119', guildId: 'guild-1', channelId: 'channel-codex', authorId: 'operator-1', isBot: false, content: '119' });
  first.state.acceptDiscordMessage({ id: '120', guildId: 'guild-1', channelId: 'channel-codex', authorId: 'operator-1', isBot: false, content: '120' });
  first.state.claimDispatch('120');
  first.state.close();
  const state = new SurfaceState(first.db);
  state.recoverAfterRestart();
  assert.equal(state.getMessage('119').state, MESSAGE_STATES.ACCEPTED);
  assert.equal(state.getMessage('120').state, MESSAGE_STATES.UNCERTAIN);
  state.close();
});

test('simulated: native ACK fences rollback, claim, uncertain reconciliation, and restart recovery', () => {
  const first = fixture('ack-replay-fence.sqlite');
  first.state.bind({ channelId: 'channel-codex', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: first.dir }, { intakeCutoff: '100' });
  function accept(id) {
    first.state.acceptDiscordMessage({ id, guildId: 'guild-1', channelId: 'channel-codex', authorId: 'operator-1', isBot: false, content: id });
    first.state.claimDispatch(id);
    recordNativeAcknowledgment(first.state, { provider: 'codex', messageId: id, nativeId: CODEX_ID, generation: 1 });
  }

  accept('126');
  assert.equal(first.state.markNotSubmitted('126', new Error('late fetch')).state, MESSAGE_STATES.SUBMITTED);
  assert.equal(first.state.getMessage('126').error, null);

  accept('127');
  first.state.db.prepare('UPDATE messages SET state=? WHERE discord_id=?').run(MESSAGE_STATES.ACCEPTED, '127');
  const claim = first.state.claimDispatch('127');
  assert.equal(claim.claimed, false);
  assert.equal(claim.reason, 'native-already-acknowledged');
  assert.equal(claim.message.state, MESSAGE_STATES.SUBMITTED);

  first.state.acceptDiscordMessage({ id: '121', guildId: 'guild-1', channelId: 'channel-codex', authorId: 'operator-1', isBot: false, content: '121' });
  first.state.claimDispatch('121');
  first.state.markUncertain('121', new Error('delivery uncertain'));
  recordNativeAcknowledgment(first.state, { provider: 'codex', messageId: '121', nativeId: CODEX_ID, generation: 1 });
  assert.throws(() => first.state.reconcileUncertain('121', 'not_submitted'), /native acknowledgment prevents retrying delivery/);
  assert.equal(first.state.getMessage('121').state, MESSAGE_STATES.SUBMITTED);

  accept('128');
  first.state.close();
  const recovered = new SurfaceState(first.db);
  recovered.recoverAfterRestart();
  assert.equal(recovered.getMessage('128').state, MESSAGE_STATES.SUBMITTED);
  assert.equal(recovered.listReceipts().some(row => row.discord_id === '128' && row.kind === 'dispatch-uncertain-after-restart'), false);
  recovered.close();
});

test('simulated: dispatch rollback without native ACK remains retryable', () => {
  const { dir, state } = fixture();
  state.bind({ channelId: 'channel-codex', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir }, { intakeCutoff: '100' });
  state.acceptDiscordMessage({ id: '122', guildId: 'guild-1', channelId: 'channel-codex', authorId: 'operator-1', isBot: false, content: 'x' });
  state.claimDispatch('122');
  assert.equal(state.markNotSubmitted('122', new Error('not sent')).state, MESSAGE_STATES.ACCEPTED);
  assert.equal(state.claimDispatch('122').claimed, true);
  state.markSubmitted('122');
  state.close();
});

test('simulated: rebind is blocked by in-flight work and stale reply is rejected after a drained rebind', () => {
  const { dir, state } = fixture();
  state.bind({ channelId: 'channel-codex', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir }, { intakeCutoff: '100' });
  state.acceptDiscordMessage({ id: '123', guildId: 'guild-1', channelId: 'channel-codex', authorId: 'operator-1', isBot: false, content: 'x' });
  state.claimDispatch('123');
  assert.throws(() => state.rebind({ channelId: 'channel-codex', guildId: 'guild-1', provider: 'codex', nativeId: CLAUDE_ID, workspace: dir }), UnresolvedWorkError);
  state.markSubmitted('123');
  state.recordNativeReply({ provider: 'codex', messageId: '123', nativeId: CODEX_ID, generation: 1, text: 'done' });
  state.beginReply('123');
  state.markReplySent('123', 'reply-in-flight');
  const rebound = state.rebind({ channelId: 'channel-codex', guildId: 'guild-1', provider: 'codex', nativeId: CLAUDE_ID, workspace: dir });
  assert.equal(rebound.generation, 2);
  assert.throws(() => state.recordNativeReply({ provider: 'codex', messageId: '123', nativeId: CODEX_ID, generation: 1, text: 'stale' }), StaleGenerationError);
  state.close();
});

test('simulated: rebind rechecks unresolved custody inside the generation transaction', () => {
  const { dir, state } = fixture();
  state.bind({ channelId: 'rebind-transaction-guard', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir }, { intakeCutoff: '100' });
  let checks = 0;
  state.hasUnresolved = () => checks++ > 0;
  assert.throws(() => state.rebind({
    channelId: 'rebind-transaction-guard', guildId: 'guild-1', provider: 'codex', nativeId: CLAUDE_ID, workspace: dir
  }), UnresolvedWorkError);
  assert.equal(checks, 2);
  assert.equal(state.getBinding('rebind-transaction-guard').generation, 1);
});

test('simulated: reply delivery failure keeps custody and records the failure', async () => {
  const { dir, state } = fixture();
  state.bind({ channelId: 'channel-codex', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir }, { intakeCutoff: '100' });
  const calls = { codex: 0, claude: 0 };
  const consumer = createSurfaceConsumer({ state, providers: providers({ calls }), sendReply: async () => { throw new Error('Discord send failed'); } });
  const result = await consumer.handleMessage(discordMessage({ id: '124', channelId: 'channel-codex' }));
  assert.equal(result.message.state, MESSAGE_STATES.REPLY_UNKNOWN);
  assert.equal(state.getMessage('124').replyText, '4');
  assert.ok(state.listReceipts().some(receipt => receipt.kind === 'reply-unknown'));
  state.close();
});

test('simulated: unavailable Claude owner holds accepted input without execution acknowledgement', async () => {
  const { dir, state } = fixture();
  state.bind({ channelId: 'channel-claude', guildId: 'guild-1', provider: 'claude', nativeId: CLAUDE_ID, workspace: dir, endpoint: path.join(dir, 'offline.sock') }, { intakeCutoff: '100' });
  let sends = 0;
  const consumer = createSurfaceConsumer({
    state,
    providers: { claude: { async dispatch() { return { status: 'not_submitted', error: new Error('channel unavailable') }; } } },
    sendReply: async () => { sends += 1; return { id: 'unexpected' }; }
  });
  const result = await consumer.handleMessage(discordMessage({ id: '125', channelId: 'channel-claude' }));
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
