'use strict';

// Issue #108: retrying recovery with no historical starting bound must not select the
// current newest history message as a fresh adoption/exclusion cutoff.
// F15a/F15b are unwrapped causal findings; C1-C10 are passing controls proving a
// qualified cursor still recovers, genuine first adoption still installs a baseline,
// a known-empty completed adoption still completes, and unqualified retries stay held.

const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./helpers/intake-recovery-fixture');
const { operatorMessage } = require('./helpers/intake-recovery-scenarios');
const { enrollPublicThread, recoverThread } = require('../src/discord/thread-enrollment');
const { waitForRecoveryOperation } = require('../src/discord');
const { retryPendingBoundaryDetail, RECOVERY_RETRY_PENDING_PREFIX } = require('../src/discord/recovery-fetch');

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

test('F15a parent retry with no historical bound must not adopt newest history as cutoff', { timeout: 8000 }, async t => {
  const f = fixture(t);
  f.state.bind({ channelId: '3000', guildId: 'guild', provider: 'codex', nativeId: SECOND_NATIVE, workspace: f.secret }, { intakeCutoff: '100' });
  f.channels.set('3000', { ...f.channels.get('1000'), id: '3000' });
  f.history.set('3000', []);
  // Named historical/unknown-coverage scenario: the legacy parent route predates the
  // atomic cutoff commit, so it carries no covered cursor at all.
  f.state.db.prepare('UPDATE intake_watermarks SET recovered_through_id=NULL WHERE channel_id=?').run('3000');
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

  // First pass: the no-bound parent is held with no coverage rather than adopting.
  assert.equal(r1.ready, false, JSON.stringify(r1));
  const w1 = f.state.getIntakeWatermark('3000');
  assert.equal(w1.state, 'pending');
  assert.match(w1.detail, /refused without historical coverage|requires qualified historical coverage/);
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

test('F15b child pre-adoption retry must not adopt via newest history as a fresh cutoff', { timeout: 8000 }, async t => {
  const f = fixture(t, { adoptThread: false });
  // Named historical/unknown-coverage scenario: clear the enrollment's covered cursor
  // so this exercises the pre-cutoff legacy child shape rather than a qualified one.
  f.state.db.prepare('UPDATE thread_enrollments SET recovered_through_id=NULL WHERE thread_id=?').run('2000');

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

// F15 bounded controls: retries with an absent cursor are held, while genuine first
// adoption and covered-cursor retries still recover through public producers.
function http503NoCursorParent(f) {
  f.state.bind({ channelId: '3000', guildId: 'guild', provider: 'codex', nativeId: SECOND_NATIVE, workspace: f.secret }, { intakeCutoff: '100' });
  f.channels.set('3000', { ...f.channels.get('1000'), id: '3000' });
  f.history.set('3000', []);
  // Named historical/unknown-coverage scenario: this legacy route predates the atomic
  // cutoff commit, so it carries no covered cursor at all.
  f.state.db.prepare('UPDATE intake_watermarks SET recovered_through_id=NULL WHERE channel_id=?').run('3000');
  const admitted = f.state.acceptDiscordMessage(operatorMessage(f, '101', '3000'), { ready: false });
  assert.equal(admitted.accepted, true);
  return f;
}

test('C3 parent HTTP503 retry with absent cursor stays held and keeps custody', { timeout: 8000 }, async t => {
  const f = http503NoCursorParent(fixture(t));
  f.fail({ id: '3000', kind: 'channel', status: 503 });
  const first = await f.gateway.recoverInbound(new AbortController().signal, 'restart',
    f.gateway.lifecycleEpoch, new Set(['3000']), Date.now() + 200);
  assert.equal(first.ready, false, JSON.stringify(first));
  const w1 = f.state.getIntakeWatermark('3000');
  assert.equal(w1.state, 'unavailable');
  assert.match(w1.detail, /^Discord HTTP 503/);
  assert.equal(w1.recovered_through_id, null);

  f.fail(null);
  f.history.set('3000', [f.message('102', '3000')]);
  const retry = await f.gateway.recoverInbound(new AbortController().signal, 'restart',
    f.gateway.lifecycleEpoch, new Set(['3000']), Date.now() + 200);
  const w2 = f.state.getIntakeWatermark('3000');
  const safe = {
    held: retry.ready === false || w2.state !== 'ready',
    cursor: w2.recovered_through_id,
    aState: f.state.getMessage('101').state,
    bPromoted: w2.recovered_through_id === '102',
    dispatched: f.dispatched.length
  };
  assert.deepEqual(safe, { held: true, cursor: null, aState: 'accepted', bPromoted: false, dispatched: 0 },
    'HTTP503 retry with no cursor must not select newest history as a fresh cutoff');
});

test('C4 parent interrupted-retry-pending with absent cursor stays held', { timeout: 8000 }, async t => {
  const f = http503NoCursorParent(fixture(t));
  // First pass leaves a retryable HTTP503 boundary with no cursor.
  f.fail({ id: '3000', kind: 'channel', status: 503 });
  await f.gateway.recoverInbound(new AbortController().signal, 'restart',
    f.gateway.lifecycleEpoch, new Set(['3000']), Date.now() + 200);
  const held = f.state.getIntakeWatermark('3000');
  assert.equal(held.recovered_through_id, null);
  const marked = f.state.markIntakeBoundary('3000', 'pending', retryPendingBoundaryDetail('restart', held),
    held.gap_from, held.gap_to, f.state.getBinding('3000'));
  assert.equal(marked.state, 'pending');
  assert.match(f.state.getIntakeWatermark('3000').detail, /^Discord recovery retry pending: /);
  f.fail(null);
  f.history.set('3000', [f.message('102', '3000')]);
  const retry = await f.gateway.recoverInbound(new AbortController().signal, 'restart',
    f.gateway.lifecycleEpoch, new Set(['3000']), Date.now() + 200);
  const w = f.state.getIntakeWatermark('3000');
  assert.equal(retry.ready === false || w.state !== 'ready', true);
  assert.equal(w.recovered_through_id, null, 'interrupted retry alone is not coverage');
  assert.equal(f.state.getMessage('101').state, 'accepted');
  assert.equal(f.dispatched.length, 0);
});

test('C5 parent genuinely fresh first adoption still installs its baseline', { timeout: 8000 }, async t => {
  const f = fixture(t); const base = f.state.getBinding('1000');
  f.state.bind({ channelId: '4000', guildId: 'guild', provider: 'codex', nativeId: '55555555-5555-4555-8555-555555555555', workspace: base.workspace }, { intakeCutoff: '100' });
  f.channels.set('4000', { ...f.channels.get('1000'), id: '4000' });
  f.history.set('4000', [f.message('900', '4000')]);
  const result = await f.gateway.recoverInbound(new AbortController().signal, 'restart',
    f.gateway.lifecycleEpoch, new Set(['4000']), Date.now() + 200);
  assert.equal(result.ready, true, JSON.stringify(result));
  const w = f.state.getIntakeWatermark('4000');
  assert.equal(w.state, 'ready');
  assert.equal(w.recovered_through_id, '900');
  assert.equal(f.state.getBinding('4000').readiness, 'ready');
  assert.equal(f.dispatched.length, 0);
});

test('C6 child genuinely fresh first adoption still installs its baseline', { timeout: 8000 }, async t => {
  const f = fixture(t, { adoptThread: false });
  // Genuinely fresh child: enrollment commits its own qualified cutoff with the
  // active row, then the first recovery installs the observed baseline on top.
  f.state.db.prepare('DELETE FROM thread_enrollments WHERE thread_id=?').run('2000');
  f.history.set('2000', [f.message('102', '2000')]);
  const enrolled = f.state.enrollThread(
    { threadId: '2000', parentChannelId: '1000', guildId: 'guild', adoptionCutoff: '100' },
    f.state.getBinding('1000')
  );
  assert.equal(enrolled.state, 'pending');
  assert.equal(enrolled.adoptedThroughId, '100');
  assert.equal(enrolled.recoveredThroughId, '100');
  const result = await f.gateway.recoverTransport('restart');
  assert.equal(result.ready, true, JSON.stringify(result));
  const e = f.boundary('2000');
  assert.equal(e.state, 'ready');
  assert.equal(e.adoptedThroughId, '100');
  assert.ok(e.adoptedAt);
  assert.ok(e.recoveredThroughId >= '102');
  assert.equal(f.dispatched.length, 0);
});

test('C7 covered-cursor parent retry still recovers history-only B on page two', { timeout: 8000 }, async t => {
  const f = fixture(t);
  const restore = blockThatNeverResolves(f, 'fetchHistory', '1000');
  try {
    await f.gateway.recoverInbound(new AbortController().signal, 'restart',
      f.gateway.lifecycleEpoch, new Set(['1000']), Date.now() + 50);
  } finally {
    restore();
  }
  assert.equal(f.cursor('1000'), '100');
  // pageLimit is 1, so 103 is only reachable on page two.
  f.history.set('1000', [f.message('102', '1000'), f.message('103', '1000')]);
  const retry = await f.gateway.recoverInbound(new AbortController().signal, 'restart',
    f.gateway.lifecycleEpoch, new Set(['1000']), Date.now() + 400);
  assert.equal(retry.ready, true, JSON.stringify(retry));
  assert.equal(f.cursor('1000'), '103');
  assert.equal(f.state.getMessage('102')?.state, 'accepted');
  assert.equal(f.state.getMessage('103')?.state, 'accepted');
  assert.equal(f.dispatched.length, 0);
});

test('C8 known-empty completed adoption still installs its baseline', { timeout: 8000 }, async t => {
  const f = fixture(t); const base = f.state.getBinding('1000');
  f.state.bind({ channelId: '5000', guildId: 'guild', provider: 'codex', nativeId: '66666666-6666-4666-8666-666666666666', workspace: base.workspace }, { intakeCutoff: '100' });
  f.channels.set('5000', { ...f.channels.get('1000'), id: '5000' });
  // Known-empty completed adoption: an all-null ready boundary is completion proof,
  // not a failed attempt, so the baseline may still be installed.
  f.state.markIntakeBoundary('5000', 'ready', 'empty channel baseline', null, null, f.state.getBinding('5000'));
  f.history.set('5000', [f.message('901', '5000')]);
  const result = await f.gateway.recoverInbound(new AbortController().signal, 'restart',
    f.gateway.lifecycleEpoch, new Set(['5000']), Date.now() + 200);
  assert.equal(result.ready, true, JSON.stringify(result));
  const w = f.state.getIntakeWatermark('5000');
  assert.equal(w.state, 'ready');
  assert.equal(w.recovered_through_id, '901');
  assert.equal(f.dispatched.length, 0);
});

test('C9 child interrupted-retry-pending with absent cursor stays held', { timeout: 8000 }, async t => {
  const f = fixture(t, { adoptThread: false });
  // Named historical/unknown-coverage scenario: the legacy child carries no covered
  // cursor, so the interrupted retry cannot install one.
  f.state.db.prepare('UPDATE thread_enrollments SET recovered_through_id=NULL WHERE thread_id=?').run('2000');
  f.state.markThreadBoundary('2000', 'pending',
    `${RECOVERY_RETRY_PENDING_PREFIX}startup after HTTP 503`, null, null, f.state.getBinding('1000'));
  assert.equal(f.boundary('2000').state, 'pending');
  f.history.set('2000', [f.message('102', '2000')]);
  const retry = await recoverThread(f.gateway, f.boundary('2000'), new AbortController().signal,
    f.gateway.lifecycleEpoch, waitForRecoveryOperation, false, Date.now() + 300);
  assert.equal(retry, false);
  const e = f.boundary('2000');
  assert.equal(e.state, 'pending', 'interrupted child retry must stay visibly held');
  assert.equal(e.adoptedAt, null);
  assert.equal(e.adoptedThroughId, null);
  assert.equal(e.recoveredThroughId, null);
  assert.equal(f.dispatched.length, 0);
});

test('C10 child HTTP503 retry with absent cursor stays held', { timeout: 8000 }, async t => {
  const f = fixture(t, { adoptThread: false });
  // Named historical/unknown-coverage scenario: no covered cursor on the child row.
  f.state.db.prepare('UPDATE thread_enrollments SET recovered_through_id=NULL WHERE thread_id=?').run('2000');
  const restore = blockThatNeverResolves(f, 'channels.fetch', '2000');
  let first;
  try {
    first = await recoverThread(f.gateway, f.boundary('2000'), new AbortController().signal,
      f.gateway.lifecycleEpoch, waitForRecoveryOperation, false, Date.now() + 50);
  } finally {
    restore();
  }
  assert.equal(first, false);
  const held = f.boundary('2000');
  assert.equal(held.state, 'unavailable');
  assert.match(held.detail, /^Discord recovery deadline: /);
  assert.equal(held.recoveredThroughId, null);

  f.history.set('2000', [f.message('102', '2000')]);
  const retry = await recoverThread(f.gateway, f.boundary('2000'), new AbortController().signal,
    f.gateway.lifecycleEpoch, waitForRecoveryOperation, false, Date.now() + 300);
  assert.equal(retry, false);
  const e = f.boundary('2000');
  assert.equal(e.state, 'pending');
  assert.equal(e.adoptedAt, null);
  assert.equal(e.adoptedThroughId, null);
  assert.equal(e.recoveredThroughId, null);
  assert.equal(f.dispatched.length, 0);
});
