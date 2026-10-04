'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { StateCorruptError } = require('../../src/state');
const {
  receiptIds,
  publicationRows,
  townHallFixture,
  townHallHandlers,
  probeError,
  PUBLICATION_PREFIX
} = require('./fixtures.cjs');

// ---------------------------------------------------------------------------
// Test 6: town-hall domain policy
// ---------------------------------------------------------------------------

test('town-hall preserves claimed hold and in-flight unknown under shared evidence', t => {
  // CLAIMED + probe proves absence (ESRCH): the domain releases the matching claim.
  {
    const { state, journalKey, attemptId } = townHallFixture(t, 'b1');
    const before = receiptIds(state);
    const recovered = townHallHandlers(() => { throw probeError('ESRCH'); }).recoverTownHallPublication(state, journalKey);
    assert.equal(recovered.status, 'not_sent');
    assert.equal(recovered.attemptId, attemptId);
    const outcomes = publicationRows(state, journalKey).filter(row => JSON.parse(row.detail).event === 'outcome');
    assert.equal(outcomes.length, 1);
    assert.equal(JSON.parse(outcomes[0].detail).outcome, 'not_sent');
    assert.deepEqual(receiptIds(state), before.concat([outcomes[0].id]));
  }

  // CLAIMED + matching-live identity: hold, no settlement.
  {
    const { state, journalKey } = townHallFixture(t, 'b2');
    const before = receiptIds(state);
    const held = townHallHandlers(() => true).recoverTownHallPublication(state, journalKey);
    assert.equal(held.status, 'claimed');
    assert.deepEqual(receiptIds(state), before);
    assert.equal(publicationRows(state, journalKey).some(row => JSON.parse(row.detail).event === 'outcome'), false);
  }

  // CLAIMED + proved identity mismatch: domain downgrades absence to indeterminate and holds.
  {
    const { state, journalKey } = townHallFixture(t, 'b3');
    state.directPostOwnerIdentity = () => ({ ownerPid: process.pid, ownerStartTime: 'other-start', ownerCommand: 'recorded-command' });
    const before = receiptIds(state);
    const held = townHallHandlers(() => true).recoverTownHallPublication(state, journalKey);
    assert.equal(held.status, 'claimed');
    assert.deepEqual(receiptIds(state), before);
    assert.equal(publicationRows(state, journalKey).some(row => JSON.parse(row.detail).event === 'outcome'), false);
  }

  // CLAIMED + unreadable identity (unobservable evidence): hold, no settlement.
  {
    const { state, journalKey } = townHallFixture(t, 'b4');
    state.directPostOwnerIdentity = () => null;
    const before = receiptIds(state);
    const held = townHallHandlers(() => true).recoverTownHallPublication(state, journalKey);
    assert.equal(held.status, 'claimed');
    assert.deepEqual(receiptIds(state), before);
  }

  // IN_FLIGHT + indeterminate probe: existing unknown-outcome transition.
  {
    const { state, journalKey, attemptId } = townHallFixture(t, 'b5');
    state.markTownHallPublicationInFlight(journalKey, attemptId);
    const before = receiptIds(state);
    const observed = townHallHandlers(() => { throw probeError('EPERM'); }).recoverTownHallPublication(state, journalKey);
    assert.equal(observed.status, 'unknown');
    assert.equal(observed.messageId, null);
    const outcomes = publicationRows(state, journalKey).filter(row => JSON.parse(row.detail).event === 'outcome');
    assert.equal(outcomes.length, 1);
    assert.equal(JSON.parse(outcomes[0].detail).outcome, 'unknown');
    assert.deepEqual(receiptIds(state), before.concat([outcomes[0].id]));
  }

  // IN_FLIGHT + matching-live: hold in flight, no settlement.
  {
    const { state, journalKey, attemptId } = townHallFixture(t, 'b6');
    state.markTownHallPublicationInFlight(journalKey, attemptId);
    const before = receiptIds(state);
    const held = townHallHandlers(() => true).recoverTownHallPublication(state, journalKey);
    assert.equal(held.status, 'in_flight');
    assert.deepEqual(receiptIds(state), before);
    assert.equal(publicationRows(state, journalKey).some(row => JSON.parse(row.detail).event === 'outcome'), false);
  }

  // Missing recorded start time cannot be presented through the typed journal:
  // the journal decoder refuses the row as corrupt before classification, so the
  // weak claim is never released and no outcome is written. The domain adapter's
  // empty-start rule is therefore defensive for this path.
  {
    const { state, journalKey } = townHallFixture(t, 'b7');
    const row = state.db.prepare('SELECT id, detail FROM receipts WHERE kind=?').get(PUBLICATION_PREFIX + journalKey);
    const detail = JSON.parse(row.detail);
    detail.owner.ownerStartTime = '';
    state.db.prepare('UPDATE receipts SET detail=? WHERE id=?').run(JSON.stringify(detail), row.id);
    const before = receiptIds(state);
    assert.throws(
      () => townHallHandlers(() => true).recoverTownHallPublication(state, journalKey),
      StateCorruptError
    );
    assert.deepEqual(receiptIds(state), before, 'a corrupt missing-start row must not write an outcome');
    assert.equal(publicationRows(state, journalKey).some(candidate => JSON.parse(candidate.detail).event === 'outcome'), false);
  }
});
