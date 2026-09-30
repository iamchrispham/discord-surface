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

test('legacy parent request holds without one ready child and freezes the selected route', t => {
  const f = fixture(t);
  acceptRequest(f, 'legacy-route', true);
  assert.equal(f.state.claimDispatch('legacy-route').reason, 'legacy-agent-route-not-unique');
  assert.equal(f.state.getMessage('legacy-route').state, MESSAGE_STATES.ACCEPTED);
  enroll(f, '103');
  const claimed = f.state.claimDispatch('legacy-route');
  assert.equal(claimed.claimed, true);
  assert.equal(claimed.message.agentRoute, '103');
  const completion = ['node', 'cli.js', 'agent-complete', '--state-dir', f.dir, '--db', f.db];
  const firstPrompt = codexPrompt(claimed.message, null, completion);
  assert.match(firstPrompt, /--agent-thread-id/);
  assert.match(firstPrompt, /103/);
  const firstClaude = claudeEvent(claimed.message, completion);
  assert.match(firstClaude.content, /--agent-thread-id/);
  enroll(f, '104');
  assert.equal(f.state.getMessage('legacy-route').agentRoute, '103');
  assert.equal(codexPrompt(f.state.getMessage('legacy-route'), null, completion), firstPrompt);
  assert.deepEqual(claudeEvent(f.state.getMessage('legacy-route'), completion), firstClaude);
});

test('legacy parent route stays held when children are ambiguous or its frozen child is lost', t => {
  const f = fixture(t);
  acceptRequest(f, 'legacy-ambiguous', true);
  enroll(f, '103');
  enroll(f, '104');
  assert.equal(f.state.claimDispatch('legacy-ambiguous').reason, 'legacy-agent-route-not-unique');
  f.state.markThreadBoundary('104', THREAD_STATES.UNAVAILABLE, 'fixture unavailable', null, null, f.binding);
  assert.equal(f.state.claimDispatch('legacy-ambiguous').claimed, true);
  f.state.markNotSubmitted('legacy-ambiguous', new Error('native unavailable'));
  f.state.markThreadBoundary('103', THREAD_STATES.UNAVAILABLE, 'fixture unavailable', null, null, f.binding);
  f.state.markThreadBoundary('104', THREAD_STATES.READY, 'fixture ready again', null, null, f.binding);
  assert.equal(f.state.claimDispatch('legacy-ambiguous').reason, 'legacy-agent-route-not-ready');
  assert.equal(f.state.getMessage('legacy-ambiguous').agentRoute, '103');
  assert.equal(f.state.getMessage('legacy-ambiguous').state, MESSAGE_STATES.ACCEPTED);
});

test('legacy parent reconciliation wakes when a child becomes ready', () => {
  assert.equal(legacyParentReconciliationChannel(
    { state: THREAD_STATES.PENDING },
    { state: THREAD_STATES.READY, parentChannelId: '101', threadId: '103' }
  ), '101');
  assert.equal(legacyParentReconciliationChannel(
    { state: THREAD_STATES.READY },
    { state: THREAD_STATES.UNAVAILABLE, parentChannelId: '101', threadId: '103' }
  ), '101');
  assert.equal(legacyParentReconciliationChannel(
    { state: THREAD_STATES.PENDING },
    { state: THREAD_STATES.PENDING, parentChannelId: '101', threadId: '103' }
  ), null);
});

test('frozen legacy parent rejects a parent-sourced result identity', t => {
  const f = fixture(t);
  enroll(f);
  const request = acceptRequest(f, 'legacy-parent-source', true);
  assert.equal(f.state.claimDispatch('legacy-parent-source').claimed, true);
  assert.throws(() => resolveAgentReplyRequestMatch(f.state, request.id, source, null, source, Error, true, true),
    /frozen child route/);
});

test('stamped frozen parent rejects a parent-sourced result identity', t => {
  const f = fixture(t);
  enroll(f);
  const request = acceptRequest(f, 'stamped-parent-source', true, source);
  f.state.db.prepare("UPDATE receipts SET detail=json_set(detail, '$.routingVersion', ?) WHERE discord_id=? AND kind='agent-message'")
    .run(AGENT_ROUTING_VERSION, 'stamped-parent-source');
  assert.equal(f.state.claimDispatch('stamped-parent-source').claimed, true);
  assert.throws(() => resolveAgentReplyRequestMatch(f.state, request.id, source, null, source, Error, false, true),
    /frozen child route/);
});

test('frozen legacy route rejects a sibling result after enrollment changes', async t => {
  const f = fixture(t);
  enroll(f, '103');
  const request = acceptRequest(f, '8119', true);
  assert.equal(f.state.claimDispatch('8119').claimed, true);
  f.state.markSubmitted('8119');
  recordNativeAcknowledgment(f.state, { provider: 'codex', messageId: '8119', nativeId: source.nativeId, generation: 1 });
  enroll(f, '104');
  const receivedResult = (discordId, childId) => {
    acceptRequest(f, discordId, false, { ...source, channelId: childId });
    const packet = { id: `result-${discordId}`, kind: KINDS.RESULT,
      source: { ...source, channelId: childId }, target, replyTo: request.id, text: 'Result.' };
    f.state.db.prepare("UPDATE receipts SET detail=? WHERE discord_id=? AND kind='agent-message'")
      .run(JSON.stringify({ packet }), discordId);
  };
  const complete = () => agentComplete({ db: f.db, 'state-dir': f.dir, 'message-id': '8119', provider: 'codex',
    'native-id': source.nativeId, generation: '1' }, {
    gatewayProcessStatus: () => ({ state: 'stopped', pid: null }),
    requestGatewayRecovery: () => ({ requested: false }), print: () => {}
  });
  receivedResult('9019', '104');
  assert.throws(complete, /immutable correlated result/);
  let networkCalls = 0;
  await assert.rejects(runDirectPost(input(f, { agentThreadId: '104', dedupeKey: 'sibling-sent',
    agentKind: KINDS.RESULT, agentReplyTo: request.id,
    fetchImpl: async () => { networkCalls++; throw new Error('unexpected network call'); } })), /frozen child route/);
  assert.equal(networkCalls, 0);
  assert.deepEqual(f.state.directPostRows('sibling-sent'), []);
  assert.throws(complete, /immutable correlated result/);
  receivedResult('9020', '103');
  assert.equal(complete().evidence.source.channelId, '103');
});

test('frozen legacy parent rejects an earlier exact child-target request result', t => {
  const f = fixture(t);
  enroll(f, '103');
  const childTarget = { ...source, channelId: '103' };
  const parentRequestId = '8123';
  const packetId = 'reused-before-parent-freeze';
  acceptRequest(f, '9023', false, childTarget, packetId);
  const parentRequest = acceptRequest(f, parentRequestId, true, source, packetId);
  assert.equal(f.state.claimDispatch(parentRequestId).claimed, true);
  f.state.markSubmitted(parentRequestId);
  recordNativeAcknowledgment(f.state, { provider: 'codex', messageId: parentRequestId,
    nativeId: source.nativeId, generation: 1 });
  const receivedPacket = { id: 'earlier-child-result', kind: KINDS.RESULT,
    source: childTarget, target, replyTo: parentRequest.id, text: 'Result from the earlier child request.' };
  acceptRequest(f, '9024', false, childTarget, 'result-envelope');
  f.state.db.prepare("UPDATE receipts SET detail=? WHERE discord_id=? AND kind='agent-message'")
    .run(JSON.stringify({ packet: receivedPacket }), '9024');
  assert.throws(() => agentComplete({ db: f.db, 'state-dir': f.dir, 'message-id': parentRequestId,
    provider: 'codex', 'native-id': source.nativeId, generation: '1' }, {
    gatewayProcessStatus: () => ({ state: 'stopped', pid: null }),
    requestGatewayRecovery: () => ({ requested: false }), print: () => {}
  }), /immutable correlated result/);
  assert.equal(f.state.getMessage(parentRequestId).state, MESSAGE_STATES.SUBMITTED);
});

test('already submitted parent request without a frozen route rejects later child results', async t => {
  const f = fixture(t);
  const request = acceptRequest(f, '8120', true);
  alreadySubmittedLegacyRequest(f, '8120');
  recordNativeAcknowledgment(f.state, { provider: 'codex', messageId: '8120', nativeId: source.nativeId, generation: 1 });
  const completion = ['node', 'cli.js', 'agent-complete', '--state-dir', f.dir, '--db', f.db];
  const materializedPayload = codexPrompt(f.state.getMessage('8120'), null, completion);
  enroll(f, '103');
  enroll(f, '104');
  assert.equal(codexPrompt(f.state.getMessage('8120'), null, completion), materializedPayload);
  assert.equal(f.state.getMessage('8120').agentRoute, null);
  const receivedPacket = { id: 'late-child-result', kind: KINDS.RESULT,
    source: { ...source, channelId: '103' }, target, replyTo: request.id, text: 'Result.' };
  acceptRequest(f, '9021', false, { ...source, channelId: '103' });
  f.state.db.prepare("UPDATE receipts SET detail=? WHERE discord_id=? AND kind='agent-message'")
    .run(JSON.stringify({ packet: receivedPacket }), '9021');
  const complete = () => agentComplete({ db: f.db, 'state-dir': f.dir, 'message-id': '8120', provider: 'codex',
    'native-id': source.nativeId, generation: '1' }, {
    gatewayProcessStatus: () => ({ state: 'stopped', pid: null }),
    requestGatewayRecovery: () => ({ requested: false }), print: () => {}
  });
  assert.throws(complete, /immutable correlated result/);
  let networkCalls = 0;
  await assert.rejects(runDirectPost(input(f, { agentThreadId: '104', dedupeKey: 'late-sent',
    agentKind: KINDS.RESULT, agentReplyTo: request.id,
    fetchImpl: async () => { networkCalls++; throw new Error('unexpected network call'); } })), /frozen child route/);
  assert.equal(networkCalls, 0);
  assert.deepEqual(f.state.directPostRows('late-sent'), []);
  assert.throws(complete, /immutable correlated result/);
  assert.equal(f.state.getMessage('8120').state, MESSAGE_STATES.SUBMITTED);
});

test('already submitted parent request completes from pre-upgrade sent child custody', async t => {
  const f = fixture(t);
  const request = acceptRequest(f, '8121', true);
  alreadySubmittedLegacyRequest(f, '8121');
  recordNativeAcknowledgment(f.state, { provider: 'codex', messageId: '8121', nativeId: source.nativeId, generation: 1 });
  enroll(f, '103');
  const childResult = {
    id: 'pre-upgrade-child-result',
    kind: KINDS.RESULT,
    source: { ...source, channelId: '103' },
    target,
    replyTo: request.id,
    text: 'Saved before route receipts existed.'
  };
  const binding = f.state.getBinding(source.channelId);
  const meta = {
    requestId: childResult.id,
    inReplyTo: request.id,
    attemptId: 'pre-upgrade-child-attempt',
    sourcePath: f.textFile,
    textHash: hash(JSON.stringify(childResult)),
    operatorId: '900',
    partHash: hash(encodeAgentMessage(childResult, token)),
    ...source,
    conductorId: binding.conductorId,
    repoKey: binding.repoKey,
    partIndex: 0,
    partCount: 1,
    nonce: 'pre-upgrade-child-nonce',
    binding,
    deliveryChannelId: target.channelId,
    agentPacket: childResult,
    presentation: 'legacy'
  };
  assert.equal(f.state.beginDirectPostPart(meta).claimed, true);
  f.state.recordDirectPostOutcome(childResult.id, meta.attemptId, 'sent', { messageId: 'pre-upgrade-child-sent' });
  const completed = agentComplete({ db: f.db, 'state-dir': f.dir, 'message-id': '8121', provider: 'codex',
    'native-id': source.nativeId, generation: '1' }, {
    gatewayProcessStatus: () => ({ state: 'stopped', pid: null }),
    requestGatewayRecovery: () => ({ requested: false }), print: () => {}
  });
  assert.equal(completed.completed, true);
  assert.equal(completed.evidence.kind, 'sent-result');
  assert.equal(f.state.getMessage('8121').agentRoute, null);
});

test('route-less parent with stamped provenance keeps immutable sent child custody', async t => {
  const f = fixture(t);
  const request = acceptRequest(f, '8122', true, source);
  f.state.db.prepare("UPDATE receipts SET detail=json_set(detail, '$.routingVersion', ?) WHERE discord_id=? AND kind='agent-message'")
    .run(AGENT_ROUTING_VERSION, '8122');
  alreadySubmittedLegacyRequest(f, '8122');
  recordNativeAcknowledgment(f.state, { provider: 'codex', messageId: '8122', nativeId: source.nativeId, generation: 1 });
  enroll(f, '103');
  const childResult = {
    id: 'stamped-child-result',
    kind: KINDS.RESULT,
    source: { ...source, channelId: '103' },
    target,
    replyTo: request.id,
    text: 'Saved before the route receipt was written.'
  };
  const binding = f.state.getBinding(source.channelId);
  const meta = {
    requestId: childResult.id,
    inReplyTo: request.id,
    attemptId: 'stamped-child-attempt',
    sourcePath: f.textFile,
    textHash: hash(JSON.stringify(childResult)),
    operatorId: '900',
    partHash: hash(encodeAgentMessage(childResult, token)),
    ...source,
    conductorId: binding.conductorId,
    repoKey: binding.repoKey,
    partIndex: 0,
    partCount: 1,
    nonce: 'stamped-child-nonce',
    binding,
    deliveryChannelId: target.channelId,
    agentPacket: childResult,
    presentation: 'legacy'
  };
  assert.equal(f.state.beginDirectPostPart(meta).claimed, true);
  f.state.recordDirectPostOutcome(childResult.id, meta.attemptId, 'sent', { messageId: 'stamped-child-sent' });
  const completed = agentComplete({ db: f.db, 'state-dir': f.dir, 'message-id': '8122', provider: 'codex',
    'native-id': source.nativeId, generation: '1' }, {
    gatewayProcessStatus: () => ({ state: 'stopped', pid: null }),
    requestGatewayRecovery: () => ({ requested: false }), print: () => {}
  });
  assert.equal(completed.completed, true);
  assert.equal(completed.evidence.kind, 'sent-result');
  assert.equal(f.state.getMessage('8122').agentRoute, null);
});
