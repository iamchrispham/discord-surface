'use strict';

// Issue #108: retrying recovery with no historical starting bound must not select the
// current newest history message as a fresh adoption/exclusion cutoff.
// T1/T2 are TODO-wrapped causal fixtures (they report the real mismatch, not a hard failure).
// C1/C2 are passing controls proving a qualified cursor still recovers and admits history.

const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./helpers/intake-recovery-fixture');
const { operatorMessage } = require('./helpers/intake-recovery-scenarios');
const { recoverThread } = require('../src/discord/thread-enrollment');
const { waitForRecoveryOperation } = require('../src/discord');

const PARENT_NATIVE = '11111111-1111-1111-1111-111111111111';
const SECOND_NATIVE = '33333333-3333-3333-3333-333333333333';

// Make one channel's fetch hang forever while every other channel delegates to the real fetch.
function blockThatNeverResolves(f, gatewayProp, channelId) {
  const owner = gatewayProp === 'fetchHistory' ? f.gateway : f.gateway.client.channels;
  const name = gatewayProp === 'fetchHistory' ? 'fetchHistory' : 'fetch';
  const original = owner[name];
  owner[name] = function (first, ...rest) {
    const id = typeof first === 'string' ? first : first?.id;
    if (id === channelId) return new Promise(() => {});
    return original.call(this, first, ...rest);
  };
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    owner[name] = original;
  };
}

test('F15a parent retry with no historical bound must not adopt newest history as cutoff', {
  timeout: 8000,
  todo: 'F15a — typed parent retry must not select newest history as a fresh exclusion cutoff'
}, async t => {
  const f = fixture(t);
  f.state.bind({ channelId: '3000', guildId: 'guild', provider: 'codex', nativeId: SECOND_NATIVE, workspace: f.secret });
  f.channels.set('3000', { ...f.channels.get('1000'), id: '3000' });
  f.history.set('3000', []);
  const admitted = f.state.acceptDiscordMessage(operatorMessage(f, '101', '3000'), { ready: false });
  assert.equal(admitted.accepted, true, 'history-only A must enter custody before recovery');

  const restore = blockThatNeverResolves(f, 'fetchHistory', '3000');
  let r1;
  try {
    r1 = await f.gateway.recoverInbound(new AbortController().signal, 'restart',
      f.gateway.lifecycleEpoch, new Set(['3000']), Date.now() + 50);
  } finally {
    restore();
  }

  // First pass: the deadline holds the no-bound parent exactly as it was.
  assert.equal(r1.ready, false, JSON.stringify(r1));
  const w1 = f.state.getIntakeWatermark('3000');
  assert.equal(w1.state, 'unavailable');
  assert.match(w1.detail, /^Discord recovery deadline: /);
  assert.equal(w1.recovered_through_id, null);
  assert.equal(w1.gap_from, null);
  assert.equal(w1.gap_to, null);
  const a0 = f.state.getMessage('101');
  assert.equal(a0.state, 'accepted');

  // Retry with one history-only B and no block.
  f.history.set('3000', [f.message('102', '3000')]);
  const r2 = await f.gateway.recoverInbound(new AbortController().signal, 'restart',
    f.gateway.lifecycleEpoch, new Set(['3000']), Date.now() + 200);

  const w2 = f.state.getIntakeWatermark('3000');
  const a2 = f.state.getMessage('101');
  const safe = {
    held: r2.ready === false || w2.state !== 'ready',
    cursor: w2.recovered_through_id,
    gapFrom: w2.gap_from,
    gapTo: w2.gap_to,
    aState: a2.state,
    aNativeId: a2.nativeId,
    aGeneration: a2.generation,
    bPromotedAsCutoff: w2.recovered_through_id === '102',
    dispatched: f.dispatched.length
  };
  assert.deepEqual(safe, {
    held: true,
    cursor: null,
    gapFrom: null,
    gapTo: null,
    aState: 'accepted',
    aNativeId: SECOND_NATIVE,
    aGeneration: a0.generation,
    bPromotedAsCutoff: false,
    dispatched: 0
  }, 'F15a: no-bound retry must keep original boundary/custody and must not select newest history as exclusion cutoff');
});

test('F15b child pre-adoption retry must not adopt via newest history as a fresh cutoff', {
  timeout: 8000,
  todo: 'F15b — typed child retry must not adopt via newest history as a fresh cutoff'
}, async t => {
  const f = fixture(t, { adoptThread: false });

  const restore = blockThatNeverResolves(f, 'channels.fetch', '2000');
  let first;
  try {
    first = await recoverThread(f.gateway, f.boundary('2000'), new AbortController().signal,
      f.gateway.lifecycleEpoch, waitForRecoveryOperation, false, Date.now() + 50);
  } finally {
    restore();
  }

  // First pass: pre-adoption child is still unenrolled/unadopted.
  assert.equal(first, false);
  const e1 = f.boundary('2000');
  assert.equal(e1.state, 'unavailable');
  assert.match(e1.detail, /^Discord recovery deadline: /);
  assert.equal(e1.adoptedAt, null);
  assert.equal(e1.adoptedThroughId, null);
  assert.equal(e1.recoveredThroughId, null);

  // Retry with one history-only B and no block.
  f.history.set('2000', [f.message('102', '2000')]);
  const retry = await f.gateway.recoverTransport('restart');

  const e2 = f.boundary('2000');
  const b = f.state.getMessage('102');
  const safe = {
    held: retry.ready === false || e2.state !== 'ready',
    adoptedAt: e2.adoptedAt,
    adoptedThroughId: e2.adoptedThroughId,
    recoveredThroughId: e2.recoveredThroughId,
    bIdentity: b ? `${b.nativeId}:${b.generation}` : null,
    dispatched: f.dispatched.length
  };
  assert.deepEqual(safe, {
    held: true,
    adoptedAt: null,
    adoptedThroughId: null,
    recoveredThroughId: null,
    bIdentity: null,
    dispatched: 0
  }, 'F15b: pre-adoption retry must not adopt via newest history as a fresh cutoff');
});

test('C1 parent qualified cursor keeps coverage and admits history-only B', { timeout: 8000 }, async t => {
  const f = fixture(t);

  const restore = blockThatNeverResolves(f, 'fetchHistory', '1000');
  let r1;
  try {
    r1 = await f.gateway.recoverInbound(new AbortController().signal, 'restart',
      f.gateway.lifecycleEpoch, new Set(['1000']), Date.now() + 50);
  } finally {
    restore();
  }

  assert.equal(r1.ready, false, JSON.stringify(r1));
  const w1 = f.boundary('1000');
  assert.equal(w1.state, 'unavailable');
  assert.match(w1.detail, /^Discord recovery deadline: /);
  assert.equal(w1.recovered_through_id, '100');
  assert.equal(w1.gap_from, '100');
  assert.equal(w1.gap_to, '100');

  f.history.set('1000', [f.message('102', '1000')]);
  const r2 = await f.gateway.recoverInbound(new AbortController().signal, 'restart',
    f.gateway.lifecycleEpoch, new Set(['1000']), Date.now() + 200);
  assert.equal(r2.ready, true, JSON.stringify(r2));
  assert.equal(f.cursor('1000'), '102');
  const m = f.state.getMessage('102');
  assert.ok(m, 'history-only B must be admitted into custody');
  assert.equal(m.state, 'accepted');
  assert.equal(m.nativeId, f.state.getBinding('1000').nativeId);
  assert.equal(m.generation, f.state.getBinding('1000').generation);
  assert.equal(f.dispatched.length, 0);
});

test('C2 adopted child preserves enrollment and admits history-only B', { timeout: 8000 }, async t => {
  const f = fixture(t);
  const before = f.boundary('2000');

  const restore = blockThatNeverResolves(f, 'channels.fetch', '2000');
  let first;
  try {
    first = await recoverThread(f.gateway, f.boundary('2000'), new AbortController().signal,
      f.gateway.lifecycleEpoch, waitForRecoveryOperation, false, Date.now() + 50);
  } finally {
    restore();
  }

  assert.equal(first, false);
  const e1 = f.boundary('2000');
  assert.equal(e1.state, 'unavailable');
  assert.match(e1.detail, /^Discord recovery deadline: /);
  assert.equal(e1.recoveredThroughId, '100');
  assert.equal(e1.adoptedAt, before.adoptedAt);

  f.history.set('2000', [f.message('102', '2000')]);
  const retry = await f.gateway.recoverTransport('restart');
  assert.equal(retry.ready, true, JSON.stringify(retry));
  const e2 = f.boundary('2000');
  assert.equal(e2.state, 'ready');
  const m = f.state.getMessage('102');
  assert.ok(m, 'history-only B must be admitted into custody');
  assert.equal(m.state, 'accepted');
  assert.equal(f.state.getBinding('1000').nativeId, PARENT_NATIVE);
  assert.equal(m.nativeId, PARENT_NATIVE);
  assert.equal(m.generation, f.state.getBinding('1000').generation);
  assert.equal(e2.adoptedAt, before.adoptedAt);
  assert.equal(e2.adoptedThroughId, '100');
  assert.equal(f.dispatched.length, 0);
});
