'use strict';

const { TOWN_HALL_PUBLICATION_EVENTS } = require('../dist/state/town-hall-publication/index.js');
const { SurfaceState, discordNonce } = require('../src/state');
const { CONFIRM_REFUSED, INVALID_OUTCOME, MARK_REFUSED, OUTCOME_CONFLICT, RECORD_REFUSED, assertBindingError, assertBindingRefusal, assertFrozenProjection, fixture, input, overrideOwnerAlive, overrideOwnerIdentity, parsedPublicationRows, publicationHandlers, publicationKeyFor, publicationRows, receiptIds, sortedKeys } = require('./town-hall-publication-scenarios-fixtures.cjs');
const { foreignAttemptId } = require('./town-hall-publication-scenarios-history.cjs');
const assert = require('node:assert/strict');
const test = require('node:test');

test('orphan in-flight stays unknown across reopen and cannot resend', t => {
  const f = fixture(t);
  const created = f.state.createTownHallBroadcast(input());
  const journalKey = created.broadcast.journalKey;
  const nonce = discordNonce(publicationKeyFor(journalKey));
  const reserved = f.state.reserveTownHallPublication(journalKey);
  const attemptId = reserved.publication.attemptId;
  f.state.markTownHallPublicationInFlight(journalKey, attemptId);
  f.state.close();

  const reopened = new SurfaceState(f.dbPath);
  t.after(() => { try { reopened.close(); } catch {} });
  overrideOwnerAlive(reopened, false);
  const esrch = publicationHandlers(() => {
    const error = new Error('mocked ESRCH inspection');
    error.code = 'ESRCH';
    throw error;
  });
  const publication = esrch.recoverTownHallPublication(reopened, journalKey);
  assert.equal(publication.status, 'unknown');
  assert.equal(publication.attemptId, attemptId);
  assert.equal(publication.messageId, null);
  assert.equal(publication.nonce, nonce);
  const outcomeRows = parsedPublicationRows(reopened, journalKey).filter(row => row.detail.event === 'outcome');
  assert.equal(outcomeRows.length, 1);
  assert.equal(outcomeRows[0].detail.outcome, 'unknown');
  assert.equal(outcomeRows[0].detail.messageId, null);
  reopened.close();

  const second = new SurfaceState(f.dbPath);
  t.after(() => { try { second.close(); } catch {} });
  assert.equal(second.getTownHallPublication(journalKey).status, 'unknown');
  const attemptedReserve = second.reserveTownHallPublication(journalKey);
  assert.equal(attemptedReserve.claimed, false);
  assert.equal(attemptedReserve.publication.status, 'unknown');
  assertBindingError(() => second.markTownHallPublicationInFlight(journalKey, attemptId), MARK_REFUSED, 'resend after unknown');

  const other = second.createTownHallBroadcast(input({ broadcastId: 'b2' }));
  const otherKey = other.broadcast.journalKey;
  const otherReserved = second.reserveTownHallPublication(otherKey);
  second.markTownHallPublicationInFlight(otherKey, otherReserved.publication.attemptId);
  overrideOwnerAlive(second, false);
  const beforeIds = receiptIds(second);
  // Mocked EIO: in-flight plus indeterminate inspection appends UNKNOWN, not held.
  const eio = publicationHandlers(() => {
    const error = new Error('mocked EIO inspection');
    error.code = 'EIO';
    throw error;
  });
  const observed = eio.recoverTownHallPublication(second, otherKey);
  assert.equal(observed.status, 'unknown');
  assert.equal(observed.messageId, null);
  assert.equal(observed.attemptId, otherReserved.publication.attemptId);
  const afterEioIds = receiptIds(second);
  const eioAdded = afterEioIds.filter(id => !beforeIds.includes(id));
  assert.equal(eioAdded.length, 1);
  const eioOutcomes = parsedPublicationRows(second, otherKey).filter(row => row.detail.event === 'outcome');
  assert.equal(eioOutcomes.length, 1);
  assert.equal(eioOutcomes[0].id, eioAdded[0]);
  assert.equal(eioOutcomes[0].discordId, null);
  assert.equal(eioOutcomes[0].detail.outcome, 'unknown');
  assert.equal(eioOutcomes[0].detail.messageId, null);

  const third = new SurfaceState(f.dbPath);
  t.after(() => { try { third.close(); } catch {} });
  const thirdCreated = third.createTownHallBroadcast(input({ broadcastId: 'b3' }));
  const thirdKey = thirdCreated.broadcast.journalKey;
  const thirdReserved = third.reserveTownHallPublication(thirdKey);
  third.markTownHallPublicationInFlight(thirdKey, thirdReserved.publication.attemptId);
  const restoreThirdAlive = overrideOwnerAlive(third, false);
  try {
    const beforeEpermIds = receiptIds(third);
    // Mocked EPERM: in-flight plus permission refusal is indeterminate and appends UNKNOWN.
    const eperm = publicationHandlers(() => {
      const error = new Error('mocked EPERM inspection');
      error.code = 'EPERM';
      throw error;
    });
    const observedEperm = eperm.recoverTownHallPublication(third, thirdKey);
    assert.equal(observedEperm.status, 'unknown');
    assert.equal(observedEperm.messageId, null);
    assert.equal(observedEperm.attemptId, thirdReserved.publication.attemptId);
    const afterEpermIds = receiptIds(third);
    const epermAdded = afterEpermIds.filter(id => !beforeEpermIds.includes(id));
    assert.equal(epermAdded.length, 1);
    const epermOutcomes = parsedPublicationRows(third, thirdKey).filter(row => row.detail.event === 'outcome');
    assert.equal(epermOutcomes.length, 1);
    assert.equal(epermOutcomes[0].id, epermAdded[0]);
    assert.equal(epermOutcomes[0].discordId, null);
    assert.equal(epermOutcomes[0].detail.outcome, 'unknown');
    assert.equal(epermOutcomes[0].detail.messageId, null);
  } finally {
    restoreThirdAlive();
  }
});

test('sent outcome requires in-flight and message ID', t => {
  const f = fixture(t);
  const created = f.state.createTownHallBroadcast(input());
  const journalKey = created.broadcast.journalKey;
  const reserved = f.state.reserveTownHallPublication(journalKey);
  const attemptId = reserved.publication.attemptId;
  f.state.markTownHallPublicationInFlight(journalKey, attemptId);

  const beforeIds = receiptIds(f.state);
  assertBindingRefusal(
    () => f.state.recordTownHallPublicationOutcome(journalKey, attemptId, 'sent'),
    [RECORD_REFUSED, INVALID_OUTCOME],
    'sent without detail'
  );
  assertBindingRefusal(
    () => f.state.recordTownHallPublicationOutcome(journalKey, attemptId, 'sent', {}),
    [RECORD_REFUSED, INVALID_OUTCOME],
    'sent without message id'
  );
  assertBindingRefusal(
    () => f.state.recordTownHallPublicationOutcome(journalKey, attemptId, 'sent', { messageId: '' }),
    [RECORD_REFUSED, INVALID_OUTCOME],
    'sent with empty message id'
  );
  assert.deepEqual(receiptIds(f.state), beforeIds);

  const sent = f.state.recordTownHallPublicationOutcome(journalKey, attemptId, 'sent', { messageId: 'msg-1' });
  assert.equal(sent.status, 'sent');
  assert.equal(sent.messageId, 'msg-1');
  assert.equal(sent.attemptId, attemptId);

  const afterSentIds = receiptIds(f.state);
  assertBindingRefusal(
    () => f.state.recordTownHallPublicationOutcome(journalKey, attemptId, 'not_sent'),
    [OUTCOME_CONFLICT, RECORD_REFUSED, INVALID_OUTCOME],
    'conflicting outcome on sent'
  );
  assertBindingError(() => f.state.markTownHallPublicationInFlight(journalKey, attemptId), MARK_REFUSED, 'mark after sent');
  assert.deepEqual(receiptIds(f.state), afterSentIds);
  assert.equal(f.state.getTownHallPublication(journalKey).status, 'sent');
});

test('repeated outcome is idempotent and conflicts refuse', t => {
  const f = fixture(t);
  const created = f.state.createTownHallBroadcast(input());
  const journalKey = created.broadcast.journalKey;
  const reserved = f.state.reserveTownHallPublication(journalKey);
  const attemptId = reserved.publication.attemptId;
  f.state.markTownHallPublicationInFlight(journalKey, attemptId);

  const first = f.state.recordTownHallPublicationOutcome(journalKey, attemptId, 'sent', { messageId: 'm1' });
  assert.equal(first.status, 'sent');
  assert.equal(first.messageId, 'm1');
  const afterFirstIds = receiptIds(f.state);

  const repeat = f.state.recordTownHallPublicationOutcome(journalKey, attemptId, 'sent', { messageId: 'm1' });
  assert.deepEqual(repeat, first);
  assert.deepEqual(receiptIds(f.state), afterFirstIds);

  assertBindingError(
    () => f.state.recordTownHallPublicationOutcome(journalKey, attemptId, 'sent', { messageId: 'm2' }),
    OUTCOME_CONFLICT,
    'conflicting message id'
  );
  assert.deepEqual(receiptIds(f.state), afterFirstIds);
  assert.deepEqual(f.state.getTownHallPublication(journalKey), first);
});

test('matching late confirmation completes unknown without rewriting it', t => {
  const f = fixture(t);
  const created = f.state.createTownHallBroadcast(input());
  const journalKey = created.broadcast.journalKey;
  const plan = created.broadcast.plan;
  const nonce = discordNonce(publicationKeyFor(journalKey));
  const reserved = f.state.reserveTownHallPublication(journalKey);
  const attemptId = reserved.publication.attemptId;
  f.state.markTownHallPublicationInFlight(journalKey, attemptId);
  const unknown = f.state.recordTownHallPublicationOutcome(journalKey, attemptId, 'unknown');
  assert.equal(unknown.status, 'unknown');
  assert.equal(unknown.messageId, null);

  const unknownRow = publicationRows(f.state, journalKey)
    .find(row => JSON.parse(row.detail).event === 'outcome');
  assert.ok(unknownRow);
  const unknownBefore = { id: unknownRow.id, detail: unknownRow.detail };

  const confirmed = f.state.confirmTownHallPublication(journalKey, attemptId, {
    messageId: 'm1',
    nonce,
    guildId: plan.townHall.guildId,
    channelId: plan.townHall.channelId
  });
  assert.equal(confirmed.status, 'sent');
  assert.equal(confirmed.messageId, 'm1');
  assert.equal(confirmed.attemptId, attemptId);
  assert.equal(confirmed.nonce, nonce);
  assertFrozenProjection(confirmed);

  const rows = publicationRows(f.state, journalKey);
  const preserved = rows.find(row => row.id === unknownBefore.id);
  assert.ok(preserved);
  assert.equal(preserved.detail, unknownBefore.detail);
  assert.equal(preserved.discord_id, null);
  const confirmedRow = rows.find(row => row.id > unknownBefore.id);
  assert.ok(confirmedRow);
  assert.equal(confirmedRow.id > unknownBefore.id, true);
  const detail = JSON.parse(confirmedRow.detail);
  assert.deepEqual(
    sortedKeys(detail),
    ['attemptId', 'channelId', 'event', 'fingerprint', 'guildId', 'journalKey', 'messageId', 'nonce', 'owner', 'version'].sort()
  );
  assert.equal(detail.version, 1);
  assert.equal(detail.journalKey, journalKey);
  assert.equal(detail.fingerprint, plan.fingerprint);
  assert.equal(detail.event, TOWN_HALL_PUBLICATION_EVENTS.CONFIRMED);
  assert.equal(detail.attemptId, attemptId);
  assert.equal(detail.nonce, nonce);
  assert.equal(detail.messageId, 'm1');
  assert.equal(detail.guildId, plan.townHall.guildId);
  assert.equal(detail.channelId, plan.townHall.channelId);
});

test('mismatched or duplicate confirmation preserves exact custody', t => {
  const f = fixture(t);
  const created = f.state.createTownHallBroadcast(input());
  const journalKey = created.broadcast.journalKey;
  const plan = created.broadcast.plan;
  const nonce = discordNonce(publicationKeyFor(journalKey));
  const reserved = f.state.reserveTownHallPublication(journalKey);
  const attemptId = reserved.publication.attemptId;
  f.state.markTownHallPublicationInFlight(journalKey, attemptId);
  f.state.recordTownHallPublicationOutcome(journalKey, attemptId, 'unknown');

  const evidence = {
    messageId: 'm1',
    nonce,
    guildId: plan.townHall.guildId,
    channelId: plan.townHall.channelId
  };
  const refusals = [
    { ...evidence, nonce: discordNonce('town-hall-instruction/v1:' + 'f'.repeat(64)) },
    { ...evidence, guildId: 'other-guild' },
    { ...evidence, channelId: 'other-channel' },
    { ...evidence, messageId: '' },
    { ...evidence, extra: true }
  ];
  for (const [index, wrong] of refusals.entries()) {
    const beforeIds = receiptIds(f.state);
    assertBindingError(
      () => f.state.confirmTownHallPublication(journalKey, attemptId, wrong),
      CONFIRM_REFUSED,
      `mismatched confirmation ${index}`
    );
    assert.deepEqual(receiptIds(f.state), beforeIds);
  }

  const beforeOwnerIds = receiptIds(f.state);
  const restore = overrideOwnerIdentity(f.state, {
    ownerPid: process.pid,
    ownerStartTime: 'later-observer-generation',
    ownerCommand: null
  });
  try {
    assertBindingError(
      () => f.state.confirmTownHallPublication(journalKey, attemptId, evidence),
      CONFIRM_REFUSED,
      'later observer confirmation'
    );
  } finally {
    restore();
  }
  assert.deepEqual(receiptIds(f.state), beforeOwnerIds);
  assert.equal(f.state.getTownHallPublication(journalKey).status, 'unknown');

  const confirmed = f.state.confirmTownHallPublication(journalKey, attemptId, evidence);
  assert.equal(confirmed.status, 'sent');
  assert.equal(confirmed.messageId, 'm1');
  const afterConfirmIds = receiptIds(f.state);
  const repeated = f.state.confirmTownHallPublication(journalKey, attemptId, evidence);
  assert.deepEqual(repeated, confirmed);
  assert.deepEqual(receiptIds(f.state), afterConfirmIds);
  const restoreConfirmOwner = overrideOwnerIdentity(f.state, {
    ownerPid: process.pid,
    ownerStartTime: 'later-observer-generation',
    ownerCommand: null
  });
  try {
    assertBindingError(
      () => f.state.confirmTownHallPublication(journalKey, attemptId, evidence),
      CONFIRM_REFUSED,
      'non-owner repeat of exact confirmation'
    );
  } finally {
    restoreConfirmOwner();
  }
  assert.deepEqual(receiptIds(f.state), afterConfirmIds);

  const second = f.state.createTownHallBroadcast(input({ broadcastId: 'b2' }));
  const secondKey = second.broadcast.journalKey;
  const secondReserved = f.state.reserveTownHallPublication(secondKey);
  f.state.markTownHallPublicationInFlight(secondKey, secondReserved.publication.attemptId);
  f.state.recordTownHallPublicationOutcome(secondKey, secondReserved.publication.attemptId, 'sent', { messageId: 'm9' });
  assertBindingError(
    () => f.state.confirmTownHallPublication(secondKey, secondReserved.publication.attemptId, {
      messageId: 'm9',
      nonce: discordNonce(publicationKeyFor(secondKey)),
      guildId: plan.townHall.guildId,
      channelId: plan.townHall.channelId
    }),
    CONFIRM_REFUSED,
    'confirmation after sent without unknown'
  );

  const planned = f.state.createTownHallBroadcast(input({ broadcastId: 'b3' }));
  assertBindingError(
    () => f.state.confirmTownHallPublication(planned.broadcast.journalKey, foreignAttemptId(), {
      messageId: 'm1',
      nonce: discordNonce(publicationKeyFor(planned.broadcast.journalKey)),
      guildId: plan.townHall.guildId,
      channelId: plan.townHall.channelId
    }),
    CONFIRM_REFUSED,
    'confirmation on planned'
  );

  const claimed = f.state.createTownHallBroadcast(input({ broadcastId: 'b4' }));
  const claimedReserved = f.state.reserveTownHallPublication(claimed.broadcast.journalKey);
  assertBindingError(
    () => f.state.confirmTownHallPublication(claimed.broadcast.journalKey, claimedReserved.publication.attemptId, {
      messageId: 'm1',
      nonce: discordNonce(publicationKeyFor(claimed.broadcast.journalKey)),
      guildId: plan.townHall.guildId,
      channelId: plan.townHall.channelId
    }),
    CONFIRM_REFUSED,
    'confirmation on claimed'
  );

  const inFlight = f.state.createTownHallBroadcast(input({ broadcastId: 'b5' }));
  const inFlightReserved = f.state.reserveTownHallPublication(inFlight.broadcast.journalKey);
  f.state.markTownHallPublicationInFlight(inFlight.broadcast.journalKey, inFlightReserved.publication.attemptId);
  assertBindingError(
    () => f.state.confirmTownHallPublication(inFlight.broadcast.journalKey, inFlightReserved.publication.attemptId, {
      messageId: 'm1',
      nonce: discordNonce(publicationKeyFor(inFlight.broadcast.journalKey)),
      guildId: plan.townHall.guildId,
      channelId: plan.townHall.channelId
    }),
    CONFIRM_REFUSED,
    'confirmation on in_flight'
  );
});
