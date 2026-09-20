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
const { main, agentComplete, agentSend } = require('../src/cli');
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
  const content = encodeAgentMessage(packet, token);
  if (legacy && requestTarget.channelId === source.channelId) {
    const binding = f.state.getBinding(source.channelId);
    const timestamp = new Date().toISOString();
    f.state.db.prepare(`INSERT INTO messages(discord_id, guild_id, channel_id, delivery_channel_id, author_id, content, attachments, provider, native_id, workspace, endpoint, conductor_id, repo_key, generation, state, created_at, updated_at)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, packet.target.guildId, source.channelId, source.channelId, '901', content, '[]', binding.provider, binding.nativeId,
      binding.workspace, binding.endpoint, binding.conductorId, binding.repoKey, binding.generation, MESSAGE_STATES.ACCEPTED, timestamp, timestamp
    );
    f.state.receipt(id, 'agent-message', { packet, authorId: '901' });
    f.state.receipt(id, 'accepted', { channelId: source.channelId, conductorId: binding.conductorId, generation: binding.generation, readiness: 'ready' });
  } else {
    assert.equal(f.state.acceptDiscordMessage({ id, guildId: '100', channelId: requestTarget.channelId, authorId: '901', isBot: true,
      content }, { agentToken: token }).accepted, true);
  }
  if (!legacy) assert.equal(f.state.getAgentMessage(id).routingVersion, AGENT_ROUTING_VERSION);
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

test('public agent-send recovers signed v1 custody before new-address validation', async t => {
  const f = fixture(t);
  enroll(f);
  const original = legacyPost(f, 'not_sent');
  const targetFile = path.join(f.dir, 'legacy-target.json');
  const legacyTarget = { address: target,
    proof: crypto.createHmac('sha256', crypto.createHmac('sha256', token).update('discord-tether/agent-message/v1').digest())
      .update(`address/v1\0${JSON.stringify(target)}`).digest('base64url') };
  fs.writeFileSync(targetFile, JSON.stringify(legacyTarget));
  const args = { db: f.db, 'state-dir': f.dir, provider: source.provider, 'channel-id': source.channelId,
    'native-id': source.nativeId, generation: '1', 'agent-thread-id': '103', 'target-file': targetFile,
    'text-file': f.textFile, 'dedupe-key': original.id };
  let posts = 0;
  const result = await agentSend(args, { print() {}, fetchImpl: async (_url, options) => {
    if (options.method === 'GET') return { ok: true, status: 200, json: async () => ({ id: target.channelId, guild_id: target.guildId }) };
    posts++;
    const sent = decodeAgentMessage(JSON.parse(options.body).content, token, target);
    assert.deepEqual(sent, { ...original, source: { ...source, channelId: '103' } });
    return { ok: true, status: 200, json: async () => ({ id: 'legacy-cli-sent' }) };
  } });
  assert.equal(result.status, 'sent');
  assert.equal(posts, 1);
  const repeat = await agentSend(args, { print() {}, fetchImpl: async () => { throw new Error('terminal custody must not send again'); } });
  assert.deepEqual(repeat.messageIds, ['legacy-cli-sent']);
  await assert.rejects(agentSend({ ...args, 'dedupe-key': 'new-request' }, { print() {},
    fetchImpl: async () => { throw new Error('new v1 request must not reach network'); } }), /invalid agent target|proof|routing/i);
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

test('attemptless legacy preflight custody migrates after child enrollment', async t => {
  const f = fixture(t);
  const packet = legacyPost(f, 'not_sent', { id: 'legacy-preflight-only', kind: KINDS.REQUEST, source, target,
    replyTo: null, text: fs.readFileSync(f.textFile, 'utf8') });
  const attempt = f.state.directPostRows(packet.id).find(row => row.kind === 'direct-post-attempt').detail;
  f.state.db.prepare("DELETE FROM receipts WHERE discord_id IS NULL AND kind IN ('direct-post-attempt', 'direct-post-outcome') AND json_extract(detail, '$.requestId')=?")
    .run(packet.id);
  f.state.recordDirectPostPreflight(attempt, 'not_sent', { reason: 'legacy preflight only' });
  enroll(f);
  const result = await runDirectPost(input(f, { dedupeKey: packet.id, fetchImpl: async (_url, options) => {
    if (options.method === 'GET') return { ok: true, status: 200, json: async () => ({ id: target.channelId, guild_id: target.guildId }) };
    return { ok: true, status: 200, json: async () => ({ id: 'legacy-preflight-migrated' }) };
  } }));
  assert.equal(result.status, 'sent');
  assert.equal(f.state.directPostRows(packet.id).some(row => row.kind === 'direct-post-attempt' &&
    row.detail.legacyAgentPacket && row.detail.agentPacket?.source.channelId === '103'), true);
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
  const result = await runDirectPost(input(f, { dedupeKey: packet.id, agentThreadId: '103',
    agentTarget: legacyTarget, fetchImpl: async (_url, options) => {
      if (options.method === 'GET') return { ok: true, status: 200, json: async () => ({ id: target.channelId, guild_id: target.guildId }) };
      posted = decodeAgentMessage(JSON.parse(options.body).content, token, target);
      return { ok: true, status: 200, json: async () => ({ id: 'legacy-child-retry' }) };
    } }));
  assert.equal(result.status, 'sent');
  assert.deepEqual(posted, packet);
});

test('pre-upgrade child-sourced retry requires an explicit enrolled child', async t => {
  const f = fixture(t);
  enroll(f);
  const child = { ...source, channelId: '103' };
  const packet = legacyPost(f, 'not_sent', { id: 'legacy-child-requires-route', kind: KINDS.REQUEST, source: child, target,
    replyTo: null, text: fs.readFileSync(f.textFile, 'utf8') });
  await assert.rejects(runDirectPost(input(f, { dedupeKey: packet.id, agentThreadId: null,
    agentTarget: issueAgentAddress(target, token), fetchImpl: async () => { throw new Error('child retry must not send'); } })), /require --agent-thread-id/);
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

test('attempt-backed terminal custody outranks a later preflight', async t => {
  for (const outcome of ['sent', 'unknown']) {
    await t.test(outcome, async t => {
      const f = fixture(t);
      const packet = legacyPost(f, outcome);
      legacyPreflight(f, packet.id, 'rate_limited');
      enroll(f);
      const result = await runDirectPost(input(f, { fetchImpl: async () => {
        throw new Error('terminal custody must not resend');
      } }));
      assert.equal(result.status, outcome);
      if (outcome === 'sent') assert.equal(result.duplicate, true);
    });
  }
});

test('overlapping legacy retries honor a newer attemptless preflight inside the claim', async t => {
  const f = fixture(t);
  legacyPost(f, 'not_sent');
  enroll(f);
  let releaseFirst;
  let releaseSecond;
  const firstGate = new Promise(resolve => { releaseFirst = resolve; });
  const secondGate = new Promise(resolve => { releaseSecond = resolve; });
  let lookups = 0;
  let posts = 0;
  const fetchImpl = async (_url, options) => {
    if (options.method === 'POST') {
      posts += 1;
      throw new Error('legacy retry must not post after a preflight outcome');
    }
    lookups += 1;
    if (lookups === 1) {
      await firstGate;
      return { ok: false, status: 429, json: async () => ({}) };
    }
    await secondGate;
    return { ok: true, status: 200, json: async () => ({ id: target.channelId, guild_id: target.guildId }) };
  };
  const first = runDirectPost(input(f, { fetchImpl }));
  while (lookups < 1) await new Promise(resolve => setTimeout(resolve, 1));
  const second = runDirectPost(input(f, { fetchImpl }));
  while (lookups < 2) await new Promise(resolve => setTimeout(resolve, 1));
  releaseFirst();
  const firstResult = await first;
  assert.equal(firstResult.parts[0].status, 'rate_limited');
  releaseSecond();
  const secondResult = await second;
  assert.equal(secondResult.parts[0].status, 'rate_limited');
  assert.equal(posts, 0);
  assert.equal(f.state.directPostRows('legacy-post').filter(row => row.kind === 'direct-post-attempt').length, 1);
});

test('legacy parent requests complete from a received child result without local send custody', async t => {
  const f = fixture(t);
  const request = acceptRequest(f, '8111', true, source, 'shared-request-key');
  enroll(f);
  assert.equal(f.state.claimDispatch('8111').claimed, true);
  f.state.markSubmitted('8111');
  recordNativeAcknowledgment(f.state, { provider: 'codex', messageId: '8111', nativeId: source.nativeId, generation: 1 });
  const receivedPacket = { id: 'received-child-result', kind: KINDS.RESULT, source: { ...source, channelId: '103' }, target,
    replyTo: request.id, text: fs.readFileSync(f.textFile, 'utf8') };
  acceptRequest(f, 'received-child-result-discord', false, { ...source, channelId: '103' });
  f.state.db.prepare("UPDATE receipts SET detail=? WHERE discord_id=? AND kind='agent-message'")
    .run(JSON.stringify({ packet: receivedPacket }), 'received-child-result-discord');
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
  assert.equal(completed.evidence.discordId, 'received-child-result-discord');
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
  acceptRequest(f, 'received-before-cutoff-discord', false, { ...source, channelId: '103' });
  f.state.db.prepare("UPDATE receipts SET detail=? WHERE discord_id=? AND kind='agent-message'")
    .run(JSON.stringify({ packet: receivedPacket }), 'received-before-cutoff-discord');
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
  f.state.enrollThread({ threadId: '103', parentChannelId: '101', guildId: '100' }, f.binding);
  assert.equal(f.state.claimDispatch('8114').claimed, true);
  f.state.markSubmitted('8114');
  recordNativeAcknowledgment(f.state, { provider: 'codex', messageId: '8114', nativeId: source.nativeId, generation: 1 });
  const receivedPacket = { id: 'received-before-ready', kind: KINDS.RESULT, source: { ...source, channelId: '103' }, target,
    replyTo: request.id, text: fs.readFileSync(f.textFile, 'utf8') };
  acceptRequest(f, 'received-before-ready-discord', false, { ...source, channelId: '103' });
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

test('legacy parent requests reject held child results until their message is submitted', async t => {
  const f = fixture(t);
  const request = acceptRequest(f, '8116', true);
  enroll(f);
  assert.equal(f.state.claimDispatch('8116').claimed, true);
  f.state.markSubmitted('8116');
  recordNativeAcknowledgment(f.state, { provider: 'codex', messageId: '8116', nativeId: source.nativeId, generation: 1 });
  const childResult = { id: 'held-child-result', kind: KINDS.RESULT, source: { ...source, channelId: '103' }, target,
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
      acceptRequest(f, `received-during-${scenarioKey}-discord`, false, { ...source, channelId: '103' });
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
    replyTo: request.id, routingVersion: AGENT_ROUTING_VERSION, text: 'Completed task.' };
  receiver.state.receipt(null, 'direct-post-outcome', { outcome: 'sent', agentPacket: request });
  sender.state.receipt(null, 'direct-post-outcome', { outcome: 'sent', agentPacket: packet });
  const ingest = (value, id) => receiver.state.acceptDiscordMessage({ id, guildId: '100', channelId: '101',
    authorId: '901', isBot: true, content: encodeAgentMessage(value, token) }, { agentToken: token });
  for (const [suffix, value] of [
    ['correlation', { ...packet, replyTo: 'unknown-request' }],
    ['parent-source', { ...packet, source: target }],
    ['owner', { ...packet, source: { ...packet.source, nativeId: source.nativeId } }],
    ['generation', { ...packet, source: { ...packet.source, generation: 2 } }]
  ]) assert.equal(ingest(value, suffix).accepted, false);
  const legacyWire = { ...packet };
  delete legacyWire.routingVersion;
  assert.equal(ingest(legacyWire, 'legacy-wire').accepted, false);
  receiver.state.receipt(null, 'direct-post-outcome', { outcome: 'sent', routingVersion: 2,
    agentPacket: { ...request, id: 'new-request', routingVersion: 2 } });
  assert.equal(ingest({ ...packet, replyTo: 'new-request' }, 'new-request-result').accepted, false);
  receiver.state.receipt(null, 'direct-post-outcome', { outcome: 'unknown', phase: 'preflight',
    agentPacket: { ...request, id: 'never-posted' } });
  assert.equal(ingest({ ...packet, replyTo: 'never-posted' }, 'preflight-result').accepted, false);
  const accepted = ingest(packet, 'legacy-parent-result-discord');
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
  assert.equal(f.state.claimDispatch('8113').claimed, true);
  f.state.markSubmitted('8113');
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
  acceptRequest(f, 'received-sibling-child-result-discord', false, childA);
  f.state.db.prepare("UPDATE receipts SET detail=? WHERE discord_id=? AND kind='agent-message'")
    .run(JSON.stringify({ packet: receivedPacket }), 'received-sibling-child-result-discord');
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
    const receiver = fixture(t);
    receiver.state.bind({ ...target, workspace: receiver.dir, endpoint: '/tmp/legacy-result-fixture.sock', conductorId: 'receiver', repoKey: 'receiver' });
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
