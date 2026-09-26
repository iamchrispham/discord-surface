const test = require('node:test');
const assert = require('node:assert/strict');

const { fixture } = require('./helpers/intake-recovery-fixture');
const { createTestGate, waitForCondition, READINESS, THREAD_STATES } = require('./agent-attachment-fixture');

// recoverTransport settlement must re-read live thread enrollment state instead of
// trusting a pass result. These cases pin the terminal/pending gates on the unscoped
// own-result shortcut, the fresh-enrollment re-read behind it, and the follow-up guard.

for (const terminal of [THREAD_STATES.GAP, THREAD_STATES.UNAVAILABLE]) {
  test(`P2 direct recoverInbound: active ${terminal} child blocks readiness while parent custody is retained`, async t => {
    const f = fixture(t);
    const binding = f.state.getBinding('1000');
    const accepted = f.state.acceptDiscordMessage(
      { ...f.message('101', '2000'), authorId: 'operator', isBot: false, attachments: [] },
      { expectedBinding: binding }
    );
    assert.equal(accepted.accepted, true);
    assert.equal(f.state.getMessage('101').state, 'accepted');
    const custodyBefore = f.cursor('2000');
    f.state.markThreadBoundary('2000', terminal, `terminal child ${terminal}`, '100', '202', binding);

    const result = await f.recover();

    assert.equal(result.ready, false);
    assert.equal(result.state, terminal);
    assert.equal(f.boundary('2000').state, terminal);
    assert.equal(f.cursor('2000'), custodyBefore, 'accepted thread custody must survive the failed pass');
    assert.equal(f.state.getMessage('101').state, 'accepted');
    assert.equal(f.state.getBinding('1000').readiness, READINESS.READY);
    assert.equal(f.state.getIntakeWatermark('1000').state, READINESS.READY);
  });
}

test('P2 unscoped recoverTransport reports not ready while a terminal child is unresolved', async t => {
  const f = fixture(t);
  const binding = f.state.getBinding('1000');
  f.state.markThreadBoundary('2000', THREAD_STATES.UNAVAILABLE, 'terminal child hold', '100', '202', binding);

  const result = await f.gateway.recoverTransport('restart', f.gateway.lifecycleEpoch);

  assert.equal(result.ready, false);
  assert.equal(result.state, THREAD_STATES.UNAVAILABLE);
  assert.equal(f.state.getBinding('1000').readiness, READINESS.READY);
});

test('P3 unscoped waiter with a ready own pass and a pending child settles not ready', async t => {
  const f = fixture(t, { adoptThread: false });
  f.gateway.recoverInbound = async () => ({ ready: true, state: 'ready' });

  const result = await f.gateway.recoverTransport('restart', f.gateway.lifecycleEpoch);

  assert.equal(f.boundary('2000').state, THREAD_STATES.PENDING);
  assert.equal(f.gateway.isPreAdoptionRetryableThread('2000'), false);
  assert.equal(result.ready, false);
  assert.equal(result.state, 'unavailable');
});

test('P3 retryable pre-adoption pending child is still gated when the own pass reports ready', async t => {
  const f = fixture(t, { adoptThread: false });
  f.fail({ id: '2000', kind: 'channel', status: 503 });
  const recoverInbound = f.gateway.recoverInbound.bind(f.gateway);
  let ownResult = null;
  f.gateway.recoverInbound = async (...args) => {
    ownResult = await recoverInbound(...args);
    return ownResult;
  };

  const result = await f.gateway.recoverTransport('restart', f.gateway.lifecycleEpoch);

  assert.equal(ownResult.ready, true,
    'pre-adoption retry is exempt from the failure accounting, so the own pass reports ready');
  assert.equal(f.boundary('2000').state, THREAD_STATES.PENDING);
  assert.equal(f.gateway.isPreAdoptionRetryableThread('2000'), true);
  assert.equal(result.ready, false);
  assert.equal(result.state, 'unavailable');
});

test('P4 fresh pending enrollment created during a suspended unscoped pass blocks settlement', async t => {
  const f = fixture(t);
  const gate = createTestGate('fresh enrollment during pass');
  let started = false;
  f.gateway.recoverInbound = async () => {
    started = true;
    await gate.promise;
    return { ready: true, state: 'ready' };
  };

  const pending = f.gateway.recoverTransport('restart', f.gateway.lifecycleEpoch);
  await waitForCondition(() => started, 'unscoped recovery pass did not start');
  const enrolled = f.state.enrollThread(
    { threadId: '3000', parentChannelId: '1000', guildId: 'guild' },
    f.state.getBinding('1000')
  );
  assert.equal(enrolled.active, true);
  assert.equal(enrolled.state, THREAD_STATES.PENDING);

  gate.resolve();
  const result = await pending;

  assert.equal(result.ready, false);
  assert.equal(result.state, 'unavailable');
  assert.equal(f.boundary('3000').state, THREAD_STATES.PENDING);
});

test('P4 deactivating the only non-ready enrollment restores the own-result shortcut with no phantom blocker', async t => {
  const f = fixture(t, { adoptThread: false });
  const binding = f.state.getBinding('1000');
  // Hold the parent so scopeIsReady(null) cannot supply readiness on its own; the
  // unscoped own-ready pass must be allowed through by the all-active-enrollments gate.
  f.state.markIntakeBoundary('1000', 'gap', 'parent held by guard', '100', null, binding);
  f.gateway.recoverInbound = async () => ({ ready: true, state: 'ready' });

  const blocked = await f.gateway.recoverTransport('held', f.gateway.lifecycleEpoch);
  assert.equal(f.boundary('2000').active, true);
  assert.equal(blocked.ready, false, 'an active non-ready enrollment must still block settlement');

  assert.equal(f.state.deactivateThreadEnrollments('1000', f.state.getBinding('1000')), 1);
  assert.equal(f.state.getThreadEnrollment('2000').active, false);
  const result = await f.gateway.recoverTransport('restart', f.gateway.lifecycleEpoch);

  assert.equal(result.ready, true);
  assert.equal(result.state, 'ready');
});

test('regression guard: a waiter that gained a follow-up does not regain the no-follow-up shortcut', async t => {
  const f = fixture(t);
  const binding = f.state.getBinding('1000');
  f.state.markIntakeBoundary('1000', 'gap', 'guard: parent binding held', '100', null, binding);
  const gate = createTestGate('regression guard first pass');
  const passes = [];
  f.gateway.recoverInbound = async (_signal, _reason, _epoch, channelIds) => {
    passes.push(channelIds ? [...channelIds] : null);
    if (passes.length === 1) await gate.promise;
    return { ready: true, state: 'ready' };
  };

  const first = f.gateway.recoverTransport('first', f.gateway.lifecycleEpoch);
  await waitForCondition(() => passes.length === 1, 'first pass did not start');
  const second = f.gateway.recoverTransport('second', f.gateway.lifecycleEpoch, ['1000']);
  gate.resolve();
  const [firstResult, secondResult] = await Promise.all([first, second]);

  assert.deepEqual(passes, [null, ['1000']]);
  assert.equal(firstResult.ready, false,
    'own pass was ready and pending returned to zero, but a follow-up attached, so the shortcut must not fire');
  assert.equal(secondResult.ready, false);
  assert.equal(f.gateway.pendingRecoveryRequests.length, 0);
});
