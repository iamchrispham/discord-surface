const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { ChannelType } = require('discord.js');
const { attachOrdinaryListener } = require('../src/cli');
const { ClaudeChannel } = require('../src/claude-channel');
const { DiscordGateway } = require('../src/discord');
const { READINESS, THREAD_STATES } = require('../src/state');
const { CLAUDE, OTHER, fixture, transcript } = require('./ordinary-claude-scenarios/fixture.cjs');

function historyMessage(id, channelId, content) {
  return {
    id,
    guildId: 'guild',
    channelId,
    author: { id: 'operator', bot: false },
    content,
    attachments: []
  };
}

test(
  'ordinary Claude handoff retries endpoint recovery and backfills parent and child history without changing old cursors',
  { timeout: 45000 },
  async t => {
  const f = fixture(t);
  const channelId = f.binding.channelId;
  const childId = '123456789012345679';
  const oldBinding = f.state.getBinding(channelId);
  f.state.setIntakeCutoff(channelId, 'guild', '100', 'existing parent coverage', oldBinding);
  f.state.markIntakeBoundary(channelId, READINESS.READY, 'existing parent coverage ready', null, null, oldBinding);
  f.state.enrollThread({ threadId: childId, parentChannelId: channelId, guildId: 'guild', adoptionCutoff: '200' }, oldBinding);
  f.state.setThreadBaseline(childId, '200', oldBinding);
  f.state.markThreadBoundary(childId, THREAD_STATES.READY, 'existing child coverage ready', null, null, oldBinding);
  f.state.markThreadBoundary(childId, THREAD_STATES.GAP, 'child history requires reconciliation', '201', '202', oldBinding);
  const parentCursorBefore = f.state.getIntakeWatermark(channelId).recovered_through_id;
  const childBefore = f.state.getThreadEnrollment(childId);
  assert.equal(parentCursorBefore, '100');
  assert.equal(childBefore.recoveredThroughId, '200');

  const successorTranscript = transcript(t, f.dir, OTHER);
  const successorEndpoint = path.join(f.dir, 'next.sock');
  const handoff = f.state.handoffOrdinary({
    channelId,
    provider: 'claude',
    fromNativeId: CLAUDE,
    fromGeneration: oldBinding.generation,
    nativeId: OTHER,
    workspace: f.dir,
    endpoint: successorEndpoint,
    handoffId: 'ordinary-claude-history-recovery',
    identity: { sessionId: OTHER, threadId: OTHER, harness: 'claude-code' },
    nativeProof: {
      file: successorTranscript.file,
      sessionId: OTHER,
      threadId: OTHER,
      workspace: f.dir,
      endpoint: successorEndpoint,
      harness: 'claude-code'
    }
  });
  assert.equal(handoff.generation, oldBinding.generation + 1);
  assert.equal(handoff.readiness, READINESS.PENDING);
  assert.equal(f.state.getIntakeWatermark(channelId).recovered_through_id, parentCursorBefore);
  assert.deepEqual(f.state.getThreadEnrollment(childId), childBefore);

  const parentChannel = {
    id: channelId,
    guildId: 'guild',
    permissionsFor: () => ({ has: () => true })
  };
  const childChannel = {
    id: childId,
    guildId: 'guild',
    parentId: channelId,
    type: ChannelType.PublicThread,
    isThread: () => true,
    permissionsFor: () => ({ has: () => true })
  };
  const history = new Map([
    [channelId, [
      historyMessage('101', channelId, 'parent history 101'),
      historyMessage('102', channelId, 'parent history 102')
    ]],
    [childId, [
      historyMessage('201', childId, 'child history 201'),
      historyMessage('202', childId, 'child history 202')
    ]]
  ]);
  const historyReads = [];
  const gateway = new DiscordGateway({
    state: f.state,
    client: {
      user: { id: 'bot' },
      channels: { fetch: async id => id === channelId ? parentChannel : id === childId ? childChannel : null },
      on() {},
      off() {},
      async destroy() {}
    },
    providers: { claude: { async dispatch() { throw new Error('recovery must not dispatch before reconciliation'); } } },
    fetchHistory: async (channel, options) => {
      historyReads.push({ channelId: channel.id, after: options.after || null });
      return (history.get(channel.id) || []).filter(message => !options.after || BigInt(message.id) > BigInt(options.after));
    },
    recoveryOptions: { pageLimit: 10, maxPages: 5, maxMessages: 20, timeoutMs: 30000 }
  });
  t.after(async () => {
    await gateway.stop();
  });

  const oldGenerationIntake = await gateway.consumer.intakeMessage(
    historyMessage('99', channelId, 'must not be accepted by the old generation'),
    true,
    '99',
    oldBinding,
    false,
    null,
    undefined,
    true
  );
  assert.equal(oldGenerationIntake.stale, true);
  assert.equal(f.state.getMessage('99'), null);

  const failedPreflight = await gateway.recoverTransport('ordinary-handoff', gateway.lifecycleEpoch, [channelId]);
  assert.equal(failedPreflight.ready, false);
  assert.equal(f.state.getBinding(channelId).readiness, READINESS.UNAVAILABLE);
  const unavailable = f.state.getIntakeWatermark(channelId);
  assert.match(unavailable.detail, /^Claude endpoint unavailable before event write: /);
  assert.equal(unavailable.recovered_through_id, parentCursorBefore);
  assert.equal(f.state.getThreadEnrollment(childId).state, THREAD_STATES.GAP);
  assert.deepEqual(historyReads, []);

  const successorChannel = new ClaudeChannel({
    state: f.state,
    nativeId: OTHER,
    socketPath: successorEndpoint,
    mcp: { async notification() {}, async close() {} }
  });
  t.after(async () => {
    try { await successorChannel.stop(); } catch {}
  });
  await successorChannel.start();

  let attachRecovery;
  const wake = attachOrdinaryListener({
    state: f.state,
    paths: { stateDir: f.dir, db: f.db },
    startupBinding: f.state.getBinding(channelId),
    identity: successorChannel.bindingIdentity,
    label: 'Claude channel',
    requestRecovery: () => {
      attachRecovery = gateway.recoverTransport('ordinary-handoff', gateway.lifecycleEpoch, [channelId]);
      return { requested: true };
    },
    stderr: { write() {} }
  });
  assert.equal(wake.requested, true);
  assert.ok(attachRecovery);
  const parentRecovery = await attachRecovery;
  assert.equal(parentRecovery.ready, false);
  assert.equal(f.state.getBinding(channelId).readiness, READINESS.READY);
  assert.equal(f.state.getIntakeWatermark(channelId).recovered_through_id, '102');
  assert.equal(f.state.getThreadEnrollment(childId).state, THREAD_STATES.GAP);
  assert.equal(f.state.getThreadEnrollment(childId).recoveredThroughId, childBefore.recoveredThroughId);
  assert.deepEqual(historyReads, [{ channelId, after: '100' }]);

  for (const id of ['101', '102']) {
    const recovered = f.state.getMessage(id);
    assert.equal(recovered.state, 'accepted');
    assert.equal(recovered.provider, 'claude');
    assert.equal(recovered.nativeId, OTHER);
    assert.equal(recovered.generation, handoff.generation);
    assert.equal(f.state.currentMessageBinding(recovered).current, true);
  }

  const reconciledChild = f.state.reconcileIntake(childId, f.state.getBinding(channelId));
  assert.equal(reconciledChild.state, THREAD_STATES.PENDING);
  assert.equal(reconciledChild.recoveredThroughId, childBefore.recoveredThroughId);
  assert.equal(reconciledChild.lastSeenId, childBefore.lastSeenId);
  assert.equal(reconciledChild.lastAcceptedId, childBefore.lastAcceptedId);

  const childRecovery = await gateway.recoverTransport('ordinary-handoff', gateway.lifecycleEpoch, [childId]);
  assert.equal(childRecovery.ready, true);
  assert.equal(f.state.getThreadEnrollment(childId).state, THREAD_STATES.READY);
  assert.equal(f.state.getThreadEnrollment(childId).recoveredThroughId, '202');
  assert.deepEqual(historyReads, [
    { channelId, after: '100' },
    { channelId: childId, after: '200' }
  ]);
  for (const id of ['201', '202']) {
    const recovered = f.state.getMessage(id);
    assert.equal(recovered.state, 'accepted');
    assert.equal(recovered.provider, 'claude');
    assert.equal(recovered.nativeId, OTHER);
    assert.equal(recovered.generation, handoff.generation);
    assert.equal(f.state.currentMessageBinding(recovered).current, true);
  }
  }
);
