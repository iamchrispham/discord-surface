const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { SurfaceState, READINESS, MESSAGE_STATES } = require('../src/state');
const { THREAD_STATES } = require('../src/state/thread-enrollment');
const { AGENT_ROUTING_VERSION, resolveAgentReplyRequestMatch } = require('../src/state/agent-routing');
const { legacyParentReconciliationChannel } = require('../src/state/legacy-agent-request-route');
const { runDirectPost } = require('../src/direct-post');
const { main, agentComplete, agentSend } = require('../src/cli');
const { recordNativeAcknowledgment } = require('../src/acknowledgment');
const { codexPrompt, claudeEvent } = require('../src/native');
const { encodeAgentMessage, decodeAgentMessage, issueAgentAddress, KINDS } = require('../src/agent-message');

const { source, target, token, hash, fixture, enroll, legacyPost, input, legacyPreflight, acceptRequest, alreadySubmittedLegacyRequest } = require('./agent-routing-migration-fixture');

test('legacy parent requests complete from a received child result without local send custody', async t => {
  const f = fixture(t);
  const request = acceptRequest(f, '8111', true, source, 'shared-request-key');
  enroll(f);
  assert.equal(f.state.claimDispatch('8111').claimed, true);
  f.state.markSubmitted('8111');
  recordNativeAcknowledgment(f.state, { provider: 'codex', messageId: '8111', nativeId: source.nativeId, generation: 1 });
  const receivedPacket = { id: 'received-child-result', kind: KINDS.RESULT, source: { ...source, channelId: '103' }, target,
    replyTo: request.id, text: fs.readFileSync(f.textFile, 'utf8') };
  acceptRequest(f, '9010', false, { ...source, channelId: '103' });
  f.state.db.prepare("UPDATE receipts SET detail=? WHERE discord_id=? AND kind='agent-message'")
    .run(JSON.stringify({ packet: receivedPacket }), '9010');
  assert.deepEqual(f.state.directPostRows(receivedPacket.id), []);
  f.state.receipt(null, 'agent-message', {
    packet: { ...request, target: { ...source, channelId: '104' } },
    routingVersion: AGENT_ROUTING_VERSION
  });
  const completed = agentComplete({ db: f.db, 'state-dir': f.dir, 'message-id': '8111', provider: 'codex',
    'native-id': source.nativeId, generation: '1' }, {
    gatewayProcessStatus: () => ({ state: 'stopped', pid: null }),
    requestGatewayRecovery: () => ({ requested: false }), print: () => {}
  });
  assert.equal(completed.completed, true);
  assert.equal(completed.evidence.kind, 'received-result');
  assert.equal(completed.evidence.discordId, '9010');
});

test('stamped frozen parent requests accept a received child result', async t => {
  const f = fixture(t);
  const request = acceptRequest(f, '8111-stamped', true, source, 'stamped-frozen-shared-key');
  f.state.db.prepare("UPDATE receipts SET detail=json_set(detail, '$.routingVersion', ?) WHERE discord_id=? AND kind='agent-message'")
    .run(AGENT_ROUTING_VERSION, '8111-stamped');
  enroll(f);
  assert.equal(f.state.claimDispatch('8111-stamped').claimed, true);
  f.state.markSubmitted('8111-stamped');
  recordNativeAcknowledgment(f.state, { provider: 'codex', messageId: '8111-stamped', nativeId: source.nativeId, generation: 1 });
  const receivedPacket = { id: 'received-stamped-frozen-child-result', kind: KINDS.RESULT,
    source: { ...source, channelId: '103' }, target, replyTo: request.id, routingVersion: AGENT_ROUTING_VERSION,
    text: fs.readFileSync(f.textFile, 'utf8') };
  const childBinding = f.state.getBinding(source.channelId);
  const receivedTimestamp = new Date().toISOString();
  f.state.db.prepare(`INSERT INTO messages(discord_id, guild_id, channel_id, delivery_channel_id, author_id, content, attachments,
    provider, native_id, workspace, endpoint, conductor_id, repo_key, generation, state, created_at, updated_at)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    '9010-stamped', '100', '101', '103', '901', encodeAgentMessage(receivedPacket, token), '[]', childBinding.provider,
    childBinding.nativeId, childBinding.workspace, childBinding.endpoint, childBinding.conductorId, childBinding.repoKey,
    childBinding.generation, MESSAGE_STATES.ACCEPTED, receivedTimestamp, receivedTimestamp
  );
  f.state.receipt('9010-stamped', 'agent-message', { packet: receivedPacket });
  f.state.receipt('9010-stamped', 'accepted', { channelId: '103', generation: childBinding.generation, readiness: 'ready' });
  f.state.receipt(null, 'agent-message', {
    packet: { ...request, target: { ...source, channelId: '104' } }, routingVersion: AGENT_ROUTING_VERSION
  });
  const completed = agentComplete({ db: f.db, 'state-dir': f.dir, 'message-id': '8111-stamped', provider: 'codex',
    'native-id': source.nativeId, generation: '1' }, {
    gatewayProcessStatus: () => ({ state: 'stopped', pid: null }),
    requestGatewayRecovery: () => ({ requested: false }), print: () => {}
  });
  assert.equal(completed.completed, true);
  assert.equal(completed.evidence.kind, 'received-result');
  assert.equal(completed.evidence.discordId, '9010-stamped');
});

test('legacy parent requests accept a normal intake baseline before later ready evidence', async t => {
  const f = fixture(t);
  const request = acceptRequest(f, '8112', true);
  enroll(f);
  assert.equal(f.state.claimDispatch('8112').claimed, true);
  f.state.markSubmitted('8112');
  recordNativeAcknowledgment(f.state, { provider: 'codex', messageId: '8112', nativeId: source.nativeId, generation: 1 });
  f.state.setIntakeBaseline('101', '2', 'fixture baseline', f.state.getBinding('101'));
  f.state.markIntakeBoundary('101', READINESS.READY, 'fixture baseline ready', null, null, f.state.getBinding('101'));
  f.state.checkpointIntake('101', '2', f.state.getBinding('101'));
  const receivedPacket = { id: 'received-after-baseline', kind: KINDS.RESULT, source: { ...source, channelId: '103' }, target,
    replyTo: request.id, text: fs.readFileSync(f.textFile, 'utf8') };
  const intakePacket = { id: 'normal-after-baseline', kind: KINDS.REQUEST, source: target, target: { ...source, channelId: '103' },
    replyTo: null, text: 'Normal intake fixture.' };
  const receivedEvent = { id: '8113', guildId: '100', channelId: '103', authorId: '901', isBot: true,
    content: encodeAgentMessage(intakePacket, token) };
  const accepted = f.state.acceptDiscordMessage(receivedEvent, { agentToken: token });
  assert.equal(accepted.accepted, true, JSON.stringify(accepted));
  assert.equal(f.state.getAgentMessage('8113').routingVersion, AGENT_ROUTING_VERSION);
  f.state.db.prepare("UPDATE receipts SET detail=? WHERE discord_id=? AND kind='agent-message'")
    .run(JSON.stringify({ packet: receivedPacket }), '8113');
  const completed = agentComplete({ db: f.db, 'state-dir': f.dir, 'message-id': '8112', provider: 'codex',
    'native-id': source.nativeId, generation: '1' }, {
    gatewayProcessStatus: () => ({ state: 'stopped', pid: null }),
    requestGatewayRecovery: () => ({ requested: false }), print: () => {}
  });
  assert.equal(completed.completed, true);
  assert.equal(completed.evidence.kind, 'received-result');
});

test('legacy parent requests ignore a recovery cutoff recorded after the result', async t => {
  const f = fixture(t);
  const request = acceptRequest(f, '8112-after', true);
  enroll(f);
  assert.equal(f.state.claimDispatch('8112-after').claimed, true);
  f.state.markSubmitted('8112-after');
  recordNativeAcknowledgment(f.state, { provider: 'codex', messageId: '8112-after', nativeId: source.nativeId, generation: 1 });
  const receivedPacket = { id: 'received-before-cutoff', kind: KINDS.RESULT, source: { ...source, channelId: '103' }, target,
    replyTo: request.id, text: fs.readFileSync(f.textFile, 'utf8') };
  acceptRequest(f, '9011', false, { ...source, channelId: '103' });
  f.state.db.prepare("UPDATE receipts SET detail=? WHERE discord_id=? AND kind='agent-message'")
    .run(JSON.stringify({ packet: receivedPacket }), '9011');
  f.state.upsertIntakeWatermark({ channelId: '101', guildId: '100', id: '8112-after-cutoff' }, false);
  assert.equal(f.state.getBinding('101').readiness, READINESS.RECOVERING);
  f.state.setBindingReadiness('101', READINESS.READY, 'fixture recovered', f.state.getBinding('101'));
  const completed = agentComplete({ db: f.db, 'state-dir': f.dir, 'message-id': '8112-after', provider: 'codex',
    'native-id': source.nativeId, generation: '1' }, {
    gatewayProcessStatus: () => ({ state: 'stopped', pid: null }),
    requestGatewayRecovery: () => ({ requested: false }), print: () => {}
  });
  assert.equal(completed.completed, true);
  assert.equal(completed.evidence.kind, 'received-result');
});

test('legacy parent requests reject a result received before child readiness', async t => {
  const f = fixture(t);
  const request = acceptRequest(f, '8114', true);
  f.state.enrollThread({ threadId: '103', parentChannelId: '101', guildId: '100', adoptionCutoff: '100'}, f.binding);
  alreadySubmittedLegacyRequest(f, '8114');
  recordNativeAcknowledgment(f.state, { provider: 'codex', messageId: '8114', nativeId: source.nativeId, generation: 1 });
  const receivedPacket = { id: 'received-before-ready', kind: KINDS.RESULT, source: { ...source, channelId: '103' }, target,
    replyTo: request.id, text: fs.readFileSync(f.textFile, 'utf8') };
  acceptRequest(f, '9012', false, { ...source, channelId: '103' });
  f.state.db.prepare("UPDATE receipts SET detail=? WHERE discord_id=? AND kind='agent-message'")
    .run(JSON.stringify({ packet: receivedPacket }), '9012');
  f.state.markThreadBoundary('103', THREAD_STATES.READY, 'fixture became ready', null, null, f.binding);
  assert.throws(() => agentComplete({ db: f.db, 'state-dir': f.dir, 'message-id': '8114', provider: 'codex',
    'native-id': source.nativeId, generation: '1' }, {
    gatewayProcessStatus: () => ({ state: 'stopped', pid: null }),
    requestGatewayRecovery: () => ({ requested: false }), print: () => {}
  }), /immutable correlated result/);
  assert.equal(f.state.getMessage('8114').state, MESSAGE_STATES.SUBMITTED);
});

test('legacy parent requests reject held child results until their message is submitted', async t => {
  const f = fixture(t);
  const request = acceptRequest(f, '8116', true);
  enroll(f);
  assert.equal(f.state.claimDispatch('8116').claimed, true);
  f.state.markSubmitted('8116');
  recordNativeAcknowledgment(f.state, { provider: 'codex', messageId: '8116', nativeId: source.nativeId, generation: 1 });
  const childResult = { id: '9013', kind: KINDS.RESULT, source: { ...source, channelId: '103' }, target,
    replyTo: request.id, text: fs.readFileSync(f.textFile, 'utf8') };
  const intakePacket = { id: childResult.id, kind: childResult.kind, source: target, target: { ...source, channelId: '103' }, replyTo: childResult.replyTo, text: childResult.text };
  const accepted = f.state.acceptDiscordMessage({ id: childResult.id, guildId: '100', channelId: '103', authorId: '901', isBot: true,
    content: encodeAgentMessage(intakePacket, token) }, { agentToken: token, ready: false });
  assert.equal(accepted.accepted, true);
  f.state.db.prepare("UPDATE receipts SET detail=? WHERE discord_id=? AND kind='agent-message'")
    .run(JSON.stringify({ packet: childResult }), childResult.id);
  assert.equal(f.state.listReceipts().some(row => row.discord_id === childResult.id && row.kind === 'intake-held-not-ready'), true);
  assert.throws(() => agentComplete({ db: f.db, 'state-dir': f.dir, 'message-id': '8116', provider: 'codex',
    'native-id': source.nativeId, generation: '1' }, {
    gatewayProcessStatus: () => ({ state: 'stopped', pid: null }),
    requestGatewayRecovery: () => ({ requested: false }), print: () => {}
  }), /immutable correlated result/);
  assert.equal(f.state.getMessage('8116').state, MESSAGE_STATES.SUBMITTED);
});

test('legacy parent requests reject results received during parent readiness transitions', async t => {
  for (const scenario of ['intake reconciliation', 'disconnect recovery']) {
    await t.test(scenario, async t => {
      const f = fixture(t);
      const scenarioKey = scenario.replaceAll(' ', '-');
      const requestMessageId = `8115-${scenarioKey}`;
      const request = acceptRequest(f, requestMessageId, true);
      enroll(f);
      assert.equal(f.state.claimDispatch(requestMessageId).claimed, true);
      f.state.markSubmitted(requestMessageId);
      recordNativeAcknowledgment(f.state, { provider: 'codex', messageId: requestMessageId, nativeId: source.nativeId, generation: 1 });
      if (scenario === 'intake reconciliation') {
        f.state.markIntakeBoundary('101', READINESS.READY, 'fixture intake ready', null, null, f.state.getBinding('101'));
        f.state.reconcileIntake('101', f.state.getBinding('101'));
      } else {
        f.state.upsertIntakeWatermark({ channelId: '101', guildId: '100', id: '8115-recovery' }, false);
        assert.equal(f.state.listReceipts().some(row => row.kind === 'binding-readiness' &&
          JSON.parse(row.detail).readiness === READINESS.RECOVERING), true);
      }
      assert.notEqual(f.state.getBinding('101').readiness, READINESS.READY);
      const receivedPacket = { id: `received-during-${scenarioKey}`, kind: KINDS.RESULT, source: { ...source, channelId: '103' }, target,
        replyTo: request.id, text: fs.readFileSync(f.textFile, 'utf8') };
      const receivedDiscordId = scenario === 'intake reconciliation' ? '9014' : '9015';
      acceptRequest(f, receivedDiscordId, false, { ...source, channelId: '103' });
      f.state.db.prepare("UPDATE receipts SET detail=? WHERE discord_id=? AND kind='agent-message'")
        .run(JSON.stringify({ packet: receivedPacket }), receivedDiscordId);
      if (scenario === 'intake reconciliation') {
        f.state.markIntakeBoundary('101', READINESS.READY, 'fixture intake recovered', null, null, f.state.getBinding('101'));
      } else {
        f.state.setBindingReadiness('101', READINESS.READY, 'fixture recovered', f.state.getBinding('101'));
      }
      assert.throws(() => agentComplete({ db: f.db, 'state-dir': f.dir, 'message-id': requestMessageId, provider: 'codex',
        'native-id': source.nativeId, generation: '1' }, {
        gatewayProcessStatus: () => ({ state: 'stopped', pid: null }),
        requestGatewayRecovery: () => ({ requested: false }), print: () => {}
      }), /immutable correlated result/);
      assert.equal(f.state.getMessage(requestMessageId).state, MESSAGE_STATES.SUBMITTED);
    });
  }
});

test('new intake stamps its route version and cannot use legacy parent-result compatibility', async t => {
  const f = fixture(t);
  enroll(f);
  const request = acceptRequest(f, '8103', false, { ...source, channelId: '103' });
  let networkCalls = 0;
  await assert.rejects(runDirectPost(input(f, { dedupeKey: 'new-parent-result', agentThreadId: null, agentKind: KINDS.RESULT,
    agentTarget: null, agentReplyTo: request.id, fetchImpl: async () => { networkCalls++; throw new Error('must not send'); } })), /unknown or does not match|require --agent-thread-id/);
  assert.equal(networkCalls, 0);
  assert.equal(f.state.directPostRows('new-parent-result').length, 0);
});

test('legacy results use receiver request custody across separate installations', async t => {
  const receiver = fixture(t);
  const sender = fixture(t);
  const request = { id: 'legacy-parent-request', kind: KINDS.REQUEST, source, target,
    replyTo: null, text: 'Original task.' };
  const packet = { id: 'legacy-parent-result', kind: KINDS.RESULT,
    source: { ...target, channelId: '203' }, target: source,
    replyTo: request.id, routingVersion: AGENT_ROUTING_VERSION, sourceParentChannelId: target.channelId, text: 'Completed task.' };
  receiver.state.receipt(null, 'direct-post-outcome', { outcome: 'sent', agentPacket: request });
  sender.state.receipt(null, 'direct-post-outcome', { outcome: 'sent', agentPacket: packet });
  const ingest = (value, id) => receiver.state.acceptDiscordMessage({ id, guildId: '100', channelId: '101',
    authorId: '901', isBot: true, content: encodeAgentMessage(value, token) }, { agentToken: token });
  for (const [suffix, value] of [
    ['correlation', { ...packet, replyTo: 'unknown-request' }],
    ['parent-source', { ...packet, source: target }],
    ['owner', { ...packet, source: { ...packet.source, nativeId: source.nativeId } }],
    ['generation', { ...packet, source: { ...packet.source, generation: 2 } }]
  ]) {
    if (suffix === 'parent-source') delete value.sourceParentChannelId;
    assert.equal(ingest(value, suffix).accepted, false);
  }
  const legacyWire = { ...packet };
  delete legacyWire.routingVersion;
  delete legacyWire.sourceParentChannelId;
  assert.equal(ingest(legacyWire, 'legacy-wire').accepted, false);
  receiver.state.receipt(null, 'direct-post-outcome', { outcome: 'sent', routingVersion: 2,
    agentPacket: { ...request, id: 'new-request', routingVersion: 2 } });
  assert.equal(ingest({ ...packet, replyTo: 'new-request' }, 'new-request-result').accepted, false);
  receiver.state.receipt(null, 'direct-post-outcome', { outcome: 'unknown', phase: 'preflight',
    agentPacket: { ...request, id: 'never-posted' } });
  assert.equal(ingest({ ...packet, replyTo: 'never-posted' }, 'preflight-result').accepted, false);
  receiver.state.receipt(null, 'direct-post-outcome', { outcome: 'sent',
    agentPacket: { ...request, id: 'child-request', target: packet.source } });
  assert.equal(ingest({ ...packet, replyTo: 'child-request', source: { ...packet.source, channelId: '204' } }, 'sibling-result').accepted, false);
  assert.equal(ingest({ ...packet, sourceParentChannelId: '999' }, 'wrong-parent-result').accepted, false);
  const reconciled = { ...request, id: 'reconciled-request' };
  legacyPost(receiver, 'unknown', reconciled);
  receiver.state.reconcileDirectPostOutcome(reconciled.id, 'legacy-attempt', 'not_sent', { source: 'confirmed absent' });
  assert.equal(ingest({ ...packet, replyTo: reconciled.id }, 'reconciled-result').accepted, false);
  const accepted = ingest(packet, '9020');
  assert.equal(accepted.accepted, true, JSON.stringify(accepted));
  assert.equal(receiver.state.directPostRows(packet.id).length, 0, 'receiver has no sender result custody');
});

test('previous child-result custody remains idempotent without migration metadata', async t => {
  const f = fixture(t);
  enroll(f);
  const child = { ...source, channelId: '103' };
  const request = acceptRequest(f, '8110', false, child);
  const packet = legacyPost(f, 'sent', { id: 'old-child-result', kind: KINDS.RESULT, source: child, target,
    replyTo: request.id, text: fs.readFileSync(f.textFile, 'utf8') });
  const repeated = await runDirectPost(input(f, { dedupeKey: packet.id, agentKind: KINDS.RESULT,
    agentReplyTo: request.id, fetchImpl: async () => { throw new Error('confirmed child result must not resend'); } }));
  assert.equal(repeated.status, 'sent');
  assert.equal(repeated.duplicate, true);
  assert.deepEqual(repeated.messageIds, ['legacy-sent']);
  assert.equal(f.state.directPostRows(packet.id).length, 2);
});

test('legacy parent requests reject received results from an unenrolled child', async t => {
  const f = fixture(t);
  const request = acceptRequest(f, '8113', true);
  alreadySubmittedLegacyRequest(f, '8113');
  recordNativeAcknowledgment(f.state, { provider: 'codex', messageId: '8113', nativeId: source.nativeId, generation: 1 });
  const receivedPacket = { id: 'unenrolled-child-result', kind: KINDS.RESULT, source: { ...source, channelId: '999' }, target,
    replyTo: request.id, text: fs.readFileSync(f.textFile, 'utf8') };
  acceptRequest(f, 'unenrolled-child-result-discord', true);
  f.state.db.prepare("UPDATE receipts SET detail=? WHERE discord_id=? AND kind='agent-message'")
    .run(JSON.stringify({ packet: receivedPacket }), 'unenrolled-child-result-discord');
  assert.throws(() => agentComplete({ db: f.db, 'state-dir': f.dir, 'message-id': '8113', provider: 'codex',
    'native-id': source.nativeId, generation: '1' }, {
    gatewayProcessStatus: () => ({ state: 'stopped', pid: null }),
    requestGatewayRecovery: () => ({ requested: false }), print: () => {}
  }), /immutable correlated result/);
  assert.equal(f.state.getMessage('8113').state, MESSAGE_STATES.SUBMITTED);
});

test('legacy retry migration only sends for known-unsent custody', async t => {
  for (const outcome of ['rejected', 'rate_limited', 'stale']) {
    await t.test(outcome, async t => {
      const f = fixture(t);
      legacyPost(f, outcome);
      enroll(f);
      let posts = 0;
      await assert.rejects(runDirectPost(input(f, { fetchImpl: async (_url, options) => {
        if (options.method === 'POST') posts++;
        return { ok: true, status: 200, json: async () => ({ id: 'unexpected', guild_id: '100' }) };
      } })), /unsupported retry outcome/);
      assert.equal(posts, 0);
    });
  }
});

test('v2 child retry does not enter legacy recovery after a rate limit', async t => {
  const f = fixture(t);
  enroll(f);
  let posts = 0;
  const first = await runDirectPost(input(f, { fetchImpl: async (_url, options) => {
    if (options.method === 'GET') return { ok: true, status: 200, json: async () => ({ id: target.channelId, guild_id: target.guildId }) };
    posts++;
    return { ok: false, status: 429, json: async () => ({}) };
  } }));
  assert.equal(first.status, 'rate_limited');
  const second = await runDirectPost(input(f, { fetchImpl: async (_url, options) => {
    if (options.method === 'GET') return { ok: true, status: 200, json: async () => ({ id: target.channelId, guild_id: target.guildId }) };
    posts++;
    return { ok: true, status: 200, json: async () => ({ id: 'v2-retry' }) };
  } }));
  assert.equal(second.status, 'sent');
  assert.equal(posts, 2);
  assert.equal(f.state.directPostRows('legacy-post').some(row => row.detail.routingVersion === AGENT_ROUTING_VERSION), true);
});

test('legacy child-targeted requests reject sibling child promotion', async t => {
  const f = fixture(t);
  enroll(f, '103');
  enroll(f, '104');
  const childA = { ...source, channelId: '103' };
  const childB = { ...source, channelId: '104' };
  const request = acceptRequest(f, '8112', true, childA);
  assert.equal(f.state.claimDispatch('8112').claimed, true);
  f.state.markSubmitted('8112');
  recordNativeAcknowledgment(f.state, { provider: 'codex', messageId: '8112', nativeId: source.nativeId, generation: 1 });
  const receivedPacket = { id: 'received-sibling-child-result', kind: KINDS.RESULT, source: childB, target,
    replyTo: request.id, text: fs.readFileSync(f.textFile, 'utf8') };
  acceptRequest(f, '9016', false, childA);
  f.state.db.prepare("UPDATE receipts SET detail=? WHERE discord_id=? AND kind='agent-message'")
    .run(JSON.stringify({ packet: receivedPacket }), '9016');
  assert.throws(() => agentComplete({ db: f.db, 'state-dir': f.dir, 'message-id': '8112', provider: 'codex',
    'native-id': source.nativeId, generation: '1' }, {
    gatewayProcessStatus: () => ({ state: 'stopped', pid: null }),
    requestGatewayRecovery: () => ({ requested: false }), print: () => {}
  }), /immutable correlated result/);
  assert.equal(f.state.getMessage('8112').state, MESSAGE_STATES.SUBMITTED);
});

test('agent-complete preserves earlier custody across later request-target reuse', async t => {
  const f = fixture(t);
  enroll(f);
  enroll(f, '104');
  acceptRequest(f, '8101', true, { ...source, channelId: '103' }, 'shared-request-key');
  assert.equal(f.state.claimDispatch('8101').claimed, true);
  f.state.markSubmitted('8101');
  recordNativeAcknowledgment(f.state, { provider: 'codex', messageId: '8101', nativeId: source.nativeId, generation: 1 });
  let posted = 0;
  const sendResult = (child, requestId, dedupeKey) => runDirectPost(input(f, {
    agentThreadId: child, dedupeKey, agentKind: KINDS.RESULT, agentReplyTo: requestId,
    fetchImpl: async (_url, options) => ({ ok: true, status: 200,
      json: async () => options.method === 'GET' ? { id: '202', guild_id: '100' } : { id: `result-${++posted}` } })
  }));
  assert.equal((await sendResult('103', '8101', 'matching-result')).status, 'sent');
  acceptRequest(f, '8102', false, { ...source, channelId: '104' }, 'shared-request-key');
  for (let index = 0; index < 64; index++) {
    assert.equal((await sendResult('104', '8102', `sibling-result-${index}`)).status, 'sent');
  }
  const completed = agentComplete({ db: f.db, 'state-dir': f.dir, 'message-id': '8101', provider: 'codex',
    'native-id': source.nativeId, generation: '1' }, {
    gatewayProcessStatus: () => ({ state: 'stopped', pid: null }),
    requestGatewayRecovery: () => ({ requested: false }), print: () => {}
  });
  assert.equal(completed.completed, true);
  assert.equal(completed.evidence.messageId, 'result-1');
  assert.equal(completed.evidence.source.channelId, '103');
  assert.equal(f.state.getMessage('8101').state, MESSAGE_STATES.AGENT_HANDLED_WITHOUT_POST);
  assert.equal(f.state.getMessage('8102').state, MESSAGE_STATES.ACCEPTED);
});

for (const targetedChild of [false, true]) {
  test(`known-unsent legacy result reaches separate origin (${targetedChild ? 'child' : 'parent'} request target)`, async t => {
    const sender = fixture(t);
    enroll(sender);
    const requestTarget = targetedChild ? { ...source, channelId: '103' } : source;
    const request = acceptRequest(sender, '9200', true, requestTarget);
    const original = legacyPost(sender, 'not_sent', { id: 'result-migration', kind: KINDS.RESULT,
      source: requestTarget, target, replyTo: request.id, text: fs.readFileSync(sender.textFile, 'utf8') });
    if (!targetedChild) {
      const before = sender.state.directPostRows(original.id);
      let networkCalls = 0;
      await assert.rejects(runDirectPost(input(sender, { dedupeKey: original.id, agentKind: KINDS.RESULT,
        agentReplyTo: request.id, agentTarget: null,
        fetchImpl: async () => { networkCalls++; throw new Error('unexpected network call'); } })), /frozen child route/);
      assert.equal(networkCalls, 0);
      assert.deepEqual(sender.state.directPostRows(original.id), before);
      return;
    }
    const receiver = fixture(t);
    receiver.state.bind({ ...target, workspace: receiver.dir, endpoint: '/tmp/legacy-result-fixture.sock', conductorId: 'receiver', repoKey: 'receiver' }, { intakeCutoff: '100' });
    receiver.state.receipt(null, 'direct-post-outcome', { outcome: 'sent', agentPacket: request });
    let wire;
    const result = await runDirectPost(input(sender, { dedupeKey: original.id, agentKind: KINDS.RESULT,
      agentReplyTo: request.id, agentTarget: null, fetchImpl: async (_url, options) => {
        if (options.method === 'POST') wire = JSON.parse(options.body).content;
        return { ok: true, status: 200, json: async () => options.method === 'GET'
          ? { id: target.channelId, guild_id: target.guildId } : { id: '9300' } };
      } }));
    assert.equal(result.status, 'sent');
    const packet = decodeAgentMessage(wire, token, target);
    assert.equal(packet.routingVersion, 2);
    assert.equal(packet.source.channelId, '103');
    assert.equal(packet.sourceParentChannelId, source.channelId);
    const accepted = receiver.state.acceptDiscordMessage({ id: '9300', guildId: target.guildId,
      channelId: target.channelId, authorId: '901', isBot: true, content: wire }, { agentToken: token });
    assert.equal(accepted.accepted, true, JSON.stringify(accepted));
    assert.throws(() => encodeAgentMessage({ ...packet, sourceParentChannelId: packet.source.channelId }, token), /invalid agent message/);
    const repeated = await runDirectPost(input(sender, { dedupeKey: original.id, agentKind: KINDS.RESULT,
      agentReplyTo: request.id, agentTarget: null, agentThreadId: null,
      fetchImpl: async () => { throw new Error('terminal migration must not resend'); } }));
    assert.equal(repeated.status, 'sent');
    assert.equal(repeated.duplicate, true);
  });
}
