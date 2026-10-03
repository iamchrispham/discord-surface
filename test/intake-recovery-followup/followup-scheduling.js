const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('../helpers/intake-recovery-fixture');
const { recoverThread } = require('../../src/discord/thread-enrollment');
const { waitForRecoveryOperation } = require('../../src/discord');
const { settleRecovery } = require('./settle-recovery');

function injectArrivals(f, count = 1) {
  const original = f.state.markIntakeBoundary.bind(f.state);
  let inserted = 0;
  f.state.markIntakeBoundary = (...args) => {
    if (args[0] === '1000' && args[1] === 'ready' && inserted < count) {
      const id = String(101 + inserted++);
      const binding = f.state.getBinding('1000');
      assert.equal(f.state.acceptDiscordMessage({ ...f.message(id, '1000'),
        authorId: 'operator', isBot: false, attachments: [] },
      { expectedBinding: binding, ready: false }).accepted, true);
      f.history.set('1000', Array.from({ length: inserted }, (_, i) => f.message(String(101 + i), '1000')));
    }
    return original(...args);
  };
  return () => inserted;
}

function pauseFollowup(f) {
  const original = f.gateway.fetchHistory;
  let parentCalls = 0;
  let reached;
  let release;
  const entered = new Promise(resolve => { reached = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  f.gateway.fetchHistory = async (channel, options) => {
    if (channel.id === '1000' && ++parentCalls === 2) {
      reached();
      await held;
    }
    return original(channel, options);
  };
  return { entered, release };
}

test('stop settles active recovery and queued followup', { timeout: 3000 }, async t => {
  const f = fixture(t);
  injectArrivals(f);
  const pause = pauseFollowup(f);
  try {
    const operation = f.gateway.recoverTransport('startup');
    await pause.entered;
    await f.gateway.stop();
    const result = await operation;
    assert.equal(result.ready, false);
    assert.equal(result.state, 'stopped');
    assert.equal(f.state.getMessage('101').state, 'accepted');
    assert.equal(f.dispatched.length, 0);
  } finally { pause.release(); }
});

test('queued followup retains a newer explicit gap', { timeout: 3000 }, async t => {
  const f = fixture(t);
  injectArrivals(f);
  const pause = pauseFollowup(f);
  try {
    const operation = f.gateway.recoverTransport('startup');
    await pause.entered;
    f.state.markIntakeBoundary('1000', 'gap', 'new explicit hold');
    pause.release();
    const result = await operation;
    assert.equal(result.ready, false);
    assert.equal(f.boundary('1000').state, 'gap');
    assert.equal(f.boundary('1000').detail, 'new explicit hold');
    assert.equal(f.state.getMessage('101').state, 'accepted');
    assert.equal(f.dispatched.length, 0);
  } finally { pause.release(); }
});

test('initial caller includes three consecutive arrival followups', { timeout: 3000 }, async t => {
  const f = fixture(t);
  const inserted = injectArrivals(f, 3);
  const result = await settleRecovery(f.gateway.recoverTransport('startup'));
  assert.equal(result.ready, true);
  assert.equal(inserted(), 3);
  assert.equal(f.boundary('1000').state, 'ready');
  assert.equal(f.boundary('1000').recovered_through_id, '103');
  for (const id of ['101', '102', '103']) assert.equal(f.state.getMessage(id).state, 'accepted');
  assert.equal(f.dispatched.length, 0);
});


test('selected recovery remains selected after an arrival followup', { timeout: 3000 }, async t => {
  const f = fixture(t);
  f.state.bind({ channelId: '3000', guildId: 'guild', provider: 'codex',
    nativeId: '33333333-3333-4333-8333-333333333333', workspace: f.state.getBinding('1000').workspace }, { intakeCutoff: '100' });
  f.state.setIntakeBaseline('3000', '100', 'fixture');
  f.state.markIntakeBoundary('3000', 'ready');
  f.channels.set('3000', { ...f.channels.get('1000'), id: '3000' });
  f.history.set('3000', []);
  f.fail({ kind: 'history', id: '3000', status: 403 });
  injectArrivals(f);
  const result = await f.gateway.recoverTransport('startup', f.gateway.lifecycleEpoch, ['1000']);
  assert.equal(f.boundary('1000').state, 'ready');
  assert.equal(f.state.getIntakeWatermark('3000').state, 'ready', 'selected recovery must not alter an unrelated binding');
  assert.equal(result.ready, true);
  assert.equal(f.calls.some(call => call.id === '3000'), false);
  assert.equal(f.state.getMessage('101').state, 'accepted');
  assert.equal(f.dispatched.length, 0);
});

test('queued scoped recovery starts with a fresh deadline', { timeout: 3000 }, async t => {
  const f = fixture(t);
  for (const [channelId, nativeId] of [
    ['3000', '33333333-3333-4333-8333-333333333333'],
    ['4000', '44444444-4444-4444-8444-444444444444']
  ]) {
    f.state.bind({ channelId, guildId: 'guild', provider: 'codex',
      nativeId, workspace: f.state.getBinding('1000').workspace }, { intakeCutoff: '100' });
    f.state.setIntakeBaseline(channelId, '100', 'fixture');
    f.state.markIntakeBoundary(channelId, 'ready');
    f.channels.set(channelId, { ...f.channels.get('1000'), id: channelId });
    f.history.set(channelId, []);
  }
  const realNow = Date.now;
  let clock = 1_000_000;
  Date.now = () => clock;
  f.gateway.recoveryTimeoutMs = 5000;
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  t.after(() => { Date.now = realNow; release(); });
  const records = [];
  let active = 0, peak = 0;
  f.gateway.recoverInbound = async (signal, reason, lifecycle, scope, deadline) => {
    active++;
    peak = Math.max(peak, active);
    records.push({ reason, scope: scope === null ? null : [...scope], deadline, enteredAt: clock });
    try {
      if (reason === 'active') { entered(); await held; }
      if (scope !== null && scope.has('3000')) clock = deadline + 1;
      return { ready: true, state: 'ready' };
    } finally { active--; }
  };
  try {
    const activeRun = f.gateway.recoverTransport('active', f.gateway.lifecycleEpoch, ['1000'], Date.now() + 1000);
    await started;
    const first = f.gateway.recoverTransport('expired-first', f.gateway.lifecycleEpoch, ['3000'], Date.now() - 1);
    const second = f.gateway.recoverTransport('expired-second', f.gateway.lifecycleEpoch, ['4000'], Date.now() - 1);
    release();
    await settleRecovery(activeRun);
    await settleRecovery(first);
    await settleRecovery(second);
    await f.gateway.recoveryFollowupPromise;
    assert.deepEqual(records.map(record => record.scope), [['1000'], ['3000'], ['4000']]);
    assert.equal(peak, 1);
    const firstQueued = records.find(record => record.scope && record.scope.includes('3000'));
    const secondQueued = records.find(record => record.scope && record.scope.includes('4000'));
    assert.equal(firstQueued.deadline, firstQueued.enteredAt + f.gateway.recoveryTimeoutMs);
    assert.equal(secondQueued.deadline, secondQueued.enteredAt + f.gateway.recoveryTimeoutMs);
    assert.ok(secondQueued.deadline > firstQueued.deadline);
    assert.equal(f.dispatched.length, 0);
  } finally { Date.now = realNow; release(); }
});

for (let hops = 0; hops <= 8; hops++) {
  test(`reconciliation and followup remain serialized at microtask ${hops}`, { timeout: 3000 }, async t => {
    const f = fixture(t);
    let release, entered, active = 0, peak = 0;
    const held = new Promise(resolve => { release = resolve; });
    const started = new Promise(resolve => { entered = resolve; });
    const operation = async reason => {
      active++; peak = Math.max(peak, active);
      if (reason === 'first') { entered(); await held; }
      else for (let step = 0; step < 5; step++) await Promise.resolve();
      active--;
      return { ready: true, state: 'ready' };
    };
    f.gateway.recoverInbound = async (_signal, reason) => operation(reason);
    f.gateway._reconcilePending = async () => { await operation('reconcile'); return []; };
    const first = f.gateway.recoverTransport('first');
    await started;
    const reconciliation = f.gateway.reconcilePending(undefined, { allowPaused: true });
    let late = Promise.resolve();
    for (let hop = 0; hop < hops; hop++) late = late.then(() => {});
    late = late.then(() => f.gateway.recoverTransport('followup'));
    release();
    await settleRecovery(Promise.all([first, late, reconciliation]));
    assert.equal(peak, 1, 'recovery and reconciliation must never own the slot together');
  });
}

for (let hops = 0; hops <= 8; hops++) {
  test(`coordinator drains arrivals ${hops} microtasks after completion`, { timeout: 3000 }, async t => {
    const f = fixture(t);
    const seen = [];
    f.gateway.recoverInbound = async (_signal, reason) => {
      seen.push(reason);
      return { ready: true, state: 'ready' };
    };
    const first = f.gateway.recoverTransport('first');
    const queued = f.gateway.recoverTransport('queued');
    let late = queued;
    for (let hop = 0; hop < hops; hop++) late = late.then(() => {});
    late = late.then(() => f.gateway.recoverTransport('late'));
    await settleRecovery(Promise.all([first, queued, late]));
    assert.deepEqual(seen, ['first', 'queued', 'late']);
    await f.gateway.recoveryFollowupPromise;
    assert.equal(f.gateway.pendingRecoveryRequests.length, 0);
  });
}

test('live custody arriving after the ready write is covered before recovery settles', { timeout: 4000 }, async t => {
  const f = fixture(t);
  const original = f.state.markIntakeBoundary.bind(f.state);
  let injected = false;
  f.state.markIntakeBoundary = (...args) => {
    const result = original(...args);
    if (!injected && args[0] === '1000' && args[1] === 'ready' && result) {
      injected = true;
      const message = { ...f.message('101', '1000'), authorId: 'operator', isBot: false, attachments: [] };
      assert.equal(f.state.acceptDiscordMessage(message, { expectedBinding: f.state.getBinding('1000'), ready: false }).accepted, true);
      f.history.set('1000', [f.message('101', '1000')]);
    }
    return result;
  };
  await settleRecovery(f.gateway.recoverTransport('startup'));
  assert.ok(injected);
  assert.equal(f.state.getBinding('1000').readiness, 'ready');
  assert.equal(f.cursor('1000'), '101');
  assert.equal(f.state.getMessage('101').state, 'accepted');
  assert.equal(f.dispatched.length, 0);
});

test('selected thread recovery reports failure while its route remains held', async t => {
  const f = fixture(t);
  f.fail({ kind: 'channel', id: '2000', status: 403 });
  const result = await settleRecovery(f.gateway.recoverTransport('selected', f.gateway.lifecycleEpoch, ['2000']));
  assert.equal(f.boundary('2000').state, 'unavailable');
  assert.equal(result.ready, false);
  assert.equal(f.dispatched.length, 0);
});

for (const kind of ['channel', 'history']) {
  test(`selected pre-adoption ${kind} 503 remains unresolved without a retry loop`, async t => {
    const f = fixture(t, { adoptThread: false });
    f.fail({ kind, id: '2000', status: 503 });
    const result = await settleRecovery(f.gateway.recoverTransport('selected', f.gateway.lifecycleEpoch, ['2000']));
    assert.equal(result.ready, false);
    assert.equal(f.state.getThreadEnrollment('2000').state, 'pending');
    assert.equal(f.state.getThreadEnrollment('2000').adoptedAt, null);
    assert.equal(f.calls.filter(c => c.kind === kind && c.id === '2000').length, 1);
    assert.equal(Boolean(f.gateway.liveCheckpointRetryTimer), false);
    assert.equal(f.dispatched.length, 0);
  });
}

test('live attachment recovery preserves a verified empty cursor', { timeout: 4000 }, async t => {
  const f = fixture(t);
  f.state.db.prepare(`UPDATE intake_watermarks
    SET state='ready', last_seen_id=NULL, recovered_through_id=NULL
    WHERE channel_id=?`).run('1000');
  const binding = f.state.getBinding('1000');
  const message = { ...f.message('101', '1000'), authorId: 'operator', isBot: false, attachments: [] };

  await f.gateway.recordLiveAttachmentGap(message, binding, new Error('attachment fetch failed'));
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline && f.boundary('1000').state !== 'ready') {
    await new Promise(resolve => setTimeout(resolve, 10));
  }

  assert.equal(f.boundary('1000').state, 'ready');
  assert.equal(f.boundary('1000').recovered_through_id, '0');
});
