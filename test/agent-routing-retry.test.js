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

test('public legacy retry requires refreshed child proof but preserves terminal recovery', async t => {
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
  const before = f.state.directPostRows(original.id);
  await assert.rejects(agentSend(args, { print() {}, fetchImpl: async () => { posts++; throw new Error('must not send'); } }), /invalid agent target|proof|routing/i);
  assert.equal(posts, 0);
  assert.deepEqual(f.state.directPostRows(original.id), before);
  fs.writeFileSync(targetFile, JSON.stringify(issueAgentAddress(target, token)));
  const result = await agentSend(args, { print() {}, fetchImpl: async (_url, options) => {
    if (options.method === 'GET') return { ok: true, status: 200, json: async () => ({ id: target.channelId, guild_id: target.guildId }) };
    posts++;
    const sent = decodeAgentMessage(JSON.parse(options.body).content, token, target);
    assert.deepEqual(sent, { ...original, source: { ...source, channelId: '103' } });
    return { ok: true, status: 200, json: async () => ({ id: 'legacy-cli-sent' }) };
  } });
  assert.equal(result.status, 'sent');
  assert.equal(posts, 1);
  fs.writeFileSync(targetFile, JSON.stringify(legacyTarget));
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
  let posted;
  const result = await runDirectPost(input(f, { dedupeKey: packet.id, agentThreadId: '103',
    agentTarget: issueAgentAddress(target, token), fetchImpl: async (_url, options) => {
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
