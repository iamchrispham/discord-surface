'use strict';

const test = require('node:test');

const assert = require('node:assert/strict');

const fs = require('node:fs');

const os = require('node:os');

const path = require('node:path');

const { SurfaceState, BindingError, StateCorruptError, discordNonce } = require('../../src/state');

const {
  TOWN_HALL_PUBLICATION_RECEIPTS,
  createTownHallPublicationHandlers
} = require('../../dist/state/town-hall-publication/index.js');

const { planTownHallRoomParts } = require('../../dist/peer/town-hall-room-parts');

const INSTRUCTION_PREFIX = 'town-hall-instruction/v1:';

const PUBLICATION_PREFIX = 'town-hall-publication/v1:';

const INSTRUCTION_PART_PREFIX = TOWN_HALL_PUBLICATION_RECEIPTS.INSTRUCTION_PART_PREFIX;

const PUBLICATION_PART_PREFIX = TOWN_HALL_PUBLICATION_RECEIPTS.PUBLICATION_PART_PREFIX;

const CORRUPT = 'town-hall publication journal is corrupt';

const INVALID_KEY = 'invalid town-hall journal key';

const MISSING_JOURNAL = 'town-hall publication requires an existing journal';

const INVALID_PART = 'invalid town-hall publication part';

const PROJECT_ROOT = path.resolve(__dirname, '../..');

const SOURCE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const CODEX_ID = '11111111-1111-4111-8111-aabbccddeeff';

const SECOND_ID = '22222222-2222-4222-8222-222222222222';

const OWNER = () => ({ ownerPid: process.pid, ownerStartTime: 'parts-owner-start', ownerCommand: '/usr/bin/node' });

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

module.exports = { test, assert, fs, os, path, SurfaceState, BindingError, StateCorruptError, discordNonce, TOWN_HALL_PUBLICATION_RECEIPTS, createTownHallPublicationHandlers, planTownHallRoomParts, INSTRUCTION_PREFIX, PUBLICATION_PREFIX, INSTRUCTION_PART_PREFIX, PUBLICATION_PART_PREFIX, CORRUPT, INVALID_KEY, MISSING_JOURNAL, INVALID_PART, PROJECT_ROOT, SOURCE_ID, CODEX_ID, SECOND_ID, OWNER, address, input, longInput, fixture, publicationKeyFor, partPublicationKey, partReceiptKind, receiptIds, rowsOf, sortedKeys, assertBindingError, assertCorrupt, publicationHandlers, overrideOwnerAlive, insertRawReceipt, dropExpressionIndexes, restoreExpressionIndexes, insertMessagesRow, partIds, journalPlan, eventDetail, seedSentPart };
