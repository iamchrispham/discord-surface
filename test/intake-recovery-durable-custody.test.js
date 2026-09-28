'use strict';

// PR113 durable custody fixtures: F11-F14 causal findings (unwrapped, real assertions)
// plus passing controls C11-C15 and the F13 same-generation readiness fence.
// Recipe (adapted to relative imports): ~/.agents/work-control/discord-pr113-current-findings-20260926/recovery-findings.test.cjs

const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./helpers/intake-recovery-fixture');
const { CASES, operatorMessage } = require('./helpers/intake-recovery-scenarios');
const { waitForCondition } = require('./surface-fixtures');

function submitted(f, id, channel = '1000') {
  assert.equal(f.state.acceptDiscordMessage(operatorMessage(f, id, channel)).accepted, true);
  assert.equal(f.state.claimDispatch(id).claimed, true);
  assert.equal(f.state.markSubmitted(id).state, 'submitted');
}

function hold(f) {
  f.state.markIntakeBoundary('1000', 'gap', 'explicit uncovered history', '101', '102');
}

function identity(binding) {
  return [binding.provider, binding.nativeId, binding.generation];
}

test('F11 recovered channel must attach to an existing native observation', CASES, async t => {
  const f = fixture(t); submitted(f, '101'); hold(f); f.enableDelivery();
  let release;
  const answer = new Promise(resolve => { release = resolve; });
  f.gateway.providers.codex.observe = async (message, outcome, options) => {
    options.signal.addEventListener('abort', () => release({ text: 'late reply' }), { once: true });
    return answer;
  };
  const fetch = f.gateway.client.channels.fetch;
  let releaseFetch;
  const pendingFetch = new Promise(resolve => { releaseFetch = resolve; });
  f.gateway.recoveryTimeoutMs = 30;
  f.gateway.client.channels.fetch = async () => pendingFetch;
  try {
    await f.gateway.reconcilePending(undefined, { allowPaused: true, readyOnly: true });
    assert.equal(f.state.getMessage('101').state, 'submitted');
    f.gateway.client.channels.fetch = fetch;
    release({ text: 'late reply' });
    await waitForCondition(() => f.state.getMessage('101').state === 'reply_ready');
    assert.equal(f.replies.length, 0, 'a reply cannot send before its channel lookup settles');
    releaseFetch(f.channels.get('1000'));
    await waitForCondition(() => f.state.getMessage('101').state === 'replied');
  } finally {
    release({ text: 'late reply' });
    releaseFetch(f.channels.get('1000'));
  }
  await f.gateway.consumer.waitForNativeWork();
  assert.equal(f.state.getMessage('101').state, 'replied', 'observer settlement must wake reconciliation without redispatch');
  assert.equal(f.replies.length, 1);
  assert.equal(f.dispatched.length, 0);
});

test('F12 held parent reply must refuse a channel in another guild', CASES, async t => {
  const f = fixture(t); submitted(f, '101');
  const m = f.state.getMessage('101');
  const owner = f.state.getBinding('1000');
  f.state.recordNativeReply({ provider: m.provider, messageId: m.id, nativeId: m.nativeId, generation: m.generation, text: 'saved reply' });
  hold(f); f.enableDelivery(); f.channels.get('1000').guildId = 'foreign-guild';
  await f.gateway.reconcilePending(undefined, { allowPaused: true, readyOnly: true });
  assert.equal(f.replies.length, 0, 'wrong-guild parent must receive no saved reply');
  assert.equal(f.state.getMessage('101').state, 'reply_ready');
  const after = f.state.getMessage('101');
  assert.equal(identity(f.state.getBinding('1000')).join('|'), identity(owner).join('|'));
  assert.equal(after.nativeId, owner.nativeId);
  assert.equal(after.generation, owner.generation);
  assert.equal(f.dispatched.length, 0);
});

test('F12 fetched wrong-guild parent channel must not publish the saved reply', CASES, async t => {
  const f = fixture(t); submitted(f, '101');
  const m = f.state.getMessage('101');
  f.state.recordNativeReply({ provider: m.provider, messageId: m.id, nativeId: m.nativeId, generation: m.generation, text: 'saved reply' });
  hold(f); f.enableDelivery();
  const foreign = { ...f.channels.get('1000'), guildId: 'foreign-guild' };
  f.gateway.client.channels.fetch = async id => id === '1000' ? foreign : f.channels.get(id);
  await f.gateway.reconcilePending(undefined, { allowPaused: true, readyOnly: true });
  assert.equal(f.replies.length, 0, 'fetched wrong-guild parent must receive no saved reply');
  assert.equal(f.state.getMessage('101').state, 'reply_ready');
  assert.equal(f.dispatched.length, 0);
});

test('F12 attached wrong-guild parent channel is refused before send', CASES, async t => {
  const f = fixture(t); submitted(f, '101');
  const m = f.state.getMessage('101');
  f.state.recordNativeReply({ provider: m.provider, messageId: m.id, nativeId: m.nativeId, generation: m.generation, text: 'saved reply' });
  const ready = f.state.getMessage('101');
  const wrong = { ...f.channels.get('1000'), guildId: 'foreign-guild' };
  await assert.rejects(
    f.gateway.sendReply({ ...ready, channel: wrong }, ready),
    error => error.outcome === 'not_sent'
  );
  assert.equal(f.replies.length, 0, 'attached wrong-guild parent must receive no saved reply');
  assert.equal(f.state.getMessage('101').state, 'reply_ready');
  assert.equal(f.dispatched.length, 0);
});

test('P1 held parent reply revalidates reply permission before send', CASES, async t => {
  const f = fixture(t); submitted(f, '101');
  const message = f.state.getMessage('101');
  f.state.recordNativeReply({ provider: message.provider, messageId: message.id, nativeId: message.nativeId, generation: message.generation, text: 'saved reply' });
  hold(f); f.enableDelivery();
  f.channels.get('1000').permissionsFor = () => ({ has: () => false });
  await f.gateway.reconcilePending(undefined, { allowPaused: true, readyOnly: true });
  assert.equal(f.replies.length, 0);
  assert.equal(f.state.getMessage('101').state, 'reply_ready');
});

test('P2 reply-ready custody gets a fresh reconciliation deadline after an earlier timeout', CASES, async t => {
  const f = fixture(t); submitted(f, '101');
  const first = f.state.getMessage('101');
  f.state.recordNativeReply({ provider: first.provider, messageId: first.id, nativeId: first.nativeId, generation: first.generation, text: 'first reply' });
  hold(f);
  const base = f.state.getBinding('1000');
  f.state.bind({ channelId: '3000', guildId: 'guild', provider: 'codex',
    nativeId: '33333333-3333-4333-8333-333333333333', workspace: base.workspace }, { intakeCutoff: '100' });
  f.state.setIntakeBaseline('3000', '100', 'fixture');
  f.state.markIntakeBoundary('3000', 'ready');
  f.channels.set('3000', { ...f.channels.get('1000'), id: '3000' });
  submitted(f, '102', '3000');
  const second = f.state.getMessage('102');
  f.state.recordNativeReply({ provider: second.provider, messageId: second.id, nativeId: second.nativeId, generation: second.generation, text: 'second reply' });
  f.enableDelivery();
  f.gateway.recoveryTimeoutMs = 30;
  let firstFetch = true;
  let releaseFirstFetch;
  const pendingFirstFetch = new Promise(resolve => { releaseFirstFetch = resolve; });
  f.gateway.client.channels.fetch = async id => {
    if (id === '1000' && firstFetch) {
      firstFetch = false;
      return pendingFirstFetch;
    }
    return f.channels.get(id);
  };
  await f.gateway.reconcilePending(undefined, { allowPaused: true, readyOnly: true });
  await waitForCondition(() => f.state.getMessage('102').state === 'replied');
  assert.equal(f.state.getMessage('101').state, 'reply_ready');
  releaseFirstFetch(f.channels.get('1000'));
  await waitForCondition(() => f.state.getMessage('101').state === 'replied');
  assert.equal(f.replies.length, 2);
  assert.equal(f.state.getMessage('101').state, 'replied');
  assert.equal(f.state.getMessage('102').state, 'replied');
});

test('F13 unvisited terminal watermark must restore paused binding readiness', CASES, async t => {
  const f = fixture(t); const base = f.state.getBinding('1000');
  f.state.bind({ channelId: '3000', guildId: 'guild', provider: 'codex', nativeId: '33333333-3333-4333-8333-333333333333', workspace: base.workspace }, { intakeCutoff: '100' });
  f.state.setIntakeBaseline('3000', '100', 'fixture');
  f.state.markIntakeBoundary('3000', 'gap', 'explicit uncovered history', '101', '102');
  f.history.set('1000', [f.message('101', '1000')]);
  const now = Date.now, intake = f.gateway.consumer.intakeMessage;
  let advanced = false;
  f.gateway.consumer.intakeMessage = async function (...args) {
    const result = await intake.apply(f.gateway.consumer, args);
    if (!advanced && args[0]?.id === '101') { advanced = true; Date.now = () => now() + 120000; }
    return result;
  };
  try { f.gateway.pauseConnection('reconnect'); await f.recover(); }
  finally { Date.now = now; f.gateway.consumer.intakeMessage = intake; }
  assert.equal(advanced, true);
  assert.equal(f.state.getIntakeWatermark('3000').state, 'gap');
  assert.equal(f.state.getBinding('3000').readiness, 'gap', 'terminal skipped route must not remain recovering');
});

// F14: the diagnostic counter became an explicit admitted-event race with a bounded timer.
test('F14 slow first fetch must not starve a later submitted observation', CASES, async t => {
  const f = fixture(t); submitted(f, '101');
  const base = f.state.getBinding('1000');
  f.state.bind({ channelId: '3000', guildId: 'guild', provider: 'codex', nativeId: '33333333-3333-4333-8333-333333333333', workspace: base.workspace }, { intakeCutoff: '100' });
  f.state.setIntakeBaseline('3000', '100', 'fixture'); f.state.markIntakeBoundary('3000', 'ready');
  submitted(f, '102', '3000'); hold(f);
  const owner = f.state.getBinding('3000');
  let secondObserved = 0;
  let admitSecond;
  const secondEntered = new Promise(resolve => { admitSecond = resolve; });
  f.gateway.providers.codex.observe = async message => {
    if (message.id === '102') { secondObserved += 1; admitSecond(); }
    return { text: 'observed reply' };
  };
  f.gateway.client.channels.fetch = () => new Promise(() => {});
  f.gateway.recoveryTimeoutMs = 30;
  await f.gateway.reconcilePending(undefined, { allowPaused: true, readyOnly: true });
  let timer;
  try {
    await Promise.race([secondEntered, new Promise(resolve => { timer = setTimeout(resolve, 1000); })]);
  } finally {
    clearTimeout(timer);
  }
  await f.gateway.consumer.waitForNativeWork();
  assert.equal(secondObserved, 1, 'native-only observation must be admitted despite another route consuming the fetch deadline');
  assert.equal(f.state.getMessage('102').state, 'reply_ready');
  assert.equal(identity(f.state.getBinding('3000')).join('|'), identity(owner).join('|'));
  assert.equal(f.dispatched.length, 0);
});

test('C11 available channel delivers a submitted observation exactly once', CASES, async t => {
  const f = fixture(t); submitted(f, '101');
  const owner = f.state.getBinding('1000');
  f.enableDelivery();
  await f.gateway.reconcilePending(undefined, { allowPaused: true, readyOnly: true });
  await f.gateway.consumer.waitForNativeWork();
  assert.equal(f.state.getMessage('101').state, 'replied');
  assert.equal(f.replies.length, 1);
  assert.equal(identity(f.state.getBinding('1000')).join('|'), identity(owner).join('|'));
  assert.equal(f.dispatched.length, 0);
});

test('C12 saved reply on a held same-guild channel sends exactly once', CASES, async t => {
  const f = fixture(t); submitted(f, '101');
  const m = f.state.getMessage('101');
  const owner = f.state.getBinding('1000');
  f.state.recordNativeReply({ provider: m.provider, messageId: m.id, nativeId: m.nativeId, generation: m.generation, text: 'saved reply' });
  hold(f); f.enableDelivery();
  await f.gateway.reconcilePending(undefined, { allowPaused: true, readyOnly: true });
  await f.gateway.consumer.waitForNativeWork();
  assert.equal(f.state.getMessage('101').state, 'replied');
  assert.equal(f.replies.length, 1);
  assert.equal(identity(f.state.getBinding('1000')).join('|'), identity(owner).join('|'));
  assert.equal(f.dispatched.length, 0);
});

test('C13 visited terminal watermark without a deadline advance restores gap readiness', CASES, async t => {
  const f = fixture(t); const base = f.state.getBinding('1000');
  f.state.bind({ channelId: '3000', guildId: 'guild', provider: 'codex', nativeId: '33333333-3333-4333-8333-333333333333', workspace: base.workspace }, { intakeCutoff: '100' });
  f.state.setIntakeBaseline('3000', '100', 'fixture');
  f.state.markIntakeBoundary('3000', 'gap', 'explicit uncovered history', '101', '102');
  f.history.set('1000', [f.message('101', '1000')]);
  const owner = f.state.getBinding('3000');
  f.gateway.pauseConnection('reconnect');
  await f.recover();
  assert.equal(f.state.getIntakeWatermark('3000').state, 'gap');
  assert.equal(f.state.getBinding('3000').readiness, 'gap');
  assert.equal(identity(f.state.getBinding('3000')).join('|'), identity(owner).join('|'));
  assert.equal(f.dispatched.length, 0);
});

// F13 control: a same-generation newer READY/PENDING outcome committed while the
// expired deadline pass is running must not be overwritten by the terminal restore.
for (const newer of ['ready', 'pending']) {
  test(`F13 same-generation newer ${newer} is not overwritten by the terminal restore`, CASES, async t => {
    const f = fixture(t); const base = f.state.getBinding('1000');
    f.state.bind({ channelId: '3000', guildId: 'guild', provider: 'codex', nativeId: '33333333-3333-4333-8333-333333333333', workspace: base.workspace }, { intakeCutoff: '100' });
    f.state.setIntakeBaseline('3000', '100', 'fixture');
    f.state.markIntakeBoundary('3000', 'gap', 'explicit uncovered history', '101', '102');
    f.history.set('1000', [f.message('101', '1000')]);
    const owner = f.state.getBinding('3000');
    const now = Date.now, intake = f.gateway.consumer.intakeMessage;
    let advanced = false;
    f.gateway.consumer.intakeMessage = async function (...args) {
      const result = await intake.apply(f.gateway.consumer, args);
      if (!advanced && args[0]?.id === '101') { advanced = true; Date.now = () => now() + 120000; }
      return result;
    };
    // A same-generation concurrent recovery commits a newer outcome for the other
    // route at the moment the terminal restore is about to write.
    let injected = false;
    const recordBoundary = f.gateway.recordBoundary.bind(f.gateway);
    f.gateway.recordBoundary = async function (binding, channel, boundaryState, detail, gapFrom, gapTo, signal, deadline, expectedBoundary, expectedReadiness) {
      if (!injected && binding?.channelId === '3000' && ['gap', 'unavailable'].includes(boundaryState)) {
        injected = true;
        const committed = f.state.markIntakeBoundary('3000', newer, `concurrent ${newer}`, null, null, f.state.getBinding('3000'));
        assert.equal(committed?.state, newer);
      }
      return recordBoundary(binding, channel, boundaryState, detail, gapFrom, gapTo, signal, deadline, expectedBoundary, expectedReadiness);
    };
    try { f.gateway.pauseConnection('reconnect'); await f.recover(); }
    finally { Date.now = now; f.gateway.consumer.intakeMessage = intake; }
    assert.equal(advanced, true);
    assert.equal(injected, true);
    assert.equal(f.state.getIntakeWatermark('3000').state, newer, `newer same-generation ${newer} watermark must not be overwritten`);
    assert.equal(f.state.getBinding('3000').readiness, newer, `newer same-generation ${newer} readiness must not be overwritten`);
    assert.equal(identity(f.state.getBinding('3000')).join('|'), identity(owner).join('|'));
    assert.equal(f.dispatched.length, 0);
  });
}

test('C14 unexhausted reconcile observes both owners exactly once', CASES, async t => {
  const f = fixture(t); submitted(f, '101');
  const base = f.state.getBinding('1000');
  f.state.bind({ channelId: '3000', guildId: 'guild', provider: 'codex', nativeId: '33333333-3333-4333-8333-333333333333', workspace: base.workspace }, { intakeCutoff: '100' });
  f.state.setIntakeBaseline('3000', '100', 'fixture'); f.state.markIntakeBoundary('3000', 'ready');
  submitted(f, '102', '3000'); hold(f);
  f.channels.set('3000', { ...f.channels.get('1000'), id: '3000' });
  const owners = [f.state.getBinding('1000'), f.state.getBinding('3000')];
  const observed = new Map();
  f.gateway.providers.codex.observe = async message => {
    observed.set(message.id, (observed.get(message.id) || 0) + 1);
    return { text: 'observed reply' };
  };
  await f.gateway.reconcilePending(undefined, { allowPaused: true, readyOnly: true });
  await f.gateway.consumer.waitForNativeWork();
  assert.equal(observed.get('101'), 1);
  assert.equal(observed.get('102'), 1);
  assert.equal(f.state.getMessage('101').state, 'replied');
  assert.equal(f.state.getMessage('102').state, 'replied');
  assert.equal(f.replies.length, 2);
  assert.equal(identity(f.state.getBinding('1000')).join('|'), identity(owners[0]).join('|'));
  assert.equal(identity(f.state.getBinding('3000')).join('|'), identity(owners[1]).join('|'));
  assert.equal(f.dispatched.length, 0);
});

test('C15 history message landing on page two is admitted with the cursor advanced', CASES, async t => {
  const f = fixture(t); // fixture pageLimit is 1, so 102 is only reachable on page two.
  f.history.set('1000', [f.message('101', '1000'), f.message('102', '1000')]);
  const owner = f.state.getBinding('1000');
  f.gateway.pauseConnection('reconnect');
  await f.recover();
  assert.equal(f.state.getMessage('101').state, 'accepted');
  assert.equal(f.state.getMessage('102').state, 'accepted');
  assert.equal(f.cursor('1000'), '102');
  assert.equal(f.state.getIntakeWatermark('1000').state, 'ready');
  assert.equal(identity(f.state.getBinding('1000')).join('|'), identity(owner).join('|'));
  assert.equal(f.dispatched.length, 0);
});

test('C16 deadline exhaustion mid-recovery keeps the partial cursor and does not dispatch', CASES, async t => {
  const f = fixture(t);
  f.history.set('1000', [f.message('101', '1000'), f.message('102', '1000')]);
  const now = Date.now, intake = f.gateway.consumer.intakeMessage;
  let advanced = false;
  f.gateway.consumer.intakeMessage = async function (...args) {
    const result = await intake.apply(f.gateway.consumer, args);
    // Exhaust the bounded recovery deadline after the first page is admitted.
    if (!advanced && args[0]?.id === '101') { advanced = true; Date.now = () => now() + 120000; }
    return result;
  };
  try { f.gateway.pauseConnection('reconnect'); await f.recover(); }
  finally { Date.now = now; f.gateway.consumer.intakeMessage = intake; }
  assert.equal(advanced, true);
  const watermark = f.state.getIntakeWatermark('1000');
  assert.equal(watermark.state, 'unavailable');
  assert.match(watermark.detail, /^Discord recovery deadline: /);
  assert.equal(watermark.recovered_through_id, '101');
  assert.equal(f.state.getMessage('101').state, 'accepted');
  assert.equal(f.state.getMessage('102'), null, 'page two must not be admitted past the exhausted deadline');
  assert.equal(f.state.getBinding('1000').readiness, 'unavailable');
  assert.equal(f.dispatched.length, 0);
});

test('C17 owner change during recovery await is not overwritten', CASES, async t => {
  const f = fixture(t);
  const base = f.state.getBinding('1000');
  f.state.bind({ channelId: '3000', guildId: 'guild', provider: 'codex', nativeId: '33333333-3333-4333-8333-333333333333', workspace: base.workspace }, { intakeCutoff: '100' });
  f.channels.set('3000', { ...f.channels.get('1000'), id: '3000' });
  f.state.setIntakeBaseline('3000', '100', 'fixture'); f.state.markIntakeBoundary('3000', 'ready');
  f.history.set('3000', [f.message('101', '3000')]);
  const intake = f.gateway.consumer.intakeMessage;
  let advanced = false, rebound = null;
  f.gateway.consumer.intakeMessage = async function (...args) {
    // A cutover to a new native owner completes while the recovery pass is awaiting.
    if (!advanced && args[0]?.id === '101') {
      advanced = true;
      rebound = f.state.rebind({ channelId: '3000', guildId: 'guild', provider: 'codex',
        nativeId: '44444444-4444-4444-8444-444444444444', workspace: base.workspace }, { resetIntake: true });
    }
    return intake.apply(f.gateway.consumer, args);
  };
  try { f.gateway.pauseConnection('reconnect'); await f.recover(); }
  finally { f.gateway.consumer.intakeMessage = intake; }
  assert.equal(advanced, true);
  assert.equal(rebound?.nativeId, '44444444-4444-4444-8444-444444444444');
  const owner = f.state.getBinding('3000');
  assert.equal(owner.nativeId, '44444444-4444-4444-8444-444444444444', 'cutover owner must survive the stale recovery pass');
  assert.equal(owner.generation, rebound.generation);
  assert.equal(owner.readiness, 'pending', 'cutover owner must not be marked ready by the stale pass');
  assert.equal(f.dispatched.length, 0);
});
