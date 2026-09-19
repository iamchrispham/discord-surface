const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { SurfaceState, READINESS, MESSAGE_STATES } = require('../src/state');
const { THREAD_STATES } = require('../src/state/thread-enrollment');
const { AGENT_ROUTING_VERSION } = require('../src/state/agent-routing');
const { runDirectPost } = require('../src/direct-post');
const { main, agentComplete } = require('../src/cli');
const { recordNativeAcknowledgment } = require('../src/acknowledgment');
const { encodeAgentMessage, decodeAgentMessage, issueAgentAddress, KINDS } = require('../src/agent-message');

const source = { guildId: '100', channelId: '101', provider: 'codex', nativeId: '11111111-1111-1111-1111-111111111111', generation: 1 };
const target = { guildId: '100', channelId: '202', provider: 'claude', nativeId: '22222222-2222-2222-2222-222222222222', generation: 1 };
const token = 'agent-routing-fixture';
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-routing-migration-'));
  const db = path.join(dir, 'surface.sqlite');
  const state = new SurfaceState(db);
  const secret = path.join(dir, 'secret');
  fs.writeFileSync(secret, `DISCORD_TOKEN=${token}\n`, { mode: 0o600 });
  state.setConfig({ operatorId: '900', guildId: '100', secretFile: secret });
  state.bind({ ...source, workspace: dir, conductorId: 'fixture', repoKey: 'repo:fixture' });
  const binding = state.setBindingReadiness('101', READINESS.READY, 'fixture ready', state.getBinding('101'));
  const textFile = path.join(dir, 'task.txt');
  fs.writeFileSync(textFile, 'Preserve the task and its custody.');
  t.after(() => { state.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, db, state, binding, textFile };
}

function enroll(f, threadId = '103') {
  f.state.enrollThread({ threadId, parentChannelId: '101', guildId: '100' }, f.binding);
  f.state.setThreadBaseline(threadId, '0', f.binding);
  f.state.markThreadBoundary(threadId, THREAD_STATES.READY, 'fixture ready', null, null, f.binding);
}

function legacyPost(f, outcome = 'not_sent', suppliedPacket = null) {
  const packet = suppliedPacket || { id: 'legacy-post', kind: KINDS.REQUEST, source, target, replyTo: null, text: fs.readFileSync(f.textFile, 'utf8') };
  const meta = { requestId: packet.id, inReplyTo: null, attemptId: 'legacy-attempt', sourcePath: f.textFile,
    textHash: hash(JSON.stringify(packet)), operatorId: '900', partHash: hash(encodeAgentMessage(packet, token)),
    ...source, conductorId: 'fixture', repoKey: 'repo:fixture', partIndex: 0, partCount: 1, nonce: 'legacy-nonce',
    binding: f.binding, deliveryChannelId: target.channelId, agentPacket: packet, presentation: 'legacy' };
  assert.equal(f.state.beginDirectPostPart(meta).claimed, true);
  f.state.recordDirectPostOutcome(packet.id, meta.attemptId, outcome, outcome === 'sent' ? { messageId: 'legacy-sent' } : {});
  return packet;
}

function input(f, extra = {}) {
  return { state: f.state, token, nativeId: source.nativeId, generation: 1, channelId: '101', provider: 'codex',
    textFile: f.textFile, dedupeKey: 'legacy-post', agentThreadId: '103', agentTarget: issueAgentAddress(target, token), ...extra };
}

function legacyPreflight(f, requestId, outcome) {
  const attempt = f.state.directPostRows(requestId).find(row => row.kind === 'direct-post-attempt');
  assert.ok(attempt);
  return f.state.recordDirectPostPreflight(attempt.detail, outcome, { reason: `fixture ${outcome}` });
}

function acceptRequest(f, id, legacy, requestTarget = source, packetId = `request-${id}`) {
  const packet = { id: packetId, kind: KINDS.REQUEST, source: target, target: requestTarget, replyTo: null, text: 'Pending request.' };
  assert.equal(f.state.acceptDiscordMessage({ id, guildId: '100', channelId: requestTarget.channelId, authorId: '901', isBot: true,
    content: encodeAgentMessage(packet, token) }, { agentToken: token }).accepted, true);
  assert.equal(f.state.getAgentMessage(id).routingVersion, AGENT_ROUTING_VERSION);
  if (legacy) {
    // Model a receipt written by the pre-upgrade intake owner.
    f.state.db.prepare("UPDATE receipts SET detail=json_remove(detail, '$.routingVersion') WHERE discord_id=? AND kind='agent-message'").run(id);
  }
  return packet;
}

test('public agent-send refuses a null destination without becoming an ordinary parent post', async t => {
  const f = fixture(t);
  const targetFile = path.join(f.dir, 'target.json');
  fs.writeFileSync(targetFile, 'null');
  const previousArgv = process.argv;
  const previousFetch = globalThis.fetch;
  let posts = 0;
  try {
    globalThis.fetch = async () => { posts++; return { ok: true, status: 200, json: async () => ({ id: 'unexpected' }) }; };
    process.argv = [process.execPath, path.resolve(__dirname, '../src/cli.js'), 'agent-send', '--db', f.db,
      '--provider', source.provider, '--channel-id', source.channelId, '--native-id', source.nativeId, '--generation', '1',
      '--target-file', targetFile, '--text-file', f.textFile, '--dedupe-key', 'null-target'];
    await assert.rejects(main(), /require --agent-thread-id/);
    assert.equal(posts, 0);
    assert.deepEqual(f.state.directPostRows('null-target'), []);
  } finally { process.argv = previousArgv; globalThis.fetch = previousFetch; }
});

test('known-unsent legacy custody moves only the wire source and survives restart without resend', async t => {
  const f = fixture(t);
  const original = legacyPost(f, 'unknown');
  f.state.reconcileDirectPostOutcome(original.id, 'legacy-attempt', 'not_sent', { source: 'fixture confirmation' });
  const originalRows = f.state.directPostRows(original.id);
  enroll(f);
  let posted;
  const result = await runDirectPost(input(f, { fetchImpl: async (_url, options) => {
    if (options.method === 'GET') return { ok: true, status: 200, json: async () => ({ id: '202', guild_id: '100' }) };
    posted = decodeAgentMessage(JSON.parse(options.body).content, token, target);
    throw Object.assign(new Error('write outcome unknown'), { outcome: 'unknown' });
  } }));
  assert.equal(result.status, 'unknown');
  assert.deepEqual(posted, { ...original, source: { ...source, channelId: '103' } });
  const rows = f.state.directPostRows(original.id);
  assert.deepEqual(rows.slice(0, originalRows.length), originalRows);
  const migrated = rows.filter(row => row.detail.legacyAgentPacket);
  assert.equal(migrated.length, 2);
  assert.deepEqual(migrated[0].detail.legacyAgentPacket, original);
  assert.deepEqual(migrated[0].detail.agentPacket, posted);
  const reopened = new SurfaceState(f.db);
  try {
    const retry = await runDirectPost(input(f, { state: reopened, fetchImpl: async () => { throw new Error('unknown must not resend'); } }));
    assert.equal(retry.status, 'unknown');
    assert.equal(reopened.directPostRows(original.id).length, rows.length);
    enroll({ ...f, state: reopened }, '104');
    await assert.rejects(runDirectPost(input(f, { state: reopened, agentThreadId: '104', fetchImpl: async () => { throw new Error('sibling must not send'); } })), /identity conflicts/);
    await assert.rejects(runDirectPost(input(f, { state: reopened, agentTarget: issueAgentAddress({ ...target, channelId: '203' }, token) })), /identity conflicts/);
    fs.writeFileSync(f.textFile, 'Changed task');
    await assert.rejects(runDirectPost(input(f, { state: reopened })), /identity conflicts/);
  } finally { reopened.close(); }
});

test('a retryable migrated request cannot move to another child', async t => {
  const f = fixture(t);
  legacyPost(f);
  enroll(f);
  enroll(f, '104');
  const failed = await runDirectPost(input(f, { fetchImpl: async (_url, options) => {
    if (options.method === 'POST') throw Object.assign(new Error('known unsent'), { outcome: 'not_sent' });
    return { ok: true, status: 200, json: async () => ({ id: '202', guild_id: '100' }) };
  } }));
  assert.equal(failed.status, 'not_sent');
  await assert.rejects(runDirectPost(input(f, { agentThreadId: '104', fetchImpl: async () => { throw new Error('must not lookup'); } })), /identity conflicts/);
});

test('pre-upgrade child-sourced retry preserves its recorded packet hash', async t => {
  const f = fixture(t);
  enroll(f);
  const child = { ...source, channelId: '103' };
  const packet = legacyPost(f, 'not_sent', { id: 'legacy-child-request', kind: KINDS.REQUEST, source: child, target,
    replyTo: null, text: fs.readFileSync(f.textFile, 'utf8') });
  const legacyTarget = { address: target,
    proof: crypto.createHmac('sha256', crypto.createHmac('sha256', token).update('discord-tether/agent-message/v1').digest())
      .update(`address/v1\0${JSON.stringify(target)}`).digest('base64url') };
  let posted;
  const result = await runDirectPost(input(f, { dedupeKey: packet.id, agentThreadId: null,
    agentTarget: legacyTarget, fetchImpl: async (_url, options) => {
      if (options.method === 'GET') return { ok: true, status: 200, json: async () => ({ id: target.channelId, guild_id: target.guildId }) };
      posted = decodeAgentMessage(JSON.parse(options.body).content, token, target);
      return { ok: true, status: 200, json: async () => ({ id: 'legacy-child-retry' }) };
    } }));
  assert.equal(result.status, 'sent');
  assert.deepEqual(posted, packet);
});

test('pre-upgrade child-sourced retry rejects a forged legacy target proof', async t => {
  const f = fixture(t);
  enroll(f);
  const child = { ...source, channelId: '103' };
  const packet = legacyPost(f, 'not_sent', { id: 'legacy-child-forged', kind: KINDS.REQUEST, source: child, target,
    replyTo: null, text: fs.readFileSync(f.textFile, 'utf8') });
  let networkCalls = 0;
  await assert.rejects(runDirectPost(input(f, { dedupeKey: packet.id, agentThreadId: null,
    agentTarget: { address: target, proof: 'A'.repeat(43) }, fetchImpl: async () => { networkCalls++; } })), /invalid agent address signature/);
  assert.equal(networkCalls, 0);
});

test('pre-upgrade parent-sourced retry rejects a forged legacy target proof', async t => {
  const f = fixture(t);
  const packet = legacyPost(f, 'not_sent');
  let networkCalls = 0;
  await assert.rejects(runDirectPost(input(f, { dedupeKey: packet.id, agentThreadId: null,
    agentTarget: { address: target, proof: 'A'.repeat(43) }, fetchImpl: async () => { networkCalls++; } })), /invalid agent address signature/);
  assert.equal(networkCalls, 0);
});

test('legacy parent requests complete through agent-complete regardless of earlier child enrollment', async t => {
  for (const scenario of ['child after request', 'existing child before upgrade', 'retry an old result']) {
    await t.test(scenario, async t => {
      const childFirst = scenario === 'existing child before upgrade';
      const f = fixture(t);
      if (childFirst) enroll(f);
      const request = acceptRequest(f, '8102', true);
      if (scenario === 'retry an old result') legacyPost(f, 'not_sent', { id: 'legacy-result', kind: KINDS.RESULT,
        source, target, replyTo: request.id, text: fs.readFileSync(f.textFile, 'utf8') });
      if (!childFirst) enroll(f);
      assert.equal(f.state.claimDispatch('8102').claimed, true);
      f.state.markSubmitted('8102');
      recordNativeAcknowledgment(f.state, { provider: 'codex', messageId: '8102', nativeId: source.nativeId, generation: 1 });
      const sent = await runDirectPost(input(f, { dedupeKey: 'legacy-result', agentTarget: null, agentKind: KINDS.RESULT,
        agentReplyTo: request.id, fetchImpl: async (_url, options) => ({ ok: true, status: 200,
          json: async () => options.method === 'GET' ? { id: '202', guild_id: '100' } : { id: '8202' } }) }));
      assert.equal(sent.status, 'sent');
      const resultRow = f.state.directPostRows('legacy-result').filter(row => row.kind === 'direct-post-outcome').at(-1);
      assert.equal(resultRow.detail.agentPacket.source.channelId, '103');
      assert.deepEqual(resultRow.detail.agentRequestTarget, source);
      if (childFirst) f.state.markThreadBoundary('103', THREAD_STATES.UNAVAILABLE, 'retired after successful result', null, null, f.binding);
      const completed = agentComplete({ db: f.db, 'state-dir': f.dir, 'message-id': '8102', provider: 'codex',
        'native-id': source.nativeId, generation: '1' }, {
        gatewayProcessStatus: () => ({ state: 'stopped', pid: null }),
        requestGatewayRecovery: () => ({ requested: false }), print: () => {}
      });
      assert.equal(completed.completed, true);
      assert.equal(completed.evidence.kind, 'sent-result');
      assert.equal(f.state.getMessage('8102').state, MESSAGE_STATES.AGENT_HANDLED_WITHOUT_POST);
    });
  }
});

test('newer attemptless terminal legacy custody controls retry', async t => {
  const f = fixture(t);
  const packet = legacyPost(f, 'not_sent');
  legacyPreflight(f, packet.id, 'not_sent');
  legacyPreflight(f, packet.id, 'rate_limited');
  enroll(f);
  let posts = 0;
  await assert.rejects(runDirectPost(input(f, { fetchImpl: async (_url, options) => {
    if (options.method === 'POST') posts++;
    return { ok: true, status: 200, json: async () => ({ id: 'unexpected', guild_id: '100' }) };
  } })), /unsupported retry outcome/);
  assert.equal(posts, 0);
});

test('legacy parent requests complete from a received child result without local send custody', async t => {
  const f = fixture(t);
  const request = acceptRequest(f, '8111', true);
  enroll(f);
  assert.equal(f.state.claimDispatch('8111').claimed, true);
  f.state.markSubmitted('8111');
  recordNativeAcknowledgment(f.state, { provider: 'codex', messageId: '8111', nativeId: source.nativeId, generation: 1 });
  const receivedPacket = { id: 'received-child-result', kind: KINDS.RESULT, source: { ...source, channelId: '103' }, target,
    replyTo: request.id, text: fs.readFileSync(f.textFile, 'utf8') };
  acceptRequest(f, 'received-child-result-discord', false);
  f.state.db.prepare("UPDATE receipts SET detail=? WHERE discord_id=? AND kind='agent-message'")
    .run(JSON.stringify({ packet: receivedPacket }), 'received-child-result-discord');
  assert.deepEqual(f.state.directPostRows(receivedPacket.id), []);
  const completed = agentComplete({ db: f.db, 'state-dir': f.dir, 'message-id': '8111', provider: 'codex',
    'native-id': source.nativeId, generation: '1' }, {
    gatewayProcessStatus: () => ({ state: 'stopped', pid: null }),
    requestGatewayRecovery: () => ({ requested: false }), print: () => {}
  });
  assert.equal(completed.completed, true);
  assert.equal(completed.evidence.kind, 'received-result');
  assert.equal(completed.evidence.discordId, 'received-child-result-discord');
});

test('legacy parent requests reject a result received before child readiness', async t => {
  const f = fixture(t);
  const request = acceptRequest(f, '8114', true);
  f.state.enrollThread({ threadId: '103', parentChannelId: '101', guildId: '100' }, f.binding);
  f.state.setThreadBaseline('103', '0', f.binding);
  assert.equal(f.state.claimDispatch('8114').claimed, true);
  f.state.markSubmitted('8114');
  recordNativeAcknowledgment(f.state, { provider: 'codex', messageId: '8114', nativeId: source.nativeId, generation: 1 });
  const receivedPacket = { id: 'received-before-ready', kind: KINDS.RESULT, source: { ...source, channelId: '103' }, target,
    replyTo: request.id, text: fs.readFileSync(f.textFile, 'utf8') };
  acceptRequest(f, 'received-before-ready-discord', false);
  f.state.db.prepare("UPDATE receipts SET detail=? WHERE discord_id=? AND kind='agent-message'")
    .run(JSON.stringify({ packet: receivedPacket }), 'received-before-ready-discord');
  f.state.markThreadBoundary('103', THREAD_STATES.READY, 'fixture became ready', null, null, f.binding);
  assert.throws(() => agentComplete({ db: f.db, 'state-dir': f.dir, 'message-id': '8114', provider: 'codex',
    'native-id': source.nativeId, generation: '1' }, {
    gatewayProcessStatus: () => ({ state: 'stopped', pid: null }),
    requestGatewayRecovery: () => ({ requested: false }), print: () => {}
  }), /immutable correlated result/);
  assert.equal(f.state.getMessage('8114').state, MESSAGE_STATES.SUBMITTED);
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
      acceptRequest(f, `received-during-${scenarioKey}-discord`, false);
      f.state.db.prepare("UPDATE receipts SET detail=? WHERE discord_id=? AND kind='agent-message'")
        .run(JSON.stringify({ packet: receivedPacket }), `received-during-${scenarioKey}-discord`);
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
  const request = acceptRequest(f, '8103', false);
  enroll(f);
  let networkCalls = 0;
  await assert.rejects(runDirectPost(input(f, { dedupeKey: 'new-parent-result', agentKind: KINDS.RESULT,
    agentTarget: null, agentReplyTo: request.id, fetchImpl: async () => { networkCalls++; throw new Error('must not send'); } })), /unknown or does not match/);
  assert.equal(networkCalls, 0);
  assert.equal(f.state.directPostRows('new-parent-result').length, 0);
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
  assert.equal(f.state.claimDispatch('8113').claimed, true);
  f.state.markSubmitted('8113');
  recordNativeAcknowledgment(f.state, { provider: 'codex', messageId: '8113', nativeId: source.nativeId, generation: 1 });
  const receivedPacket = { id: 'unenrolled-child-result', kind: KINDS.RESULT, source: { ...source, channelId: '999' }, target,
    replyTo: request.id, text: fs.readFileSync(f.textFile, 'utf8') };
  acceptRequest(f, 'unenrolled-child-result-discord', false);
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
  acceptRequest(f, 'received-sibling-child-result-discord', false);
  f.state.db.prepare("UPDATE receipts SET detail=? WHERE discord_id=? AND kind='agent-message'")
    .run(JSON.stringify({ packet: receivedPacket }), 'received-sibling-child-result-discord');
  assert.throws(() => agentComplete({ db: f.db, 'state-dir': f.dir, 'message-id': '8112', provider: 'codex',
    'native-id': source.nativeId, generation: '1' }, {
    gatewayProcessStatus: () => ({ state: 'stopped', pid: null }),
    requestGatewayRecovery: () => ({ requested: false }), print: () => {}
  }), /immutable correlated result/);
  assert.equal(f.state.getMessage('8112').state, MESSAGE_STATES.SUBMITTED);
});

test('agent-complete finds its result behind 64 newer sibling results sharing the request key', async t => {
  const f = fixture(t);
  enroll(f);
  enroll(f, '104');
  acceptRequest(f, '8101', true, { ...source, channelId: '103' }, 'shared-request-key');
  acceptRequest(f, '8102', false, { ...source, channelId: '104' }, 'shared-request-key');
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
