'use strict';

function register({ test, assert, fs, os, path, SurfaceState, BindingError, StateCorruptError, discordNonce, TOWN_HALL_PUBLICATION_RECEIPTS, createTownHallPublicationHandlers, planTownHallRoomParts, INSTRUCTION_PREFIX, PUBLICATION_PREFIX, INSTRUCTION_PART_PREFIX, PUBLICATION_PART_PREFIX, CORRUPT, INVALID_KEY, MISSING_JOURNAL, INVALID_PART, PROJECT_ROOT, SOURCE_ID, CODEX_ID, SECOND_ID, OWNER, address, input, longInput, fixture, publicationKeyFor, partPublicationKey, partReceiptKind, receiptIds, rowsOf, sortedKeys, assertBindingError, assertCorrupt, publicationHandlers, overrideOwnerAlive, insertRawReceipt, dropExpressionIndexes, restoreExpressionIndexes, insertMessagesRow, partIds, journalPlan, eventDetail, seedSentPart }) {
test('publication parts retry known-unsent with original identity', () => {
  const f = fixture();
  try {
    const state = f.state;
    const created = state.createTownHallBroadcast(longInput());
    const journalKey = created.broadcast.journalKey;
    const fingerprint = created.broadcast.plan.fingerprint;
    const part = state.getTownHallPublicationSet(journalKey).parts[0];

    const reserved = state.reserveTownHallPublication(journalKey, part.partId);
    const firstAttempt = reserved.publication.attemptId;
    state.recordTownHallPublicationOutcome(journalKey, firstAttempt, 'not_sent', undefined, part.partId);
    const retry = state.reserveTownHallPublication(journalKey, part.partId);
    assert.equal(retry.claimed, true);
    assert.equal(retry.publication.publicationKey, part.publication.publicationKey);
    assert.equal(retry.publication.publicationKey, partPublicationKey(journalKey, part.partId));
    assert.equal(retry.publication.nonce, discordNonce(partPublicationKey(journalKey, part.partId)));
    assert.equal(retry.publication.fingerprint, fingerprint);
    assert.notEqual(retry.publication.attemptId, firstAttempt);

    const after = state.getTownHallPublicationSet(journalKey).parts[0];
    assert.equal(after.partId, part.partId);
    assert.equal(after.content, part.content);
    assert.equal(after.publication.status, 'claimed');
    assert.equal(rowsOf(state, partReceiptKind(journalKey, part.partId)).filter(row => JSON.parse(row.detail).event === 'reserved').length, 2);
  } finally {
    f.close();
  }
});

test('publication parts never reserve unknown outcomes again', () => {
  const f = fixture();
  try {
    const state = f.state;
    const created = state.createTownHallBroadcast(longInput());
    const journalKey = created.broadcast.journalKey;
    const parts = state.getTownHallPublicationSet(journalKey).parts;
    const reserved = state.reserveTownHallPublication(journalKey, parts[0].partId);
    state.markTownHallPublicationInFlight(journalKey, reserved.publication.attemptId, parts[0].partId);
    state.recordTownHallPublicationOutcome(journalKey, reserved.publication.attemptId, 'unknown', undefined, parts[0].partId);

    const before = receiptIds(state);
    const again = state.reserveTownHallPublication(journalKey, parts[0].partId);
    assert.equal(again.claimed, false);
    assert.equal(again.publication.status, 'unknown');
    assert.equal(again.publication.attemptId, reserved.publication.attemptId);
    assert.deepEqual(receiptIds(state), before);

    const sibling = state.reserveTownHallPublication(journalKey, parts[1].partId);
    assert.equal(sibling.claimed, true, 'an unknown sibling must not block other parts');
    assert.equal(state.getTownHallPublicationSet(journalKey).parts[0].publication.status, 'unknown');
  } finally {
    f.close();
  }
});

test('publication part recovery separates preflight and in-flight death', () => {
  const f = fixture();
  try {
    const state = f.state;
    const created = state.createTownHallBroadcast(longInput());
    const journalKey = created.broadcast.journalKey;
    const parts = state.getTownHallPublicationSet(journalKey).parts;

    // Preflight: claimed owner absent -> not_sent for exactly that part.
    const claimed = state.reserveTownHallPublication(journalKey, parts[0].partId);
    const restoreAlive = overrideOwnerAlive(state, false);
    try {
      const esrch = publicationHandlers(() => { const error = new Error('mocked ESRCH'); error.code = 'ESRCH'; throw error; });
      const recovered = esrch.recoverTownHallPublication(state, journalKey, parts[0].partId);
      assert.equal(recovered.status, 'not_sent');
      assert.equal(recovered.messageId, null);
      assert.equal(recovered.attemptId, claimed.publication.attemptId);
      assert.equal(recovered.nonce, claimed.publication.nonce);

      // Indeterminate preflight stays claimed.
      const second = state.reserveTownHallPublication(journalKey, parts[1].partId);
      const eperm = publicationHandlers(() => { const error = new Error('mocked EPERM'); error.code = 'EPERM'; throw error; });
      const held = eperm.recoverTownHallPublication(state, journalKey, parts[1].partId);
      assert.equal(held.status, 'claimed');
      assert.equal(held.attemptId, second.publication.attemptId);

      // In-flight absence -> unknown; indeterminate in-flight -> unknown.
      const third = state.reserveTownHallPublication(journalKey, parts[2].partId);
      state.markTownHallPublicationInFlight(journalKey, third.publication.attemptId, parts[2].partId);
      const observed = esrch.recoverTownHallPublication(state, journalKey, parts[2].partId);
      assert.equal(observed.status, 'unknown');
      assert.equal(observed.attemptId, third.publication.attemptId);

      const fourth = state.reserveTownHallPublication(journalKey, parts[3].partId);
      state.markTownHallPublicationInFlight(journalKey, fourth.publication.attemptId, parts[3].partId);
      const unknown = eperm.recoverTownHallPublication(state, journalKey, parts[3].partId);
      assert.equal(unknown.status, 'unknown');
      assert.equal(unknown.attemptId, fourth.publication.attemptId);
    } finally {
      restoreAlive();
    }

    const set = state.getTownHallPublicationSet(journalKey);
    assert.equal(set.parts[0].publication.status, 'not_sent');
    assert.equal(set.parts[1].publication.status, 'claimed');
    assert.equal(set.parts[2].publication.status, 'unknown');
    assert.equal(set.parts[3].publication.status, 'unknown');
    assert.equal(set.parts[4].publication.status, 'planned', 'untouched siblings stay planned');
  } finally {
    f.close();
  }
});

test('publication sets survive reopen with the same ordered obligations', () => {
  const f = fixture();
  try {
    const created = f.state.createTownHallBroadcast(longInput());
    const journalKey = created.broadcast.journalKey;
    const before = f.state.getTownHallPublicationSet(journalKey);
    seedSentPart(f.state, journalKey, before.parts[0].partId, 'reopen-msg');
    const partial = f.state.getTownHallPublicationSet(journalKey);

    const reopened = f.reopen();
    const after = reopened.getTownHallPublicationSet(journalKey);
    assert.deepEqual(after.parts.map(part => part.partId), before.parts.map(part => part.partId));
    assert.deepEqual(after.parts.map(part => [part.index, part.total, part.content]), before.parts.map(part => [part.index, part.total, part.content]));
    assert.equal(after.parts[0].publication.status, 'sent');
    assert.equal(after.parts[0].publication.messageId, 'reopen-msg');
    assert.equal(after.complete, partial.complete);
    assert.equal(after.fingerprint, partial.fingerprint);

    const second = f.reopen();
    const final = second.getTownHallPublicationSet(journalKey);
    assert.deepEqual(final.parts.map(part => part.partId), before.parts.map(part => part.partId));
    assert.equal(final.parts[0].publication.status, 'sent');
  } finally {
    f.close();
  }
});
}

module.exports = register;
