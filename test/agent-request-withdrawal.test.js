const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { encodeAgentMessage, KINDS } = require('../src/agent-message');
const { SurfaceState, MESSAGE_STATES, READINESS } = require('../src/state');
const { THREAD_STATES } = require('../src/state/thread-enrollment');
const { recordNativeAcknowledgment } = require('../src/acknowledgment');
const { runDirectPost } = require('../src/direct-post');
const { agentWithdraw } = require('../src/cli');

const token = 'withdrawal-fixture-secret';
const requester = { guildId: '100', channelId: '101', provider: 'codex', nativeId: '11111111-1111-1111-1111-111111111111' };
const recipient = { guildId: '100', channelId: '102', provider: 'claude', nativeId: '22222222-2222-2222-2222-222222222222' };

function setup(t, { acknowledge = true, kind = KINDS.REQUEST } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-withdraw-'));
  const state = new SurfaceState(path.join(dir, 'surface.sqlite'));
  t.after(() => {
    state.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  state.setConfig({ operatorId: '900', guildId: '100', secretFile: path.join(dir, 'secret') });
  fs.writeFileSync(path.join(dir, 'secret'), token);
  const sourceBinding = state.bind({ ...requester, workspace: dir, conductorId: 'withdraw-source', repoKey: 'repo:withdraw-source' });
  const targetBinding = state.bind({ ...recipient, workspace: dir, endpoint: '/tmp/agent-withdraw-target.sock',
    conductorId: 'withdraw-target', repoKey: 'repo:withdraw-target' });
  for (const binding of [sourceBinding, targetBinding]) {
    state.setBindingReadiness(binding.channelId, READINESS.READY, 'fixture ready', binding);
  }
  state.enrollThread({ threadId: '103', parentChannelId: requester.channelId, guildId: '100' }, sourceBinding);
  state.markThreadBoundary('103', THREAD_STATES.READY, 'fixture child ready', null, null, sourceBinding);
  state.enrollThread({ threadId: '104', parentChannelId: recipient.channelId, guildId: '100' }, targetBinding);
  state.markThreadBoundary('104', THREAD_STATES.READY, 'fixture child ready', null, null, targetBinding);
  const source = { ...requester, channelId: '103', generation: sourceBinding.generation };
  const target = { ...recipient, channelId: '104', generation: targetBinding.generation };
  const packet = { id: 'withdraw-me', kind, source, target,
    replyTo: kind === KINDS.RESULT ? 'earlier-request' : null, text: 'Old request.' };
  const messageId = '8100';
  assert.equal(state.acceptDiscordMessage({ id: messageId, guildId: '100', channelId: target.channelId,
    authorId: '901', isBot: true, attachments: [], content: encodeAgentMessage(packet, token) },
    { agentToken: token }).accepted, true);
  assert.equal(state.claimDispatch(messageId).claimed, true);
  state.markSubmitted(messageId);
  if (acknowledge) recordNativeAcknowledgment(state, { provider: target.provider, messageId,
    nativeId: target.nativeId, generation: target.generation });
  return { state, packet, messageId, source, target, dir };
}

function withdrawal({ state, messageId, packet, source }) {
  return state.withdrawAgentRequest({ messageId, packetId: packet.id, provider: source.provider,
    nativeId: source.nativeId, generation: source.generation });
}

test('current requester withdraws an acknowledged request without calling it completed', t => {
  const fixture = setup(t);
  const before = fixture.state.listReceipts();
  assert.equal(fixture.state.hasUnresolved(recipient.channelId), true);
  const result = withdrawal(fixture);
  assert.equal(result.withdrawn, true);
  assert.equal(result.duplicate, false);
  assert.equal(result.disposition, 'agent-request-withdrawn');
  assert.equal(fixture.state.getMessage(fixture.messageId).state, MESSAGE_STATES.AGENT_HANDLED_WITHOUT_POST);
  assert.equal(fixture.state.hasUnresolved(recipient.channelId), false);
  assert.deepEqual(fixture.state.getAgentMessage(fixture.messageId).packet, fixture.packet);
  assert.ok(before.some(row => row.kind === 'native-ack' && row.discord_id === fixture.messageId));
  const receipt = fixture.state.listReceipts().at(-1);
  assert.equal(receipt.kind, 'agent-request-withdrawn');
  assert.equal(JSON.parse(receipt.detail).packetId, fixture.packet.id);
  assert.equal(withdrawal(fixture).duplicate, true);
  const reopened = new SurfaceState(fixture.state.dbPath);
  t.after(() => reopened.close());
  assert.equal(withdrawal({ ...fixture, state: reopened }).duplicate, true);
  assert.equal(fixture.state.listReceipts().length, before.length + 1);
});

test('a late result cannot reopen withdrawn request custody', t => {
  const fixture = setup(t);
  withdrawal(fixture);
  const before = fixture.state.listReceipts();
  const result = { id: 'late-result', kind: KINDS.RESULT, source: fixture.target,
    target: fixture.source, replyTo: fixture.packet.id, text: 'Too late.' };
  const intake = fixture.state.acceptDiscordMessage({ id: '8101', guildId: '100',
    channelId: fixture.source.channelId, authorId: '901', isBot: true,
    attachments: [], content: encodeAgentMessage(result, token) }, { agentToken: token });
  assert.equal(intake.accepted, false);
  assert.equal(intake.reason, 'agent-request-withdrawn');
  assert.equal(fixture.state.getMessage('8101'), null);
  assert.equal(fixture.state.listReceipts().filter(row => row.kind === 'agent-message').length,
    before.filter(row => row.kind === 'agent-message').length);
});

test('a late result cannot create an outbound attempt or call Discord', async t => {
  const fixture = setup(t);
  withdrawal(fixture);
  const textFile = path.join(fixture.dir, 'reply.txt');
  fs.writeFileSync(textFile, 'Too late.');
  let networkCalls = 0;
  await assert.rejects(runDirectPost({ state: fixture.state, token,
    nativeId: fixture.target.nativeId, generation: fixture.target.generation,
    channelId: recipient.channelId, provider: recipient.provider,
    agentThreadId: fixture.target.channelId, agentKind: KINDS.RESULT,
    agentTarget: null, agentReplyTo: fixture.packet.id,
    textFile, dedupeKey: 'late-outbound', fetchImpl: async () => {
      networkCalls += 1;
      throw new Error('network must not be called');
    } }), /withdrawn/);
  assert.equal(networkCalls, 0);
  assert.equal(fixture.state.directPostRows('late-outbound').length, 0);
});

test('withdrawal during destination lookup cannot leave result preflight custody', async t => {
  const fixture = setup(t);
  const textFile = path.join(fixture.dir, 'reply.txt');
  fs.writeFileSync(textFile, 'Too late.');
  let calls = 0;
  await assert.rejects(runDirectPost({ state: fixture.state, token,
    nativeId: fixture.target.nativeId, generation: fixture.target.generation,
    channelId: recipient.channelId, provider: recipient.provider,
    agentThreadId: fixture.target.channelId, agentKind: KINDS.RESULT,
    agentTarget: null, agentReplyTo: fixture.packet.id,
    textFile, dedupeKey: 'lookup-race', fetchImpl: async () => {
      calls += 1;
      withdrawal(fixture);
      throw new Error('destination lookup failed');
    } }), /withdrawn/);
  assert.equal(calls, 1);
  assert.equal(fixture.state.directPostRows('lookup-race').length, 0);
  assert.equal(fixture.state.getMessage(fixture.messageId).state, MESSAGE_STATES.AGENT_HANDLED_WITHOUT_POST);
});

test('public withdrawal requires the current requester caller', async t => {
  const fixture = setup(t);
  const args = { 'state-dir': fixture.dir, db: fixture.state.dbPath,
    'message-id': fixture.messageId, 'packet-id': fixture.packet.id,
    provider: fixture.source.provider, 'native-id': fixture.source.nativeId,
    generation: String(fixture.source.generation) };
  const dependencies = { print: () => {}, gatewayProcessStatus: () => ({ state: 'stopped', pid: null }),
    validateCodexSessionIdentity: async nativeId => ({ sessionId: nativeId }) };
  await assert.rejects(agentWithdraw(args, { ...dependencies,
    resolveInvocationIdentity: () => ({ sessionId: '33333333-3333-3333-3333-333333333333',
      threadId: '33333333-3333-3333-3333-333333333333' }) }), /current Codex caller/);
  assert.equal(fixture.state.getMessage(fixture.messageId).state, MESSAGE_STATES.SUBMITTED);
  const result = await agentWithdraw(args, { ...dependencies,
    resolveInvocationIdentity: () => ({ sessionId: fixture.source.nativeId,
      threadId: fixture.source.nativeId }) });
  assert.equal(result.withdrawn, true);
  assert.equal(fixture.state.getMessage(fixture.messageId).state, MESSAGE_STATES.AGENT_HANDLED_WITHOUT_POST);
});

test('withdrawal refuses the wrong requester, packet, generation and kind', t => {
  const fixture = setup(t);
  const original = { messageId: fixture.messageId, packetId: fixture.packet.id,
    provider: fixture.source.provider, nativeId: fixture.source.nativeId,
    generation: fixture.source.generation };
  for (const change of [
    { nativeId: '33333333-3333-3333-3333-333333333333' },
    { generation: fixture.source.generation + 1 },
    { packetId: 'different-packet' },
    { messageId: 'unknown-message' }
  ]) {
    assert.throws(() => fixture.state.withdrawAgentRequest({ ...original, ...change }));
    assert.equal(fixture.state.getMessage(fixture.messageId).state, MESSAGE_STATES.SUBMITTED);
  }
  const result = setup(t, { kind: KINDS.RESULT });
  assert.throws(() => withdrawal(result), /provenance is missing/);
  assert.equal(result.state.getMessage(result.messageId).state, MESSAGE_STATES.SUBMITTED);
  const stale = setup(t);
  const sourceBinding = stale.state.getBinding(requester.channelId);
  stale.state.handoffConductor({ ...sourceBinding,
    fromNativeId: sourceBinding.nativeId, fromGeneration: sourceBinding.generation,
    nativeId: '44444444-4444-4444-4444-444444444444',
    handoffId: 'requester-handoff', intakeCutoff: stale.messageId });
  assert.throws(() => withdrawal(stale), /requester is no longer current/);
  assert.equal(stale.state.getMessage(stale.messageId).state, MESSAGE_STATES.SUBMITTED);
});

test('withdrawal refuses missing acknowledgment and reply or result custody', t => {
  const unacknowledged = setup(t, { acknowledge: false });
  assert.throws(() => withdrawal(unacknowledged), /native acknowledgment/);
  const reply = setup(t);
  reply.state.db.prepare('UPDATE messages SET reply_nonce=? WHERE discord_id=?')
    .run('reply-started', reply.messageId);
  assert.throws(() => withdrawal(reply), /reply or result custody/);
  const result = setup(t);
  const packet = { id: 'result-before-withdrawal', kind: KINDS.RESULT,
    source: result.target, target: result.source, replyTo: result.packet.id, text: 'Done.' };
  assert.equal(result.state.acceptDiscordMessage({ id: '8101', guildId: '100',
    channelId: result.source.channelId, authorId: '901', isBot: true,
    attachments: [], content: encodeAgentMessage(packet, token) }, { agentToken: token }).accepted, true);
  assert.throws(() => withdrawal(result), /reply or result custody/);
  const outbound = setup(t);
  outbound.state.receipt(null, 'direct-post-attempt', { agentPacket: {
    id: 'outbound-attempt', kind: KINDS.RESULT, source: outbound.target,
    target: outbound.source, replyTo: outbound.packet.id, text: 'In flight.'
  } });
  assert.throws(() => withdrawal(outbound), /reply or result custody/);
});

test('completion and withdrawal remain distinct terminal dispositions', t => {
  const withdrawn = setup(t);
  withdrawal(withdrawn);
  assert.throws(() => withdrawn.state.completeAgentHandledWithoutPost({
    messageId: withdrawn.messageId, provider: withdrawn.target.provider,
    nativeId: withdrawn.target.nativeId, generation: withdrawn.target.generation
  }), /already finalized/);
  assert.equal(withdrawn.state.listReceipts().filter(row => row.kind === 'agent-request-withdrawn').length, 1);
  const completed = setup(t);
  const result = { id: 'completed-result', kind: KINDS.RESULT, source: completed.target,
    target: completed.source, replyTo: completed.packet.id, text: 'Done.' };
  assert.equal(completed.state.acceptDiscordMessage({ id: '8101', guildId: '100',
    channelId: completed.source.channelId, authorId: '901', isBot: true,
    attachments: [], content: encodeAgentMessage(result, token) }, { agentToken: token }).accepted, true);
  assert.equal(completed.state.completeAgentHandledWithoutPost({ messageId: completed.messageId,
    provider: completed.target.provider, nativeId: completed.target.nativeId,
    generation: completed.target.generation }).completed, true);
  assert.throws(() => withdrawal(completed), /requires submitted state/);
  assert.equal(completed.state.listReceipts().filter(row => row.kind === 'agent-request-withdrawn').length, 0);
});

test('competing result completion and withdrawal settle in one order', async t => {
  const fixture = setup(t);
  const result = { id: 'racing-result', kind: KINDS.RESULT, source: fixture.target,
    target: fixture.source, replyTo: fixture.packet.id, text: 'Done.' };
  const resultEvent = { id: '8101', guildId: '100', channelId: fixture.source.channelId,
    authorId: '901', isBot: true, attachments: [], content: encodeAgentMessage(result, token) };
  const script = `const { parentPort, workerData } = require('node:worker_threads');
    const { SurfaceState } = require(${JSON.stringify(path.resolve(__dirname, '../src/state'))});
    const deadline = setTimeout(() => process.exit(124), 8000);
    deadline.unref();
    parentPort.once('message', () => {
      const state = new SurfaceState(workerData.db);
      try {
        let result;
        if (workerData.action === 'withdraw') result = state.withdrawAgentRequest(workerData.withdrawal);
        else {
          const intake = state.acceptDiscordMessage(workerData.event, { agentToken: workerData.token });
          result = intake.accepted ? state.completeAgentHandledWithoutPost(workerData.completion) : intake;
        }
        parentPort.postMessage({ action: workerData.action, ok: true, result });
      } catch (error) {
        parentPort.postMessage({ action: workerData.action, ok: false, error: error.message });
      } finally { state.close(); parentPort.close(); }
    });
    parentPort.postMessage({ ready: true });`;
  const data = [
    { action: 'withdraw', db: fixture.state.dbPath,
      withdrawal: { messageId: fixture.messageId, packetId: fixture.packet.id,
        provider: fixture.source.provider, nativeId: fixture.source.nativeId,
        generation: fixture.source.generation } },
    { action: 'complete', db: fixture.state.dbPath, event: resultEvent, token,
      completion: { messageId: fixture.messageId, provider: fixture.target.provider,
        nativeId: fixture.target.nativeId, generation: fixture.target.generation } }
  ];
  const workers = data.map(workerData => new Worker(script, { eval: true, workerData }));
  t.after(() => workers.forEach(worker => worker.terminate()));
  let ready = 0;
  const outcomes = await Promise.all(workers.map(worker => new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error('withdrawal race worker timed out')), 10000);
    worker.on('message', message => {
      if (message.ready) {
        ready += 1;
        if (ready === workers.length) workers.forEach(candidate => candidate.postMessage('go'));
      } else {
        clearTimeout(deadline);
        resolve(message);
      }
    });
    worker.once('error', reject);
    worker.once('exit', code => {
      if (code !== 0) reject(new Error(`withdrawal race worker exited ${code}`));
    });
  })));
  const withdrawalWon = outcomes.some(outcome => outcome.action === 'withdraw' && outcome.ok);
  const completionWon = outcomes.some(outcome => outcome.action === 'complete' && outcome.ok && outcome.result.completed);
  assert.notEqual(withdrawalWon, completionWon);
  assert.equal(fixture.state.getMessage(fixture.messageId).state, MESSAGE_STATES.AGENT_HANDLED_WITHOUT_POST);
  const terminal = fixture.state.listReceipts().filter(row => row.discord_id === fixture.messageId &&
    ['agent-request-withdrawn', 'agent-handled-without-post'].includes(row.kind));
  assert.equal(terminal.length, 1);
  assert.equal(terminal[0].kind, withdrawalWon ? 'agent-request-withdrawn' : 'agent-handled-without-post');
});

test('withdrawal clears only its recipient handoff fence', t => {
  const fixture = setup(t);
  const recipientBefore = fixture.state.getBinding(recipient.channelId);
  const requesterBefore = fixture.state.getBinding(requester.channelId);
  const handoff = { ...recipientBefore, fromNativeId: recipientBefore.nativeId,
    fromGeneration: recipientBefore.generation,
    nativeId: '44444444-4444-4444-4444-444444444444',
    handoffId: 'withdrawal-handoff', intakeCutoff: fixture.messageId };
  assert.throws(() => fixture.state.handoffConductor(handoff), /cannot handoff while work is unresolved/);
  withdrawal(fixture);
  const successor = fixture.state.handoffConductor(handoff);
  assert.equal(successor.nativeId, handoff.nativeId);
  assert.equal(successor.generation, recipientBefore.generation + 1);
  assert.deepEqual(fixture.state.getBinding(requester.channelId), requesterBefore);
  assert.deepEqual(fixture.state.getAgentMessage(fixture.messageId).packet, fixture.packet);
});
