'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { SurfaceState, BindingError, StateCorruptError, discordNonce } = require('../src/state');
const {
  TOWN_HALL_PUBLICATION_RECEIPTS,
  createTownHallPublicationHandlers
} = require('../dist/state/town-hall-publication/index.js');
const { planTownHallRoomParts } = require('../dist/peer/town-hall-room-parts');

const INSTRUCTION_PREFIX = 'town-hall-instruction/v1:';
const PUBLICATION_PREFIX = 'town-hall-publication/v1:';
const INSTRUCTION_PART_PREFIX = TOWN_HALL_PUBLICATION_RECEIPTS.INSTRUCTION_PART_PREFIX;
const PUBLICATION_PART_PREFIX = TOWN_HALL_PUBLICATION_RECEIPTS.PUBLICATION_PART_PREFIX;
const CORRUPT = 'town-hall publication journal is corrupt';
const INVALID_KEY = 'invalid town-hall journal key';
const MISSING_JOURNAL = 'town-hall publication requires an existing journal';
const INVALID_PART = 'invalid town-hall publication part';
const PROJECT_ROOT = path.resolve(__dirname, '..');
const BASE_COMMIT = '497d75cff6922a2f8cf37d7a01df35aa616711d2';

const SOURCE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CODEX_ID = '11111111-1111-4111-8111-aabbccddeeff';
const SECOND_ID = '22222222-2222-4222-8222-222222222222';

function address(overrides = {}) {
  return {
    guildId: '100',
    channelId: '300',
    provider: 'codex',
    nativeId: CODEX_ID,
    generation: 1,
    ...overrides
  };
}

function input(overrides = {}) {
  return {
    broadcastId: 'b1',
    townHall: { guildId: '100', channelId: '900' },
    source: address({ channelId: '200', nativeId: SOURCE_ID }),
    recipients: [address({ channelId: '300' })],
    text: 'hello',
    ...overrides
  };
}

function longInput(overrides = {}) {
  return input({ text: 'x'.repeat(9000), ...overrides });
}

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'town-hall-publication-parts-'));
  const dbPath = path.join(dir, 'surface.sqlite');
  let state = new SurfaceState(dbPath);
  return {
    dir,
    dbPath,
    get state() { return state; },
    reopen() {
      try { state.close(); } catch {}
      state = new SurfaceState(dbPath);
      return state;
    },
    close() {
      try { state.close(); } catch {}
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

function publicationKeyFor(journalKey) {
  return INSTRUCTION_PREFIX + journalKey;
}

function partPublicationKey(journalKey, partId) {
  return INSTRUCTION_PART_PREFIX + journalKey + ':' + partId;
}

function partReceiptKind(journalKey, partId) {
  return PUBLICATION_PART_PREFIX + journalKey + ':' + partId;
}

function receiptIds(state) {
  return state.listReceipts().map(row => row.id);
}

function rowsOf(state, kind) {
  return state.listReceipts().filter(row => row.kind === kind);
}

function sortedKeys(value) {
  return Object.keys(value).sort();
}

function assertBindingError(run, message, label = '') {
  assert.throws(run, error => {
    assert.ok(error instanceof BindingError, `${label} expected BindingError, got ${error?.constructor?.name}: ${error?.message}`);
    assert.equal(error.message, message, label);
    return true;
  }, label);
}

function assertCorrupt(run, label = '') {
  assert.throws(run, error => {
    assert.ok(error instanceof StateCorruptError, `${label} expected StateCorruptError, got ${error?.constructor?.name}: ${error?.message}`);
    assert.equal(error.message, CORRUPT, label);
    return true;
  }, label);
}

function publicationHandlers(probePid) {
  return createTownHallPublicationHandlers({
    BindingError,
    StateCorruptError,
    discordNonce,
    probePid
  });
}

function overrideOwnerAlive(state, value) {
  const original = state.directPostOwnerAlive;
  state.directPostOwnerAlive = function ownerAliveOverride() { return value; };
  return () => { state.directPostOwnerAlive = original; };
}

function insertRawReceipt(state, kind, detail, discordId = null) {
  state.db.prepare('INSERT INTO receipts(discord_id, kind, detail, created_at) VALUES(?, ?, ?, ?)')
    .run(discordId, kind, typeof detail === 'string' ? detail : JSON.stringify(detail), '2026-01-01T00:00:00.000Z');
}

function dropExpressionIndexes(state) {
  const indexes = state.db.prepare(
    "SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='receipts' AND sql LIKE '%json_extract%'"
  ).all();
  for (const index of indexes) state.db.exec(`DROP INDEX ${index.name}`);
  return indexes;
}

function restoreExpressionIndexes(state, indexes) {
  for (const index of indexes) state.db.exec(index.sql);
}

function insertMessagesRow(state, discordId) {  state.db.prepare(`INSERT OR IGNORE INTO bindings(channel_id, guild_id, provider, native_id, workspace,
    readiness, generation, active, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?, 1, ?)`).run(
    '900', '100', 'codex', CODEX_ID, '/tmp/town-hall-parts-fixture', 'ready', 1, '2026-01-01T00:00:00.000Z');
  state.db.prepare(`INSERT INTO messages(discord_id, guild_id, channel_id, delivery_channel_id, author_id,
    content, attachments, provider, native_id, workspace, endpoint, conductor_id, repo_key, generation,
    state, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    discordId, '100', '900', '900', '901', 'parts fixture', '[]', 'codex', CODEX_ID,
    '/tmp/town-hall-parts-fixture', null, null, null, 1, 'accepted', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
}

function partIds(state, journalKey) {
  return state.getTownHallPublicationSet(journalKey).parts.map(part => part.partId);
}

function journalPlan(state, journalKey) {
  return state.getTownHallBroadcast(journalKey).plan;
}

function eventDetail(journalKey, fingerprint, nonce, event, attemptId, owner, extra = {}) {
  return {
    version: 1,
    journalKey,
    fingerprint,
    event,
    attemptId,
    nonce,
    owner,
    ...extra
  };
}

function seedSentPart(state, journalKey, partId, messageId) {
  const reserved = state.reserveTownHallPublication(journalKey, partId);
  assert.equal(reserved.claimed, true);
  const attemptId = reserved.publication.attemptId;
  state.markTownHallPublicationInFlight(journalKey, attemptId, partId);
  state.recordTownHallPublicationOutcome(journalKey, attemptId, 'sent', { messageId }, partId);
  return attemptId;
}

const OWNER = () => ({ ownerPid: process.pid, ownerStartTime: 'parts-owner-start', ownerCommand: '/usr/bin/node' });

// 1
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

// 2
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

// 3
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

// 4
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

// 5
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

// 6
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

// 7
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

// 8
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

// 9
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

// 10
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

// 11
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

// 12
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

// 13
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

// 14
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

// 15
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

function listProductionSourceFiles() {
  const files = [];
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (!entry.name.endsWith('.d.ts') && (entry.name.endsWith('.ts') || entry.name.endsWith('.js'))) {
        files.push(path.relative(PROJECT_ROOT, full).split(path.sep).join('/'));
      }
    }
  };
  walk(path.join(PROJECT_ROOT, 'src'));
  return files.sort();
}

function parseSources(files) {
  const ts = require('typescript');
  return files.map(file => {
    const text = fs.readFileSync(path.join(PROJECT_ROOT, file), 'utf8');
    return {
      file,
      text,
      sourceFile: ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS)
    };
  });
}

function collectDefinitions(ts, records) {
  const definitions = [];
  const calls = [];
  const receiptWrites = [];
  const constantConsumers = new Set();
  const visit = (record, node) => {
    const line = record.sourceFile.getLineAndCharacterOfPosition(node.getStart(record.sourceFile)).line + 1;
    if (ts.isFunctionDeclaration(node) && node.name) {
      definitions.push({ name: node.name.text, file: record.file, node });
    } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      if (node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
        definitions.push({ name: node.name.text, file: record.file, node });
      }
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      calls.push({ name: node.expression.text, file: record.file, node });
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const isReceipt = (ts.isIdentifier(callee) && callee.text === 'receipt') ||
        (ts.isPropertyAccessExpression(callee) && callee.name.text === 'receipt');
      if (isReceipt) {
        const text = node.getText(record.sourceFile);
        const publicationWriter = text.includes('TOWN_HALL_PUBLICATION_RECEIPTS') ||
          text.includes('PUBLICATION_PART_PREFIX') || text.includes('PUBLICATION_PREFIX') ||
          text.includes('INSTRUCTION_PART_PREFIX') || text.includes('context.receiptKind');
        if (publicationWriter) {
          receiptWrites.push({ file: record.file, text, referencesPartKind: publicationWriter });
        }
      }
    }
    if (ts.isIdentifier(node) && (node.text === 'TOWN_HALL_PUBLICATION_RECEIPTS' || node.text === 'TOWN_HALL_PUBLICATION_EVENTS')) {
      let ancestor = node.parent;
      while (ancestor && !ts.isImportDeclaration(ancestor)) ancestor = ancestor.parent;
      if (!ancestor) constantConsumers.add(`${record.file}:${node.text}`);
    }
    ts.forEachChild(node, child => visit(record, child));
  };
  for (const record of records) visit(record, record.sourceFile);
  return { definitions, calls, receiptWrites, constantConsumers };
}

function assertReceiptConsumerFiles(consumers, expectedFiles) {
  const suffix = ':TOWN_HALL_PUBLICATION_RECEIPTS';
  const actual = [...consumers].filter(value => value.endsWith(suffix))
    .map(value => value.slice(0, -suffix.length)).sort();
  assert.deepEqual(actual, [...expectedFiles].sort(), 'receipt constants have exactly four real owner consumers');
}

// 16
test('publication part transitions keep one writer and decoder', () => {
  const ts = require('typescript');
  const records = parseSources(listProductionSourceFiles());
  const { definitions, calls, receiptWrites, constantConsumers } = collectDefinitions(ts, records);
  const repositoryFile = 'src/state/town-hall-publication/repository.ts';
  const contextFile = 'src/state/town-hall-publication/context.ts';
  const projectionFile = 'src/state/town-hall-publication/projection.ts';
  const ownerFiles = [
    'src/state/town-hall-publication/index.ts',
    projectionFile,
    repositoryFile,
    'src/state/town-hall-publication/types.ts'
  ];

  const ownerDirectory = 'src/state/town-hall-publication/';
  const inOwner = entry => entry.file.startsWith(ownerDirectory);
  for (const name of ['appendEvent', 'canonicalEvent', 'decodePublication', 'readRows', 'classifyLiveness']) {
    const found = definitions.filter(entry => entry.name === name && inOwner(entry));
    assert.equal(found.length, 1, `expected one ${name} definition under the publication owner, found ${found.map(entry => entry.file).join(', ')}`);
    assert.equal(found[0].file, repositoryFile, `${name} belongs to repository.ts`);
  }
  const groupEvents = definitions.filter(entry => entry.name === 'groupEvents' && inOwner(entry));
  assert.equal(groupEvents.length, 1, 'expected one groupEvents definition');
  assert.equal(groupEvents[0].file, projectionFile, 'groupEvents belongs to projection.ts');
  for (const name of ['appendEvent', 'canonicalEvent', 'decodePublication', 'readRows', 'classifyLiveness', 'groupEvents']) {
    assert.equal(definitions.filter(entry => entry.name === name && entry.file === contextFile).length, 0, `${name} must not be defined in context.ts`);
  }

  const appendCalls = calls.filter(entry => entry.name === 'appendEvent');
  assert.equal(appendCalls.length, 5, `expected five appendEvent calls, found ${appendCalls.length}`);
  assert.ok(appendCalls.every(entry => entry.file === repositoryFile), 'appendEvent is only called in repository.ts');

  const partWrites = receiptWrites.filter(entry => entry.referencesPartKind);
  assert.equal(partWrites.length, 1, 'exactly one publication receipt writer call site');
  assert.equal(partWrites[0].file, repositoryFile, 'no receipt writes outside repository.ts');
  assert.equal(receiptWrites.filter(entry => entry.referencesPartKind && entry.file !== repositoryFile).length, 0);

  for (const consumer of constantConsumers) {
    const file = consumer.slice(0, consumer.lastIndexOf(':'));
    assert.ok(ownerFiles.includes(file), `publication constants consumed outside the owner files: ${consumer}`);
  }

  const repositoryRecord = records.find(record => record.file === repositoryFile);
  assert.ok(repositoryRecord);
  assertReceiptConsumerFiles(constantConsumers, ownerFiles);
  const unusedImportText = repositoryRecord.text.replace(
    "TOWN_HALL_PUBLICATION_RECEIPTS.PUBLICATION_PART_PREFIX + key + ':'",
    "'town-hall-publication-part/v1:' + key + ':'"
  );
  assert.notEqual(unusedImportText, repositoryRecord.text);
  const unusedImportRecord = {
    ...repositoryRecord,
    text: unusedImportText,
    sourceFile: ts.createSourceFile(repositoryFile, unusedImportText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  };
  const mutantConsumers = collectDefinitions(ts, records.map(record =>
    record.file === repositoryFile ? unusedImportRecord : record)).constantConsumers;
  assert.throws(() => assertReceiptConsumerFiles(mutantConsumers, ownerFiles), /four real owner consumers/);

  const entrypoints = ['getTownHallPublication', 'reserveTownHallPublication', 'markTownHallPublicationInFlight',
    'recordTownHallPublicationOutcome', 'recoverTownHallPublication', 'confirmTownHallPublication'];
  for (const name of entrypoints) {
    const declaration = repositoryRecord.sourceFile.statements.find(statement =>
      ts.isFunctionDeclaration(statement) && statement.name && statement.name.text === name);
    assert.ok(declaration, `${name} must be exported by repository.ts`);
    const parameters = declaration.parameters;
    const last = parameters[parameters.length - 1];
    assert.ok(last && ts.isIdentifier(last.name) && last.name.text === 'partId', `${name} must take a final partId parameter`);
    assert.ok(last.questionToken, `${name}'s partId must be optional`);
  }
});

// 17
test('publication part suite and readonly types are registered once', () => {
  const newSuite = 'test/town-hall-publication-parts.test.js';
  const roomSuite = 'test/town-hall-room-parts.test.js';
  const pkg = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8'));
  const tokens = pkg.scripts.test.trim().split(/\s+/);
  assert.equal(tokens.filter(entry => entry === newSuite).length, 1, 'the new suite must be registered exactly once');
  assert.equal(tokens.filter(entry => entry === roomSuite).length, 1, 'room parts stays registered exactly once');
  assert.equal(tokens[tokens.length - 1], roomSuite, 'room parts remains the final registered entry');
  assert.equal(tokens[tokens.length - 2], newSuite, 'the new suite is registered immediately before room parts');

  const base = spawnSync('git', ['show', `${BASE_COMMIT}:package.json`], { cwd: PROJECT_ROOT, encoding: 'utf8' });
  assert.equal(base.status, 0, `git show failed: ${base.stderr}`);
  const baseTokens = JSON.parse(base.stdout).scripts.test.trim().split(/\s+/);
  assert.deepEqual(
    tokens.filter(entry => entry !== newSuite),
    baseTokens,
    'all pre-existing test paths keep their original relative order'
  );

  const newContext = 'src/state/town-hall-publication/context.ts';
  const repository = 'src/state/town-hall-publication/repository.ts';
  const baseConfig = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'tsconfig.json'), 'utf8'));
  assert.equal(baseConfig.include.filter(entry => entry === newContext).length, 1, 'tsconfig lists context.ts once');
  assert.equal(baseConfig.include.indexOf(newContext), baseConfig.include.indexOf(repository) + 1, 'context.ts follows repository.ts in tsconfig');
  assert.equal(baseConfig.include.filter(entry => entry === 'test/types/town-hall-publication-parts-types.ts').length, 0, 'tsconfig excludes the type fixture');

  const fixturePath = 'test/types/town-hall-publication-parts-types.ts';
  const oldFixture = 'test/types/town-hall-publication-types.ts';
  const typesConfig = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'tsconfig.typecheck.json'), 'utf8'));
  assert.equal(typesConfig.include.filter(entry => entry === newContext).length, 1, 'typecheck lists context.ts once');
  assert.equal(typesConfig.include.indexOf(newContext), typesConfig.include.indexOf(repository) + 1, 'context.ts follows repository.ts in typecheck');
  assert.equal(typesConfig.include.filter(entry => entry === fixturePath).length, 1, 'typecheck lists the new fixture once');
  assert.equal(typesConfig.include.indexOf(fixturePath), typesConfig.include.indexOf(oldFixture) + 1, 'the new fixture follows the existing publication fixture');

  const fixture = fs.readFileSync(path.join(PROJECT_ROOT, fixturePath), 'utf8');
  assert.equal((fixture.match(/@ts-expect-error/g) || []).length, 8, 'the new fixture pins exactly eight errors');
  assert.equal(/\bany\b|@ts-ignore|@ts-nocheck/.test(fixture), false, 'the new fixture must not use an escape hatch');
});
