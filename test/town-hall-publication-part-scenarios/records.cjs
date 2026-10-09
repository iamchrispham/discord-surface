'use strict';

function register({ test, assert, fs, os, path, SurfaceState, BindingError, StateCorruptError, discordNonce, TOWN_HALL_PUBLICATION_RECEIPTS, createTownHallPublicationHandlers, planTownHallRoomParts, INSTRUCTION_PREFIX, PUBLICATION_PREFIX, INSTRUCTION_PART_PREFIX, PUBLICATION_PART_PREFIX, CORRUPT, INVALID_KEY, MISSING_JOURNAL, INVALID_PART, PROJECT_ROOT, SOURCE_ID, CODEX_ID, SECOND_ID, OWNER, address, input, longInput, fixture, publicationKeyFor, partPublicationKey, partReceiptKind, receiptIds, rowsOf, sortedKeys, assertBindingError, assertCorrupt, publicationHandlers, overrideOwnerAlive, insertRawReceipt, dropExpressionIndexes, restoreExpressionIndexes, insertMessagesRow, partIds, journalPlan, eventDetail, seedSentPart }) {
test('publication sets reject malformed and orphaned part receipts', () => {
  const f = fixture();
  try {
    const state = f.state;
    const unrelated = state.createTownHallBroadcast(longInput({ broadcastId: 'unrelated-case-prefix' }));
    const unrelatedKey = unrelated.broadcast.journalKey;
    insertMessagesRow(state, 'unrelated-case-message');
    insertRawReceipt(state, PUBLICATION_PART_PREFIX.toUpperCase() + unrelatedKey + ':other', {}, 'unrelated-case-message');
    const beforeUnrelatedRead = receiptIds(state);
    assert.equal(state.getTownHallPublicationSet(unrelatedKey).complete, false);
    assert.deepEqual(receiptIds(state), beforeUnrelatedRead);

    // Malformed JSON cannot be inserted past the json_extract expression indexes.
    const expressionIndexes = dropExpressionIndexes(state);
    try {

    // malformed JSON
    const bad = state.createTownHallBroadcast(longInput({ broadcastId: 'bad-json' }));
    const badKey = bad.broadcast.journalKey;
    insertRawReceipt(state, partReceiptKind(badKey, partIds(state, badKey)[0]), '{not json');
    assertCorrupt(() => state.getTownHallPublicationSet(badKey), 'malformed json');

    // wrong nonce
    const wrongNonce = state.createTownHallBroadcast(longInput({ broadcastId: 'wrong-nonce' }));
    const wrongNonceKey = wrongNonce.broadcast.journalKey;
    insertRawReceipt(state, partReceiptKind(wrongNonceKey, partIds(state, wrongNonceKey)[0]), eventDetail(
      wrongNonceKey, wrongNonce.broadcast.plan.fingerprint, discordNonce('other'), 'reserved',
      '00000000-0000-4000-8000-000000000001', OWNER()
    ));
    assertCorrupt(() => state.getTownHallPublicationSet(wrongNonceKey), 'wrong nonce');

    // wrong fingerprint
    const wrongFingerprint = state.createTownHallBroadcast(longInput({ broadcastId: 'wrong-fp' }));
    const wrongFingerprintKey = wrongFingerprint.broadcast.journalKey;
    const wrongFingerprintPart = partIds(state, wrongFingerprintKey)[0];
    insertRawReceipt(state, partReceiptKind(wrongFingerprintKey, wrongFingerprintPart), eventDetail(
      wrongFingerprintKey, 'f'.repeat(64), discordNonce(partPublicationKey(wrongFingerprintKey, wrongFingerprintPart)),
      'reserved', '00000000-0000-4000-8000-000000000002', OWNER()
    ));
    assertCorrupt(() => state.getTownHallPublicationSet(wrongFingerprintKey), 'wrong fingerprint');

    // wrong version
    const wrongVersion = state.createTownHallBroadcast(longInput({ broadcastId: 'wrong-version' }));
    const wrongVersionKey = wrongVersion.broadcast.journalKey;
    const wrongVersionPart = partIds(state, wrongVersionKey)[0];
    insertRawReceipt(state, partReceiptKind(wrongVersionKey, wrongVersionPart), {
      ...eventDetail(wrongVersionKey, wrongVersion.broadcast.plan.fingerprint,
        discordNonce(partPublicationKey(wrongVersionKey, wrongVersionPart)), 'reserved',
        '00000000-0000-4000-8000-000000000003', OWNER()),
      version: 2
    });
    assertCorrupt(() => state.getTownHallPublicationSet(wrongVersionKey), 'wrong version');

    // unexpected part ID suffix
    const unexpected = state.createTownHallBroadcast(longInput({ broadcastId: 'unexpected-part' }));
    const unexpectedKey = unexpected.broadcast.journalKey;
    insertRawReceipt(state, partReceiptKind(unexpectedKey, 'townhall_room_' + 'f'.repeat(64)), eventDetail(
      unexpectedKey, unexpected.broadcast.plan.fingerprint, discordNonce('other'), 'reserved',
      '00000000-0000-4000-8000-000000000004', OWNER()
    ));
    assertCorrupt(() => state.getTownHallPublicationSet(unexpectedKey), 'unexpected part');

    // non-null discord_id
    const bound = state.createTownHallBroadcast(longInput({ broadcastId: 'bound-receipt' }));
    const boundKey = bound.broadcast.journalKey;
    const boundPart = partIds(state, boundKey)[0];
    insertMessagesRow(state, 'discord-bound-1');
    insertRawReceipt(state, partReceiptKind(boundKey, boundPart), eventDetail(
      boundKey, bound.broadcast.plan.fingerprint, discordNonce(partPublicationKey(boundKey, boundPart)),
      'reserved', '00000000-0000-4000-8000-000000000005', OWNER()
    ), 'discord-bound-1');
    assertCorrupt(() => state.getTownHallPublicationSet(boundKey), 'non-null discord id');

    // orphan outcome with no reservation
    const orphan = state.createTownHallBroadcast(longInput({ broadcastId: 'orphan-outcome' }));
    const orphanKey = orphan.broadcast.journalKey;
    const orphanPart = partIds(state, orphanKey)[0];
    insertRawReceipt(state, partReceiptKind(orphanKey, orphanPart), eventDetail(
      orphanKey, orphan.broadcast.plan.fingerprint, discordNonce(partPublicationKey(orphanKey, orphanPart)),
      'outcome', '00000000-0000-4000-8000-000000000006', OWNER(), { outcome: 'not_sent', messageId: null }
    ));
    assertCorrupt(() => state.getTownHallPublicationSet(orphanKey), 'orphan outcome');

    // a sibling that is otherwise clean still refuses alongside the bad row
    const mixed = state.createTownHallBroadcast(longInput({ broadcastId: 'mixed-clean' }));
    const mixedKey = mixed.broadcast.journalKey;
    const mixedParts = partIds(state, mixedKey);
    seedSentPart(state, mixedKey, mixedParts[0], 'clean-msg');
    insertRawReceipt(state, mixedParts.length > 1 ? partReceiptKind(mixedKey, mixedParts[1]) : partReceiptKind(mixedKey, mixedParts[0]), '{bad');
    assertCorrupt(() => state.getTownHallPublicationSet(mixedKey), 'partial valid then malformed');
    } finally {
      // Remove the malformed rows before recreating the json_extract indexes.
      state.db.prepare('DELETE FROM receipts WHERE detail=?').run('{not json');
      state.db.prepare('DELETE FROM receipts WHERE detail=?').run('{bad');
      restoreExpressionIndexes(state, expressionIndexes);
    }
  } finally {
    f.close();
  }
});

test('publication sets reject duplicate sent message IDs', () => {
  const f = fixture();
  try {
    const state = f.state;
    const created = state.createTownHallBroadcast(longInput());
    const journalKey = created.broadcast.journalKey;
    const ids = partIds(state, journalKey);
    assert.ok(ids.length > 1);

    seedSentPart(state, journalKey, ids[0], 'dup-msg');
    seedSentPart(state, journalKey, ids[1], 'dup-msg');
    assertCorrupt(() => state.getTownHallPublicationSet(journalKey), 'duplicate while incomplete');

    // Even a fully complete-looking set with a repeated ID refuses.
    for (let index = 2; index < ids.length; index += 1) seedSentPart(state, journalKey, ids[index], `unique-${index}`);
    assertCorrupt(() => state.getTownHallPublicationSet(journalKey), 'duplicate while otherwise complete');

    // Repair one duplicate to distinct IDs and the set completes.
    const sentRow = rowsOf(state, partReceiptKind(journalKey, ids[1]))
      .find(row => JSON.parse(row.detail).event === 'outcome');
    assert.ok(sentRow);
    state.db.prepare('UPDATE receipts SET detail=? WHERE id=?').run(
      JSON.stringify({ ...JSON.parse(sentRow.detail), messageId: 'distinct-msg' }),
      sentRow.id
    );
    const repaired = state.getTownHallPublicationSet(journalKey);
    assert.equal(repaired.complete, true);
    assert.equal(new Set(repaired.parts.map(part => part.publication.messageId)).size, ids.length);
  } finally {
    f.close();
  }
});

test('publication set reads use one snapshot without nested transactions', () => {
  const f = fixture();
  try {
    const state = f.state;
    const created = state.createTownHallBroadcast(longInput());
    const journalKey = created.broadcast.journalKey;
    seedSentPart(state, journalKey, partIds(state, journalKey)[0], 'snapshot-msg');

    const originalTransaction = state.transaction;
    const originalBroadcast = state.getTownHallBroadcast;
    const originalReceipt = state.receipt;
    const events = [];
    let depth = 0;
    state.transaction = function tracking(operation) {
      events.push({ kind: 'begin', depth });
      depth += 1;
      try {
        return originalTransaction.call(this, operation);
      } finally {
        depth -= 1;
      }
    };
    state.getTownHallBroadcast = function trackingBroadcast(...args) {
      events.push({ kind: 'journal', depth });
      return originalBroadcast.apply(this, args);
    };
    state.receipt = function trackingReceipt(...args) {
      events.push({ kind: 'write', depth });
      return originalReceipt.apply(this, args);
    };
    const transitions = {};
    for (const name of ['getTownHallPublication', 'reserveTownHallPublication', 'markTownHallPublicationInFlight',
      'recordTownHallPublicationOutcome', 'recoverTownHallPublication', 'confirmTownHallPublication']) {
      const original = state[name];
      transitions[name] = 0;
      state[name] = function trackingTransition(...args) {
        transitions[name] += 1;
        events.push({ kind: 'transition', name, depth });
        return original.apply(this, args);
      };
    }

    try {
      const set = state.getTownHallPublicationSet(journalKey);
      assert.ok(set.parts.length > 0);

      const journalEvent = events.find(event => event.kind === 'journal');
      assert.ok(journalEvent, 'the journal read happens');
      assert.equal(journalEvent.depth, 0, 'the journal read runs outside any transaction');

      const begins = events.filter(event => event.kind === 'begin');
      assert.equal(begins.length, 2, 'the journal transaction plus exactly one set transaction');
      const setBeginIndex = events.lastIndexOf(begins[1]);
      const setBegin = events[setBeginIndex];
      assert.equal(setBegin.depth, 0, 'the set transaction starts at depth zero');

      const inside = events.slice(setBeginIndex + 1).filter(event => event.kind === 'begin');
      assert.equal(inside.length, 0, 'the set transaction does not nest');
      assert.equal(events.some(event => event.kind === 'transition'), false, 'no public transition runs during the read');
      assert.equal(events.some(event => event.kind === 'write' && event.depth > 0), false, 'the read performs no write');
      assert.deepEqual(Object.values(transitions).reduce((sum, count) => sum + count, 0), 0);
    } finally {
      state.transaction = originalTransaction;
      state.getTownHallBroadcast = originalBroadcast;
      state.receipt = originalReceipt;
    }

    // A second read still opens exactly one set transaction.
    const before = receiptIds(state);
    state.getTownHallPublicationSet(journalKey);
    assert.deepEqual(receiptIds(state), before, 'the set read is write free');
  } finally {
    f.close();
  }
});

test('publication sets freeze records and preserve legacy projections', () => {
  const f = fixture();
  try {
    const state = f.state;
    const created = state.createTownHallBroadcast(longInput());
    const journalKey = created.broadcast.journalKey;
    const set = state.getTownHallPublicationSet(journalKey);

    assert.deepEqual(sortedKeys(set), ['anchorMessageId', 'complete', 'fingerprint', 'journalKey', 'parts']);
    assert.ok(Object.isFrozen(set));
    assert.ok(Object.isFrozen(set.parts));
    assert.throws(() => { set.complete = true; }, TypeError);
    assert.throws(() => { set.parts.push(set.parts[0]); }, TypeError);
    for (const part of set.parts) {
      assert.deepEqual(sortedKeys(part), ['content', 'index', 'partId', 'publication', 'total']);
      assert.ok(Object.isFrozen(part));
      assert.ok(Object.isFrozen(part.publication));
      assert.throws(() => { part.partId = 'mutated'; }, TypeError);
      assert.throws(() => { part.publication.status = 'mutated'; }, TypeError);
    }

    const legacy = state.getTownHallPublication(journalKey);
    assert.deepEqual(sortedKeys(legacy), ['attemptId', 'fingerprint', 'journalKey', 'messageId', 'nonce', 'owner', 'publicationKey', 'status'].sort());
    assert.equal(legacy.publicationKey, publicationKeyFor(journalKey));
    const legacyReserved = state.reserveTownHallPublication(journalKey);
    assert.deepEqual(sortedKeys(legacyReserved.publication), ['attemptId', 'fingerprint', 'journalKey', 'messageId', 'nonce', 'owner', 'publicationKey', 'status'].sort());
    assert.equal(legacyReserved.publication.publicationKey, publicationKeyFor(journalKey));
    assert.equal(legacyReserved.claimed, true);

    const partReserved = state.reserveTownHallPublication(journalKey, set.parts[0].partId);
    assert.deepEqual(sortedKeys(partReserved.publication), ['attemptId', 'fingerprint', 'journalKey', 'messageId', 'nonce', 'owner', 'publicationKey', 'status'].sort());
    assert.equal(partReserved.publication.publicationKey, partPublicationKey(journalKey, set.parts[0].partId));
  } finally {
    f.close();
  }
});
}

module.exports = register;
