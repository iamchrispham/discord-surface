'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { fixture, service, addRecipient } = require('./fixtures/peer-fixture');
const { inspectPeerResult } = require('../src/peer/result');
const { encodeAgentMessage, KINDS } = require('../src/agent-message');
const { createDirectPostHandlers } = require('../dist/state/direct-post');

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

test('peer result ignores packetless ordinary attempts after agent preflight', () => {
  const source = { guildId: '100', channelId: '101', provider: 'claude', nativeId: '11111111-1111-1111-1111-111111111111', generation: 1 };
  const target = { guildId: '100', channelId: '202', provider: 'codex', nativeId: '22222222-2222-2222-2222-222222222222', generation: 1 };
  const packet = { id: 'packetless-mix', kind: 'request', source, target, replyTo: null, routingVersion: 2, text: 'hello' };
  const base = { requestId: packet.id, guildId: source.guildId, channelId: source.channelId, provider: source.provider,
    nativeId: source.nativeId, generation: source.generation, partIndex: 0, partCount: 1 };
  const rows = [
    { id: 1, kind: 'direct-post-outcome', detail: { ...base, agentPacket: packet, attemptId: 'agent-attempt', outcome: 'rejected', phase: 'preflight' } },
    { id: 2, kind: 'direct-post-attempt', detail: { ...base, attemptId: 'ordinary-attempt' } },
    { id: 3, kind: 'direct-post-outcome', detail: { ...base, attemptId: 'ordinary-attempt', outcome: 'sent', phase: 'final' } }
  ];
  const state = { directPostRows: () => rows, listAgentMessageReceiptIds: () => [], getAgentMessage: () => null,
    getMessage: () => null, listAgentCompletionReceipts: () => [], hasNativeAcknowledgment: () => false };
  assert.equal(inspectPeerResult(state, source, packet.id).sendOutcome, 'rejected');
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

test('peer result preserves a legacy child result after the parent target hands off', () => {
  const source = { guildId: '100', channelId: '101', provider: 'claude', nativeId: '11111111-1111-1111-1111-111111111111', generation: 1 };
  const parent = { guildId: '100', channelId: '201', provider: 'codex', nativeId: '22222222-2222-2222-2222-222222222222', generation: 1 };
  const child = { ...parent, channelId: '202' };
  const packet = { id: 'legacy-request', kind: 'request', source, target: parent, replyTo: null, text: 'request' };
  const candidate = { id: 'legacy-child-result', kind: 'result', source: child, target: source, replyTo: packet.id, text: 'accepted result' };
  const detail = { journal: 'direct-post-v1', requestId: 'correlation', guildId: source.guildId, channelId: source.channelId,
    provider: source.provider, nativeId: source.nativeId, generation: source.generation, agentPacket: packet, legacyAgentPacket: packet };
  const state = {
    directPostRows: () => [{ id: 1, kind: 'direct-post-attempt', detail }],
    listAgentMessageReceiptIds: () => ['discord-result'],
    getAgentMessage: () => ({ packet: candidate }),
    getMessage: () => ({ ...candidate.target, state: 'accepted' }),
    listAgentCompletionReceipts: () => [],
    hasNativeAcknowledgment: () => false,
    getMessageRoute: () => ({ binding: { ...parent, generation: 2 }, enrollment: null, ready: true })
  };
  assert.deepEqual(inspectPeerResult(state, source, detail.requestId).results, [{
    messageId: 'discord-result',
    state: 'accepted',
    nativeAcknowledged: false,
    completed: false,
    completionReceiptId: null,
    packetId: candidate.id,
    text: candidate.text
  }]);
});

test('peer result preserves an unmarked legacy child result before and after a parent handoff', async t => {
  const f = fixture(t);
  f.enroll('102');
  const target = addRecipient(f);
  const caller = f.state.getBinding('101');
  const request = {
    id: 'unmarked-legacy-request', kind: KINDS.REQUEST,
    source: { guildId: '100', channelId: '102', provider: 'claude', nativeId: caller.nativeId, generation: caller.generation },
    target: { guildId: '100', channelId: '201', provider: 'codex', nativeId: target.nativeId, generation: target.generation },
    replyTo: null, text: 'request without a promotion marker'
  };
  const detail = {
    journal: 'direct-post-v1', requestId: request.id, guildId: caller.guildId, channelId: caller.channelId,
    provider: caller.provider, nativeId: caller.nativeId, generation: caller.generation,
    partIndex: 0, partCount: 1, attemptId: 'unmarked-legacy-attempt', agentPacket: request
  };
  f.state.receipt(null, 'direct-post-attempt', detail);
  f.state.receipt(null, 'direct-post-outcome', { ...detail, outcome: 'sent', messageId: 'request-message' });

  const result = {
    id: 'unmarked-legacy-result', kind: KINDS.RESULT,
    source: { guildId: target.guildId, channelId: '202', provider: target.provider,
      nativeId: target.nativeId, generation: target.generation }, target: request.source,
    replyTo: request.id, routingVersion: 2, sourceParentChannelId: target.channelId, text: 'accepted result'
  };
  const accepted = f.state.acceptDiscordMessage({ id: '10002', guildId: '100', channelId: '102',
    authorId: '901', isBot: true, content: encodeAgentMessage(result, 'fixture') }, { agentToken: 'fixture' });
  assert.equal(accepted.accepted, true, JSON.stringify(accepted));

  const peer = service(f);
  const beforeHandoff = await peer.result(request.id);
  assert.equal(beforeHandoff.results.length, 1);
  assert.equal(beforeHandoff.results[0].text, result.text);

  f.state.db.prepare("UPDATE bindings SET generation=generation+1 WHERE channel_id='201'").run();
  const afterHandoff = await peer.result(request.id);
  assert.deepEqual(afterHandoff.results, beforeHandoff.results);
});

test('newest promoted packet recognizes the enrolled return route', () => {
  const source = { guildId: '100', channelId: '102', provider: 'claude', nativeId: '11111111-1111-1111-1111-111111111111', generation: 1 };
  const target = { guildId: '100', channelId: '202', provider: 'codex', nativeId: '22222222-2222-2222-2222-222222222222', generation: 1 };
  function packet(from) { return { id: 'reused-request', kind: 'request', source: from, target, replyTo: null, text: 'inspect' }; }
  const oldSource = { ...source, channelId: '101' };
  const legacy = packet(oldSource);
  const promoted = { ...packet(source), routingVersion: 2, sourceParentChannelId: '101' };
  const base = { requestId: legacy.id, ...oldSource };
  const rows = [
    { id: 1, kind: 'direct-post-attempt', detail: { ...base, agentPacket: legacy, attemptId: 'a' } },
    { id: 2, kind: 'direct-post-outcome', detail: { ...base, agentPacket: promoted, legacyAgentPacket: legacy, attemptId: 'a', outcome: 'sent' } }
  ];
  const candidate = { id: 'result-promoted', kind: 'result', source: target, target: source, replyTo: legacy.id, text: 'answer', routingVersion: 2 };
  const state = {
    directPostRows: () => rows,
    listAgentMessageReceiptIds: () => ['receipt'],
    getAgentMessage: () => ({ packet: candidate }),
    getMessage: () => ({ ...source, state: 'accepted' }),
    listAgentCompletionReceipts: () => [],
    hasNativeAcknowledgment: () => false,
    getMessageRoute: () => ({ enrollment: { threadId: '202' } })
  };
  const result = inspectPeerResult(state, source, legacy.id);
  assert.equal(result.sendOutcome, 'sent');
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].packetId, candidate.id);
});

test('retirement cannot merge a foreign caller failure into pending custody', () => {
  const source = { guildId: '100', channelId: '102', provider: 'claude', nativeId: '11111111-1111-1111-1111-111111111111', generation: 1 };
  function packet(from) { return { id: 'reused-request', kind: 'request', source: from, target: { guildId: '100', channelId: '202', provider: 'codex', nativeId: '22222222-2222-2222-2222-222222222222', generation: 1 }, replyTo: null, text: 'inspect' }; }
  const other = { ...source, channelId: '302', nativeId: '33333333-3333-3333-3333-333333333333' };
  const first = { requestId: 'reused-request', ...source, agentPacket: packet(source), attemptId: 'a', partIndex: 0, partCount: 1 };
  const second = { requestId: 'reused-request', ...other, agentPacket: packet(other), attemptId: 'b', partIndex: 0, partCount: 1 };
  const rows = [
    { id: 1, kind: 'direct-post-attempt', detail: first },
    { id: 2, kind: 'direct-post-attempt', detail: second },
    { id: 3, kind: 'direct-post-outcome', detail: { ...second, outcome: 'rate_limited' } }
  ];
  const state = { directPostRows: () => rows, listThreadEnrollments: () => [{ threadId: '202' }] };
  const handlers = createDirectPostHandlers({ DIRECT_POST_ATTEMPT: 'direct-post-attempt', DIRECT_POST_OUTCOME: 'direct-post-outcome' });
  assert.equal(handlers.hasUnresolvedBindingPost(state, '201'), true);
  rows.push({ id: 4, kind: 'direct-post-outcome', detail: { ...first, outcome: 'sent' } });
  assert.equal(handlers.hasUnresolvedBindingPost(state, '201'), false);
});
