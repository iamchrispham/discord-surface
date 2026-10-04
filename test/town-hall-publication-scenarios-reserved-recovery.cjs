'use strict';

const { SurfaceState, discordNonce } = require('../src/state');
const { INVALID_OUTCOME, MARK_REFUSED, PUBLICATION_PREFIX, RECORD_REFUSED, UUID_PATTERN, assertBindingError, assertBindingRefusal, fixture, input, overrideOwnerAlive, publicationHandlers, publicationKeyFor, publicationRows, receiptIds } = require('./town-hall-publication-scenarios-fixtures.cjs');
const { reserveWithChild, waitForChildGone } = require('./town-hall-publication-scenarios-process.cjs');
const assert = require('node:assert/strict');
const test = require('node:test');

test('reserved cancellation is known unsent and retry preserves nonce', t => {
  const f = fixture(t);
  const created = f.state.createTownHallBroadcast(input());
  const journalKey = created.broadcast.journalKey;
  const fingerprint = created.broadcast.plan.fingerprint;
  const nonce = discordNonce(publicationKeyFor(journalKey));

  const reserved = f.state.reserveTownHallPublication(journalKey);
  const attemptId = reserved.publication.attemptId;
  const cancelled = f.state.recordTownHallPublicationOutcome(journalKey, attemptId, 'not_sent');
  assert.equal(cancelled.status, 'not_sent');
  assert.equal(cancelled.messageId, null);
  assert.equal(cancelled.attemptId, attemptId);
  assert.equal(cancelled.nonce, nonce);

  const retry = f.state.reserveTownHallPublication(journalKey);
  assert.equal(retry.claimed, true);
  assert.equal(retry.publication.status, 'claimed');
  assert.equal(retry.publication.nonce, nonce);
  assert.notEqual(retry.publication.attemptId, attemptId);
  const rows = publicationRows(f.state, journalKey);
  assert.equal(rows.filter(row => JSON.parse(row.detail).event === 'reserved').length, 2);

  const second = f.state.createTownHallBroadcast(input({ broadcastId: 'b2' }));
  const secondKey = second.broadcast.journalKey;
  const secondNonce = discordNonce(publicationKeyFor(secondKey));
  const secondReserved = f.state.reserveTownHallPublication(secondKey);
  const beforeIds = receiptIds(f.state);
  assertBindingRefusal(
    () => f.state.recordTownHallPublicationOutcome(secondKey, secondReserved.publication.attemptId, 'sent', { messageId: 'msg-1' }),
    [INVALID_OUTCOME, RECORD_REFUSED],
    'sent from claimed'
  );
  assert.deepEqual(receiptIds(f.state), beforeIds);
  const projected = f.state.getTownHallPublication(secondKey);
  assert.equal(projected.status, 'claimed');
  assert.equal(projected.nonce, secondNonce);
  assert.equal(projected.fingerprint, second.broadcast.plan.fingerprint);
  assert.equal(fingerprint, created.broadcast.plan.fingerprint);
});

test('reserved absent owner releases only matching claim', async t => {
  const f = fixture(t);
  const created = f.state.createTownHallBroadcast(input());
  const journalKey = created.broadcast.journalKey;

  const child = await reserveWithChild(f.dbPath, journalKey);
  assert.equal(child.result.claimed, true);
  assert.equal(child.result.status, 'claimed');
  assert.match(child.result.attemptId, UUID_PATTERN);
  assert.equal(child.result.journalKey, journalKey);

  const reservedRow = publicationRows(f.state, journalKey)
    .find(row => JSON.parse(row.detail).event === 'reserved');
  assert.ok(reservedRow);
  const reservedDetail = JSON.parse(reservedRow.detail);
  assert.equal(reservedDetail.owner.ownerPid, child.pid);

  const beforeIds = receiptIds(f.state);
  const recovered = f.state.recoverTownHallPublication(journalKey);
  assert.equal(recovered.status, 'not_sent');
  assert.equal(recovered.messageId, null);
  assert.equal(recovered.attemptId, child.result.attemptId);
  assert.equal(recovered.nonce, discordNonce(publicationKeyFor(journalKey)));

  const afterRows = publicationRows(f.state, journalKey);
  assert.equal(afterRows.length, 2);
  const outcomeRow = afterRows.filter(row => JSON.parse(row.detail).event === 'outcome');
  assert.equal(outcomeRow.length, 1);
  assert.deepEqual(receiptIds(f.state), beforeIds.concat([outcomeRow[0].id]));
  const outcomeDetail = JSON.parse(outcomeRow[0].detail);
  assert.equal(outcomeDetail.outcome, 'not_sent');
  assert.equal(outcomeDetail.messageId, null);
  assert.deepEqual(outcomeDetail.owner, reservedDetail.owner);

  assertBindingError(
    () => f.state.markTownHallPublicationInFlight(journalKey, child.result.attemptId),
    MARK_REFUSED,
    'old token after release'
  );
  assert.equal(publicationRows(f.state, journalKey).length, 2);
});

test('publication child deadlines finish after process exit', { timeout: 60000 }, async t => {
  const f = fixture(t);
  const created = f.state.createTownHallBroadcast(input());
  const journalKey = created.broadcast.journalKey;

  // (a) Child self-destruct deadline: the child exits on its own before the
  // parent deadline, and rejection is settled only after it is gone.
  let childPid = null;
  try {
    await reserveWithChild(f.dbPath, journalKey, { timeoutMs: 15000, childDeadlineMs: 300, keepAlive: true });
    assert.fail('child self-destruct must reject');
  } catch (error) {
    assert.match(error.message, /publication child exited code 97/);
    assert.equal(typeof error.pid, 'number');
    assert.equal(error.closeObserved, true, 'rejection must settle after the child close event');
    childPid = error.pid;
  }
  await waitForChildGone(childPid, 'child self-destruct');

  // (b) Parent deadline: the parent SIGKILLs the still-alive child and settles
  // only after the close event. The closeObserved marker is attached only in
  // the 'close' path, so an early rejection from the timeout callback, or an
  // 'exit'-instead-of-'close' mutation, both fail this assertion.
  let killedPid = null;
  try {
    await reserveWithChild(f.dbPath, journalKey, { timeoutMs: 250, childDeadlineMs: 15000, keepAlive: true });
    assert.fail('parent deadline must reject');
  } catch (error) {
    assert.match(error.message, /publication child reservation timed out after 250ms/);
    assert.equal(typeof error.pid, 'number');
    assert.equal(error.closeObserved, true, 'timeout rejection must settle only after the child close event');
    killedPid = error.pid;
  }
  await waitForChildGone(killedPid, 'parent deadline SIGKILL');

  // (c) Empty output: the child exits 0 with no stdout and settles after close.
  let emptyPid = null;
  try {
    await reserveWithChild(f.dbPath, journalKey, { timeoutMs: 15000, childDeadlineMs: 5000, emptyOutput: true });
    assert.fail('empty output must reject');
  } catch (error) {
    assert.match(error.message, /unusable output/);
    assert.equal(error.closeObserved, true, 'empty-output rejection must settle after the child close event');
    emptyPid = error.pid;
  }
  await waitForChildGone(emptyPid, 'empty output');

  assert.ok(childPid !== null && childPid !== killedPid && childPid !== emptyPid, 'one child per case');
});

test('reserved indeterminate owner remains held', t => {
  const f = fixture(t);
  const created = f.state.createTownHallBroadcast(input());
  const journalKey = created.broadcast.journalKey;
  const reserved = f.state.reserveTownHallPublication(journalKey);
  const attemptId = reserved.publication.attemptId;
  const restore = overrideOwnerAlive(f.state, false);

  try {
    const beforeIds = receiptIds(f.state);
    // Mocked EPERM: permission refusal is indeterminate and must not release custody.
    const eperm = publicationHandlers(() => {
      const error = new Error('mocked EPERM inspection');
      error.code = 'EPERM';
      throw error;
    });
    const held = eperm.recoverTownHallPublication(f.state, journalKey);
    assert.equal(held.status, 'claimed');
    assert.equal(held.attemptId, attemptId);
    assert.deepEqual(receiptIds(f.state), beforeIds);

    const second = f.state.createTownHallBroadcast(input({ broadcastId: 'b2' }));
    const secondKey = second.broadcast.journalKey;
    const secondReserved = f.state.reserveTownHallPublication(secondKey);
    const beforeSecondIds = receiptIds(f.state);
    // Mocked EIO: any unexpected inspection error is indeterminate and must not release custody.
    const eio = publicationHandlers(() => {
      const error = new Error('mocked EIO inspection');
      error.code = 'EIO';
      throw error;
    });
    const heldSecond = eio.recoverTownHallPublication(f.state, secondKey);
    assert.equal(heldSecond.status, 'claimed');
    assert.equal(heldSecond.attemptId, secondReserved.publication.attemptId);
    assert.deepEqual(receiptIds(f.state), beforeSecondIds);
    assert.equal(f.state.getTownHallPublication(secondKey).status, 'claimed');
  } finally {
    restore();
  }
});

test('recovery recheck preserves intervening in-flight marker', t => {
  const f = fixture(t);
  const created = f.state.createTownHallBroadcast(input());
  const journalKey = created.broadcast.journalKey;
  const reserved = f.state.reserveTownHallPublication(journalKey);
  const attemptId = reserved.publication.attemptId;

  const secondConnection = new SurfaceState(f.dbPath);
  t.after(() => { try { secondConnection.close(); } catch {} });
  const restore = overrideOwnerAlive(f.state, false);
  const beforeIds = receiptIds(f.state);
  let induced = false;
  // Mocked ESRCH after the second connection commits an intervening marker:
  // the recovery recheck must observe the new phase and drop its stale absence evidence.
  const handlers = publicationHandlers(() => {
    if (!induced) {
      induced = true;
      const mark = secondConnection.markTownHallPublicationInFlight(journalKey, attemptId);
      assert.equal(mark.started, true);
    }
    const error = new Error('mocked ESRCH inspection');
    error.code = 'ESRCH';
    throw error;
  });

  try {
    const publication = handlers.recoverTownHallPublication(f.state, journalKey);
    assert.equal(induced, true);
    assert.equal(publication.status, 'in_flight');
    assert.equal(publication.attemptId, attemptId);
    assert.equal(publication.messageId, null);

    const after = f.state.listReceipts();
    assert.equal(after.length, beforeIds.length + 1);
    const added = after.filter(row => !beforeIds.includes(row.id));
    assert.equal(added.length, 1);
    assert.equal(added[0].kind, PUBLICATION_PREFIX + journalKey);
    assert.equal(added[0].discord_id, null);
    assert.equal(JSON.parse(added[0].detail).event, 'in_flight');
    assert.equal(
      after.some(row => row.kind === PUBLICATION_PREFIX + journalKey && JSON.parse(row.detail).event === 'outcome'),
      false,
      'stale absence evidence must not append an outcome'
    );
    assert.equal(f.state.getTownHallPublication(journalKey).status, 'in_flight');
  } finally {
    restore();
  }
});
