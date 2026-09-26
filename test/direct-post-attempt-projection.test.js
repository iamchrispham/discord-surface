'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { SurfaceState } = require('../src/state');
const { runDirectPost } = require('../src/direct-post');
const { inspectPeerResult } = require('../src/peer/result');
const { projectNewestDirectPostAttempt, querySentAgentResultRows } = require('../dist/state/direct-post.js');

const KINDS = { attemptKind: 'direct-post-attempt', outcomeKind: 'direct-post-outcome' };
const CODEX = '9caa5d21-2169-429d-918b-5f08651b5dbd';
const CLAUDE = '11111111-1111-1111-1111-111111111111';
const SOURCE = { channelId: '101', guildId: '100', provider: 'claude',
  nativeId: '11111111-1111-1111-1111-111111111111', generation: 1 };
const PACKET = {
  id: 'peer-corr', kind: 'request', source: { ...SOURCE },
  target: { channelId: '201', guildId: '100', provider: 'codex',
    nativeId: '22222222-2222-2222-2222-222222222222', generation: 1 },
  replyTo: null, text: 'project the newest attempt'
};

function attempt(id, attemptId, extra = {}) {
  return { id, kind: KINDS.attemptKind, detail: { journal: 'direct-post-v1', attemptId, ...extra } };
}
function outcome(id, detail) {
  return { id, kind: KINDS.outcomeKind, detail: { journal: 'direct-post-v1', ...detail } };
}

test('helper selects the newest attempt and only that attempt outcome', () => {
  assert.deepEqual(projectNewestDirectPostAttempt([], KINDS), { attempt: null, outcome: null, latestPreflight: null });
  const rows = [
    attempt(1, 'old'), outcome(2, { attemptId: 'old', outcome: 'rate_limited' }),
    attempt(3, 'new'), outcome(4, { attemptId: 'old', outcome: 'sent' }),
    outcome(5, { attemptId: 'new', outcome: 'unknown' }), outcome(6, { attemptId: 'new', outcome: 'sent' }),
    outcome(7, { phase: 'preflight', outcome: 'not_sent' })
  ];
  const before = JSON.parse(JSON.stringify(rows));
  const projected = projectNewestDirectPostAttempt(rows, KINDS);
  assert.equal(projected.attempt.id, 3);
  assert.equal(projected.outcome.id, 6, 'greatest matching outcome id wins after reconciliation');
  assert.equal(projected.latestPreflight.id, 7);
  assert.deepEqual(rows, before, 'input rows are not mutated');
});

test('helper ignores empty attempt ids and never pairs empty outcome ids', () => {
  const rows = [attempt(1, ''), outcome(2, { attemptId: '', outcome: 'sent' }), attempt(3, undefined)];
  assert.deepEqual(projectNewestDirectPostAttempt(rows, KINDS), { attempt: rows[2], outcome: null, latestPreflight: null });
  const newest = projectNewestDirectPostAttempt([
    attempt(1, 'a'), outcome(2, { attemptId: 'a', outcome: 'sent' }),
    attempt(3, 'b'), outcome(4, { attemptId: '', outcome: 'rate_limited' })
  ], KINDS);
  assert.equal(newest.attempt.id, 3);
  assert.equal(newest.outcome, null, 'empty-id evidence is not an outcome for the newest attempt');
});

test('helper matches outcome by attemptId, not by greatest outcome id alone', () => {
  const rows = [
    attempt(1, 'a'), attempt(2, 'b'),
    outcome(3, { attemptId: 'b', outcome: 'unknown' }),
    outcome(4, { attemptId: 'a', outcome: 'sent' })
  ];
  const projected = projectNewestDirectPostAttempt(rows, KINDS);
  assert.equal(projected.attempt.id, 2);
  assert.equal(projected.outcome.id, 3, 'the greatest-id outcome belongs to the older attempt and must not be projected');
});

test('a preflight is separate evidence and a later one does not pair with the newest attempt', () => {
  const rows = [
    attempt(1, 'a'), outcome(2, { attemptId: 'a', outcome: 'rate_limited' }),
    attempt(3, 'b'), outcome(4, { phase: 'preflight', outcome: 'not_sent' })
  ];
  const projected = projectNewestDirectPostAttempt(rows, KINDS);
  assert.equal(projected.attempt.id, 3);
  assert.equal(projected.outcome, null);
  assert.equal(projected.latestPreflight.id, 4);
});

// --- Preserved consumer scenarios against real SurfaceState receipts.

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attempt-projection-'));
  const state = new SurfaceState(path.join(dir, 'surface.sqlite'));
  state.setConfig({ operatorId: 'operator', guildId: 'guild', secretFile: path.join(dir, 'unused') });
  state.bind({ channelId: 'channel', guildId: 'guild', provider: 'codex', nativeId: CODEX,
    workspace: dir, conductorId: 'conductor', repoKey: 'repo:fixture' });
  const binding = state.getBinding('channel');
  const meta = (attemptId, overrides = {}) => ({
    requestId: 'request', inReplyTo: null, attemptId, sourcePath: path.join(dir, 'source'),
    textHash: 'text', operatorId: 'operator', partHash: 'part', ...binding, binding,
    partIndex: 0, partCount: 1, nonce: `nonce-${attemptId}`, ...overrides
  });
  t.after(() => { state.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, state, binding, meta };
}

function seedAttempt(state, meta, outcomeName = null, outcomeExtra = {}) {
  const detail = { journal: 'direct-post-v1', ...meta, status: 'attempted' };
  state.receipt(null, 'direct-post-attempt', detail);
  if (outcomeName) state.receipt(null, 'direct-post-outcome', { ...detail, outcome: outcomeName, ...outcomeExtra });
}

test('sender inspection reports in_flight for a newer pending attempt after a definitive failure', t => {
  const { state, meta } = fixture(t);
  seedAttempt(state, meta('attempt-old'), 'rate_limited', { status: 429 });
  seedAttempt(state, meta('attempt-new'));
  assert.deepEqual(state.inspectDirectPostPart(meta('attempt-new')),
    { claimed: false, status: 'in_flight', attemptId: 'attempt-new', nonce: 'nonce-attempt-new' });
});

test('sender inspection projects the matching unknown and its later reconciled outcome', t => {
  const { state, meta } = fixture(t);
  const current = meta('attempt-1');
  seedAttempt(state, current, 'unknown', { reason: 'transport' });
  state.reconcileDirectPostOutcome(current.requestId, current.attemptId, 'sent', { reason: 'reconciled', messageId: 'm1' });
  const projected = state.inspectDirectPostPart(current);
  assert.equal(projected.status, 'sent');
  assert.equal(projected.outcome.messageId, 'm1');
  assert.equal(projected.outcome.reconciledFrom, 'unknown');
});

test('a late older-attempt outcome never replaces the newest admitted attempt', t => {
  const { state, meta } = fixture(t);
  const older = meta('attempt-old');
  seedAttempt(state, older, 'rate_limited', { status: 429 });
  seedAttempt(state, meta('attempt-new'));
  state.receipt(null, 'direct-post-outcome', { journal: 'direct-post-v1', ...older, outcome: 'sent', messageId: 'late-old' });
  assert.deepEqual(state.inspectDirectPostPart(meta('attempt-new')),
    { claimed: false, status: 'in_flight', attemptId: 'attempt-new', nonce: 'nonce-attempt-new' });
});

test('older unknown reconciled to not-sent does not count as confirmed before a preflight', t => {
  const { state, meta } = fixture(t);
  const current = meta('attempt-1');
  seedAttempt(state, current, 'unknown', { reason: 'transport' });
  state.reconcileDirectPostOutcome(current.requestId, current.attemptId, 'not_sent', { reason: 'reconciled' });
  state.recordDirectPostPreflight(current, 'rejected', { reason: 'transport rejected' });
  const inspected = state.inspectDirectPostPart(current);
  assert.equal(inspected.status, 'rejected');
  assert.equal(inspected.outcome.phase, 'preflight');
});

test('preflight-only history stays diagnostic and fabricates no admitted attempt', t => {
  const { state, meta } = fixture(t);
  const current = meta('attempt-1');
  state.recordDirectPostPreflight(current, 'not_sent', { reason: 'stopped before custody' });
  assert.equal(state.inspectDirectPostPart(current), null);
  assert.equal(state.directPostRows(current.requestId).filter(row => row.kind === 'direct-post-attempt').length, 0);
});

// --- Passive peer readback: caller/generation filtering and custody stay unchanged.

function seedPeer(state, kind, extra) {
  state.receipt(null, kind, { journal: 'direct-post-v1', requestId: 'peer-corr', ...SOURCE,
    partIndex: 0, partCount: 1, agentPacket: PACKET, ...extra });
}

test('passive peer readback reports in_flight and a later preflight does not replace it', t => {
  const { state } = fixture(t);
  seedPeer(state, 'direct-post-attempt', { attemptId: 'a1', nonce: 'n1' });
  seedPeer(state, 'direct-post-outcome', { attemptId: 'a1', nonce: 'n1', outcome: 'rate_limited' });
  seedPeer(state, 'direct-post-attempt', { attemptId: 'a2', nonce: 'n2' });
  seedPeer(state, 'direct-post-outcome', { phase: 'preflight', outcome: 'not_sent' });
  const before = state.listReceipts().length;
  assert.equal(inspectPeerResult(state, SOURCE, 'peer-corr').sendOutcome, 'in_flight');
  assert.equal(state.listReceipts().length, before, 'passive inspection adds no custody');
});

test('passive peer readback keeps caller and generation filtering', t => {
  const { state } = fixture(t);
  seedPeer(state, 'direct-post-attempt', { attemptId: 'a1', nonce: 'n1' });
  seedPeer(state, 'direct-post-outcome', { attemptId: 'a1', nonce: 'n1', outcome: 'sent', generation: SOURCE.generation + 1 });
  assert.equal(inspectPeerResult(state, SOURCE, 'peer-corr').sendOutcome, 'in_flight',
    'a newer-generation outcome is not visible to this caller');
  assert.equal(inspectPeerResult(state, { ...SOURCE, generation: SOURCE.generation + 1 }, 'peer-corr').sendOutcome, null,
    'the newer-generation caller has an outcome but no matching admitted attempt');
});

test('passive peer readback reports no attempt as a preflight diagnostic', t => {
  const { state } = fixture(t);
  seedPeer(state, 'direct-post-outcome', { phase: 'preflight', outcome: 'rate_limited' });
  assert.equal(inspectPeerResult(state, SOURCE, 'peer-corr').sendOutcome, 'rate_limited');
});

// --- Ordinary retirement projections and D3 preserved semantics.

function seedOrdinary(state, requestId, channelId, partIndex, partCount, outcomeName, attemptSuffix) {
  const detail = { journal: 'direct-post-v1', requestId, channelId, provider: 'codex',
    attemptId: `${requestId}-${attemptSuffix}`, partIndex, partCount };
  state.receipt(null, 'direct-post-attempt', detail);
  if (outcomeName) state.receipt(null, 'direct-post-outcome', { ...detail, outcome: outcomeName });
}

test('ordinary retirement fences a missing expected part when nothing failed definitively', t => {
  const { state } = fixture(t);
  seedOrdinary(state, 'r1', 'ordinary-a', 0, 2, 'sent', 'a1');
  assert.equal(state.hasUnresolvedOrdinaryPost('ordinary-a'), true, 'missing expected part fences retirement');
});

test('ordinary retirement keeps a pending part ahead of a definitive failure', t => {
  const { state } = fixture(t);
  seedOrdinary(state, 'r2', 'ordinary-b', 0, 2, 'not_sent', 'a1');
  seedOrdinary(state, 'r2', 'ordinary-b', 1, 2, null, 'a1');
  assert.equal(state.hasUnresolvedOrdinaryPost('ordinary-b'), true, 'a known failure cannot hide a pending part');
});

test('ordinary retirement projects the newest attempt instead of an older outcome', t => {
  const { state } = fixture(t);
  seedOrdinary(state, 'r3', 'ordinary-c', 0, 1, 'sent', 'a1');
  seedOrdinary(state, 'r3', 'ordinary-c', 0, 1, 'unknown', 'a2');
  assert.equal(state.hasUnresolvedOrdinaryPost('ordinary-c'), true, 'newest unresolved attempt fences retirement');
  seedOrdinary(state, 'r4', 'ordinary-d', 0, 1, 'unknown', 'a1');
  seedOrdinary(state, 'r4', 'ordinary-d', 0, 1, 'not_sent', 'a2');
  assert.equal(state.hasUnresolvedOrdinaryPost('ordinary-d'), false, 'newest definitive failure resolves the part');
});

test('ordinary retirement preserves legacy part defaults for older attempts', t => {
  const { state } = fixture(t);
  state.receipt(null, 'direct-post-attempt', { journal: 'direct-post-v1', requestId: 'r5',
    channelId: 'ordinary-e', provider: 'codex', attemptId: 'r5-a1' });
  state.receipt(null, 'direct-post-outcome', { journal: 'direct-post-v1', requestId: 'r5',
    channelId: 'ordinary-e', provider: 'codex', attemptId: 'r5-a1', outcome: 'sent' });
  assert.equal(state.hasUnresolvedOrdinaryPost('ordinary-e'), false);
});

test('querySentAgentResultRows still completes every historical sent attempt (D3)', t => {
  const { state } = fixture(t);
  const request = { id: 'req-sent', kind: 'request',
    source: { channelId: 'caller', guildId: 'guild', provider: 'claude', nativeId: CLAUDE, generation: 1 },
    target: { channelId: 'result-channel', guildId: 'guild', provider: 'codex', nativeId: CODEX, generation: 1 },
    replyTo: null, text: 'request' };
  const resultPacket = { id: 'res-sent', kind: 'result', source: request.target, target: request.source,
    replyTo: request.id, text: 'result' };
  for (const attemptId of ['att-1', 'att-2']) {
    const detail = { journal: 'direct-post-v1', requestId: request.id, channelId: 'result-channel',
      attemptId, nonce: `nonce-${attemptId}`, partIndex: 0, partCount: 1, agentPacket: resultPacket };
    state.receipt(null, 'direct-post-attempt', detail);
    state.receipt(null, 'direct-post-outcome', { ...detail, outcome: 'sent', messageId: `m-${attemptId}` });
  }
  const rows = querySentAgentResultRows({
    db: state.db,
    parseJson: (value, fallback) => {
      if (typeof value !== 'string') return fallback;
      try { return JSON.parse(value); } catch { return fallback; }
    },
    attemptKind: KINDS.attemptKind, outcomeKind: KINDS.outcomeKind
  }, request, 'result-channel');
  assert.equal(rows.length, 2, 'every historical sent attempt stays queryable');
  assert.deepEqual(rows.map(row => row.attemptDetail.attemptId).sort(), ['att-1', 'att-2']);
});

test('releaseDirectPostFilePreparation still checks every historical attempt (D3)', async t => {
  const { dir, state } = fixture(t);
  const caption = path.join(dir, 'caption.txt');
  const source = path.join(dir, 'source.bin');
  fs.writeFileSync(caption, 'release check');
  fs.writeFileSync(source, Buffer.from([1, 2, 3]));
  const stopped = new AbortController();
  stopped.abort();
  await runDirectPost({ state, token: 'fixture', nativeId: CODEX, generation: 1, textFile: caption,
    attachmentFile: source, dedupeKey: 'release-d3', signal: stopped.signal,
    fetchImpl: async () => { throw new Error('refused'); } });
  const preparation = state.directPostFilePreparation('release-d3');
  for (const [attemptId, outcomeName] of [['sent-attempt', 'sent'], ['unknown-attempt', 'unknown']]) {
    state.receipt(null, 'direct-post-attempt', { journal: 'direct-post-v1', requestId: 'release-d3',
      channelId: 'channel', attemptId });
    state.receipt(null, 'direct-post-outcome', { journal: 'direct-post-v1', requestId: 'release-d3',
      channelId: 'channel', attemptId, outcome: outcomeName });
  }
  assert.throws(() => state.releaseDirectPostFilePreparation(preparation.preparationId), /resolved network outcome/);
});
