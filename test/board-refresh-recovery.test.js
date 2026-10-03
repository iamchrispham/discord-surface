'use strict';

const {
  test, assert, fs, CLI_PATH, SurfaceState, BOARD_OUTCOMES,
  fixture, runChild, recoveryEvidence, seedBoardAttempt, rewriteBoardAttemptContent,
  seedBoardOutcome, runRecoverChild
} = require('./board-refresh-fixture');
const { OWNER_EVIDENCE, OWNER_EVIDENCE_REASON } = require('../src/state/process-owner-evidence');

// The orphan's producer is recorded as a PID that the OS probe proves absent
// (ESRCH). Empty identity is fine: a proved ESRCH is absence by itself.
function recordAbsentOwner(state, attemptId) {
  const row = state.db.prepare("SELECT id, detail FROM receipts WHERE kind='board-refresh-attempt' AND json_extract(detail, '$.attemptId')=?").get(attemptId);
  assert.ok(row);
  const detail = JSON.parse(row.detail);
  state.db.prepare('UPDATE receipts SET detail=? WHERE id=?').run(
    JSON.stringify({ ...detail, ownerPid: 999999 }),
    row.id
  );
}

test('board recovery returns applied history without writing a receipt', async t => {
  const f = fixture();
  t.after(() => f.state.close());
  const seeded = seedBoardOutcome(f, 'recover-applied', BOARD_OUTCOMES.APPLIED);
  const evidence = recoveryEvidence();
  const before = f.state.listReceipts();
  const binding = f.state.getBinding('channel-1');
  const recovered = f.state.reconcileBoardRefresh(seeded.target, seeded.attemptId, BOARD_OUTCOMES.APPLIED, evidence);
  assert.equal(recovered.status, BOARD_OUTCOMES.APPLIED);
  assert.equal(recovered.historical, true);
  assert.deepEqual(f.state.listReceipts(), before);
  assert.deepEqual(f.state.getBinding('channel-1'), binding);
});

test('incomplete board recovery rejects the missing message selector without mutating custody', async t => {
  const f = fixture();
  let state = f.state;
  t.after(() => state.close());
  seedBoardAttempt(f, 'recover-guard-pending');
  const beforeCustody = {
    bindings: state.listBindings(),
    receipts: state.listReceipts()
  };
  state.close();
  const child = await runChild([
    CLI_PATH,
    'recover',
    '--db', f.dbPath,
    '--board-guild-id', 'guild-1',
    '--board-channel-id', 'channel-1',
    '--board-attempt-id', 'missing-attempt'
  ], { NODE_NO_WARNINGS: '1' }, { timeoutMs: 3000 });
  assert.equal(child.timedOut, false);
  assert.equal(child.code, 1, `incomplete recovery exited ${child.code} signal=${child.signal} stderr=${child.stderr} stdout=${child.stdout}`);
  assert.equal(child.signal, null);
  assert.equal(child.stdout, '');
  assert.equal(child.stderr, 'discord-surface: missing --board-message-id\n');
  state = new SurfaceState(f.dbPath);
  assert.deepEqual(state.listBindings(), beforeCustody.bindings);
  assert.deepEqual(state.listReceipts(), beforeCustody.receipts);
});

test('board recovery refuses every terminal outcome except applied', async t => {
  for (const outcome of [
    BOARD_OUTCOMES.NO_OP,
    BOARD_OUTCOMES.STALE,
    BOARD_OUTCOMES.REJECTED,
    BOARD_OUTCOMES.RATE_LIMITED,
    BOARD_OUTCOMES.NOT_SENT
  ]) {
    const f = fixture();
    t.after(() => f.state.close());
    const seeded = seedBoardOutcome(f, `recover-${outcome}`, outcome);
    const evidence = recoveryEvidence();
    const before = f.state.listReceipts();
    const binding = f.state.getBinding('channel-1');
    assert.throws(
      () => f.state.reconcileBoardRefresh(seeded.target, seeded.attemptId, BOARD_OUTCOMES.APPLIED, evidence),
      new RegExp(`terminal outcome ${outcome}`)
    );
    assert.deepEqual(f.state.listReceipts(), before);
    assert.deepEqual(f.state.getBinding('channel-1'), binding);

    if ([BOARD_OUTCOMES.REJECTED, BOARD_OUTCOMES.RATE_LIMITED, BOARD_OUTCOMES.NOT_SENT].includes(outcome)) {
      f.state.close();
      const { child, marker, deadlineMarker } = await runRecoverChild(f, seeded.attemptId, evidence);
      assert.equal(child.timedOut, false);
      assert.equal(child.code, 1, `${outcome} child exited ${child.code} signal=${child.signal} stderr=${child.stderr} stdout=${child.stdout}`);
      assert.equal(child.signal, null);
      assert.equal(child.stdout, '');
      assert.equal(child.stderr, `board refresh attempt has terminal outcome ${outcome}\n`);
      assert.equal(fs.existsSync(marker), false);
      assert.equal(fs.existsSync(deadlineMarker), false);
      f.state = new SurfaceState(f.dbPath);
      assert.deepEqual(f.state.listReceipts(), before);
      assert.deepEqual(f.state.getBinding('channel-1'), binding);
    }
  }
});

test('board recovery preserves in-flight refusal and unknown evidence reconciliation', async t => {
  const missing = fixture();
  const unknown = fixture();
  t.after(() => missing.state.close());
  t.after(() => unknown.state.close());

  const missingSeed = seedBoardAttempt(missing, 'recover-missing');
  const missingBefore = missing.state.listReceipts();
  assert.equal(missing.state.inspectBoardRequest('recover-missing', missingSeed.target).status, BOARD_OUTCOMES.IN_FLIGHT);
  assert.throws(
    () => missing.state.reconcileBoardRefresh(missingSeed.target, missingSeed.attemptId, BOARD_OUTCOMES.APPLIED, recoveryEvidence()),
    /has no outcome to reconcile/
  );
  assert.deepEqual(missing.state.listReceipts(), missingBefore);
  assert.equal(missing.state.recoverBoardRefreshAttempt({ ...missingSeed.target, messageId: 'other-target' }, missingSeed.attemptId, () => ({ status: OWNER_EVIDENCE.ABSENT, reason: OWNER_EVIDENCE_REASON.PROBE_ABSENT })), 0);
  assert.equal(missing.state.inspectBoardRequest('recover-missing', missingSeed.target).status, BOARD_OUTCOMES.IN_FLIGHT);
  recordAbsentOwner(missing.state, missingSeed.attemptId);
  missing.state.close();
  const missingEvidence = recoveryEvidence('new board', new Date(Date.now() + 5000).toISOString());
  const recoveredChild = await runRecoverChild(missing, missingSeed.attemptId, missingEvidence);
  assert.equal(recoveredChild.child.timedOut, false);
  assert.equal(recoveredChild.child.code, 0, `orphan recovery child exited ${recoveredChild.child.code} signal=${recoveredChild.child.signal} stderr=${recoveredChild.child.stderr} stdout=${recoveredChild.child.stdout}`);
  assert.equal(recoveredChild.child.signal, null);
  assert.equal(recoveredChild.child.stderr, '');
  assert.equal(JSON.parse(recoveredChild.child.stdout).status, BOARD_OUTCOMES.APPLIED);
  assert.equal(fs.existsSync(recoveredChild.marker), false);
  assert.equal(fs.existsSync(recoveredChild.deadlineMarker), false);
  missing.state = new SurfaceState(missing.dbPath);
  const recoveredRows = missing.state.listReceipts().filter(row => row.kind === 'board-refresh-outcome' && JSON.parse(row.detail).attemptId === missingSeed.attemptId);
  assert.deepEqual(recoveredRows.map(row => JSON.parse(row.detail).outcome), [BOARD_OUTCOMES.UNKNOWN, BOARD_OUTCOMES.APPLIED]);
  assert.equal(missing.state.inspectBoardRequest('recover-missing', missingSeed.target).historical, true);

  const unknownSeed = seedBoardOutcome(unknown, 'recover-unknown', BOARD_OUTCOMES.UNKNOWN);
  const unknownBefore = unknown.state.listReceipts();
  const reconciled = unknown.state.reconcileBoardRefresh(unknownSeed.target, unknownSeed.attemptId, BOARD_OUTCOMES.APPLIED, recoveryEvidence());
  assert.equal(reconciled.status, BOARD_OUTCOMES.APPLIED);
  assert.equal(reconciled.reconciledFrom, BOARD_OUTCOMES.UNKNOWN);
  const afterReconcile = unknown.state.listReceipts();
  assert.equal(afterReconcile.length, unknownBefore.length + 1);
  assert.equal(JSON.parse(afterReconcile.at(-1).detail).outcome, BOARD_OUTCOMES.APPLIED);
  const beforeDuplicate = unknown.state.listReceipts();
  const duplicate = unknown.state.reconcileBoardRefresh(unknownSeed.target, unknownSeed.attemptId, BOARD_OUTCOMES.APPLIED, recoveryEvidence());
  assert.equal(duplicate.historical, true);
  assert.deepEqual(unknown.state.listReceipts(), beforeDuplicate);
});

test('board recovery accepts actual terminal-line-ending loss and rejects whitespace-only changes', async t => {
  const recovered = fixture();
  const ambiguous = fixture();
  t.after(() => recovered.state.close());
  t.after(() => ambiguous.state.close());

  const recoveredSeed = seedBoardAttempt(recovered, 'recover-terminal-line-endings', 'new board\n\n');
  recovered.state.recordBoardRefreshOutcome(recoveredSeed.target, recoveredSeed.attemptId, BOARD_OUTCOMES.UNKNOWN, {
    operationEndedAt: '2026-01-01T00:00:00.000Z',
    error: 'fixture unknown'
  });
  const recoveredAttemptBefore = JSON.parse(recovered.state.listReceipts()
    .find(row => row.kind === 'board-refresh-attempt' && JSON.parse(row.detail).attemptId === recoveredSeed.attemptId).detail);
  const reconciled = recovered.state.reconcileBoardRefresh(
    recoveredSeed.target,
    recoveredSeed.attemptId,
    BOARD_OUTCOMES.APPLIED,
    recoveryEvidence('new board')
  );
  assert.equal(reconciled.status, BOARD_OUTCOMES.APPLIED);
  assert.equal(reconciled.reconciledFrom, BOARD_OUTCOMES.UNKNOWN);
  const recoveredOutcome = JSON.parse(recovered.state.listReceipts().at(-1).detail);
  assert.equal(recoveredOutcome.content, 'new board\n\n');
  assert.equal(recoveredOutcome.preEditContent, 'old board');
  assert.equal(recoveredOutcome.readbackContent, 'new board');
  const recoveredAttemptAfter = JSON.parse(recovered.state.listReceipts()
    .find(row => row.kind === 'board-refresh-attempt' && JSON.parse(row.detail).attemptId === recoveredSeed.attemptId).detail);
  assert.equal(recoveredAttemptAfter.content, recoveredAttemptBefore.content);
  assert.equal(recoveredAttemptAfter.payloadHash, recoveredAttemptBefore.payloadHash);

  const ambiguousSeed = seedBoardAttempt(ambiguous, 'recover-terminal-line-endings-only', 'new board');
  rewriteBoardAttemptContent(ambiguous, ambiguousSeed.attemptId, 'old board\n\n');
  ambiguous.state.recordBoardRefreshOutcome(ambiguousSeed.target, ambiguousSeed.attemptId, BOARD_OUTCOMES.UNKNOWN, {
    operationEndedAt: '2026-01-01T00:00:00.000Z',
    error: 'fixture unknown'
  });
  const ambiguousAttemptBefore = JSON.parse(ambiguous.state.listReceipts()
    .find(row => row.kind === 'board-refresh-attempt' && JSON.parse(row.detail).attemptId === ambiguousSeed.attemptId).detail);
  const before = ambiguous.state.listReceipts();
  assert.throws(
    () => ambiguous.state.reconcileBoardRefresh(
      ambiguousSeed.target,
      ambiguousSeed.attemptId,
      BOARD_OUTCOMES.APPLIED,
      recoveryEvidence('old board')
    ),
    /positive board readback requires desired content different from the pre-edit content/
  );
  assert.deepEqual(ambiguous.state.listReceipts(), before);
  const ambiguousAttemptAfter = JSON.parse(ambiguous.state.listReceipts()
    .find(row => row.kind === 'board-refresh-attempt' && JSON.parse(row.detail).attemptId === ambiguousSeed.attemptId).detail);
  assert.equal(ambiguousAttemptAfter.content, ambiguousAttemptBefore.content);
  assert.equal(ambiguousAttemptAfter.payloadHash, ambiguousAttemptBefore.payloadHash);
});
