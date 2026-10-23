const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { THREAD_STATES } = require('../src/state/thread-enrollment');
const { StaleGenerationError } = require('../src/state');
const { CLAUDE, OTHER, fixture } = require('./ordinary-claude-scenarios/fixture.cjs');

function handoffInput(f, overrides = {}) {
  const endpoint = path.join(f.dir, 'next.sock');
  return {
    channelId: f.binding.channelId,
    provider: 'claude',
    fromNativeId: CLAUDE,
    fromGeneration: f.binding.generation,
    nativeId: OTHER,
    workspace: f.dir,
    endpoint,
    handoffId: 'ordinary-claude-handoff',
    identity: { sessionId: OTHER, threadId: OTHER, harness: 'claude-code' },
    nativeProof: {
      file: path.join(f.dir, 'successor-session.jsonl'),
      sessionId: OTHER,
      threadId: OTHER,
      workspace: f.dir,
      endpoint,
      harness: 'claude-code'
    },
    ...overrides
  };
}

test('ordinary Claude handoff advances generation without changing parent or child intake cursors and gaps', t => {
  const f = fixture(t);
  const channelId = f.binding.channelId;
  const initial = f.state.getBinding(channelId);
  f.state.setIntakeCutoff(channelId, 'guild', '100', 'existing parent cursor', initial);
  f.state.markIntakeBoundary(channelId, 'gap', 'existing parent gap', '101', '109', f.state.getBinding(channelId));
  const binding = f.state.getBinding(channelId);
  const childId = 'claude-child-thread';
  f.state.enrollThread({ threadId: childId, parentChannelId: channelId, guildId: 'guild', adoptionCutoff: '100' }, binding);
  f.state.setThreadBaseline(childId, '100', binding);
  f.state.markThreadBoundary(childId, THREAD_STATES.GAP, 'existing child gap', '101', '109', binding);

  const parentBefore = f.state.getIntakeWatermark(channelId);
  const childBefore = f.state.getThreadEnrollment(childId);
  const input = handoffInput(f);
  const successor = f.state.handoffOrdinary(input);

  assert.equal(successor.provider, 'claude');
  assert.equal(successor.nativeId, OTHER);
  assert.equal(successor.endpoint, input.endpoint);
  assert.equal(successor.generation, binding.generation + 1);
  assert.equal(successor.readiness, 'pending');
  assert.deepEqual(f.state.getIntakeWatermark(channelId), parentBefore);
  assert.deepEqual(f.state.getThreadEnrollment(childId), childBefore);

  const receipt = f.state.findOrdinaryHandoff(input.handoffId);
  assert.equal(receipt.endpoint, input.endpoint);
  assert.equal(receipt.harness, 'claude-code');

  const retry = f.state.handoffOrdinary(input);
  assert.equal(retry.handoffReconciled, true);
  assert.equal(f.state.listReceipts().filter(item => item.kind === 'ordinary-handoff').length, 1);
  assert.equal(f.state.listReceipts().filter(item => item.kind === 'ordinary-handoff-retry').length, 1);

  const otherEndpoint = path.join(f.dir, 'other.sock');
  assert.throws(() => f.state.handoffOrdinary({
    ...input,
    endpoint: otherEndpoint,
    nativeProof: { ...input.nativeProof, endpoint: otherEndpoint }
  }), /handoff ID is already used for a different successor/);
  assert.equal(f.state.getBinding(channelId).endpoint, input.endpoint);
  assert.deepEqual(f.state.getIntakeWatermark(channelId), parentBefore);
  assert.deepEqual(f.state.getThreadEnrollment(childId), childBefore);
});

test('ordinary Claude handoff rejects wrong harness, mismatched endpoint proof, and unresolved work without mutation', t => {
  const f = fixture(t);
  const channelId = f.binding.channelId;
  const input = handoffInput(f);
  const before = f.state.getBinding(channelId);
  const watermarkBefore = f.state.getIntakeWatermark(channelId);

  assert.throws(() => f.state.handoffOrdinary({
    ...input,
    identity: { ...input.identity, harness: 'codex' },
    nativeProof: { ...input.nativeProof, harness: 'codex' }
  }), /claude-code harness/);
  assert.throws(() => f.state.handoffOrdinary({
    ...input,
    nativeProof: { ...input.nativeProof, endpoint: path.join(f.dir, 'other.sock') }
  }), /matching Claude transcript proof/);
  assert.deepEqual(f.state.getBinding(channelId), before);
  assert.deepEqual(f.state.getIntakeWatermark(channelId), watermarkBefore);
  assert.equal(f.state.listReceipts().some(item => item.kind === 'ordinary-handoff'), false);

  f.state.markIntakeBoundary(channelId, 'ready', 'ready for unresolved-work control', null, null, before);
  const accepted = f.state.acceptDiscordMessage({
    id: '900601', guildId: 'guild', channelId, authorId: 'operator', isBot: false, content: 'held'
  }, { ready: true });
  assert.equal(accepted.accepted, true);
  const readyBinding = f.state.getBinding(channelId);
  assert.throws(() => f.state.handoffOrdinary(input), /cannot handoff while work is unresolved/);
  assert.deepEqual(f.state.getBinding(channelId), readyBinding);
  assert.equal(f.state.listReceipts().some(item => item.kind === 'ordinary-handoff'), false);
});

test('ordinary Claude handoff refuses a successor session already owned by another channel', t => {
  const f = fixture(t);
  const otherChannel = 'claude-other-channel';
  f.state.bindOrdinaryClaude({
    channelId: otherChannel,
    guildId: 'guild',
    provider: 'claude',
    nativeId: OTHER,
    workspace: f.dir,
    endpoint: path.join(f.dir, 'other-claude.sock')
  }, { sessionId: OTHER, threadId: OTHER, harness: 'claude-code' }, '100');

  const input = handoffInput(f);
  const before = f.state.getBinding(f.binding.channelId);
  assert.throws(() => f.state.handoffOrdinary(input), /native session is already owned/);
  assert.deepEqual(f.state.getBinding(f.binding.channelId), before);
  assert.equal(f.state.listReceipts().some(item => item.kind === 'ordinary-handoff'), false);
});

test('ordinary Claude handoff exact retry refuses a source binding changed before its retry transaction', t => {
  const f = fixture(t);
  const input = handoffInput(f);
  const successor = f.state.handoffOrdinary(input);
  const originalTransaction = f.state.transaction.bind(f.state);
  let interceptRetry = true;
  const transaction = operation => {
    if (interceptRetry) {
      interceptRetry = false;
      f.state.transaction = originalTransaction;
      f.state.unbind(input.channelId);
      f.state.transaction = transaction;
    }
    return originalTransaction(operation);
  };
  f.state.transaction = transaction;
  try {
    assert.throws(() => f.state.handoffOrdinary(input), /ordinary handoff retry source identity is stale/);
  } finally {
    f.state.transaction = originalTransaction;
  }

  assert.equal(f.state.getBinding(input.channelId).active, false);
  assert.equal(f.state.getBinding(input.channelId).generation, successor.generation);
  assert.equal(f.state.listReceipts().filter(item => item.kind === 'ordinary-handoff').length, 1);
  assert.equal(f.state.listReceipts().filter(item => item.kind === 'ordinary-handoff-retry').length, 0);
});

test('ordinary Claude post-commit retry reconciliation revalidates the source before writing its receipt', t => {
  const f = fixture(t);
  const input = handoffInput(f);
  const originalTransaction = f.state.transaction.bind(f.state);
  let phase = 'commit';
  const transaction = operation => {
    if (phase === 'commit') {
      phase = 'retry';
      originalTransaction(operation);
      throw new StaleGenerationError('simulated lost handoff commit response');
    }
    if (phase === 'retry') {
      phase = 'done';
      f.state.transaction = originalTransaction;
      f.state.unbind(input.channelId);
      f.state.transaction = transaction;
    }
    return originalTransaction(operation);
  };
  f.state.transaction = transaction;
  try {
    assert.throws(() => f.state.handoffOrdinary(input), /ordinary handoff retry source identity is stale/);
  } finally {
    f.state.transaction = originalTransaction;
  }

  assert.equal(f.state.getBinding(input.channelId).active, false);
  assert.equal(f.state.findOrdinaryHandoff(input.handoffId).nativeId, input.nativeId);
  assert.equal(f.state.listReceipts().filter(item => item.kind === 'ordinary-handoff').length, 1);
  assert.equal(f.state.listReceipts().filter(item => item.kind === 'ordinary-handoff-retry').length, 0);
});

test('ordinary Claude retry rechecks its binding after the before-mutation callback', t => {
  const f = fixture(t);
  const input = handoffInput(f);
  f.state.handoffOrdinary(input);
  const alternateEndpoint = path.join(f.dir, 'race.sock');

  assert.throws(() => f.state.handoffOrdinary({
    ...input,
    beforeMutation() {
      f.state.db.prepare('UPDATE bindings SET endpoint=? WHERE channel_id=?').run(alternateEndpoint, input.channelId);
    }
  }), /ordinary handoff retry source identity changed before receipt/);

  assert.equal(f.state.getBinding(input.channelId).endpoint, input.endpoint);
  assert.equal(f.state.listReceipts().filter(item => item.kind === 'ordinary-handoff').length, 1);
  assert.equal(f.state.listReceipts().filter(item => item.kind === 'ordinary-handoff-retry').length, 0);
});
