'use strict';

// PR113 durable custody fixtures: TODO-wrapped findings F11-F14 plus passing controls C11-C14.
// Recipe (adapted to relative imports): ~/.agents/work-control/discord-pr113-current-findings-20260926/recovery-findings.test.cjs

const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./helpers/intake-recovery-fixture');
const { CASES, operatorMessage } = require('./helpers/intake-recovery-scenarios');

const F11_REASON = 'DEFECT(F11): a channel fetch that fails once leaves the recovered submitted message at reply_ready instead of attaching the already-running native observation and reaching replied';
const F12_REASON = 'DEFECT(F12): a reply saved on a held message is delivered into a channel from another guild; it must send zero replies, stay reply_ready, and preserve native identity/generation';
const F13_REASON = 'DEFECT(F13): a terminal gap watermark on an unvisited route leaves the paused binding readiness at recovering instead of restoring gap';
const F14_REASON = 'DEFECT(F14): a slow first channel fetch consumes the recovery deadline and starves the later submitted observation, which is never admitted at all';

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

test('F11 recovered channel must attach to an existing native observation', { ...CASES, todo: F11_REASON }, async t => {
  const f = fixture(t); submitted(f, '101'); hold(f); f.enableDelivery();
  let release;
  const answer = new Promise(resolve => { release = resolve; });
  f.gateway.providers.codex.observe = async (message, outcome, options) => {
    options.signal.addEventListener('abort', () => release({ text: 'late reply' }), { once: true });
    return answer;
  };
  const fetch = f.gateway.client.channels.fetch;
  f.gateway.client.channels.fetch = async () => {
    throw Object.assign(new Error('channel fetch unavailable'), { status: 503 });
  };
  try {
    await f.gateway.reconcilePending(undefined, { allowPaused: true, readyOnly: true });
    assert.equal(f.state.getMessage('101').state, 'submitted');
    f.gateway.client.channels.fetch = fetch;
    await f.gateway.reconcilePending(undefined, { allowPaused: true, readyOnly: true });
    assert.equal(f.state.getMessage('101').state, 'submitted');
  } finally {
    release({ text: 'late reply' });
  }
  await f.gateway.consumer.waitForNativeWork();
  assert.equal(f.state.getMessage('101').state, 'replied', 'successful second fetch must deliver when the original observer settles');
  assert.equal(f.replies.length, 1);
  assert.equal(f.dispatched.length, 0);
});

test('F12 held parent reply must refuse a channel in another guild', { ...CASES, todo: F12_REASON }, async t => {
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

test('F13 unvisited terminal watermark must restore paused binding readiness', { ...CASES, todo: F13_REASON }, async t => {
  const f = fixture(t); const base = f.state.getBinding('1000');
  f.state.bind({ channelId: '3000', guildId: 'guild', provider: 'codex', nativeId: '33333333-3333-4333-8333-333333333333', workspace: base.workspace });
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
test('F14 slow first fetch must not starve a later submitted observation', { ...CASES, todo: F14_REASON }, async t => {
  const f = fixture(t); submitted(f, '101');
  const base = f.state.getBinding('1000');
  f.state.bind({ channelId: '3000', guildId: 'guild', provider: 'codex', nativeId: '33333333-3333-4333-8333-333333333333', workspace: base.workspace });
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
  f.state.bind({ channelId: '3000', guildId: 'guild', provider: 'codex', nativeId: '33333333-3333-4333-8333-333333333333', workspace: base.workspace });
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

test('C14 unexhausted reconcile observes both owners exactly once', CASES, async t => {
  const f = fixture(t); submitted(f, '101');
  const base = f.state.getBinding('1000');
  f.state.bind({ channelId: '3000', guildId: 'guild', provider: 'codex', nativeId: '33333333-3333-4333-8333-333333333333', workspace: base.workspace });
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
