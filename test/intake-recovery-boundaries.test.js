'use strict';

// Issue #108 retry, deadline, legacy compatibility and coverage-bound scenarios.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fixture } = require('./helpers/intake-recovery-fixture');
const { MESSAGE_STATES } = require('../src/state');
const { THREAD_STATES } = require('../src/state/thread-enrollment');
const { recoverThread } = require('../src/discord/thread-enrollment');
const { waitForRecoveryOperation } = require('../src/discord');
const { CASES, operatorMessage } = require('./helpers/intake-recovery-scenarios');
const { waitForCondition } = require('./surface-fixtures');

const LEGACY_TIMEOUT_DETAIL = 'ordinary-bind recovery exceeded 30000ms';
const LEGACY_THREAD_TIMEOUT_DETAIL = 'Discord recovery deadline exceeded';

test('R4: deadline between full pages stays retryable after one real admission', CASES, async t => {
    const f = fixture(t);
    f.history.set('1000', [f.message('101', '1000')]);
    const realNow = Date.now;
    const realIntake = f.gateway.consumer.intakeMessage;
    let advanced = false;
    f.gateway.consumer.intakeMessage = async function (...args) {
      const result = await realIntake.apply(f.gateway.consumer, args);
      if (!advanced && args[0]?.id === '101') {
        advanced = true;
        Date.now = () => realNow() + 120000;
      }
      return result;
    };

    let result;
    try {
      result = await f.recover();
    } finally {
      Date.now = realNow;
      f.gateway.consumer.intakeMessage = realIntake;
    }

    assert.equal(result.ready, false);
    assert.equal(advanced, true, 'fixture must admit one real custody row before the deadline');
    assert.equal(f.state.getMessage('101').state, 'accepted');
    assert.equal(f.cursor('1000'), '101');
    const boundary = f.boundary('1000');
    assert.equal(boundary.state, 'unavailable');
    assert.match(boundary.detail, /^Discord recovery deadline: /);
    assert.doesNotMatch(String(boundary.detail || ''), /history (page|message) bound/);
    assert.equal(f.dispatched.length, 0);

    const recovered = await f.gateway.recoverTransport('startup');
    assert.equal(recovered.ready, true, JSON.stringify(recovered));
    assert.equal(f.boundary('1000').state, 'ready');
    f.enableDelivery();
    await f.gateway.reconcilePending();
    await f.gateway.consumer.waitForNativeWork();
    assert.equal(f.state.getMessage('101').state, 'replied');
    assert.equal(f.dispatched.filter(message => message.id === '101').length, 1);
  });

test('R4b: unvisited ready binding completes through its scoped follow-up', CASES, async t => {
  const f = fixture(t);
  f.state.bind({ channelId: '3000', guildId: 'guild', provider: 'codex',
    nativeId: '33333333-3333-3333-3333-333333333333', workspace: f.secret }, { intakeCutoff: '100' });
  f.state.setIntakeBaseline('3000', '100', 'fixture');
  f.state.markIntakeBoundary('3000', 'ready');
  const baseChannel = f.channels.get('1000');
  f.channels.set('3000', { ...baseChannel, id: '3000' });
  f.history.set('1000', [f.message('101', '1000')]);
  f.history.set('3000', [f.message('102', '3000')]);
  const realNow = Date.now;
  const realIntake = f.gateway.consumer.intakeMessage;
  let advanced = false;
  f.gateway.consumer.intakeMessage = async function (...args) {
    const result = await realIntake.apply(f.gateway.consumer, args);
    if (!advanced && args[0]?.id === '101') {
      advanced = true;
      Date.now = () => realNow() + 120000;
    }
    return result;
  };

  try {
    await f.recover();
    assert.equal(advanced, true);
  } finally {
    Date.now = realNow;
    f.gateway.consumer.intakeMessage = realIntake;
  }

  await waitForCondition(() => f.state.getBinding('3000').readiness === 'ready'
    && f.state.getIntakeWatermark('3000').state === 'ready', 2000);

  assert.ok(f.calls.some(call => call.kind === 'history' && call.id === '3000'),
    'the scoped follow-up must fetch history on channel 3000');
  assert.equal(f.state.getIntakeWatermark('3000').recovered_through_id, '102');
  assert.equal(f.state.getIntakeWatermark('3000').state, 'ready');
  assert.equal(f.state.getBinding('3000').readiness, 'ready');
  assert.equal(f.state.getMessage('102').state, 'accepted');
  assert.equal(f.dispatched.length, 0);
});

test('R4e: shared deadline schedules a fresh retry for an unvisited pending binding', CASES, async t => {
  const f = fixture(t);
  f.state.bind({ channelId: '3000', guildId: 'guild', provider: 'codex',
    nativeId: '33333333-3333-3333-3333-333333333333', workspace: f.secret }, { intakeCutoff: '100' });
  f.state.setIntakeBaseline('3000', '100', 'fixture');
  f.state.markIntakeBoundary('3000', 'pending', 'retry after a prior deadline');
  const baseChannel = f.channels.get('1000');
  f.channels.set('3000', { ...baseChannel, id: '3000' });
  f.history.set('1000', [f.message('101', '1000')]);
  f.history.set('3000', []);
  const realNow = Date.now;
  const realIntake = f.gateway.consumer.intakeMessage;
  const recoveryRetries = [];
  const originalRecoverTransport = f.gateway.recoverTransport;
  f.gateway.recoverTransport = async function (...args) {
    recoveryRetries.push({ args, observedAt: Date.now() });
    return originalRecoverTransport.apply(this, args);
  };
  let advanced = false;
  f.gateway.consumer.intakeMessage = async function (...args) {
    const result = await realIntake.apply(f.gateway.consumer, args);
    if (!advanced && args[0]?.id === '101') {
      advanced = true;
      Date.now = () => realNow() + 120000;
    }
    return result;
  };

  try {
    await f.recover();
    for (let attempt = 0; attempt < 10 && f.state.getBinding('3000').readiness !== 'ready'; attempt += 1) {
      await new Promise(resolve => setImmediate(resolve));
    }
    assert.equal(advanced, true);
    assert.equal(f.state.getIntakeWatermark('3000').state, 'ready');
    assert.equal(f.state.getBinding('3000').readiness, 'ready');
    const retry = recoveryRetries.find(({ args }) => args[2]?.includes('3000'));
    assert.ok(retry, 'the unvisited route must receive a scoped retry');
    assert.ok(retry.args[3] > retry.observedAt, 'the scoped retry must receive a fresh deadline');
  } finally {
    Date.now = realNow;
    f.gateway.consumer.intakeMessage = realIntake;
    f.gateway.recoverTransport = originalRecoverTransport;
  }
});

for (const [label, empty] of [['R4c', false], ['R4d', true]]) {
test(`${label}: reconnect deadline preserves ${empty ? 'an empty' : 'a'} ready watermark after pause`, CASES, async t => {
  const f = fixture(t);
  f.state.bind({ channelId: '3000', guildId: 'guild', provider: 'codex',
    nativeId: '33333333-3333-3333-3333-333333333333', workspace: f.secret }, { intakeCutoff: '100' });
  if (!empty) f.state.setIntakeBaseline('3000', '100', 'fixture');
  f.state.markIntakeBoundary('3000', 'ready');
  const baseChannel = f.channels.get('1000');
  f.channels.set('3000', { ...baseChannel, id: '3000' });
  f.history.set('1000', [f.message('101', '1000')]);
  f.history.set('3000', []);
  const realNow = Date.now;
  const realIntake = f.gateway.consumer.intakeMessage;
  let advanced = false;
  f.gateway.consumer.intakeMessage = async function (...args) {
    const result = await realIntake.apply(f.gateway.consumer, args);
    if (!advanced && args[0]?.id === '101') {
      advanced = true;
      Date.now = () => realNow() + 120000;
    }
    return result;
  };

  try {
    f.gateway.pauseConnection('reconnect');
    const result = await f.gateway.recoverTransport('reconnect');
    assert.equal(result.ready, false);
    assert.equal(f.state.getIntakeWatermark('3000').state, 'ready');
    for (let attempt = 0; attempt < 8 && f.state.getBinding('3000').readiness !== 'ready'; attempt += 1) {
      await new Promise(resolve => setImmediate(resolve));
    }
    assert.equal(f.state.getBinding('3000').readiness, 'ready');
  } finally {
    Date.now = realNow;
    f.gateway.consumer.intakeMessage = realIntake;
  }
});
}

for (const adopted of [true, false]) {
  test(`R5: ${adopted ? 'adopted' : 'pre-adoption'} child deadline after fetch attempt is retryable`, CASES, async t => {
    const f = fixture(t, { adoptThread: adopted });
    const message = operatorMessage(f, '101', '2000');
    f.history.set('2000', [f.message('101', '2000')]);
    if (adopted) assert.equal(f.state.acceptDiscordMessage(message).accepted, true);

    const originalFetch = f.gateway.client.channels.fetch;
    f.gateway.client.channels.fetch = id => id === '2000'
      ? new Promise(() => {})
      : originalFetch.call(f.gateway.client.channels, id);
    try {
      const first = await recoverThread(f.gateway, f.boundary('2000'), new AbortController().signal,
        f.gateway.lifecycleEpoch, waitForRecoveryOperation, false, Date.now() + 50);
      assert.equal(first, false);
    } finally {
      f.gateway.client.channels.fetch = originalFetch;
    }

    const held = f.boundary('2000');
    assert.equal(held.state, 'unavailable');
    assert.match(held.detail, /^Discord recovery deadline: /);
    assert.equal(f.dispatched.length, 0);

    const recovered = await f.gateway.recoverTransport('restart');
    assert.equal(recovered.ready, adopted, JSON.stringify(recovered));
    if (adopted) {
      assert.equal(f.boundary('2000').state, 'ready');
      f.enableDelivery();
      await f.gateway.reconcilePending(undefined, { readyOnly: true });
      await f.gateway.consumer.waitForNativeWork();
      assert.equal(f.state.getMessage('101').state, 'replied');
      assert.equal(f.dispatched.filter(item => item.id === '101').length, 1);
    } else {
      // F15 rule (lead ruling on F-005): an unqualified pre-adoption retry after a
      // typed deadline must stay visibly held; the old 'ready' expectation encoded
      // the F15 defect. See findings F-005 / decision F-007.
      const heldRetry = f.boundary('2000');
      assert.equal(heldRetry.state, 'pending');
      assert.equal(heldRetry.adoptedAt, null);
      assert.equal(heldRetry.adoptedThroughId, null);
      assert.equal(heldRetry.recoveredThroughId, null);
      assert.equal(f.dispatched.length, 0);
    }
  });
}

test('R6: child deadline before first fetch keeps the existing pending boundary', CASES, async t => {
  const f = fixture(t, { adoptThread: false });
  const callsBefore = f.calls.length;
  const result = await recoverThread(f.gateway, f.boundary('2000'), new AbortController().signal,
    f.gateway.lifecycleEpoch, waitForRecoveryOperation, false, Date.now() - 1);

  assert.equal(result, false);
  assert.equal(f.boundary('2000').state, 'pending');
  assert.equal(f.boundary('2000').detail, 'Thread history recovery pending before first fetch');
  assert.equal(f.calls.length, callsBefore);
});

test('R6b: retryable child deadline before first fetch queues a fresh scoped recovery', CASES, async t => {
  const f = fixture(t);
  const owner = f.state.getBinding('1000');
  f.state.markThreadBoundary('2000', 'unavailable', 'Discord recovery deadline: prior pass expired', null, null, owner);
  const recoveries = [];
  const originalRecoverTransport = f.gateway.recoverTransport;
  f.gateway.recoverTransport = async (...args) => {
    recoveries.push(args);
    return { ready: false, state: 'unavailable' };
  };
  try {
    const result = await recoverThread(f.gateway, f.boundary('2000'), new AbortController().signal,
      f.gateway.lifecycleEpoch, waitForRecoveryOperation, false, Date.now() - 1);
    assert.equal(result, false);
  } finally {
    f.gateway.recoverTransport = originalRecoverTransport;
  }

  assert.equal(recoveries.length, 1);
  assert.equal(recoveries[0][0], 'thread history recovery deadline retry');
  assert.equal(recoveries[0][1], f.gateway.lifecycleEpoch);
  assert.deepEqual([...recoveries[0][2]], ['2000']);
  assert.equal(recoveries[0].length, 3, 'retry must receive a fresh deadline');
});

test('R7: old timeout gap with a confirmed cursor retries after database reopen', CASES, async t => {
  const f = fixture(t);
  const owner = f.state.getBinding('1000');
  f.state.markIntakeBoundary('1000', 'gap', LEGACY_TIMEOUT_DETAIL, null, null, owner);
  assert.equal(f.state.getIntakeWatermark('1000').recovered_through_id, '100');
  assert.equal(f.state.acceptDiscordMessage(operatorMessage(f, '101', '1000'), { ready: false }).accepted, true);
  f.history.set('1000', [f.message('101', '1000')]);
  await f.reopen();

  const reopenedOwner = f.state.getBinding('1000');
  assert.deepEqual(
    [reopenedOwner.provider, reopenedOwner.nativeId, reopenedOwner.generation],
    [owner.provider, owner.nativeId, owner.generation]
  );
  f.enableDelivery();
  const result = await f.recover();
  assert.equal(result.ready, true, JSON.stringify(result));
  assert.equal(f.boundary('1000').state, 'ready');
  await f.gateway.reconcilePending(undefined, { readyOnly: true });
  await f.gateway.consumer.waitForNativeWork();
  assert.equal(f.state.getMessage('101').state, 'replied');
  assert.equal(f.dispatched.filter(message => message.id === '101').length, 1);
  assert.equal(f.dispatched[0].generation, owner.generation);
});

test('R7a: cursorless legacy timeout retains custody without inventing history coverage', CASES, async t => {
  const f = fixture(t);
  const owner = f.state.getBinding('1000');
  f.state.markIntakeBoundary('1000', 'gap', LEGACY_TIMEOUT_DETAIL, null, null, owner);
  f.state.db.prepare('UPDATE intake_watermarks SET recovered_through_id=NULL, gap_from=NULL, gap_to=NULL WHERE channel_id=?').run('1000');
  assert.equal(f.state.getIntakeWatermark('1000').recovered_through_id, null);
  assert.equal(f.state.acceptDiscordMessage(operatorMessage(f, '101', '1000'), { ready: false }).accepted, true);
  f.history.set('1000', [f.message('101', '1000')]);
  await f.reopen();

  const result = await f.recover();

  assert.equal(result.ready, false, JSON.stringify(result));
  assert.equal(f.boundary('1000').state, 'pending');
  assert.equal(f.state.getIntakeWatermark('1000').recovered_through_id, null);
  assert.equal(f.calls.filter(call => call.kind === 'history' && call.id === '1000').length, 0);
  assert.equal(f.state.getMessage('101').state, 'accepted');
  assert.equal(f.dispatched.length, 0);
  assert.equal(f.replies.length, 0);

  const reopenedOwner = f.state.getBinding('1000');
  assert.deepEqual(
    [reopenedOwner.provider, reopenedOwner.nativeId, reopenedOwner.generation],
    [owner.provider, owner.nativeId, owner.generation]
  );
});

for (const reason of ['startup', 'reconnect', 'restart']) {
  test(`R7b: legacy ${reason} timeout gap retries after database reopen`, CASES, async t => {
    const f = fixture(t);
    const owner = f.state.getBinding('1000');
    f.state.markIntakeBoundary('1000', 'gap', `${reason} recovery exceeded 30000ms`, null, null, owner);
    assert.equal(f.state.acceptDiscordMessage(operatorMessage(f, '101', '1000'), { ready: false }).accepted, true);
    f.history.set('1000', [f.message('101', '1000')]);
    await f.reopen();

    f.enableDelivery();
    const result = await f.recover();
    assert.equal(result.ready, true, JSON.stringify(result));
    assert.equal(f.boundary('1000').state, 'ready');
    await f.gateway.reconcilePending(undefined, { readyOnly: true });
    await f.gateway.consumer.waitForNativeWork();
    assert.equal(f.state.getMessage('101').state, 'replied');
    assert.equal(f.dispatched.filter(message => message.id === '101').length, 1);
  });
}

test('R7c: legacy child timeout gap retries after database reopen', CASES, async t => {
  const f = fixture(t);
  const owner = f.state.getBinding('1000');
  assert.equal(f.state.acceptDiscordMessage(operatorMessage(f, '101', '2000')).accepted, true);
  f.state.markThreadBoundary('2000', 'gap', LEGACY_THREAD_TIMEOUT_DETAIL, null, null, owner);
  assert.equal(f.cursor('2000'), '100');
  f.history.set('2000', [f.message('101', '2000')]);
  await f.reopen();

  f.enableDelivery();
  const result = await f.recover();
  assert.equal(result.ready, true, JSON.stringify(result));
  assert.equal(f.boundary('2000').state, 'ready');
  await f.gateway.reconcilePending(undefined, { readyOnly: true });
  await f.gateway.consumer.waitForNativeWork();
  assert.equal(f.state.getMessage('101').state, 'replied');
  assert.equal(f.dispatched.filter(message => message.id === '101').length, 1);
});

test('R7c2: adopted child pre-baseline timeout retries after database reopen', CASES, async t => {
  const f = fixture(t);
  const owner = f.state.getBinding('1000');
  assert.equal(f.state.acceptDiscordMessage(operatorMessage(f, '101', '2000')).accepted, true);
  f.state.db.prepare('UPDATE thread_enrollments SET recovered_through_id=NULL, last_seen_id=NULL, last_accepted_id=NULL WHERE thread_id=?').run('2000');
  f.state.markThreadBoundary('2000', 'gap', LEGACY_THREAD_TIMEOUT_DETAIL, null, null, owner);
  assert.equal(f.cursor('2000'), null);
  f.history.set('2000', [f.message('101', '2000')]);
  await f.reopen();

  f.enableDelivery();
  const result = await f.recover();
  assert.equal(result.ready, true, JSON.stringify(result));
  assert.equal(f.boundary('2000').state, 'ready');
  await f.gateway.reconcilePending(undefined, { readyOnly: true });
  await f.gateway.consumer.waitForNativeWork();
  assert.equal(f.state.getMessage('101').state, 'replied');
  assert.equal(f.dispatched.filter(message => message.id === '101').length, 1);
});

test('R7e: degraded reconciliation drains submitted and reply-ready custody on a held route', CASES, async t => {
  const f = fixture(t);
  const owner = f.state.getBinding('1000');
  for (const id of ['101', '102']) {
    assert.equal(f.state.acceptDiscordMessage(operatorMessage(f, id, '1000')).accepted, true);
    assert.equal(f.state.claimDispatch(id).claimed, true);
    assert.equal(f.state.markSubmitted(id).state, MESSAGE_STATES.SUBMITTED);
  }
  const replyReady = f.state.getMessage('102');
  f.state.recordNativeReply({
    provider: replyReady.provider,
    messageId: replyReady.id,
    nativeId: replyReady.nativeId,
    generation: replyReady.generation,
    text: 'already observed'
  });
  assert.equal(f.state.getMessage('102').state, MESSAGE_STATES.REPLY_READY);
  f.state.markIntakeBoundary('1000', 'gap', 'Discord recovery deadline: held route', null, null, owner);
  f.enableDelivery();

  await f.gateway.reconcilePending(undefined, { allowPaused: true, readyOnly: true });
  await f.gateway.consumer.waitForNativeWork();

  assert.equal(f.state.getMessage('101').state, MESSAGE_STATES.REPLIED);
  assert.equal(f.state.getMessage('102').state, MESSAGE_STATES.REPLIED);
  assert.equal(f.replies.length, 2);
});

test('R7g: reconnect recovery drains durable custody while every route stays held', CASES, async t => {
  const f = fixture(t);
  assert.equal(f.state.acceptDiscordMessage(operatorMessage(f, '101', '1000')).accepted, true);
  assert.equal(f.state.claimDispatch('101').claimed, true);
  assert.equal(f.state.markSubmitted('101').state, MESSAGE_STATES.SUBMITTED);
  f.fail({ kind: 'history', id: '1000', status: 503 });
  f.gateway.pauseConnection('reconnect');
  f.enableDelivery();

  const result = await f.gateway.beginReconnectRecovery('probe');
  assert.equal(result.ready, false, JSON.stringify(result));
  assert.equal(f.gateway.ready, false);
  assert.equal(f.boundary('1000').state, 'unavailable');
  await f.gateway.consumer.waitForNativeWork();

  assert.equal(f.state.getMessage('101').state, MESSAGE_STATES.REPLIED);
  assert.equal(f.replies.length, 1);
});

test('R7h: submitted observation survives a held channel fetch', CASES, async t => {
  const f = fixture(t);
  assert.equal(f.state.acceptDiscordMessage(operatorMessage(f, '101', '1000')).accepted, true);
  assert.equal(f.state.claimDispatch('101').claimed, true);
  assert.equal(f.state.markSubmitted('101').state, MESSAGE_STATES.SUBMITTED);
  f.enableDelivery();
  const originalFetch = f.gateway.client.channels.fetch;
  let fetches = 0;
  f.gateway.client.channels.fetch = async () => {
    fetches += 1;
    throw Object.assign(new Error('channel fetch unavailable'), { status: 403 });
  };
  try {
    await f.gateway.reconcilePending(undefined, { allowPaused: true, readyOnly: true });
    await f.gateway.consumer.waitForNativeWork();
  } finally {
    f.gateway.client.channels.fetch = originalFetch;
  }

  assert.equal(fetches, 1);
  assert.equal(f.state.getMessage('101').state, MESSAGE_STATES.REPLY_READY);
  assert.equal(f.replies.length, 0);

  await f.gateway.reconcilePending(undefined, { allowPaused: true, readyOnly: true });
  await f.gateway.consumer.waitForNativeWork();
  assert.equal(f.state.getMessage('101').state, MESSAGE_STATES.REPLIED);
  assert.equal(f.replies.length, 1);
});

test('R7f: held thread delivery deadline remains retryable', CASES, async t => {
  const f = fixture(t);
  const owner = f.state.getBinding('1000');
  assert.equal(f.state.acceptDiscordMessage(operatorMessage(f, '101', '2000'), { ready: false }).accepted, true);
  assert.equal(f.state.claimDispatch('101').claimed, true);
  assert.equal(f.state.markSubmitted('101').state, MESSAGE_STATES.SUBMITTED);
  f.state.markThreadBoundary('2000', THREAD_STATES.UNAVAILABLE,
    'Discord recovery deadline: prior pass expired', null, null, owner);
  f.gateway.recoveryTimeoutMs = 20;
  f.gateway.client.channels.fetch = () => new Promise(() => {});

  await f.gateway.reconcilePending(undefined, { allowPaused: true, readyOnly: true });

  const enrollment = f.state.getThreadEnrollment('2000');
  assert.equal(enrollment.state, THREAD_STATES.UNAVAILABLE);
  assert.equal(enrollment.detail, 'Discord recovery deadline: Discord recovery deadline exceeded');
});

for (const legacy of [
  { name: 'child admission', detail: LEGACY_THREAD_TIMEOUT_DETAIL, thread: true },
  { name: 'ordinary startup reason with coverage bounds', detail: 'startup recovery exceeded 30000ms', thread: false },
  { name: 'parent admission', detail: 'Discord recovery deadline exceeded while admitting history', thread: false },
  { name: 'parent history bound', detail: 'history recovery deadline 30000ms reached', thread: false },
  { name: 'Codex transcript preflight', detail: 'Codex transcript proof unavailable before event write: Discord recovery deadline exceeded', thread: false },
  { name: 'Claude endpoint preflight', detail: 'Claude endpoint unavailable before event write: Discord recovery deadline exceeded', thread: false },
  { name: 'Codex native preflight', detail: 'Codex native preflight deadline exceeded', thread: false }
]) {
  test(`R7d: bounded legacy ${legacy.name} timeout retries after database reopen`, CASES, async t => {
    const f = fixture(t);
    const owner = f.state.getBinding('1000');
    const channelId = legacy.thread ? '2000' : '1000';
    assert.equal(f.state.acceptDiscordMessage(operatorMessage(f, '101', channelId), { ready: false }).accepted, true);
    if (legacy.thread) f.state.markThreadBoundary(channelId, 'gap', legacy.detail, '100', '101', owner);
    else f.state.markIntakeBoundary(channelId, 'gap', legacy.detail, '100', '101', owner);
    f.history.set(channelId, [f.message('101', channelId)]);
    await f.reopen();

    f.enableDelivery();
    const result = await f.recover();
    assert.equal(result.ready, true, JSON.stringify(result));
    assert.equal(f.boundary(channelId).state, 'ready');
    await f.gateway.reconcilePending(undefined, { readyOnly: true });
    await f.gateway.consumer.waitForNativeWork();
    assert.equal(f.state.getMessage('101').state, 'replied');
    assert.equal(f.dispatched.filter(message => message.id === '101').length, 1);
  });
}

const LEGACY_NEGATIVE_CONTROLS = [
  { name: 'page-bound detail', detail: 'history page bound 100 reached', gapFrom: '100', gapTo: '101' },
  { name: 'near-match timeout detail', detail: 'ordinary-bind recovery exceeded 30001ms', gapFrom: null, gapTo: null },
  { name: 'legacy detail without a confirmed cursor', detail: LEGACY_TIMEOUT_DETAIL, gapFrom: '100', gapTo: '101', clearCursor: true },
  { name: 'native preflight detail without a confirmed cursor', detail: 'Codex native preflight deadline exceeded', gapFrom: '100', gapTo: '101', clearCursor: true }
];

for (const control of LEGACY_NEGATIVE_CONTROLS) {
  test(`G6: ${control.name} stays held without history fetch or dispatch`, CASES, async t => {
    const f = fixture(t);
    const owner = f.state.getBinding('1000');
    if (control.clearCursor) {
      f.state.db.prepare('UPDATE intake_watermarks SET recovered_through_id=NULL WHERE channel_id=?').run('1000');
    }
    f.state.markIntakeBoundary('1000', 'gap', control.detail, control.gapFrom, control.gapTo, owner);
    assert.equal(f.state.acceptDiscordMessage(operatorMessage(f, '101', '1000'), { ready: false }).accepted, true);
    f.history.set('1000', [f.message('101', '1000')]);
    f.enableDelivery();
    await f.reopen();

    const result = await f.recover();
    assert.equal(result.ready, false);
    assert.equal(result.state, 'gap');
    assert.equal(f.boundary('1000').state, 'gap');
    assert.equal(f.boundary('1000').detail, control.detail);
    assert.equal(f.calls.filter(call => call.kind === 'history' && call.id === '1000').length, 0);
    assert.equal(f.dispatched.length, 0);
    assert.equal(f.state.getMessage('101').state, 'accepted');
  });
}

const SOURCE_FILE_PATTERN = /\.(?:js|ts)$/;
const OUTCOME_NAMES = new Set(['state', 'readiness', 'status', 'result', 'outcome']);

const collectSourceFiles = directory => fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
  const absolute = path.join(directory, entry.name);
  if (entry.isDirectory()) return collectSourceFiles(absolute);
  return SOURCE_FILE_PATTERN.test(entry.name) ? [absolute] : [];
});

const readSourceInventory = sourceRoot => collectSourceFiles(sourceRoot).map(absolute => ({
  relative: path.relative(sourceRoot, absolute).split(path.sep).join('/'),
  source: fs.readFileSync(absolute, 'utf8')
}));

const isIdentifierStart = character => /[A-Za-z_$]/.test(character);
const isIdentifierPart = character => /[A-Za-z0-9_$]/.test(character);
const REGEX_PREFIXES = new Set(['(', '{', '[', ',', ';', ':', '=', '==', '===', '!=', '!==', '!', '&&', '||', '??', '?', '=>', 'return', 'case', 'throw', 'else', 'do', 'in', 'of']);

const tokenizeSource = source => {
  const tokens = [];
  const newlineOffsets = [];
  for (let offset = 0; offset < source.length; offset += 1) {
    if (source[offset] === '\n') newlineOffsets.push(offset);
  }
  const lineAt = offset => {
    let low = 0;
    let high = newlineOffsets.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (newlineOffsets[middle] < offset) low = middle + 1;
      else high = middle;
    }
    return low + 1;
  };
  let index = 0;
  let previous = null;
  const push = (type, value, start, end) => {
    const token = { type, value, start, end, line: lineAt(start) };
    tokens.push(token);
    previous = token;
  };
  const canStartRegex = () => !previous || REGEX_PREFIXES.has(previous.value);

  while (index < source.length) {
    const character = source[index];
    if (/\s/.test(character)) {
      index += 1;
      continue;
    }
    if (character === '/' && source[index + 1] === '/') {
      index += 2;
      while (index < source.length && source[index] !== '\n') index += 1;
      continue;
    }
    if (character === '/' && source[index + 1] === '*') {
      const end = source.indexOf('*/', index + 2);
      index = end === -1 ? source.length : end + 2;
      continue;
    }
    if (character === '"' || character === "'") {
      const start = index;
      const quote = character;
      let escaped = false;
      index += 1;
      while (index < source.length) {
        const current = source[index];
        if (escaped) escaped = false;
        else if (current === '\\') escaped = true;
        else if (current === quote) {
          index += 1;
          break;
        }
        index += 1;
      }
      push('string', source.slice(start + 1, Math.max(start + 1, index - 1)), start, index);
      continue;
    }
    if (character === '`') {
      const start = index;
      let escaped = false;
      let hasSubstitution = false;
      index += 1;
      while (index < source.length) {
        const current = source[index];
        if (escaped) escaped = false;
        else if (current === '\\') escaped = true;
        else if (current === '$' && source[index + 1] === '{') hasSubstitution = true;
        else if (current === '`') {
          index += 1;
          break;
        }
        index += 1;
      }
      const value = source.slice(start + 1, Math.max(start + 1, index - 1));
      push(hasSubstitution ? 'template-dynamic' : 'template', hasSubstitution ? null : value, start, index);
      continue;
    }
    if (character === '/' && canStartRegex()) {
      const start = index;
      let escaped = false;
      let inClass = false;
      index += 1;
      while (index < source.length) {
        const current = source[index];
        if (escaped) escaped = false;
        else if (current === '\\') escaped = true;
        else if (current === '[') inClass = true;
        else if (current === ']') inClass = false;
        else if (current === '/' && !inClass) {
          index += 1;
          while (index < source.length && isIdentifierPart(source[index])) index += 1;
          break;
        }
        index += 1;
      }
      push('regex', null, start, index);
      continue;
    }
    if (isIdentifierStart(character)) {
      const start = index;
      index += 1;
      while (index < source.length && isIdentifierPart(source[index])) index += 1;
      push('identifier', source.slice(start, index), start, index);
      continue;
    }
    if (/[0-9]/.test(character)) {
      const start = index;
      index += 1;
      while (index < source.length && /[0-9A-Za-z._]/.test(source[index])) index += 1;
      push('number', source.slice(start, index), start, index);
      continue;
    }
    const operator = ['===', '!==', '=>', '>=', '<=', '==', '!=', '&&', '||', '??', '?.', '++', '--'].find(value => source.startsWith(value, index));
    if (operator) {
      push('operator', operator, index, index + operator.length);
      index += operator.length;
      continue;
    }
    push('punctuation', character, index, index + 1);
    index += 1;
  }
  return tokens;
};

const findTokenPairs = tokens => {
  const pairs = new Map();
  const stacks = new Map([['(', []], ['{', []], ['[', []]]);
  const closing = new Map([[')', '('], ['}', '{'], [']', '[']]);
  for (let index = 0; index < tokens.length; index += 1) {
    const value = tokens[index].value;
    if (stacks.has(value)) {
      stacks.get(value).push(index);
      continue;
    }
    if (!closing.has(value)) continue;
    const stack = stacks.get(closing.get(value));
    const opening = stack.pop();
    if (opening === undefined) continue;
    pairs.set(opening, index);
    pairs.set(index, opening);
  }
  return pairs;
};

const isGapEnumElementAt = (tokens, index) => {
  const object = tokens[index]?.value;
  const property = tokens[index + 2];
  return (object === 'READINESS' || object === 'THREAD_STATES')
    && tokens[index + 1]?.value === '['
    && (property?.type === 'string' || property?.type === 'template')
    && property.value === 'GAP'
    && tokens[index + 3]?.value === ']';
};

const isGapValueAt = (tokens, index) => {
  const token = tokens[index];
  if (!token) return false;
  if ((token.type === 'string' || token.type === 'template') && token.value === 'gap') return true;
  return (token.value === 'READINESS' || token.value === 'THREAD_STATES')
    && ((tokens[index + 1]?.value === '.' && tokens[index + 2]?.value === 'GAP')
      || isGapEnumElementAt(tokens, index));
};

const findDelimitedEnd = (tokens, start, end, closingValue) => {
  let parenDepth = 0;
  let braceDepth = 0;
  let bracketDepth = 0;
  for (let index = start; index < end; index += 1) {
    const value = tokens[index].value;
    if (value === '(') parenDepth += 1;
    else if (value === ')') parenDepth -= 1;
    else if (value === '{') braceDepth += 1;
    else if (value === '}') braceDepth -= 1;
    else if (value === '[') bracketDepth += 1;
    else if (value === ']') bracketDepth -= 1;
    else if (value === ',' && parenDepth === 0 && braceDepth === 0 && bracketDepth === 0) return index;
    else if (value === closingValue && parenDepth === 0 && braceDepth === 0 && bracketDepth === 0) return index;
  }
  return end;
};

const COMPARISON_OPERATORS = new Set(['==', '===', '!=', '!==', '>', '>=', '<', '<=']);

const gapValueEnd = (tokens, index) => {
  if ((tokens[index]?.type === 'string' || tokens[index]?.type === 'template')) return index + 1;
  if ((tokens[index]?.value === 'READINESS' || tokens[index]?.value === 'THREAD_STATES')
    && tokens[index + 1]?.value === '.' && tokens[index + 2]?.value === 'GAP') return index + 3;
  if (isGapEnumElementAt(tokens, index)) return index + 4;
  return index + 1;
};

const isComparisonOperand = (tokens, index, start, end) => {
  let left = index - 1;
  while (left >= start && (tokens[left]?.value === '.' || tokens[left]?.type === 'identifier')) left -= 1;
  if (left >= start && COMPARISON_OPERATORS.has(tokens[left]?.value)) return true;
  let right = gapValueEnd(tokens, index);
  while (right < end && (tokens[right]?.value === '.' || tokens[right]?.type === 'identifier')) right += 1;
  return right < end && COMPARISON_OPERATORS.has(tokens[right]?.value);
};

const expressionHasGap = (tokens, start, end, aliases = new Set(), allowNestedCalls = false) => {
  let parenDepth = 0;
  let braceDepth = 0;
  let bracketDepth = 0;
  const callParentheses = [];
  for (let index = start; index < end; index += 1) {
    const value = tokens[index].value;
    const insideCall = allowNestedCalls && callParentheses.some(Boolean);
    if ((parenDepth === 0 && braceDepth === 0 && bracketDepth === 0 || insideCall)
      && !isComparisonOperand(tokens, index, start, end)
      && (isGapValueAt(tokens, index) || (tokens[index].type === 'identifier' && aliases.has(value)))) return true;
    if (value === '(') {
      const previous = tokens[index - 1];
      callParentheses.push(previous?.type === 'identifier' || [')', ']'].includes(previous?.value));
      parenDepth += 1;
    } else if (value === ')') {
      parenDepth -= 1;
      callParentheses.pop();
    }
    else if (value === '{') braceDepth += 1;
    else if (value === '}') braceDepth -= 1;
    else if (value === '[') bracketDepth += 1;
    else if (value === ']') bracketDepth -= 1;
  }
  return false;
};

const objectHasTopLevelStateGap = (tokens, openingIndex, closingIndex, pairs, aliases = new Set(), allowNestedCalls = false) => {
  let parenDepth = 0;
  let braceDepth = 0;
  let bracketDepth = 0;
  for (let index = openingIndex + 1; index < closingIndex; index += 1) {
    const value = tokens[index].value;
    if (parenDepth === 0 && braceDepth === 0 && bracketDepth === 0
      && OUTCOME_NAMES.has(value) && tokens[index + 1]?.value === ':') {
      const valueStart = index + 2;
      const valueEnd = findDelimitedEnd(tokens, valueStart, closingIndex, '}');
      if (valueHasGap(tokens, valueStart, valueEnd, pairs, aliases, allowNestedCalls)) return true;
    }
    if (value === '(') parenDepth += 1;
    else if (value === ')') parenDepth -= 1;
    else if (value === '{') braceDepth += 1;
    else if (value === '}') braceDepth -= 1;
    else if (value === '[') bracketDepth += 1;
    else if (value === ']') bracketDepth -= 1;
  }
  return false;
};

const valueHasGap = (tokens, start, end, pairs, aliases = new Set(), allowNestedCalls = false) => {
  if (start >= end) return false;
  let valueStart = start;
  let valueEnd = end;
  while (tokens[valueEnd - 1]?.value === ';') valueEnd -= 1;
  while (tokens[valueStart]?.value === '(') {
    const closingIndex = pairs.get(valueStart);
    if (closingIndex !== valueEnd - 1) break;
    valueStart += 1;
    valueEnd = closingIndex;
  }
  if (valueStart >= valueEnd) return false;
  if (isGapValueAt(tokens, valueStart)
    && !isComparisonOperand(tokens, valueStart, valueStart, valueEnd)) return true;
  if (tokens[valueStart].type === 'identifier' && aliases.has(tokens[valueStart].value)
    && !isComparisonOperand(tokens, valueStart, valueStart, valueEnd)) return true;
  if (tokens[valueStart].value === '{') {
    const closingIndex = pairs.get(valueStart);
    return closingIndex !== undefined && closingIndex < valueEnd
      ? objectHasTopLevelStateGap(tokens, valueStart, closingIndex, pairs, aliases, allowNestedCalls)
      : false;
  }
  return expressionHasGap(tokens, valueStart, valueEnd, aliases, allowNestedCalls);
};

const findStatementEnd = (tokens, start, end) => {
  let parenDepth = 0;
  let braceDepth = 0;
  let bracketDepth = 0;
  const statementLine = tokens[start]?.line;
  const asiStarters = new Set(['function', 'const', 'let', 'var', 'if', 'return', 'for', 'while', 'switch', 'try', 'throw', 'class', 'export', 'import']);
  for (let index = start; index < end; index += 1) {
    const value = tokens[index].value;
    if (index > start && tokens[index].line > statementLine && parenDepth === 0 && braceDepth === 0 && bracketDepth === 0
      && asiStarters.has(value) && ['identifier', 'string', 'template', 'number'].includes(tokens[index - 1]?.type)) return index;
    if (value === '(') parenDepth += 1;
    else if (value === ')') parenDepth -= 1;
    else if (value === '{') braceDepth += 1;
    else if (value === '}') {
      if (parenDepth === 0 && braceDepth === 0 && bracketDepth === 0) return index;
      braceDepth -= 1;
    } else if (value === '[') bracketDepth += 1;
    else if (value === ']') bracketDepth -= 1;
    else if (value === ';' && parenDepth === 0 && braceDepth === 0 && bracketDepth === 0) return index + 1;
  }
  return end;
};

const findControlledStatementEnd = (tokens, start, end, pairs, includeElse = true) => {
  if (start >= end) return end;
  if (tokens[start].value === '{') return Math.min(end, (pairs.get(start) ?? end - 1) + 1);
  if (tokens[start].value === 'if' && tokens[start + 1]?.value === '(') {
    const conditionEnd = pairs.get(start + 1);
    if (conditionEnd === undefined) return findStatementEnd(tokens, start, end);
    const bodyStart = conditionEnd + 1;
    const bodyEnd = tokens[bodyStart]?.value === '{'
      ? Math.min(end, (pairs.get(bodyStart) ?? end - 1) + 1)
      : findControlledStatementEnd(tokens, bodyStart, end, pairs);
    if (includeElse && tokens[bodyEnd]?.value === 'else') return findControlledStatementEnd(tokens, bodyEnd + 1, end, pairs);
    return bodyEnd;
  }
  return findStatementEnd(tokens, start, end);
};

const findFunctionRanges = (tokens, pairs) => {
  const ranges = [];
  const classBodies = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].value !== 'class') continue;
    for (let body = index + 1; body < tokens.length; body += 1) {
      if (tokens[body].value === '{') {
        const closing = pairs.get(body);
        if (closing !== undefined) classBodies.push({ opening: body, closing });
        break;
      }
      if ([';', '}'].includes(tokens[body].value)) break;
    }
  }
  const controlHeaders = new Set(['if', 'for', 'while', 'switch', 'catch', 'with']);
  const isClassMethod = parameterOpening => {
    const methodName = tokens[parameterOpening - 1];
    if (!methodName || (methodName.type !== 'identifier' && methodName.value !== ']')
      || controlHeaders.has(methodName.value)) return false;
    return classBodies.some(({ opening, closing }) => (
      opening < parameterOpening && parameterOpening < closing
    ));
  };
  for (let opening = 0; opening < tokens.length; opening += 1) {
    if (tokens[opening].value !== '{') continue;
    const closing = pairs.get(opening);
    if (closing === undefined) continue;
    const previousIndex = opening - 1;
    if (tokens[previousIndex]?.value === '=>') {
      ranges.push({ start: previousIndex, opening, closing });
      continue;
    }
    if (tokens[previousIndex]?.value !== ')') continue;
    const parameterOpening = pairs.get(previousIndex);
    if (parameterOpening === undefined) continue;
    let start = parameterOpening - 1;
    while (start >= 0 && ![';', '{', '}'].includes(tokens[start].value)) {
      if (tokens[start].value === 'function') {
        ranges.push({ start, opening, closing });
        break;
      }
      start -= 1;
    }
    if (isClassMethod(parameterOpening)) {
      ranges.push({ start: parameterOpening - 1, opening, closing });
    }
  }
  const findArrowExpressionEnd = start => {
    let parenDepth = 0;
    let braceDepth = 0;
    let bracketDepth = 0;
    const statementLine = tokens[start]?.line;
    const asiStarters = new Set(['function', 'const', 'let', 'var', 'if', 'return', 'for', 'while', 'switch', 'try', 'throw', 'class', 'export', 'import']);
    for (let index = start; index < tokens.length; index += 1) {
      const value = tokens[index].value;
      if (index > start && tokens[index].line > statementLine && parenDepth === 0 && braceDepth === 0 && bracketDepth === 0
        && asiStarters.has(value) && ['identifier', 'string', 'template', 'number'].includes(tokens[index - 1]?.type)) return index;
      if (value === '(') parenDepth += 1;
      else if (value === ')') {
        if (parenDepth === 0 && braceDepth === 0 && bracketDepth === 0) return index;
        parenDepth -= 1;
      } else if (value === '{') braceDepth += 1;
      else if (value === '}') {
        if (parenDepth === 0 && braceDepth === 0 && bracketDepth === 0) return index;
        braceDepth -= 1;
      } else if (value === '[') bracketDepth += 1;
      else if (value === ']') bracketDepth -= 1;
      else if (value === ';' && parenDepth === 0 && braceDepth === 0 && bracketDepth === 0) return index + 1;
      else if (value === ',' && parenDepth === 0 && braceDepth === 0 && bracketDepth === 0) return index;
    }
    return tokens.length;
  };
  for (let arrow = 0; arrow < tokens.length; arrow += 1) {
    if (tokens[arrow].value !== '=>' || tokens[arrow + 1]?.value === '{') continue;
    const bodyStart = arrow + 1;
    const bodyEnd = findArrowExpressionEnd(bodyStart);
    ranges.push({
      start: arrow,
      opening: bodyStart,
      closing: bodyEnd - 1,
      bodyStart,
      bodyEnd,
      expression: true
    });
  }
  return ranges;
};

const findIfDecision = (tokens, triggerIndex, pairs) => {
  let best = null;
  for (let index = triggerIndex; index >= 0; index -= 1) {
    if (tokens[index].value !== 'if' || tokens[index + 1]?.value !== '(') continue;
    const closingCondition = pairs.get(index + 1);
    if (closingCondition === undefined || triggerIndex > closingCondition) continue;
    if (!best || closingCondition - index < best.closingCondition - best.start) {
      best = { start: index, closingCondition };
    }
  }
  return best;
};

const findFunctionDecision = (ranges, triggerIndex) => {
  const containing = ranges
    .filter(range => range.expression
      ? range.bodyStart <= triggerIndex && triggerIndex < range.bodyEnd
      : range.opening < triggerIndex && triggerIndex < range.closing)
    .sort((left, right) => (left.closing - left.opening) - (right.closing - right.opening));
  if (containing[0]) return containing[0];
  return ranges
    .filter(range => range.start < triggerIndex
      && (range.expression ? triggerIndex < range.bodyStart : triggerIndex < range.opening))
    .sort((left, right) => left.opening - right.opening)[0] || null;
};

const findStatementRange = (tokens, triggerIndex) => {
  let start = triggerIndex;
  while (start > 0 && ![';', '{', '}'].includes(tokens[start - 1].value)) start -= 1;
  return { start, end: findStatementEnd(tokens, start, tokens.length), opening: null };
};

const isNegatedDeadlineCondition = (tokens, conditionStart, triggerIndex) => {
  let cursor = triggerIndex - 1;
  while (cursor >= conditionStart && tokens[cursor].value === '(') cursor -= 1;
  let negated = false;
  while (cursor >= conditionStart && tokens[cursor].value === '!') {
    negated = !negated;
    cursor -= 1;
    while (cursor >= conditionStart && tokens[cursor].value === '(') cursor -= 1;
  }
  const isInequality = value => value === '!=' || value === '!==';
  const scanForInequality = (start, step) => {
    for (let index = start; index >= conditionStart && index < tokens.length; index += step) {
      if (isInequality(tokens[index].value)) return true;
      if (['&&', '||', '?', ':', ')'].includes(tokens[index].value)) break;
    }
    return false;
  };
  const isNegatedBooleanComparison = index => {
    const operator = tokens[index]?.value;
    const left = tokens[index - 1]?.value;
    const right = tokens[index + 1]?.value;
    const equalityToFalse = (operator === '==' || operator === '===')
      && (left === 'false' || right === 'false');
    const inequalityFromTrue = (operator === '!=' || operator === '!==')
      && (left === 'true' || right === 'true');
    return equalityToFalse || inequalityFromTrue;
  };
  const scanForNegatedBooleanComparison = (start, step) => {
    for (let index = start; index >= conditionStart && index < tokens.length; index += step) {
      if (isNegatedBooleanComparison(index)) return true;
      if (['&&', '||', '?', ':', ')'].includes(tokens[index].value)) break;
    }
    return false;
  };
  return negated
    || scanForInequality(triggerIndex - 1, -1)
    || scanForInequality(triggerIndex + 1, 1)
    || scanForNegatedBooleanComparison(triggerIndex - 1, -1)
    || scanForNegatedBooleanComparison(triggerIndex + 1, 1);
};

const branchRange = (tokens, start, end, pairs) => {
  if (start >= end) return { start, end, opening: null };
  if (tokens[start].value !== '{') return { start, end, opening: null };
  const closing = pairs.get(start);
  if (closing === undefined || closing >= end) return { start: start + 1, end, opening: start };
  return { start: start + 1, end: closing, opening: start };
};

const findConditionalExpressionDecision = (tokens, triggerIndex, start, end, pairs) => {
  let parenDepth = 0;
  let braceDepth = 0;
  let bracketDepth = 0;
  let questionIndex;
  for (let index = triggerIndex + 1; index < end; index += 1) {
    const value = tokens[index].value;
    if (value === '(') parenDepth += 1;
    else if (value === ')') parenDepth -= 1;
    else if (value === '{') braceDepth += 1;
    else if (value === '}') braceDepth -= 1;
    else if (value === '[') bracketDepth += 1;
    else if (value === ']') bracketDepth -= 1;
    else if (value === '?' && parenDepth === 0 && braceDepth === 0 && bracketDepth === 0) {
      questionIndex = index;
      break;
    }
  }
  if (questionIndex === undefined) return null;
  let nestedQuestions = 0;
  let colonIndex;
  parenDepth = 0;
  braceDepth = 0;
  bracketDepth = 0;
  for (let index = questionIndex + 1; index < end; index += 1) {
    const value = tokens[index].value;
    if (value === '(') parenDepth += 1;
    else if (value === ')') parenDepth -= 1;
    else if (value === '{') braceDepth += 1;
    else if (value === '}') braceDepth -= 1;
    else if (value === '[') bracketDepth += 1;
    else if (value === ']') bracketDepth -= 1;
    else if (parenDepth === 0 && braceDepth === 0 && bracketDepth === 0 && value === '?') nestedQuestions += 1;
    else if (parenDepth === 0 && braceDepth === 0 && bracketDepth === 0 && value === ':') {
      if (nestedQuestions === 0) {
        colonIndex = index;
        break;
      }
      nestedQuestions -= 1;
    }
  }
  if (colonIndex === undefined) return null;
  const negated = isNegatedDeadlineCondition(tokens, start, triggerIndex);
  const selectedStart = negated ? colonIndex + 1 : questionIndex + 1;
  const selectedEnd = negated ? end : colonIndex;
  return { ...branchRange(tokens, selectedStart, selectedEnd, pairs), opening: null };
};

const findSwitchDecision = (tokens, triggerIndex, pairs) => {
  let best = null;
  for (let index = triggerIndex - 1; index >= 0; index -= 1) {
    if (tokens[index].value !== 'switch' || tokens[index + 1]?.value !== '(') continue;
    const conditionEnd = pairs.get(index + 1);
    const opening = conditionEnd === undefined ? undefined : conditionEnd + 1;
    const closing = opening === undefined ? undefined : pairs.get(opening);
    if (opening === undefined || tokens[opening]?.value !== '{' || closing === undefined
      || triggerIndex <= opening || triggerIndex >= closing) continue;
    if (!best || closing - opening < best.closing - best.opening) best = { opening, closing };
  }
  if (!best) return null;
  const labels = [];
  let braceDepth = 0;
  let parenDepth = 0;
  let bracketDepth = 0;
  for (let index = best.opening + 1; index < best.closing; index += 1) {
    const value = tokens[index].value;
    if (value === '{') braceDepth += 1;
    else if (value === '}') braceDepth -= 1;
    else if (value === '(') parenDepth += 1;
    else if (value === ')') parenDepth -= 1;
    else if (value === '[') bracketDepth += 1;
    else if (value === ']') bracketDepth -= 1;
    else if (braceDepth === 0 && parenDepth === 0 && bracketDepth === 0 && (value === 'case' || value === 'default')) {
      let colon = index + 1;
      while (colon < best.closing && tokens[colon].value !== ':') colon += 1;
      labels.push({ index, start: Math.min(colon + 1, best.closing) });
      index = colon;
    }
  }
  const matchingLabels = labels.filter(candidate => candidate.index <= triggerIndex);
  const label = matchingLabels[matchingLabels.length - 1];
  if (!label) return null;
  const labelPosition = labels.indexOf(label);
  let start = label.start;
  let nextLabelPosition = labelPosition + 1;
  while (nextLabelPosition < labels.length && start === labels[nextLabelPosition].index) {
    start = labels[nextLabelPosition].start;
    nextLabelPosition += 1;
  }
  const next = labels[nextLabelPosition];
  return { start, end: next?.index ?? best.closing, opening: best.opening };
};

const extractDeadlineDecision = (tokens, triggerIndex, pairs, functionRanges) => {
  const ifDecision = findIfDecision(tokens, triggerIndex, pairs);
  if (ifDecision) {
    const conditionStart = ifDecision.start + 2;
    const consequentStart = ifDecision.closingCondition + 1;
    const consequentEnd = findControlledStatementEnd(tokens, consequentStart, tokens.length, pairs, false);
    const alternateStart = tokens[consequentEnd]?.value === 'else' ? consequentEnd + 1 : consequentEnd;
    const negated = isNegatedDeadlineCondition(tokens, conditionStart, triggerIndex);
    if (negated && alternateStart === consequentEnd) return { start: consequentEnd, end: consequentEnd, opening: null };
    return branchRange(
      tokens,
      negated ? alternateStart : consequentStart,
      negated ? findControlledStatementEnd(tokens, alternateStart, tokens.length, pairs) : consequentEnd,
      pairs
    );
  }
  const switchDecision = findSwitchDecision(tokens, triggerIndex, pairs);
  if (switchDecision) return switchDecision;
  const functionDecision = findFunctionDecision(functionRanges, triggerIndex);
  if (functionDecision) {
    if (functionDecision.expression) {
      return findConditionalExpressionDecision(
        tokens,
        triggerIndex,
        functionDecision.bodyStart,
        functionDecision.bodyEnd,
        pairs
      ) || { start: functionDecision.bodyStart, end: functionDecision.bodyEnd, opening: null };
    }
    const statement = findStatementRange(tokens, triggerIndex);
    const conditional = findConditionalExpressionDecision(tokens, triggerIndex, statement.start, statement.end, pairs);
    if (conditional) return conditional;
    if (triggerIndex < functionDecision.opening) {
      return { start: functionDecision.opening, end: functionDecision.opening, opening: null };
    }
    return { start: functionDecision.opening + 1, end: functionDecision.closing, opening: functionDecision.opening };
  }
  const statement = findStatementRange(tokens, triggerIndex);
  return findConditionalExpressionDecision(tokens, triggerIndex, statement.start, statement.end, pairs) || statement;
};

const BOUNDARY_WRITER_STATE_ARGUMENTS = new Map([
  ['boundary', 0],
  ['markIntakeBoundary', 1],
  ['recordBoundary', 2],
  ['recordOwnedBoundary', 2]
]);

const isBoundaryWriter = value => BOUNDARY_WRITER_STATE_ARGUMENTS.has(value);

const boundaryWriterStateArgument = value => BOUNDARY_WRITER_STATE_ARGUMENTS.get(value);

const trimExpressionRange = (tokens, start, end, pairs) => {
  while (start < end && tokens[end - 1]?.value === ';') end -= 1;
  while (start < end && tokens[start]?.value === '(' && pairs.get(start) === end - 1) {
    start += 1;
    end -= 1;
  }
  return { start, end };
};

const isGapMemberExpression = (tokens, start, end) => end - start === 3
  && tokens[start]?.type === 'identifier'
  && tokens[start + 1]?.value === '.'
  && tokens[start + 2]?.value === 'GAP';

const valueHasGapOutcome = (tokens, start, end, pairs, aliases = new Set()) => {
  const expression = trimExpressionRange(tokens, start, end, pairs);
  if (expression.start >= expression.end) return false;
  if (expression.end - expression.start === 1 && aliases.has(tokens[expression.start].value)) return true;
  if (isGapMemberExpression(tokens, expression.start, expression.end)) return true;
  if (valueHasGap(tokens, expression.start, expression.end, pairs, aliases)) return true;

  const wrapperStart = expression.start;
  const wrapperOpening = wrapperStart + 3;
  if (tokens[wrapperStart]?.value !== 'Promise'
    || tokens[wrapperStart + 1]?.value !== '.'
    || tokens[wrapperStart + 2]?.value !== 'resolve'
    || tokens[wrapperOpening]?.value !== '(') return false;
  const wrapperClosing = pairs.get(wrapperOpening);
  if (wrapperClosing !== expression.end - 1) return false;
  return valueHasGapOutcome(tokens, wrapperOpening + 1, wrapperClosing, pairs, aliases);
};

const callHasGapArgument = (tokens, opening, closing, pairs, stateArgument, aliases = new Set()) => {
  if (stateArgument === undefined) return false;
  let argumentStart = opening + 1;
  let argumentIndex = 0;
  let parenDepth = 0;
  let braceDepth = 0;
  let bracketDepth = 0;
  const check = argumentEnd => argumentIndex === stateArgument
    && valueHasGapOutcome(tokens, argumentStart, argumentEnd, pairs, aliases);
  for (let index = opening + 1; index < closing; index += 1) {
    const value = tokens[index].value;
    if (value === '(') parenDepth += 1;
    else if (value === ')') parenDepth -= 1;
    else if (value === '{') braceDepth += 1;
    else if (value === '}') braceDepth -= 1;
    else if (value === '[') bracketDepth += 1;
    else if (value === ']') bracketDepth -= 1;
    else if (value === ',' && parenDepth === 0 && braceDepth === 0 && bracketDepth === 0) {
      if (check(index)) return true;
      argumentStart = index + 1;
      argumentIndex += 1;
    }
  }
  return check(closing);
};

const hasGapOutcome = (tokens, start, end, opening, pairs, functionRanges, aliases = new Set()) => {
  const knownAliases = new Set(aliases);
  const nestedFunctionStarts = new Map(functionRanges
    .filter(range => range.opening !== opening && range.start >= start && range.opening < end)
    .map(range => [range.start, range]));
  for (let index = start; index < end; index += 1) {
    const nestedFunction = nestedFunctionStarts.get(index);
    if (nestedFunction) {
      index = nestedFunction.closing;
      continue;
    }
    const token = tokens[index];
    if (token.value === 'return') {
      const statementEnd = findStatementEnd(tokens, index + 1, end);
      const expressionStart = index + 1;
      if (valueHasGapOutcome(tokens, expressionStart, statementEnd, pairs, knownAliases)) return true;
      index = Math.max(index, statementEnd - 1);
      continue;
    }
    if (token.type === 'identifier' && tokens[index + 1]?.value === '.'
      && OUTCOME_NAMES.has(tokens[index + 2]?.value)
      && tokens[index + 3]?.value === '=') {
      const statementEnd = findStatementEnd(tokens, index + 4, end);
      if (valueHasGapOutcome(tokens, index + 4, statementEnd, pairs, knownAliases)) return true;
      index = Math.max(index, statementEnd - 1);
      continue;
    }
    if (token.type === 'identifier' && tokens[index - 1]?.value !== '.'
      && tokens[index + 1]?.value === '=') {
      const statementEnd = findStatementEnd(tokens, index + 2, end);
      const assignedGap = valueHasGapOutcome(tokens, index + 2, statementEnd, pairs, knownAliases);
      if (assignedGap) knownAliases.add(token.value);
      if (assignedGap && OUTCOME_NAMES.has(token.value)) return true;
      index = Math.max(index, statementEnd - 1);
      continue;
    }
    if (token.type === 'identifier' && isBoundaryWriter(token.value)
      && tokens[index + 1]?.value === '(' && tokens[index - 1]?.value !== 'function') {
      const closing = pairs.get(index + 1);
      if (closing !== undefined && closing < end
        && callHasGapArgument(tokens, index + 1, closing, pairs, boundaryWriterStateArgument(token.value), knownAliases)) return true;
    }
  }
  return opening === null && valueHasGapOutcome(tokens, start, end, pairs, knownAliases);
};

const isDeadlineTriggerAt = (tokens, index) => {
  const value = tokens[index]?.value;
  if (value === 'DEADLINE' || value === 'deadlineReached') return true;
  const dateNow = offset => tokens[index + offset]?.value === 'Date'
    && tokens[index + offset + 1]?.value === '.'
    && tokens[index + offset + 2]?.value === 'now'
    && tokens[index + offset + 3]?.value === '('
    && tokens[index + offset + 4]?.value === ')';
  const directComparison = dateNow(0)
    && ['>', '>='].includes(tokens[index + 5]?.value)
    && tokens[index + 6]?.value === 'deadline';
  const reverseComparison = value === 'deadline'
    && ['<', '<='].includes(tokens[index + 1]?.value)
    && dateNow(2);
  return directComparison || reverseComparison;
};

const findAssignedAlias = (tokens, triggerIndex) => {
  if (tokens[triggerIndex - 1]?.value === '=>' || tokens[triggerIndex + 1]?.value === '=>') return null;
  let statementStart = triggerIndex;
  while (statementStart > 0 && ![';', '{', '}'].includes(tokens[statementStart - 1].value)) statementStart -= 1;
  for (let index = statementStart; index < triggerIndex; index += 1) {
    if (tokens[index].value === '=>') return null;
    if (tokens[index].value !== '=' || tokens[index - 1]?.type !== 'identifier' || tokens[index - 2]?.value === '.') continue;
    return { name: tokens[index - 1].value, index: index - 1 };
  }
  return null;
};

const findLexicalScopes = (tokens, pairs) => tokens.flatMap((token, opening) => {
  if (token.value !== '{') return [];
  const closing = pairs.get(opening);
  return closing === undefined ? [] : [{ opening, closing }];
});

const lexicalScopePath = (scopes, index) => scopes
  .filter(scope => scope.opening < index && index < scope.closing)
  .sort((left, right) => left.opening - right.opening)
  .map(scope => scope.opening);

const isLexicallyVisible = (declarationScope, useScope) => declarationScope.every(
  (scope, index) => useScope[index] === scope
);

const findVariableDeclarations = (tokens, pairs, lexicalScopes) => {
  const declarations = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (!['const', 'let', 'var'].includes(tokens[index].value)) continue;
    const nameIndex = index + 1;
    const equalsIndex = nameIndex + 1;
    if (tokens[nameIndex]?.type !== 'identifier' || tokens[equalsIndex]?.value !== '=') continue;
    const statementEnd = findStatementEnd(tokens, equalsIndex + 1, tokens.length);
    declarations.push({
      name: tokens[nameIndex].value,
      index: nameIndex,
      scope: lexicalScopePath(lexicalScopes, nameIndex),
      expressionStart: equalsIndex + 1,
      expressionEnd: statementEnd
    });
  }
  return declarations;
};

const findFunctionParameterBindings = (tokens, pairs, lexicalScopes, functionRanges) => functionRanges.flatMap(range => {
  if (tokens[range.start]?.value === '=>') {
    const parameter = tokens[range.start - 1];
    if (parameter?.type === 'identifier') {
      return [{
        name: parameter.value,
        index: range.start - 1,
        scope: lexicalScopePath(lexicalScopes, range.opening + 1)
      }];
    }
  }
  let parameterOpening = -1;
  for (let index = range.start; index < range.opening; index += 1) {
    if (tokens[index].value === '(' && pairs.get(index) < range.opening) parameterOpening = index;
  }
  if (parameterOpening < 0) return [];
  const parameterClosing = pairs.get(parameterOpening);
  if (parameterClosing === undefined || parameterClosing >= range.opening) return [];
  const scope = lexicalScopePath(lexicalScopes, range.opening + 1);
  return tokens.slice(parameterOpening + 1, parameterClosing).flatMap((token, offset) => {
    const index = parameterOpening + 1 + offset;
    const previous = tokens[index - 1]?.value;
    return token.type === 'identifier' && ['(', ',', '...'].includes(previous)
      ? [{ name: token.value, index, scope }]
      : [];
  });
});

const collectLexicalBindings = (tokens, pairs, lexicalScopes, functionRanges) => [
  ...findVariableDeclarations(tokens, pairs, lexicalScopes),
  ...findFunctionParameterBindings(tokens, pairs, lexicalScopes, functionRanges)
];

const resolveVisibleBinding = (bindings, name, useIndex, lexicalScopes, useScope = null) => {
  const scope = useScope || lexicalScopePath(lexicalScopes, useIndex);
  const candidates = bindings
    .filter(binding => binding.name === name
      && binding.index < useIndex
      && isLexicallyVisible(binding.scope, scope))
    .sort((left, right) => left.scope.length - right.scope.length || left.index - right.index);
  return candidates[candidates.length - 1] || null;
};

const visibleGapAliasesAt = (tokens, limit, pairs, lexicalScopes, functionRanges, baseAliases = new Set()) => {
  const declarations = findVariableDeclarations(tokens, pairs, lexicalScopes)
    .filter(declaration => declaration.index < limit)
    .sort((left, right) => left.index - right.index);
  const bindings = collectLexicalBindings(tokens, pairs, lexicalScopes, functionRanges);
  const useScope = lexicalScopePath(lexicalScopes, limit);
  const knownAliases = new Set(baseAliases);
  for (const declaration of declarations) {
    if (!isLexicallyVisible(declaration.scope, useScope)) continue;
    const visibleBinding = resolveVisibleBinding(
      bindings,
      declaration.name,
      limit,
      lexicalScopes,
      useScope
    );
    if (!visibleBinding || visibleBinding.index !== declaration.index) continue;
    const assignedGap = valueHasGapOutcome(
      tokens,
      declaration.expressionStart,
      declaration.expressionEnd,
      pairs,
      knownAliases
    );
    if (assignedGap) knownAliases.add(declaration.name);
    else knownAliases.delete(declaration.name);
  }
  return knownAliases;
};

const isConditionalDeadlineUse = (tokens, triggerIndex, pairs, functionRanges) => {
  if (findIfDecision(tokens, triggerIndex, pairs) || findSwitchDecision(tokens, triggerIndex, pairs)) return true;
  const functionDecision = findFunctionDecision(functionRanges, triggerIndex);
  if (functionDecision?.expression) {
    return Boolean(findConditionalExpressionDecision(
      tokens,
      triggerIndex,
      functionDecision.bodyStart,
      functionDecision.bodyEnd,
      pairs
    ));
  }
  const statement = findStatementRange(tokens, triggerIndex);
  return Boolean(findConditionalExpressionDecision(tokens, triggerIndex, statement.start, statement.end, pairs));
};

const findDeadlineGapOffenders = entries => entries.flatMap(({ relative, source }) => {
  const tokens = tokenizeSource(source);
  const pairs = findTokenPairs(tokens);
  const functionRanges = findFunctionRanges(tokens, pairs);
  const lexicalScopes = findLexicalScopes(tokens, pairs);
  const lexicalBindings = collectLexicalBindings(tokens, pairs, lexicalScopes, functionRanges);
  const lines = new Set();
  const deadlineAliases = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (!isDeadlineTriggerAt(tokens, index)) continue;
    const alias = findAssignedAlias(tokens, index);
    if (alias) {
      deadlineAliases.push({
        ...alias,
        scope: lexicalScopePath(lexicalScopes, alias.index)
      });
      if (isConditionalDeadlineUse(tokens, index, pairs, functionRanges)) {
        const decision = extractDeadlineDecision(tokens, index, pairs, functionRanges);
        const knownAliases = visibleGapAliasesAt(
          tokens,
          decision.start,
          pairs,
          lexicalScopes,
          functionRanges
        );
        if (hasGapOutcome(
          tokens,
          decision.start,
          decision.end,
          decision.opening,
          pairs,
          functionRanges,
          knownAliases
        )) {
          lines.add(source.slice(0, tokens[index].start).split(/\r?\n/).length);
        }
      }
      continue;
    }
    const decision = extractDeadlineDecision(tokens, index, pairs, functionRanges);
    const knownAliases = visibleGapAliasesAt(
      tokens,
      decision.start,
      pairs,
      lexicalScopes,
      functionRanges
    );
    if (hasGapOutcome(
      tokens,
      decision.start,
      decision.end,
      decision.opening,
      pairs,
      functionRanges,
      knownAliases
    )) {
      lines.add(source.slice(0, tokens[index].start).split(/\r?\n/).length);
    }
  }
  for (const alias of deadlineAliases) {
    for (let index = 0; index < tokens.length; index += 1) {
      if (index === alias.index || tokens[index].value !== alias.name || tokens[index - 1]?.value === '.') continue;
      if (lexicalBindings.some(binding => binding.name === alias.name && binding.index === index)) continue;
      const binding = resolveVisibleBinding(lexicalBindings, alias.name, index, lexicalScopes);
      if (!binding || binding.index !== alias.index) continue;
      if (!isConditionalDeadlineUse(tokens, index, pairs, functionRanges)) continue;
      const decision = extractDeadlineDecision(tokens, index, pairs, functionRanges);
      const knownAliases = visibleGapAliasesAt(
        tokens,
        decision.start,
        pairs,
        lexicalScopes,
        functionRanges
      );
      if (hasGapOutcome(
        tokens,
        decision.start,
        decision.end,
        decision.opening,
        pairs,
        functionRanges,
        knownAliases
      )) {
        lines.add(source.slice(0, tokens[index].start).split(/\r?\n/).length);
      }
    }
  }
  return [...lines].sort((left, right) => left - right).map(line => `${relative}:${line}`);
});

test('deadline policy inventory has no direct deadline-to-gap decision', () => {
  const sourceRoot = path.join(__dirname, '../src');
  const offenders = findDeadlineGapOffenders(readSourceInventory(sourceRoot));
  assert.deepEqual(offenders, [], 'new deadline decisions must not map expiry directly to a history gap');
});

test('deadline policy inventory maps local boundary state arguments', () => {
  const offenders = findDeadlineGapOffenders([{
    relative: 'discord/thread-enrollment.ts',
    source: [
      'function boundary(state, detail, source) { persist(state, detail, source); }',
      'if (deadlineReached) boundary(THREAD_STATES.GAP, detail, source);'
    ].join('\n')
  }]);
  assert.deepEqual(offenders, ['discord/thread-enrollment.ts:2']);
});

test('deadline policy inventory ignores non-mutating boundary-shaped calls', () => {
  const offenders = findDeadlineGapOffenders([{
    relative: 'discord/readiness-predicate.js',
    source: 'if (deadlineReached) { assertReadiness(binding, READINESS.GAP); return READINESS.UNAVAILABLE; }'
  }]);
  assert.deepEqual(offenders, []);
});

test('deadline policy inventory ignores gap constants used as predicate inputs', () => {
  const offenders = findDeadlineGapOffenders([{
    relative: 'discord/readiness-predicate.js',
    source: 'if (deadlineReached) return allowed.includes(READINESS.GAP);'
  }]);
  assert.deepEqual(offenders, []);
});

test('deadline policy inventory follows inequality polarity', () => {
  const offenders = findDeadlineGapOffenders([
    {
      relative: 'strict-inequality.js',
      source: 'if (kind !== CODEX_VALIDATION_KINDS.DEADLINE) return READINESS.READY; else return READINESS.GAP;'
    },
    {
      relative: 'loose-inequality.js',
      source: 'if (kind != CODEX_VALIDATION_KINDS.DEADLINE) return READINESS.READY; else return READINESS.GAP;'
    }
  ]);
  assert.deepEqual(offenders, ['strict-inequality.js:1', 'loose-inequality.js:1']);
});

test('deadline policy inventory follows explicit boolean deadline polarity', () => {
  const offenders = findDeadlineGapOffenders([
    {
      relative: 'explicit-false-gap.js',
      source: 'if (deadlineReached === false) return READINESS.READY; else return READINESS.GAP;'
    },
    {
      relative: 'explicit-false-consequent-gap.js',
      source: 'if (deadlineReached === false) return READINESS.GAP; else return READINESS.READY;'
    },
    {
      relative: 'explicit-true-gap.js',
      source: 'if (deadlineReached !== true) return READINESS.READY; else return READINESS.GAP;'
    },
    {
      relative: 'explicit-true-consequent-gap.js',
      source: 'if (deadlineReached !== true) return READINESS.GAP; else return READINESS.READY;'
    }
  ]);
  assert.deepEqual(offenders, ['explicit-false-gap.js:1', 'explicit-true-gap.js:1']);
});

test('deadline aliases remain scoped to their lexical declaration', () => {
  const offenders = findDeadlineGapOffenders([{
    relative: 'deadline-alias-scope.js',
    source: [
      'function first() {',
      '  const expired = Date.now() >= deadline;',
      '  if (expired) return READINESS.GAP;',
      '}',
      'function second(expired) {',
      '  if (expired) return READINESS.GAP;',
      '}'
    ].join('\n')
  }]);
  assert.deepEqual(offenders, ['deadline-alias-scope.js:3']);
});

test('deadline policy inventory follows gap aliases declared before the branch', () => {
  const offenders = findDeadlineGapOffenders([{
    relative: 'deadline-gap-alias.js',
    source: [
      'const nextState = READINESS.GAP;',
      'if (deadlineReached) return nextState;'
    ].join('\n')
  }]);
  assert.deepEqual(offenders, ['deadline-gap-alias.js:2']);
});

test('deadline policy inventory respects nested alias shadowing', () => {
  const offenders = findDeadlineGapOffenders([{
    relative: 'deadline-alias-shadow.js',
    source: [
      'function outer() {',
      '  const expired = Date.now() >= deadline;',
      '  function inner(expired) {',
      '    if (expired) return READINESS.GAP;',
      '  }',
      '}'
    ].join('\n')
  }]);
  assert.deepEqual(offenders, []);
});

test('deadline aliases remain shadowed by concise arrow parameters', () => {
  const offenders = findDeadlineGapOffenders([{
    relative: 'deadline-alias-concise-arrow.js',
    source: [
      'const expired = Date.now() >= deadline;',
      'const choose = expired => expired ? READINESS.GAP : READINESS.READY;'
    ].join('\n')
  }]);
  assert.deepEqual(offenders, []);
});

test('deadline policy inventory ignores gap returns declared in class methods', () => {
  const offenders = findDeadlineGapOffenders([{
    relative: 'deadline-class-method.js',
    source: [
      'if (deadlineReached) {',
      '  class Policy {',
      '    constructor() { return READINESS.GAP; }',
      '    fallback() { return READINESS.GAP; }',
      '  }',
      '  return READINESS.UNAVAILABLE;',
      '}'
    ].join('\n')
  }]);
  assert.deepEqual(offenders, []);
});

test('deadline policy inventory catches object-shaped gap decisions', () => {
  const offenders = findDeadlineGapOffenders([{
    relative: 'discord/inbound-recovery.js',
    source: "if (Date.now() >= deadline) return { ready: false, state: 'gap', detail: 'history unavailable' };"
  }]);
  assert.deepEqual(offenders, ['discord/inbound-recovery.js:1']);
});

test('deadline policy inventory recognizes computed gap constants', () => {
  const offenders = findDeadlineGapOffenders([
    {
      relative: 'discord/computed-return.js',
      source: "if (deadlineReached) return READINESS['GAP'];"
    },
    {
      relative: 'discord/computed-template-return.js',
      source: 'if (deadlineReached) return THREAD_STATES[`GAP`];'
    },
    {
      relative: 'discord/computed-object-return.js',
      source: "if (deadlineReached) return { state: READINESS['GAP'] };"
    },
    {
      relative: 'discord/computed-writer.js',
      source: "if (deadlineReached) state.markIntakeBoundary(id, READINESS['GAP'], detail);"
    },
    {
      relative: 'discord/computed-template-writer.js',
      source: 'if (deadlineReached) state.markIntakeBoundary(id, THREAD_STATES[`GAP`], detail);'
    }
  ]);
  assert.deepEqual(offenders, [
    'discord/computed-return.js:1',
    'discord/computed-template-return.js:1',
    'discord/computed-object-return.js:1',
    'discord/computed-writer.js:1',
    'discord/computed-template-writer.js:1'
  ]);
});

test('deadline policy inventory scans complete outcomes and ignores unrelated gaps', () => {
  const entries = [
    {
      relative: 'discord/multiline-owner.js',
      source: [
        'if (deadlineReached) {',
        '  return {',
        '    ready: false,',
        "    detail: 'expired',",
        "    state: 'gap'",
        '  };',
        '}'
      ].join('\n')
    },
    {
      relative: 'discord/multiline-assignment.js',
      source: [
        'const state = deadlineReached',
        '  ? READINESS.GAP',
        '  : READINESS.READY;'
      ].join('\n')
    },
    {
      relative: 'discord/member-assignment.js',
      source: 'if (deadlineReached) result.state = READINESS.GAP;'
    },
    {
      relative: 'discord/braced-member-assignment.js',
      source: [
        'if (deadlineReached) {',
        '  result.state = READINESS.GAP;',
        '  return result;',
        '}'
      ].join('\n')
    },
    {
      relative: 'discord/parenthesized-return.js',
      source: 'if (deadlineReached) return (READINESS.GAP);'
    },
    {
      relative: 'discord/wrapped-return.js',
      source: 'if (deadlineReached) return Promise.resolve(READINESS.GAP);'
    },
    {
      relative: 'discord/parenthesized-object-return.js',
      source: "if (deadlineReached) return ({ state: 'gap' });"
    },
    {
      relative: 'discord/unavailable-owner.js',
      source: [
        'if (deadlineReached) {',
        "  return { ready: false, state: 'unavailable' };",
        '}'
      ].join('\n')
    },
    {
      relative: 'discord/reversed-timestamp-deadline.js',
      source: 'if (deadline <= Date.now()) return READINESS.GAP;'
    },
    {
      relative: 'discord/reversed-strict-timestamp-deadline.js',
      source: 'if (deadline < Date.now()) return READINESS.GAP;'
    },
    {
      relative: 'discord/strict-timestamp-deadline.js',
      source: 'if (Date.now() > deadline) return READINESS.GAP;'
    },
    {
      relative: 'discord/retry-owner.js',
      source: [
        'if (deadlineReached) {',
        "  return { ready: false, state: 'retry' };",
        '}'
      ].join('\n')
    },
    {
      relative: 'discord/unrelated-gap.js',
      source: [
        'if (deadlineReached) {',
        "  return { ready: false, state: 'retry' };",
        '}',
        "const history = { state: 'gap' };"
      ].join('\n')
    },
    {
      relative: 'discord/nested-gap.js',
      source: [
        'if (deadlineReached) {',
        '  if (shouldRetry) {',
        "    return { state: 'gap' };",
        '  }',
        "  return { state: 'retry' };",
        '}'
      ].join('\n')
    },
    {
      relative: 'discord/nested-object-gap.js',
      source: [
        'if (deadlineReached) {',
        "  return { detail: { state: 'gap' } };",
        '}'
      ].join('\n')
    }
  ];
  assert.deepEqual(findDeadlineGapOffenders(entries), [
    'discord/multiline-owner.js:1',
    'discord/multiline-assignment.js:1',
    'discord/member-assignment.js:1',
    'discord/braced-member-assignment.js:1',
    'discord/parenthesized-return.js:1',
    'discord/wrapped-return.js:1',
    'discord/parenthesized-object-return.js:1',
    'discord/reversed-timestamp-deadline.js:1',
    'discord/reversed-strict-timestamp-deadline.js:1',
    'discord/strict-timestamp-deadline.js:1',
    'discord/nested-gap.js:1'
  ]);
});

test('deadline policy inventory binds lexical and persistence controls to the deadline branch', () => {
  const entries = [
    {
      relative: 'discord/braceless-gap.js',
      source: [
        'if (deadlineReached) return READINESS.GAP;',
        'function later() { return READINESS.UNAVAILABLE; }'
      ].join('\n')
    },
    {
      relative: 'discord/braceless-safe.js',
      source: [
        'if (deadlineReached) return READINESS.UNAVAILABLE;',
        'function later() { return READINESS.GAP; }'
      ].join('\n')
    },
    {
      relative: 'discord/braceless-safe-asi.js',
      source: [
        'if (deadlineReached) return READINESS.UNAVAILABLE',
        'function later() { return READINESS.GAP; }'
      ].join('\n')
    },
    {
      relative: 'discord/comment-brace.js',
      source: [
        'if (deadlineReached) { // }',
        "  return 'gap';",
        '}'
      ].join('\n')
    },
    {
      relative: 'discord/comment-decoy.js',
      source: [
        "if (deadlineReached) return READINESS.UNAVAILABLE; // state: 'gap'",
        'const regex = /return gap/;'
      ].join('\n')
    },
    {
      relative: 'discord/regex-brace.js',
      source: [
        'if (deadlineReached) {',
        '  const regex = /}/;',
        '  return READINESS.GAP;',
        '}'
      ].join('\n')
    },
    {
      relative: 'discord/template-return.js',
      source: 'if (deadlineReached) return `gap`;'
    },
    {
      relative: 'discord/template-property.js',
      source: 'if (deadlineReached) return { state: `gap` };'
    },
    {
      relative: 'discord/template-decoy.js',
      source: 'if (deadlineReached) return { detail: `state: gap` };'
    },
    {
      relative: 'discord/persistence-gap.js',
      source: 'if (deadlineReached) state.markIntakeBoundary(id, READINESS.GAP, detail);'
    },
    {
      relative: 'discord/owned-boundary-gap.js',
      source: 'if (deadlineReached) state.recordBoundary(binding, null, READINESS.GAP, detail);'
    },
    {
      relative: 'discord/owned-boundary-owned-gap.js',
      source: 'if (deadlineReached) state.recordOwnedBoundary(binding, null, READINESS.GAP, detail);'
    },
    {
      relative: 'discord/persistence-safe.js',
      source: "if (deadlineReached) state.markIntakeBoundary(id, READINESS.UNAVAILABLE, 'gap');"
    }
  ];
  assert.deepEqual(findDeadlineGapOffenders(entries), [
    'discord/braceless-gap.js:1',
    'discord/comment-brace.js:1',
    'discord/regex-brace.js:1',
    'discord/template-return.js:1',
    'discord/template-property.js:1',
    'discord/persistence-gap.js:1',
    'discord/owned-boundary-gap.js:1',
    'discord/owned-boundary-owned-gap.js:1'
  ]);
});

test('deadline policy inventory catches new owners while allowing unavailable classifiers and ordinary deadlines', () => {
  const entries = [
    {
      relative: 'discord/new-owner.js',
      source: "const state = deadlineReached ? READINESS.GAP : READINESS.READY;"
    },
    {
      relative: 'discord/decoy-classifier.js',
      source: "function recoveryDeadlineClassifier(deadlineReached) { return deadlineReached ? READINESS.GAP : READINESS.READY; }"
    },
    {
      relative: 'discord/adjacent-classifier-call.js',
      source: "if (deadlineReached) { classifyRecoveryFailure(error); return READINESS.GAP; }"
    },
    {
      relative: 'discord/new-timestamp-owner.js',
      source: "if (Date.now() >= deadline) return READINESS.GAP;"
    },
    {
      relative: 'discord/new-string-timestamp-owner.js',
      source: "if (Date.now() >= deadline) return 'gap';"
    },
    {
      relative: 'discord/recovery-fetch.ts',
      source: "function classifyRecoveryFailure(deadlineReached) { return deadlineReached ? READINESS.UNAVAILABLE : READINESS.READY; }"
    },
    {
      relative: 'discord/ordinary-deadline.js',
      source: "if (deadlineReached) return RETRY;"
    },
    {
      relative: 'discord/ordinary-timestamp.js',
      source: "if (Date.now() >= deadline) return RETRY;"
    }
  ];
  assert.deepEqual(findDeadlineGapOffenders(entries), [
    'discord/new-owner.js:1',
    'discord/decoy-classifier.js:1',
    'discord/adjacent-classifier-call.js:1',
    'discord/new-timestamp-owner.js:1',
    'discord/new-string-timestamp-owner.js:1'
  ]);
});

test('deadline policy inventory follows aliases and selected control arms', () => {
  const entries = [
    {
      relative: 'discord/parenthesized-object-property.js',
      source: 'if (deadlineReached) return { state: (READINESS.GAP) };'
    },
    {
      relative: 'discord/concise-arrow-gap.js',
      source: 'const decide = deadlineReached => deadlineReached ? READINESS.GAP : READINESS.READY;'
    },
    {
      relative: 'discord/aliased-classifier-gap.js',
      source: 'const nextState = deadlineReached ? READINESS.GAP : READINESS.READY;'
    },
    {
      relative: 'discord/aliased-writer-gap.js',
      source: 'if (deadlineReached) { const nextState = READINESS.GAP; recordBoundary(binding, null, nextState, detail); }'
    },
    {
      relative: 'discord/negated-deadline-gap.js',
      source: 'if (!deadlineReached) return READINESS.READY; else return READINESS.GAP;'
    },
    {
      relative: 'discord/aliased-deadline-gap.js',
      source: 'const expired = Date.now() >= deadline; if (expired) return READINESS.GAP;'
    },
    {
      relative: 'discord/comparison-gap-negative.js',
      source: 'if (deadlineReached) return current === READINESS.GAP ? READINESS.UNAVAILABLE : READINESS.PENDING;'
    },
    {
      relative: 'discord/non-deadline-else-negative.js',
      source: 'if (deadlineReached) return READINESS.UNAVAILABLE; else return READINESS.GAP;'
    },
    {
      relative: 'discord/switch-arm-negative.js',
      source: 'switch (kind) { case DEADLINE: return READINESS.UNAVAILABLE; default: return READINESS.GAP; }'
    },
    {
      relative: 'discord/normal-ternary-negative.js',
      source: 'function decide() { return Date.now() >= deadline ? READINESS.UNAVAILABLE : READINESS.GAP; }'
    },
    {
      relative: 'discord/parameter-ternary-negative.js',
      source: 'function decide(deadlineReached) { return deadlineReached ? READINESS.UNAVAILABLE : READINESS.GAP; }'
    }
  ];
  assert.deepEqual(findDeadlineGapOffenders(entries), [
    'discord/parenthesized-object-property.js:1',
    'discord/concise-arrow-gap.js:1',
    'discord/aliased-classifier-gap.js:1',
    'discord/aliased-writer-gap.js:1',
    'discord/negated-deadline-gap.js:1',
    'discord/aliased-deadline-gap.js:1'
  ]);
});

test('pre-adoption retry classifier sites stay in the audited owners', () => {
  const registered = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8')).scripts.test.split(/\s+/);
  assert.equal(registered.filter(value => value === 'test/intake-recovery-boundaries.test.js').length, 1,
    'the retry-classifier inventory must execute exactly once in npm test');
  const sourceRoot = path.join(__dirname, '../src');
  const sites = new Map();
  for (const { relative, source } of readSourceInventory(sourceRoot)) {
    const count = source.match(/\bisPreAdoptionRetryableThread\b/g)?.length || 0;
    if (count) sites.set(relative, count);
  }
  assert.deepEqual(Object.fromEntries([...sites].sort(([left], [right]) => left.localeCompare(right))), {
    'discord.js': 9,
    'discord/inbound-recovery.js': 1,
    'discord/lifecycle.js': 1,
    'discord/recovery-fetch.ts': 1,
    'discord/thread-enrollment.ts': 3
  }, 'new retryability consumers must join the class inventory before using this policy');
});

test('G2: page-bound exhaustion still records a gap', CASES, async t => {
  const f = fixture(t);
  f.gateway.historyMaxPages = 1;
  f.history.set('1000', [f.message('101', '1000'), f.message('102', '1000')]);

  const result = await f.recover();
  assert.equal(result.ready, false);
  assert.equal(result.state, 'gap');
  const boundary = f.boundary('1000');
  assert.equal(boundary.state, 'gap');
  assert.match(boundary.detail, /history page bound 1 reached/);
  assert.equal(f.cursor('1000'), '101');
  assert.equal(f.state.getMessage('101').state, 'accepted');
});
