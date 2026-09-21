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
  const codex = await consumer.handleMessage(discordMessage({ id: 'm-codex', channelId: 'channel-codex' }));
  const claude = await consumer.handleMessage(discordMessage({ id: 'm-claude', channelId: 'channel-claude' }));
  assert.equal(codex.message.state, MESSAGE_STATES.REPLIED);
  assert.equal(claude.message.state, MESSAGE_STATES.REPLIED);
  assert.deepEqual(calls, { codex: 1, claude: 1 });
  assert.deepEqual(sends, ['4', '4']);
  state.close();
});

test('simulated: attachment metadata survives intake, reopen, and native payload shaping', async () => {
  const { dir, db, state } = fixture('attachments.sqlite');
  state.bind({ channelId: 'channel-codex', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir });
  state.bind({ channelId: 'channel-claude', guildId: 'guild-1', provider: 'claude', nativeId: CLAUDE_ID, workspace: dir, endpoint: '/tmp/discord-surface-attachments.sock' });
  const attachment = attachmentMetadata();
  const text = state.acceptDiscordMessage({
    id: 'attachment-text', guildId: 'guild-1', channelId: 'channel-codex', authorId: 'operator-1',
    isBot: false, content: 'inspect this image', attachments: [attachment]
  });
  const only = state.acceptDiscordMessage({
    id: 'attachment-only', guildId: 'guild-1', channelId: 'channel-claude', authorId: 'operator-1',
    isBot: false, content: '', attachments: [attachment]
  });
  assert.equal(text.accepted, true);
  assert.equal(only.accepted, true);
  state.close();

  const reopened = new SurfaceState(db);
  const textMessage = reopened.getMessage('attachment-text');
  const onlyMessage = reopened.getMessage('attachment-only');
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
  state.bind({ channelId: 'channel-codex', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir });
  const attachment = attachmentMetadata({ filename: 'live.png', contentType: null });
  const sdkAttachment = { url: attachment.url, name: attachment.filename, contentType: null, size: attachment.size };
  let dispatched;
  const consumer = createSurfaceConsumer({
    state,
    providers: { codex: { async dispatch(message) { dispatched = message; return { status: 'not_submitted', error: new Error('fixture') }; } } },
    sendReply: async () => ({ id: 'unused' })
  });
  const accepted = await consumer.handleMessage(discordMessage({ id: 'attachment-live', channelId: 'channel-codex', content: '', attachments: new Map([['attachment-id', sdkAttachment]]) }));
  assert.equal(accepted.status, 'not_submitted');
  assert.equal(state.getMessage('attachment-live').state, MESSAGE_STATES.ACCEPTED);
  assert.deepEqual(dispatched.attachments, [attachment]);
  assert.deepEqual(state.getMessage('attachment-live').attachments, [attachment]);
  const malformed = await consumer.handleMessage(discordMessage({
    id: 'attachment-invalid', channelId: 'channel-codex', content: '',
    attachments: [attachmentMetadata({ url: 'file:///private/image.png' })]
  }));
  assert.equal(malformed.accepted, false);
  assert.equal(malformed.reason, 'invalid-event');
  assert.equal(state.getMessage('attachment-invalid'), null);
  state.db.prepare('UPDATE messages SET attachments=? WHERE discord_id=?').run('null', 'attachment-live');
  assert.throws(() => state.getMessage('attachment-live'), StateCorruptError);
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

test('simulated: deterministic saved receipt follows durable intake and does not delay native forwarding', async () => {
  const { dir, state } = fixture();
  state.bind({ channelId: 'receipt-codex', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir, conductorId: 'receipt-conductor', repoKey: 'repo:alpha' });
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
      assert.equal(state.getMessage('receipt-input').state, MESSAGE_STATES.ACCEPTED);
      await receiptBlocked;
      return { id: 'receipt-message' };
    }
  });
  const resultPromise = consumer.handleMessage(discordMessage({ id: 'receipt-input', channelId: 'receipt-codex' }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(dispatchStarted, true);
  assert.equal(receiptPayload.reaction, '📥');
  assert.equal(receiptPayload.content, 'Receipt: saved for this conductor.');
  assert.equal(receiptPayload.enforceNonce, true);
  assert.ok(receiptPayload.nonce.length <= 25);
  assert.deepEqual(receiptPayload.reply, { messageReference: 'receipt-input', failIfNotExists: false });
  assert.deepEqual(receiptPayload.allowedMentions, { parse: [], repliedUser: false });
  releaseReceipt();
  const result = await resultPromise;
  await consumer.waitForReceipts();
  const receiptOutcome = state.getTransportReceipt('receipt-input').outcome;
  assert.equal(receiptOutcome.outcome, 'sent');
  assert.equal(receiptOutcome.reaction, '📥');
  assert.equal(receiptOutcome.targetMessageId, 'receipt-input');
  assert.equal(receiptOutcome.receiptMessageId, undefined);
  assert.equal(result.message.state, MESSAGE_STATES.REPLIED);
  state.close();
});

test('simulated: receipt failure is isolated from native dispatch and has no retry', async () => {
  const { dir, state } = fixture();
  state.bind({ channelId: 'receipt-failure', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir, conductorId: 'receipt-failure-conductor', repoKey: 'repo:alpha' });
  state.markIntakeBoundary('receipt-failure', 'ready');
  let dispatches = 0;
  const consumer = createSurfaceConsumer({
    state,
    providers: { codex: { async dispatch() { dispatches += 1; return { status: 'submitted' }; }, async observe() { return { text: 'answer' }; } } },
    sendReply: async () => ({ id: 'native-reply' }),
    sendTransportReceipt: async () => { throw Object.assign(new Error('Discord rate limit'), { status: 429 }); }
  });
  const result = await consumer.handleMessage(discordMessage({ id: 'receipt-rate-limited', channelId: 'receipt-failure' }));
  await consumer.waitForReceipts();
  assert.equal(result.message.state, MESSAGE_STATES.REPLIED);
  assert.equal(dispatches, 1);
  assert.equal(state.getBinding('receipt-failure').readiness, READINESS.READY);
  assert.equal(state.getTransportReceipt('receipt-rate-limited').outcome.outcome, 'rate_limited');
  await consumer.issueTransportReceipt(discordMessage({ id: 'receipt-rate-limited', channelId: 'receipt-failure' }));
  assert.equal(state.listReceipts().filter(item => item.kind === 'transport-receipt-attempt').length, 1);
  state.close();
});

test('simulated: restart settles an incomplete transport receipt as unknown without retry', async () => {
  const first = fixture();
  first.state.bind({ channelId: 'receipt-restart', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: first.dir, conductorId: 'receipt-restart-conductor', repoKey: 'repo:alpha' });
  first.state.acceptDiscordMessage({ id: 'receipt-restart-input', guildId: 'guild-1', channelId: 'receipt-restart', authorId: 'operator-1', isBot: false, content: 'x' });
  assert.equal(first.state.beginTransportReceipt('receipt-restart-input').started, true);
  first.state.close();

  const state = new SurfaceState(first.db);
  state.recoverAfterRestart();
  const recovered = state.getTransportReceipt('receipt-restart-input');
  assert.equal(recovered.outcome.outcome, 'unknown');
  assert.match(recovered.outcome.reason, /stopped before transport receipt outcome/);
  let sends = 0;
  const consumer = createSurfaceConsumer({
    state,
    providers: providers({ calls: { codex: 0, claude: 0 } }),
    sendReply: async () => ({ id: 'native-reply' }),
    sendTransportReceipt: async () => { sends += 1; return { id: 'must-not-send' }; }
  });
  const result = await consumer.issueTransportReceipt(discordMessage({ id: 'receipt-restart-input', channelId: 'receipt-restart' }));
  assert.equal(result.started, false);
  assert.equal(sends, 0);
  state.close();
});

test('simulated: accepted recovery creates the missing receipt without replaying intake', async () => {
  const { dir, state } = fixture();
  state.bind({ channelId: 'receipt-recovery', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir, conductorId: 'receipt-recovery-conductor', repoKey: 'repo:alpha' });
  state.markIntakeBoundary('receipt-recovery', 'ready');
  state.acceptDiscordMessage({ id: 'receipt-recovery-input', guildId: 'guild-1', channelId: 'receipt-recovery', authorId: 'operator-1', isBot: false, content: 'x' });
  let receipts = 0;
  let dispatches = 0;
  const consumer = createSurfaceConsumer({
    state,
    providers: { codex: { async dispatch() { dispatches += 1; return { status: 'submitted' }; }, async observe() { return { text: 'answer' }; } } },
    sendReply: async () => ({ id: 'native-reply' }),
    sendTransportReceipt: async () => { receipts += 1; return { id: 'transport-receipt' }; }
  });
  const result = await consumer.handleStoredMessage(discordMessage({ id: 'receipt-recovery-input', channelId: 'receipt-recovery' }));
  await consumer.waitForReceipts();
  assert.equal(result.message.state, MESSAGE_STATES.REPLIED);
  assert.equal(dispatches, 1);
  assert.equal(receipts, 1);
  assert.equal(state.getTransportReceipt('receipt-recovery-input').outcome.outcome, 'sent');
  state.close();
});

test('simulated: duplicate and rejected inputs create no transport receipt attempt', async () => {
  const { dir, state } = fixture();
  state.bind({ channelId: 'receipt-guards', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir, conductorId: 'receipt-guards-conductor', repoKey: 'repo:alpha' });
  state.markIntakeBoundary('receipt-guards', 'ready');
  let receipts = 0;
  const consumer = createSurfaceConsumer({
    state,
    providers: { codex: { async dispatch() { return { status: 'submitted' }; }, async observe() { return { text: 'answer' }; } } },
    sendReply: async () => ({ id: 'native-reply' }),
    sendTransportReceipt: async () => { receipts += 1; return { id: `receipt-${receipts}` }; }
  });
  await consumer.handleMessage(discordMessage({ id: 'receipt-duplicate', channelId: 'receipt-guards' }));
  await consumer.waitForReceipts();
  const duplicate = await consumer.handleMessage(discordMessage({ id: 'receipt-duplicate', channelId: 'receipt-guards' }));
  const rejected = await consumer.handleMessage(discordMessage({ id: 'receipt-rejected', channelId: 'receipt-guards', authorId: 'intruder' }));
  assert.equal(duplicate.duplicate, true);
  assert.equal(rejected.reason, 'unauthorized-sender');
  assert.equal(receipts, 1);
  assert.equal(state.listReceipts().filter(item => item.kind === 'transport-receipt-attempt').length, 1);
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

test('simulated: native ACK fences rollback, claim, uncertain reconciliation, and restart recovery', () => {
  const first = fixture('ack-replay-fence.sqlite');
  first.state.bind({ channelId: 'channel-codex', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: first.dir });
  function accept(id) {
    first.state.acceptDiscordMessage({ id, guildId: 'guild-1', channelId: 'channel-codex', authorId: 'operator-1', isBot: false, content: id });
    first.state.claimDispatch(id);
    recordNativeAcknowledgment(first.state, { provider: 'codex', messageId: id, nativeId: CODEX_ID, generation: 1 });
  }

  accept('ack-rollback-fence');
  assert.equal(first.state.markNotSubmitted('ack-rollback-fence', new Error('late fetch')).state, MESSAGE_STATES.SUBMITTED);
  assert.equal(first.state.getMessage('ack-rollback-fence').error, null);

  accept('ack-claim-fence');
  first.state.db.prepare('UPDATE messages SET state=? WHERE discord_id=?').run(MESSAGE_STATES.ACCEPTED, 'ack-claim-fence');
  const claim = first.state.claimDispatch('ack-claim-fence');
  assert.equal(claim.claimed, false);
  assert.equal(claim.reason, 'native-already-acknowledged');
  assert.equal(claim.message.state, MESSAGE_STATES.SUBMITTED);

  first.state.acceptDiscordMessage({ id: 'ack-uncertain-fence', guildId: 'guild-1', channelId: 'channel-codex', authorId: 'operator-1', isBot: false, content: 'ack-uncertain-fence' });
  first.state.claimDispatch('ack-uncertain-fence');
  first.state.markUncertain('ack-uncertain-fence', new Error('delivery uncertain'));
  recordNativeAcknowledgment(first.state, { provider: 'codex', messageId: 'ack-uncertain-fence', nativeId: CODEX_ID, generation: 1 });
  assert.throws(() => first.state.reconcileUncertain('ack-uncertain-fence', 'not_submitted'), /native acknowledgment prevents retrying delivery/);
  assert.equal(first.state.getMessage('ack-uncertain-fence').state, MESSAGE_STATES.SUBMITTED);

  accept('ack-restart-fence');
  first.state.close();
  const recovered = new SurfaceState(first.db);
  recovered.recoverAfterRestart();
  assert.equal(recovered.getMessage('ack-restart-fence').state, MESSAGE_STATES.SUBMITTED);
  assert.equal(recovered.listReceipts().some(row => row.discord_id === 'ack-restart-fence' && row.kind === 'dispatch-uncertain-after-restart'), false);
  recovered.close();
});

test('simulated: dispatch rollback without native ACK remains retryable', () => {
  const { dir, state } = fixture();
  state.bind({ channelId: 'channel-codex', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir });
  state.acceptDiscordMessage({ id: 'no-ack-retry', guildId: 'guild-1', channelId: 'channel-codex', authorId: 'operator-1', isBot: false, content: 'x' });
  state.claimDispatch('no-ack-retry');
  assert.equal(state.markNotSubmitted('no-ack-retry', new Error('not sent')).state, MESSAGE_STATES.ACCEPTED);
  assert.equal(state.claimDispatch('no-ack-retry').claimed, true);
  state.markSubmitted('no-ack-retry');
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

test('simulated: rebind rechecks unresolved custody inside the generation transaction', () => {
  const { dir, state } = fixture();
  state.bind({ channelId: 'rebind-transaction-guard', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir });
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
