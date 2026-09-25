const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SurfaceState, BOARD_OUTCOMES } = require('../src/state');

function seededRecovery(t, withOutcome = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-board-time-'));
  const state = new SurfaceState(path.join(dir, 'surface.sqlite'));
  t.after(() => {
    state.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const target = { guildId: 'guild-1', channelId: 'channel-1', messageId: 'message-1' };
  const attemptId = 'attempt-1';
  const detail = {
    attemptId,
    guildId: target.guildId,
    channelId: target.channelId,
    targetMessageId: target.messageId,
    content: 'new board',
    preEditContent: 'old board'
  };
  state.receipt(null, 'board-refresh-attempt', detail);
  if (withOutcome) {
    state.receipt(null, 'board-refresh-outcome', {
      ...detail,
      outcome: BOARD_OUTCOMES.UNKNOWN,
      operationEndedAt: '2026-01-01T00:00:00.000Z'
    });
  }
  return { state, target, attemptId };
}

function evidence(observedAt) {
  return {
    evidenceScope: 'fixture readback',
    observedAt,
    readbackContent: 'new board',
    soleWriter: true,
    singleAttempt: true,
    noHiddenRetry: true
  };
}

test('board recovery refuses unqualified or invalid instants without a receipt', t => {
  const { state, target, attemptId } = seededRecovery(t);
  const before = state.listReceipts();
  for (const observedAt of ['2026-01-01T00:00:01', '2026-02-30T00:00:01Z']) {
    assert.throws(
      () => state.reconcileBoardRefresh(target, attemptId, BOARD_OUTCOMES.APPLIED, evidence(observedAt)),
      /observedAt must be a timezone-qualified ISO timestamp/
    );
    assert.deepEqual(state.listReceipts(), before);
  }
});

test('board recovery normalizes readback time and returns persisted receipt time', t => {
  const { state, target, attemptId } = seededRecovery(t);
  const input = evidence('2026-01-01T01:00:01+01:00');
  const fresh = state.reconcileBoardRefresh(target, attemptId, BOARD_OUTCOMES.APPLIED, input);
  const after = state.listReceipts();
  const receipt = after.at(-1);
  assert.equal(fresh.readbackAt, '2026-01-01T00:00:01.000Z');
  assert.equal(JSON.parse(receipt.detail).readbackAt, fresh.readbackAt);
  assert.equal(fresh.recordedAt, receipt.created_at);
  const duplicate = state.reconcileBoardRefresh(target, attemptId, BOARD_OUTCOMES.APPLIED, input);
  assert.equal(duplicate.historical, true);
  assert.equal(duplicate.recordedAt, receipt.created_at);
  assert.deepEqual(state.listReceipts(), after);
});

test('direct board outcomes return the same persisted time on first and duplicate calls', t => {
  const { state, target, attemptId } = seededRecovery(t, false);
  const detail = { operationEndedAt: '2026-01-01T00:00:00.000Z' };
  const fresh = state.recordBoardRefreshOutcome(target, attemptId, BOARD_OUTCOMES.UNKNOWN, detail);
  const after = state.listReceipts();
  const receipt = after.at(-1);
  assert.equal(fresh.recordedAt, receipt.created_at);
  const duplicate = state.recordBoardRefreshOutcome(target, attemptId, BOARD_OUTCOMES.UNKNOWN, detail);
  assert.equal(duplicate.recordedAt, receipt.created_at);
  assert.deepEqual(state.listReceipts(), after);
});
