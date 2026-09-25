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

test('R4b: shared deadline preserves an unvisited ready binding', CASES, async t => {
  const f = fixture(t);
  f.state.bind({ channelId: '3000', guildId: 'guild', provider: 'codex',
    nativeId: '33333333-3333-3333-3333-333333333333', workspace: f.secret });
  f.state.setIntakeBaseline('3000', '100', 'fixture');
  f.state.markIntakeBoundary('3000', 'ready');
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

  try {
    await f.recover();
  } finally {
    Date.now = realNow;
    f.gateway.consumer.intakeMessage = realIntake;
  }

  assert.equal(advanced, true);
  assert.equal(f.state.getIntakeWatermark('3000').state, 'ready');
  assert.equal(f.state.getBinding('3000').readiness, 'ready');
});

for (const [label, empty] of [['R4c', false], ['R4d', true]]) {
test(`${label}: reconnect deadline preserves ${empty ? 'an empty' : 'a'} ready watermark after pause`, CASES, async t => {
  const f = fixture(t);
  f.state.bind({ channelId: '3000', guildId: 'guild', provider: 'codex',
    nativeId: '33333333-3333-3333-3333-333333333333', workspace: f.secret });
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
    assert.equal(recovered.ready, true, JSON.stringify(recovered));
    assert.equal(f.boundary('2000').state, 'ready');
    if (adopted) {
      f.enableDelivery();
      await f.gateway.reconcilePending(undefined, { readyOnly: true });
      await f.gateway.consumer.waitForNativeWork();
      assert.equal(f.state.getMessage('101').state, 'replied');
      assert.equal(f.dispatched.filter(item => item.id === '101').length, 1);
    } else {
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

test('R7a: old timeout gap without a baseline cursor stays held after database reopen', CASES, async t => {
  const f = fixture(t);
  const owner = f.state.getBinding('1000');
  f.state.markIntakeBoundary('1000', 'gap', LEGACY_TIMEOUT_DETAIL, null, null, owner);
  f.state.db.prepare('UPDATE intake_watermarks SET recovered_through_id=NULL, gap_from=NULL, gap_to=NULL WHERE channel_id=?').run('1000');
  assert.equal(f.state.getIntakeWatermark('1000').recovered_through_id, null);
  assert.equal(f.state.acceptDiscordMessage(operatorMessage(f, '101', '1000'), { ready: false }).accepted, true);
  f.history.set('1000', [f.message('101', '1000')]);
  await f.reopen();

  f.enableDelivery();
  const result = await f.recover();
  assert.equal(result.ready, false, JSON.stringify(result));
  assert.equal(result.state, 'gap');
  assert.equal(f.boundary('1000').state, 'gap');
  assert.equal(f.boundary('1000').detail, LEGACY_TIMEOUT_DETAIL);
  assert.equal(f.calls.filter(call => call.kind === 'history' && call.id === '1000').length, 0);
  assert.equal(f.dispatched.length, 0);
  assert.equal(f.state.getMessage('101').state, 'accepted');
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
  { name: 'legacy detail with coverage bounds', detail: LEGACY_TIMEOUT_DETAIL, gapFrom: '100', gapTo: '101' },
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

test('deadline policy inventory has no direct deadline-to-gap decision outside its classifier', () => {
  const sourceRoot = path.join(__dirname, '../src');
  const files = ['discord.js', 'discord/thread-enrollment.ts'];
  const offenders = [];
  for (const relative of files) {
    const lines = fs.readFileSync(path.join(sourceRoot, relative), 'utf8').split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      if (!/\b(?:DEADLINE|deadlineReached)\b/.test(lines[index])) continue;
      const window = lines.slice(index, index + 4).join('\n');
      if (/\b(?:READINESS\.GAP|THREAD_STATES\.GAP)\b|\?\s*['"]gap['"]/.test(window)) {
        offenders.push(`${relative}:${index + 1}`);
      }
    }
  }
  assert.deepEqual(offenders, [], 'new deadline decisions must use the shared recovery classifier');
});

test('pre-adoption retry classifier sites stay in the audited owners', () => {
  const sourceRoot = path.join(__dirname, '../src');
  const collect = directory => fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return collect(absolute);
    return /\.(?:js|ts)$/.test(entry.name) ? [absolute] : [];
  });
  const sites = new Map();
  for (const file of collect(sourceRoot)) {
    const source = fs.readFileSync(file, 'utf8');
    const count = source.match(/\bisPreAdoptionRetryableThread\b/g)?.length || 0;
    if (count) sites.set(path.relative(sourceRoot, file).split(path.sep).join('/'), count);
  }
  assert.deepEqual(Object.fromEntries([...sites].sort(([left], [right]) => left.localeCompare(right))), {
    'discord.js': 10,
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
