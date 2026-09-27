'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { fixture, service, addRecipient } = require('./fixtures/peer-fixture');
const { inspectPeerResult } = require('../src/peer/result');

const request = { peer: { conductorId: 'recipient' }, text: 'retry after rate limit', dedupe_key: 'held-retry' };

// Causal reproduction for PR109 F2: the newest admitted attempt owns the readback.
// Previously the passive readback picked the last outcome row, so a retry held in
// flight reported the older rate_limited outcome instead of 'in_flight'.
test('peer result reports in_flight while a retry is unresolved after a rate_limited failure', { timeout: 5000 }, async t => {
  const f = fixture(t);
  f.enroll('102');
  addRecipient(f);
  let release;
  const held = new Promise(resolve => { release = resolve; });
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  let posts = 0;
  const peer = service(f, { fetchImpl: async (url, options) => {
    if (options.method === 'GET') return { ok: true, status: 200, json: async () => ({ id: '202', guild_id: '100' }) };
    posts += 1;
    if (posts === 1) return { ok: false, status: 429, json: async () => ({ retry_after: 1 }) };
    entered();
    await held;
    return { ok: true, status: 200, json: async () => ({ id: '10001' }) };
  } });
  assert.equal((await peer.send(request)).status, 'rate_limited', 'first attempt is rate limited');
  const watchdog = setTimeout(release, 3000);
  const retry = peer.send(request);
  try {
    await started;
    const rows = f.state.directPostRows(request.dedupe_key);
    assert.equal(rows.filter(row => row.kind === 'direct-post-attempt').length, 2, 'retry admitted a second attempt');
    assert.equal(rows.filter(row => row.kind === 'direct-post-outcome').length, 1, 'only the first outcome is resolved');
    const heldReadback = await peer.result(request.dedupe_key);
    assert.equal(heldReadback.sendOutcome, 'in_flight',
      'an unresolved newest attempt must not surface the older rate_limited outcome');
  } finally {
    clearTimeout(watchdog);
    release();
    await retry.catch(() => {});
  }
  assert.equal((await retry).status, 'sent', 'the held retry completes with its real outcome');
  assert.equal((await peer.result(request.dedupe_key)).sendOutcome, 'sent');
  assert.equal(posts, 2);
  const rows = f.state.directPostRows(request.dedupe_key);
  assert.equal(rows.filter(row => row.kind === 'direct-post-attempt').length, 2);
  assert.equal(rows.filter(row => row.kind === 'direct-post-outcome').length, 2);
});

test('peer result surfaces a newer rejected preflight after a rate-limited attempt', async t => {
  const f = fixture(t);
  f.enroll('102');
  addRecipient(f);
  const peer = service(f, { fetchImpl: async (_url, options) => {
    if (options.method === 'GET') return { ok: true, status: 200, json: async () => ({ id: '202', guild_id: '100' }) };
    return { ok: false, status: 429, json: async () => ({ retry_after: 1 }) };
  } });

  assert.equal((await peer.send(request)).status, 'rate_limited');
  const attempt = f.state.directPostRows(request.dedupe_key)
    .find(row => row.kind === 'direct-post-attempt');
  assert.ok(attempt);
  f.state.recordDirectPostPreflight(attempt.detail, 'rejected', { reason: 'destination readiness changed' });

  assert.equal((await peer.result(request.dedupe_key)).sendOutcome, 'rejected');
  assert.equal(inspectPeerResult(f.state,
    { channelId: '101', guildId: '100', provider: 'claude', nativeId: '11111111-1111-1111-1111-111111111111', generation: 1 },
    request.dedupe_key).sendOutcome, 'rejected');
});

test('peer result does not promote an enrolled child target to a legacy parent route', () => {
  const source = { guildId: '100', channelId: '102', provider: 'claude', nativeId: '11111111-1111-1111-1111-111111111111', generation: 1 };
  const sourceParent = { ...source, channelId: '101' };
  const parent = { guildId: '100', channelId: '201', provider: 'codex', nativeId: '22222222-2222-2222-2222-222222222222', generation: 1 };
  const child = { ...parent, channelId: '202' };
  const packet = { id: 'promoted-request', kind: 'request', source, target: child, replyTo: null, routingVersion: 2, text: 'request' };
  const legacyAgentPacket = { id: packet.id, kind: packet.kind, source: sourceParent, target: child, replyTo: null, text: packet.text };
  const candidate = { id: 'legacy-parent-result', kind: 'result', source: parent, target: source, replyTo: packet.id, text: 'wrong route' };
  const detail = { journal: 'direct-post-v1', requestId: 'correlation', guildId: source.guildId, channelId: sourceParent.channelId,
    provider: source.provider, nativeId: source.nativeId, generation: source.generation, agentPacket: packet, legacyAgentPacket };
  const state = {
    directPostRows: () => [{ id: 1, kind: 'direct-post-attempt', detail }],
    listAgentMessageReceiptIds: () => ['discord-result'],
    getAgentMessage: () => ({ packet: candidate }),
    getMessage: () => ({ ...candidate.target, state: 'accepted' }),
    listAgentCompletionReceipts: () => [],
    hasNativeAcknowledgment: () => false,
    getMessageRoute: () => ({ binding: parent, enrollment: { threadId: child.channelId }, ready: true })
  };
  assert.deepEqual(inspectPeerResult(state, source, detail.requestId).results, []);
});
