'use strict';

function register({ test, assert, fs, os, path, SurfaceState, BindingError, StateCorruptError, discordNonce, TOWN_HALL_PUBLICATION_RECEIPTS, createTownHallPublicationHandlers, planTownHallRoomParts, INSTRUCTION_PREFIX, PUBLICATION_PREFIX, INSTRUCTION_PART_PREFIX, PUBLICATION_PART_PREFIX, CORRUPT, INVALID_KEY, MISSING_JOURNAL, INVALID_PART, PROJECT_ROOT, SOURCE_ID, CODEX_ID, SECOND_ID, OWNER, address, input, longInput, fixture, publicationKeyFor, partPublicationKey, partReceiptKind, receiptIds, rowsOf, sortedKeys, assertBindingError, assertCorrupt, publicationHandlers, overrideOwnerAlive, insertRawReceipt, dropExpressionIndexes, restoreExpressionIndexes, insertMessagesRow, partIds, journalPlan, eventDetail, seedSentPart }) {
test('publication sets require every expected part', () => {
  const f = fixture();
  try {
    const state = f.state;
    const created = state.createTownHallBroadcast(longInput());
    const journalKey = created.broadcast.journalKey;
    const set = state.getTownHallPublicationSet(journalKey);
    assert.ok(set.parts.length > 1, `expected more than one part, got ${set.parts.length}`);
    assert.equal(set.complete, false);
    assert.equal(set.anchorMessageId, null);
    assert.ok(set.parts.every(part => part.publication.status === 'planned'));

    const ids = set.parts.map(part => part.partId);
    for (const partId of ids.slice(0, -1)) seedSentPart(state, journalKey, partId, `msg-${partId.slice(-6)}`);
    const partial = state.getTownHallPublicationSet(journalKey);
    assert.equal(partial.complete, false, 'a missing part must keep the set incomplete');
    assert.equal(partial.anchorMessageId, null, 'anchor requires a complete set');

    seedSentPart(state, journalKey, ids[ids.length - 1], 'msg-last');
    const complete = state.getTownHallPublicationSet(journalKey);
    assert.equal(complete.complete, true);
    assert.equal(complete.anchorMessageId, complete.parts[0].publication.messageId);

    const one = state.createTownHallBroadcast(input({ broadcastId: 'one-part', text: 'hello' }));
    const oneKey = one.broadcast.journalKey;
    const oneSet = state.getTownHallPublicationSet(oneKey);
    assert.equal(oneSet.parts.length, 1);
    assert.equal(oneSet.complete, false, 'the single part is still an obligation');
    seedSentPart(state, oneKey, oneSet.parts[0].partId, 'one-msg');
    assert.equal(state.getTownHallPublicationSet(oneKey).complete, true);

    assertBindingError(() => state.getTownHallPublicationSet('not-a-key'), INVALID_KEY, 'set invalid key');
    assertBindingError(() => state.getTownHallPublicationSet('f'.repeat(64)), MISSING_JOURNAL, 'set missing journal');
  } finally {
    f.close();
  }
});

test('publication sets ignore the legacy anchor as completion proof', () => {
  const f = fixture();
  try {
    const state = f.state;
    const created = state.createTownHallBroadcast(longInput());
    const journalKey = created.broadcast.journalKey;

    const legacy = state.reserveTownHallPublication(journalKey);
    state.markTownHallPublicationInFlight(journalKey, legacy.publication.attemptId);
    state.recordTownHallPublicationOutcome(journalKey, legacy.publication.attemptId, 'sent', { messageId: 'legacy-msg' });
    assert.equal(state.getTownHallPublication(journalKey).status, 'sent');

    const set = state.getTownHallPublicationSet(journalKey);
    assert.equal(set.complete, false, 'a legacy anchor is not part completion');
    assert.equal(set.anchorMessageId, null);
    assert.ok(set.parts.every(part => part.publication.status === 'planned'));
    assert.equal(rowsOf(state, PUBLICATION_PREFIX + journalKey).length, 3, 'legacy anchor rows stay separate');
    assert.equal(rowsOf(state, partReceiptKind(journalKey, set.parts[0].partId)).length, 0);
  } finally {
    f.close();
  }
});

test('publication part identities bind their canonical content', () => {
  const f = fixture();
  try {
    const state = f.state;
    const created = state.createTownHallBroadcast(longInput());
    const journalKey = created.broadcast.journalKey;
    const plan = created.broadcast.plan;
    const set = state.getTownHallPublicationSet(journalKey);

    const rebuilt = planTownHallRoomParts({
      broadcastId: plan.broadcastId,
      townHall: plan.townHall,
      source: plan.source,
      text: plan.text,
      recipients: plan.recipients.map(recipient => recipient.target)
    });
    assert.equal(rebuilt.plan.fingerprint, plan.fingerprint);
    assert.deepEqual(set.parts.map(part => part.partId), rebuilt.parts.map(part => part.partId));
    assert.deepEqual(set.parts.map(part => part.content), rebuilt.parts.map(part => part.content));
    assert.deepEqual(set.parts.map(part => part.index), rebuilt.parts.map(part => part.index));

    const publicationKeys = new Set();
    const nonces = new Set();
    const kinds = new Set();
    for (const part of set.parts) {
      assert.equal(part.publication.publicationKey, partPublicationKey(journalKey, part.partId));
      assert.equal(part.publication.publicationKey, INSTRUCTION_PART_PREFIX + journalKey + ':' + part.partId);
      assert.equal(part.publication.nonce, discordNonce(part.publication.publicationKey));
      const reserved = state.reserveTownHallPublication(journalKey, part.partId);
      assert.equal(reserved.publication.publicationKey, partPublicationKey(journalKey, part.partId));
      assert.equal(reserved.publication.nonce, discordNonce(partPublicationKey(journalKey, part.partId)));
      const row = rowsOf(state, partReceiptKind(journalKey, part.partId))[0];
      assert.ok(row, 'a part reservation writes its own receipt kind');
      assert.equal(row.kind, PUBLICATION_PART_PREFIX + journalKey + ':' + part.partId);
      assert.equal(row.discord_id, null);
      publicationKeys.add(part.publication.publicationKey);
      nonces.add(part.publication.nonce);
      kinds.add(partReceiptKind(journalKey, part.partId));
    }
    assert.equal(publicationKeys.size, set.parts.length, 'each part has a distinct publication key');
    assert.equal(nonces.size, set.parts.length, 'each part has a distinct nonce');
    assert.equal(kinds.size, set.parts.length, 'each part has a distinct receipt kind');

    const other = state.createTownHallBroadcast(longInput({ broadcastId: 'other-text', text: 'y'.repeat(3000) }));
    const otherSet = state.getTownHallPublicationSet(other.broadcast.journalKey);
    assert.notEqual(other.broadcast.plan.fingerprint, plan.fingerprint);
    assert.notDeepEqual(otherSet.parts.map(part => part.partId), set.parts.map(part => part.partId));
    assert.equal(otherSet.parts[0].content.includes(plan.fingerprint), false);
  } finally {
    f.close();
  }
});

test('publication part selectors refuse unknown and wrong-plan IDs', () => {
  const f = fixture();
  try {
    const state = f.state;
    const created = state.createTownHallBroadcast(longInput());
    const journalKey = created.broadcast.journalKey;
    const other = state.createTownHallBroadcast(longInput({ broadcastId: 'other-plan' }));
    const otherKey = other.broadcast.journalKey;
    const foreignPart = state.getTownHallPublicationSet(otherKey).parts[0].partId;
    const unknownPart = 'townhall_room_' + 'f'.repeat(64);
    const attemptId = '00000000-0000-4000-8000-000000000000';
    const evidence = { messageId: 'm1', nonce: discordNonce(publicationKeyFor(journalKey)), guildId: '100', channelId: '900' };

    const calls = partId => [
      ['get', () => state.getTownHallPublication(journalKey, partId)],
      ['reserve', () => state.reserveTownHallPublication(journalKey, partId)],
      ['mark', () => state.markTownHallPublicationInFlight(journalKey, attemptId, partId)],
      ['record', () => state.recordTownHallPublicationOutcome(journalKey, attemptId, 'not_sent', undefined, partId)],
      ['recover', () => state.recoverTownHallPublication(journalKey, partId)],
      ['confirm', () => state.confirmTownHallPublication(journalKey, attemptId, evidence, partId)]
    ];
    for (const [label, partId] of [['unknown', unknownPart], ['wrong-plan', foreignPart]]) {
      for (const [name, run] of calls(partId)) {
        const before = receiptIds(state);
        assertBindingError(run, INVALID_PART, `${label} ${name}`);
        assert.deepEqual(receiptIds(state), before, `${label} ${name} must not write`);
      }
    }
    assert.equal(rowsOf(state, partReceiptKind(journalKey, foreignPart)).length, 0);
  } finally {
    f.close();
  }
});

test('publication part selectors refuse nonstrings without writes', () => {
  const f = fixture();
  try {
    const state = f.state;
    const created = state.createTownHallBroadcast(longInput());
    const journalKey = created.broadcast.journalKey;
    const attemptId = '00000000-0000-4000-8000-000000000000';
    const evidence = { messageId: 'm1', nonce: discordNonce(publicationKeyFor(journalKey)), guildId: '100', channelId: '900' };

    const originalBroadcast = state.getTownHallBroadcast;
    let journalReads = 0;
    state.getTownHallBroadcast = function counting(...args) {
      journalReads += 1;
      return originalBroadcast.apply(this, args);
    };
    let coerced = 0;
    const coercing = { toString() { coerced += 1; return 'townhall_room_deadbeef'; } };
    try {
      const nonstrings = [null, 42, {}, [], coercing];
      for (const partId of nonstrings) {
        const label = partId === null ? 'null' : Array.isArray(partId) ? 'array' : typeof partId;
        const calls = [
          ['get', () => state.getTownHallPublication(journalKey, partId)],
          ['reserve', () => state.reserveTownHallPublication(journalKey, partId)],
          ['mark', () => state.markTownHallPublicationInFlight(journalKey, attemptId, partId)],
          ['record', () => state.recordTownHallPublicationOutcome(journalKey, attemptId, 'not_sent', undefined, partId)],
          ['recover', () => state.recoverTownHallPublication(journalKey, partId)],
          ['confirm', () => state.confirmTownHallPublication(journalKey, attemptId, evidence, partId)]
        ];
        for (const [name, run] of calls) {
          const before = receiptIds(state);
          assertBindingError(run, INVALID_PART, `${label} ${name}`);
          assert.deepEqual(receiptIds(state), before, `${label} ${name} must not write`);
        }
      }
      assert.equal(journalReads, 0, 'nonstring refusal must not read the journal');
      assert.equal(coerced, 0, 'partId must never be coerced with toString');

      journalReads = 0;
      const before = receiptIds(state);
      assertBindingError(() => state.getTownHallPublication(journalKey, ''), INVALID_PART, 'empty string');
      assert.deepEqual(receiptIds(state), before);
    } finally {
      state.getTownHallBroadcast = originalBroadcast;
    }
  } finally {
    f.close();
  }
});

test('publication part receipts cannot be moved between siblings', () => {
  const f = fixture();
  try {
    const state = f.state;
    const created = state.createTownHallBroadcast(longInput());
    const journalKey = created.broadcast.journalKey;
    const plan = journalPlan(state, journalKey);
    const ids = partIds(state, journalKey);
    assert.ok(ids.length > 1);

    const reserved = state.reserveTownHallPublication(journalKey, ids[0]);
    const row = rowsOf(state, partReceiptKind(journalKey, ids[0]))[0];
    assert.ok(row);
    const fingerprint = plan.fingerprint;
    const nonce0 = reserved.publication.nonce;
    const nonce1 = discordNonce(partPublicationKey(journalKey, ids[1]));

    // (a) move the reserved row's kind onto a sibling.
    state.db.prepare('UPDATE receipts SET kind=? WHERE id=?').run(partReceiptKind(journalKey, ids[1]), row.id);
    assertCorrupt(() => state.getTownHallPublicationSet(journalKey), 'moved kind');
    state.db.prepare('UPDATE receipts SET kind=? WHERE id=?').run(partReceiptKind(journalKey, ids[0]), row.id);

    // (b) rewrite the detail to a sibling's nonce.
    state.db.prepare('UPDATE receipts SET detail=? WHERE id=?').run(
      JSON.stringify(eventDetail(journalKey, fingerprint, nonce1, 'reserved', reserved.publication.attemptId, OWNER())),
      row.id
    );
    assertCorrupt(() => state.getTownHallPublicationSet(journalKey), 'sibling nonce');
    state.db.prepare('UPDATE receipts SET detail=? WHERE id=?').run(
      JSON.stringify(eventDetail(journalKey, fingerprint, nonce0, 'reserved', reserved.publication.attemptId, OWNER())),
      row.id
    );

    // (c) move a second sibling's row onto the first part.
    seedSentPart(state, journalKey, ids[1], 'sibling-msg');
    const sentRow = rowsOf(state, partReceiptKind(journalKey, ids[1])).find(entry => JSON.parse(entry.detail).event === 'outcome');
    assert.ok(sentRow);
    state.db.prepare('UPDATE receipts SET kind=? WHERE id=?').run(partReceiptKind(journalKey, ids[0]), sentRow.id);
    assertCorrupt(() => state.getTownHallPublicationSet(journalKey), 'moved outcome');
  } finally {
    f.close();
  }
});

test('publication part confirmations leave unknown siblings unchanged', () => {
  const f = fixture();
  try {
    const state = f.state;
    const created = state.createTownHallBroadcast(longInput());
    const journalKey = created.broadcast.journalKey;
    const plan = created.broadcast.plan;
    const set = state.getTownHallPublicationSet(journalKey);
    const target = set.parts[0];
    const sibling = set.parts[1];
    const siblingBefore = JSON.parse(JSON.stringify(sibling.publication));
    const siblingRowsBefore = rowsOf(state, partReceiptKind(journalKey, sibling.partId)).length;

    const reserved = state.reserveTownHallPublication(journalKey, target.partId);
    state.markTownHallPublicationInFlight(journalKey, reserved.publication.attemptId, target.partId);
    state.recordTownHallPublicationOutcome(journalKey, reserved.publication.attemptId, 'unknown', undefined, target.partId);

    const confirmed = state.confirmTownHallPublication(journalKey, reserved.publication.attemptId, {
      messageId: 'confirmed-msg',
      nonce: reserved.publication.nonce,
      guildId: plan.townHall.guildId,
      channelId: plan.townHall.channelId
    }, target.partId);
    assert.equal(confirmed.status, 'sent');
    assert.equal(confirmed.messageId, 'confirmed-msg');

    const after = state.getTownHallPublicationSet(journalKey);
    assert.equal(after.parts[0].publication.status, 'sent');
    assert.equal(after.parts[1].publication.status, 'planned');
    assert.deepEqual(JSON.parse(JSON.stringify(after.parts[1].publication)), siblingBefore);
    assert.equal(rowsOf(state, partReceiptKind(journalKey, sibling.partId)).length, siblingRowsBefore);
    assert.equal(rowsOf(state, partReceiptKind(journalKey, target.partId)).length, 4, 'claimed, in_flight, unknown, confirmed');

    assertBindingError(
      () => state.confirmTownHallPublication(journalKey, reserved.publication.attemptId, {
        messageId: 'other',
        nonce: reserved.publication.nonce,
        guildId: plan.townHall.guildId,
        channelId: plan.townHall.channelId
      }, sibling.partId),
      'town-hall publication confirmation is not admissible',
      'confirm sibling with foreign attempt'
    );
    assert.equal(rowsOf(state, partReceiptKind(journalKey, sibling.partId)).length, siblingRowsBefore);
  } finally {
    f.close();
  }
});
}

module.exports = register;
