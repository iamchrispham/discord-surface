'use strict';

// Issue #108 mixed/all-held startup, reconnect and startup lifecycle scenarios.

const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./helpers/intake-recovery-fixture');
const { CASES, operatorMessage } = require('./helpers/intake-recovery-scenarios');

function deferred() {
  let resolve;
  const promise = new Promise(finish => { resolve = finish; });
  return { promise, resolve };
}

// Bind a second public route and hold it on an explicit gap. The helper's
// boundary()/cursor() accessors only understand channel 1000 and the enrolled
// thread 2000, so the second channel is read with state.getIntakeWatermark().
function addHeldRoute(f) {
  const base = f.state.getBinding('1000');
  f.state.bind({ channelId: '3000', guildId: 'guild', provider: 'codex',
    nativeId: '33333333-3333-4333-8333-333333333333', workspace: base.workspace });
  f.state.setIntakeBaseline('3000', '100', 'fixture');
  f.state.markIntakeBoundary('3000', 'ready');
  f.channels.set('3000', { ...f.channels.get('1000'), id: '3000' });
  f.history.set('3000', []);
}

// Healthy route 1000 carrying accepted custody 101 plus real history, alongside
// route 3000 held on a genuine gap with accepted custody 102.
function prepareMixedFixture(f) {
  addHeldRoute(f);
  f.state.markIntakeBoundary('3000', 'gap', 'explicit uncovered history', '101', '102');
  assert.equal(f.state.acceptDiscordMessage(operatorMessage(f, '102', '3000'), { ready: false }).accepted, true);
  assert.equal(f.state.acceptDiscordMessage(operatorMessage(f, '101', '1000')).accepted, true);
  f.history.set('1000', [f.message('101', '1000')]);
}

test('R1: mixed healthy/gap public startup connects and dispatches only the healthy row', CASES, async t => {
    const f = fixture(t);
    prepareMixedFixture(f);
    f.enableDelivery();

    await f.gateway.start(f.secret);
    assert.equal(f.gateway.started, true);
    assert.equal(f.gateway.transportReady, true);
    assert.equal(f.gateway.ready, true);

    await f.gateway.reconcilePending(undefined, { readyOnly: true });
    await f.gateway.consumer.waitForNativeWork();

    assert.equal(f.state.getMessage('101').state, 'replied');
    assert.equal(f.dispatched.filter(message => message.id === '101').length, 1);
    assert.equal(f.dispatched.length, 1, 'only the healthy route may dispatch');
    assert.equal(f.boundary('1000').state, 'ready');
    const held = f.state.getIntakeWatermark('3000');
    assert.equal(held.state, 'gap');
    assert.equal(held.gap_to, '102');
    assert.equal(f.state.getMessage('102').state, 'accepted');
  });

test('G1: reconnect serves the healthy row once and preserves the held route', CASES, async t => {
  const f = fixture(t);
  prepareMixedFixture(f);
  f.enableDelivery();

  const result = await f.gateway.beginReconnectRecovery('fixture');
  assert.equal(result.ready, false);
  assert.equal(result.state, 'gap');
  await f.gateway.reconcilePending(undefined, { readyOnly: true });
  await f.gateway.consumer.waitForNativeWork();

  assert.equal(f.dispatched.filter(message => message.id === '101').length, 1);
  assert.equal(f.dispatched.length, 1, 'the held route must not dispatch');
  assert.equal(f.boundary('1000').state, 'ready');
  const held = f.state.getIntakeWatermark('3000');
  assert.equal(held.state, 'gap');
  assert.equal(held.gap_to, '102');
  assert.equal(f.state.getMessage('102').state, 'accepted');
});

test('R2: all-held public startup connects without a ready route', CASES, async t => {
    const f = fixture(t);
    f.state.markIntakeBoundary('1000', 'gap', 'explicit uncovered history', '101', '102');
    assert.equal(f.state.acceptDiscordMessage(operatorMessage(f, '101', '1000'), { ready: false }).accepted, true);
    f.enableDelivery();

    await f.gateway.start(f.secret);
    assert.equal(f.gateway.started, true);
    assert.equal(f.gateway.transportReady, true);
    assert.equal(f.gateway.ready, false);
    await f.gateway.reconcilePending(new Date().toISOString(), { allowPaused: true, readyOnly: true });
    assert.equal(f.dispatched.length, 0);
    assert.equal(f.state.getMessage('101').state, 'accepted');
    assert.equal(f.boundary('1000').state, 'gap');
    assert.equal(f.boundary('1000').gap_to, '102');
  });

test('R3: active history deadline stays retryable and a later pass recovers custody', CASES, async t => {
    const f = fixture(t);
    assert.equal(f.state.acceptDiscordMessage(operatorMessage(f, '101', '1000')).accepted, true);
    f.history.set('1000', [f.message('101', '1000')]);
    const realFetchHistory = f.gateway.fetchHistory;
    const realTimeoutMs = f.gateway.recoveryTimeoutMs;
    f.gateway.recoveryTimeoutMs = 30;
    f.gateway.fetchHistory = () => new Promise(() => {});

    let held;
    try {
      const first = await f.gateway.recoverTransport('ordinary-bind');
      assert.equal(first.ready, false);
      assert.equal(f.state.getMessage('101').state, 'accepted');
      held = f.boundary('1000');
    } finally {
      f.gateway.fetchHistory = realFetchHistory;
      f.gateway.recoveryTimeoutMs = realTimeoutMs;
    }

    // The failed hold assertion comes BEFORE the second invocation on purpose.
    assert.equal(held.state, 'unavailable');
    assert.match(held.detail, /^Discord recovery deadline: /);

    const recovered = await f.gateway.recoverTransport('startup');
    assert.equal(recovered.ready, true, JSON.stringify(recovered));
    assert.equal(f.boundary('1000').state, 'ready');
    f.enableDelivery();
    await f.gateway.reconcilePending();
    await f.gateway.consumer.waitForNativeWork();
    assert.equal(f.state.getMessage('101').state, 'replied');
    assert.equal(f.dispatched.filter(message => message.id === '101').length, 1);
  });

test('G3: stop during login leaves no started gateway, dispatch or lost custody', CASES, async t => {
  const f = fixture(t);
  assert.equal(f.state.acceptDiscordMessage(operatorMessage(f, '101', '1000')).accepted, true);
  const entered = deferred();
  const release = deferred();
  f.gateway.client.login = async () => { entered.resolve(); await release.promise; };

  const outcome = f.gateway.start(f.secret);
  await entered.promise;
  await f.gateway.stop();
  release.resolve();
  await assert.rejects(outcome, /Discord startup was stopped during login/);

  assert.equal(f.gateway.started, false);
  assert.equal(f.gateway.transportReady, false);
  assert.equal(f.dispatched.length, 0);
  assert.equal(f.state.getMessage('101').state, 'accepted');
});

test('G4: stop during recovery fences a late channel fetch', CASES, async t => {
  const f = fixture(t);
  assert.equal(f.state.acceptDiscordMessage(operatorMessage(f, '101', '1000')).accepted, true);
  const entered = deferred();
  const release = deferred();
  const fetchChannel = f.gateway.client.channels.fetch.bind(f.gateway.client.channels);
  f.gateway.client.channels.fetch = async id => {
    entered.resolve();
    await release.promise;
    return fetchChannel(id);
  };

  const outcome = f.gateway.start(f.secret);
  await entered.promise;
  await f.gateway.stop();
  release.resolve();
  await assert.rejects(outcome, /Discord startup was stopped during recovery/);

  assert.equal(f.gateway.started, false);
  assert.equal(f.gateway.transportReady, false);
  assert.equal(f.dispatched.length, 0);
  assert.equal(f.state.getMessage('101').state, 'accepted');
});

test('G5: login failure leaves no started gateway, dispatch or lost custody', CASES, async t => {
  const f = fixture(t);
  assert.equal(f.state.acceptDiscordMessage(operatorMessage(f, '101', '1000')).accepted, true);
  f.gateway.client.login = async () => { throw new Error('fixture login refused'); };

  await assert.rejects(f.gateway.start(f.secret), /fixture login refused/);

  assert.equal(f.gateway.started, false);
  assert.equal(f.gateway.transportReady, false);
  assert.equal(f.dispatched.length, 0);
  assert.equal(f.state.getMessage('101').state, 'accepted');
});
