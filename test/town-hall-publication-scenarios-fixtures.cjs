'use strict';

const { createTownHallPublicationHandlers } = require('../dist/state/town-hall-publication/index.js');
const { OWNER_EVIDENCE, OWNER_EVIDENCE_REASON } = require('../src/state/process-owner-evidence');
const { BindingError, StateCorruptError, SurfaceState, discordNonce } = require('../src/state');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const INSTRUCTION_PREFIX = 'town-hall-instruction/v1:';
const PUBLICATION_PREFIX = 'town-hall-publication/v1:';
const CORRUPT = 'town-hall publication journal is corrupt';
const INVALID_KEY = 'invalid town-hall journal key';
const MISSING_JOURNAL = 'town-hall publication requires an existing journal';
const MARK_REFUSED = 'town-hall publication attempt is not claimed';
const RECORD_REFUSED = 'town-hall publication attempt is not in flight';
const INVALID_OUTCOME = 'town-hall publication outcome is invalid';
const OUTCOME_CONFLICT = 'town-hall publication outcome conflict';
const CONFIRM_REFUSED = 'town-hall publication confirmation is not admissible';
const COMMON_KEYS = ['version', 'journalKey', 'fingerprint', 'event', 'attemptId', 'nonce', 'owner'];
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const SOURCE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CODEX_ID = '11111111-1111-4111-8111-aabbccddeeff';

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

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'town-hall-publication-'));
  const dbPath = path.join(dir, 'surface.sqlite');
  const state = new SurfaceState(dbPath);
  t.after(() => {
    try { state.close(); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, dbPath, state };
}

function publicationKeyFor(journalKey) {
  return INSTRUCTION_PREFIX + journalKey;
}

function publicationRows(state, journalKey) {
  return state.listReceipts().filter(row => row.kind === PUBLICATION_PREFIX + journalKey);
}

function parsedPublicationRows(state, journalKey) {
  return publicationRows(state, journalKey).map(row => ({
    id: row.id,
    discordId: row.discord_id,
    detail: JSON.parse(row.detail)
  }));
}

function receiptIds(state) {
  return state.listReceipts().map(row => row.id);
}

function sortedKeys(value) {
  return Object.keys(value).sort();
}

function assertBindingError(run, message, label = '') {
  assert.throws(run, error => {
    assert.ok(
      error instanceof BindingError,
      `${label} expected BindingError, got ${error?.constructor?.name}: ${error?.message}`
    );
    assert.equal(error.message, message, label);
    return true;
  }, label);
}

function assertBindingRefusal(run, messages, label = '') {
  assert.throws(run, error => {
    assert.ok(
      error instanceof BindingError,
      `${label} expected BindingError, got ${error?.constructor?.name}: ${error?.message}`
    );
    assert.ok(messages.includes(error.message), `${label} unexpected refusal ${error.message}`);
    return true;
  }, label);
}

function assertCorrupt(run, label = '') {
  assert.throws(run, error => {
    assert.ok(
      error instanceof StateCorruptError,
      `${label} expected StateCorruptError, got ${error?.constructor?.name}: ${error?.message}`
    );
    assert.equal(error.message, CORRUPT, label);
    return true;
  }, label);
}

function overrideOwnerAlive(state, value) {
  const original = state.directPostOwnerEvidence;
  state.directPostOwnerEvidence = function ownerEvidenceOverride() {
    return value === true
      ? { status: OWNER_EVIDENCE.MATCHING_LIVE, reason: OWNER_EVIDENCE_REASON.IDENTITY_MATCH }
      : { status: OWNER_EVIDENCE.INDETERMINATE, reason: OWNER_EVIDENCE_REASON.PROBE_DENIED };
  };
  return () => { state.directPostOwnerEvidence = original; };
}

function overrideOwnerIdentity(state, identity) {
  const original = state.directPostOwnerIdentity;
  state.directPostOwnerIdentity = function ownerIdentityOverride() { return identity; };
  return () => { state.directPostOwnerIdentity = original; };
}

function publicationHandlers(probePid) {
  return createTownHallPublicationHandlers({
    BindingError,
    StateCorruptError,
    discordNonce,
    probePid
  });
}

function assertFrozenProjection(publication) {
  assert.ok(Object.isFrozen(publication), 'projection must be frozen');
  if (publication.owner) assert.ok(Object.isFrozen(publication.owner), 'owner must be frozen');
  assert.throws(() => { publication.status = 'mutated'; }, TypeError);
  assert.throws(() => { publication.attemptId = 'mutated'; }, TypeError);
  if (publication.owner) assert.throws(() => { publication.owner.ownerPid = 1; }, TypeError);
}

function assertProjectionShape(publication, journalKey, fingerprint, status, nonce) {
  assert.deepEqual(
    sortedKeys(publication),
    ['attemptId', 'fingerprint', 'journalKey', 'messageId', 'nonce', 'owner', 'publicationKey', 'status'].sort()
  );
  assert.equal(publication.journalKey, journalKey);
  assert.equal(publication.publicationKey, publicationKeyFor(journalKey));
  assert.equal(publication.fingerprint, fingerprint);
  assert.equal(publication.status, status);
  assert.equal(publication.nonce, nonce);
}

function insertMessagesRow(state, discordId) {
  state.db.prepare(`INSERT OR IGNORE INTO bindings(channel_id, guild_id, provider, native_id, workspace,
    readiness, generation, active, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?, 1, ?)`).run(
    '900', '100', 'codex', CODEX_ID, '/tmp/townhall-publication-fixture', 'ready', 1, '2026-01-01T00:00:00.000Z');
  state.db.prepare(`INSERT INTO messages(discord_id, guild_id, channel_id, delivery_channel_id, author_id,
    content, attachments, provider, native_id, workspace, endpoint, conductor_id, repo_key, generation,
    state, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    discordId, '100', '900', '900', '901', 'publication metadata fixture', '[]', 'codex', CODEX_ID,
    '/tmp/townhall-publication-fixture', null, null, null, 1, 'accepted', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
}

module.exports = { address, input, fixture, publicationKeyFor, publicationRows, parsedPublicationRows, receiptIds, sortedKeys, assertBindingError, assertBindingRefusal, assertCorrupt, overrideOwnerAlive, overrideOwnerIdentity, publicationHandlers, assertFrozenProjection, assertProjectionShape, insertMessagesRow, INSTRUCTION_PREFIX, PUBLICATION_PREFIX, CORRUPT, INVALID_KEY, MISSING_JOURNAL, MARK_REFUSED, RECORD_REFUSED, INVALID_OUTCOME, OUTCOME_CONFLICT, CONFIRM_REFUSED, COMMON_KEYS, UUID_PATTERN, SOURCE_ID, CODEX_ID };
