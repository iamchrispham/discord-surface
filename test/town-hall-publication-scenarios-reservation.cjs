'use strict';

const { TOWN_HALL_PUBLICATION_EVENTS, TOWN_HALL_PUBLICATION_RECEIPTS } = require('../dist/state/town-hall-publication/index.js');
const { SurfaceState, discordNonce } = require('../src/state');
const { COMMON_KEYS, INSTRUCTION_PREFIX, INVALID_KEY, MARK_REFUSED, MISSING_JOURNAL, PUBLICATION_PREFIX, RECORD_REFUSED, UUID_PATTERN, assertBindingError, assertFrozenProjection, assertProjectionShape, fixture, input, overrideOwnerIdentity, publicationKeyFor, publicationRows, receiptIds, sortedKeys } = require('./town-hall-publication-scenarios-fixtures.cjs');
const { WORKER_SOURCE } = require('./town-hall-publication-scenarios-process.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { Worker } = require('node:worker_threads');

test('planned publication reads without writes', t => {
  const f = fixture(t);
  const created = f.state.createTownHallBroadcast(input());
  const journalKey = created.broadcast.journalKey;
  const fingerprint = created.broadcast.plan.fingerprint;
  const publicationKey = publicationKeyFor(journalKey);
  const expectedNonce = discordNonce(publicationKey);

  assert.equal(TOWN_HALL_PUBLICATION_RECEIPTS.INSTRUCTION_PREFIX, INSTRUCTION_PREFIX);
  assert.equal(TOWN_HALL_PUBLICATION_RECEIPTS.PUBLICATION_PREFIX, PUBLICATION_PREFIX);
  assert.equal(TOWN_HALL_PUBLICATION_EVENTS.RESERVED, 'reserved');
  assert.equal(TOWN_HALL_PUBLICATION_EVENTS.IN_FLIGHT, 'in_flight');
  assert.equal(TOWN_HALL_PUBLICATION_EVENTS.OUTCOME, 'outcome');
  assert.equal(TOWN_HALL_PUBLICATION_EVENTS.CONFIRMED, 'confirmed');

  const beforeIds = receiptIds(f.state);
  const publication = f.state.getTownHallPublication(journalKey);
  assertProjectionShape(publication, journalKey, fingerprint, 'planned', expectedNonce);
  assert.equal(publication.attemptId, null);
  assert.equal(publication.owner, null);
  assert.equal(publication.messageId, null);
  assertFrozenProjection(publication);
  assert.deepEqual(publicationRows(f.state, journalKey), []);
  assert.deepEqual(receiptIds(f.state), beforeIds);

  assertBindingError(() => f.state.getTownHallPublication('f'.repeat(64)), MISSING_JOURNAL, 'bogus journal');
  for (const key of ['', journalKey.toUpperCase(), journalKey.slice(0, 63), journalKey + '0', 'not-a-key']) {
    assertBindingError(() => f.state.getTownHallPublication(key), INVALID_KEY, JSON.stringify(key));
  }
  assert.deepEqual(receiptIds(f.state), beforeIds);
  assert.equal(f.state.getTownHallBroadcast(journalKey).publication.status, 'planned');
});

test('reservation freezes identity and stable nonce', t => {
  const f = fixture(t);
  const created = f.state.createTownHallBroadcast(input());
  const journalKey = created.broadcast.journalKey;
  const fingerprint = created.broadcast.plan.fingerprint;
  const nonce = discordNonce(publicationKeyFor(journalKey));
  const beforeIds = receiptIds(f.state);

  const reserved = f.state.reserveTownHallPublication(journalKey);
  assert.deepEqual(Object.keys(reserved).sort(), ['claimed', 'publication']);
  assert.equal(reserved.claimed, true);
  const publication = reserved.publication;
  assertProjectionShape(publication, journalKey, fingerprint, 'claimed', nonce);
  assert.match(publication.attemptId, UUID_PATTERN);
  assert.equal(publication.messageId, null);
  assertFrozenProjection(publication);
  assert.deepEqual(sortedKeys(publication.owner), ['ownerCommand', 'ownerPid', 'ownerStartTime']);
  assert.equal(publication.owner.ownerPid, process.pid);
  assert.equal(typeof publication.owner.ownerStartTime, 'string');
  assert.ok(publication.owner.ownerStartTime.length > 0);
  assert.ok(publication.owner.ownerCommand === null || typeof publication.owner.ownerCommand === 'string');
  const attemptId = publication.attemptId;

  const rows = publicationRows(f.state, journalKey);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, PUBLICATION_PREFIX + journalKey);
  assert.equal(rows[0].discord_id, null);
  assert.deepEqual(receiptIds(f.state), beforeIds.concat([rows[0].id]));
  const detail = JSON.parse(rows[0].detail);
  assert.deepEqual(sortedKeys(detail), [...COMMON_KEYS].sort());
  assert.equal(detail.version, 1);
  assert.equal(detail.journalKey, journalKey);
  assert.equal(detail.fingerprint, fingerprint);
  assert.equal(detail.event, TOWN_HALL_PUBLICATION_EVENTS.RESERVED);
  assert.equal(detail.attemptId, attemptId);
  assert.equal(detail.nonce, nonce);
  assert.deepEqual(sortedKeys(detail.owner), ['ownerCommand', 'ownerPid', 'ownerStartTime']);
  assert.deepEqual(detail.owner, publication.owner);

  const cancelled = f.state.recordTownHallPublicationOutcome(journalKey, attemptId, 'not_sent');
  assert.equal(cancelled.status, 'not_sent');
  assert.equal(cancelled.nonce, nonce);
  const retry = f.state.reserveTownHallPublication(journalKey);
  assert.equal(retry.claimed, true);
  assert.equal(retry.publication.status, 'claimed');
  assert.equal(retry.publication.nonce, nonce);
  assert.notEqual(retry.publication.attemptId, attemptId);
});

test('competing connections admit one reservation', { timeout: 20000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'town-hall-publication-race-'));
  const dbPath = path.join(dir, 'surface.sqlite');
  const seed = new SurfaceState(dbPath);
  const created = seed.createTownHallBroadcast(input());
  const journalKey = created.broadcast.journalKey;
  seed.close();
  const statePath = require.resolve('../src/state');
  const workers = [];
  const workerResult = worker => new Promise((resolve, reject) => {
    let settled = false;
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      callback(value);
    };
    worker.once('message', message => settle(resolve, message));
    worker.once('error', error => settle(reject, error));
    worker.once('exit', code => {
      settle(reject, new Error(`town-hall publication worker exited without result (code ${code})`));
    });
  });
  const startWorker = () => {
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { dbPath, statePath, journalKey, timeoutMs: 8000 }
    });
    workers.push(worker);
    return workerResult(worker);
  };
  try {
    const results = await Promise.all([startWorker(), startWorker()]);
    const winners = results.filter(result => result.ok === true && result.claimed === true);
    const losers = results.filter(result => result.ok === true && result.claimed === false);
    assert.equal(winners.length, 1, JSON.stringify(results));
    assert.equal(losers.length, 1, JSON.stringify(results));
    assert.equal(winners[0].status, 'claimed');
    assert.equal(losers[0].status, 'claimed');
    assert.match(winners[0].attemptId, UUID_PATTERN);
    assert.equal(losers[0].attemptId, winners[0].attemptId);

    const reopened = new SurfaceState(dbPath);
    try {
      const rows = publicationRows(reopened, journalKey);
      assert.equal(rows.length, 1);
      assert.equal(JSON.parse(rows[0].detail).event, 'reserved');
      const publication = reopened.getTownHallPublication(journalKey);
      assert.equal(publication.status, 'claimed');
      assert.equal(publication.attemptId, winners[0].attemptId);
    } finally {
      reopened.close();
    }
  } finally {
    for (const worker of workers) await worker.terminate();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('duplicate reserve creates no extra attempt', t => {
  const f = fixture(t);
  const created = f.state.createTownHallBroadcast(input());
  const journalKey = created.broadcast.journalKey;

  const first = f.state.reserveTownHallPublication(journalKey);
  const afterFirstIds = receiptIds(f.state);
  const second = f.state.reserveTownHallPublication(journalKey);
  assert.equal(second.claimed, false);
  assert.equal(second.publication.status, 'claimed');
  assert.equal(second.publication.attemptId, first.publication.attemptId);
  assert.deepEqual(second.publication, first.publication);
  assert.deepEqual(receiptIds(f.state), afterFirstIds);
  assert.equal(publicationRows(f.state, journalKey).length, 1);
});

test('in-flight marker admits one network start', t => {
  const f = fixture(t);
  const created = f.state.createTownHallBroadcast(input());
  const journalKey = created.broadcast.journalKey;
  const nonce = discordNonce(publicationKeyFor(journalKey));

  const reserved = f.state.reserveTownHallPublication(journalKey);
  const attemptId = reserved.publication.attemptId;
  const mark = f.state.markTownHallPublicationInFlight(journalKey, attemptId);
  assert.equal(mark.started, true);
  assert.equal(mark.publication.status, 'in_flight');
  assert.equal(mark.publication.attemptId, attemptId);
  assert.equal(mark.publication.nonce, nonce);
  assertFrozenProjection(mark.publication);

  const afterMarkIds = receiptIds(f.state);
  const repeat = f.state.markTownHallPublicationInFlight(journalKey, attemptId);
  assert.equal(repeat.started, false);
  assert.equal(repeat.publication.status, 'in_flight');
  assert.equal(repeat.publication.attemptId, attemptId);
  assert.deepEqual(receiptIds(f.state), afterMarkIds);

  const beforeResendIds = receiptIds(f.state);
  const restore = overrideOwnerIdentity(f.state, {
    ownerPid: process.pid,
    ownerStartTime: 'different-process-generation',
    ownerCommand: null
  });
  try {
    assertBindingError(
      () => f.state.markTownHallPublicationInFlight(journalKey, attemptId),
      MARK_REFUSED,
      'non-owner repeat while in flight'
    );
  } finally {
    restore();
  }
  assert.deepEqual(receiptIds(f.state), beforeResendIds);

  const rows = publicationRows(f.state, journalKey);
  assert.equal(rows.length, 2);
  assert.equal(rows.filter(row => JSON.parse(row.detail).event === 'in_flight').length, 1);
  const marker = rows.find(row => JSON.parse(row.detail).event === 'in_flight');
  assert.equal(marker.discord_id, null);
  const detail = JSON.parse(marker.detail);
  assert.deepEqual(sortedKeys(detail), [...COMMON_KEYS].sort());
  assert.equal(detail.version, 1);
  assert.equal(detail.journalKey, journalKey);
  assert.equal(detail.fingerprint, created.broadcast.plan.fingerprint);
  assert.equal(detail.attemptId, attemptId);
  assert.equal(detail.nonce, nonce);
});

test('wrong attempt and owner refuse without mutation', t => {
  const f = fixture(t);
  const created = f.state.createTownHallBroadcast(input());
  const journalKey = created.broadcast.journalKey;
  const reserved = f.state.reserveTownHallPublication(journalKey);
  const attemptId = reserved.publication.attemptId;
  const beforeIds = receiptIds(f.state);
  const foreignAttempt = '00000000-0000-4000-8000-000000000000';

  assertBindingError(() => f.state.markTownHallPublicationInFlight(journalKey, foreignAttempt), MARK_REFUSED, 'foreign mark');
  assertBindingError(
    () => f.state.recordTownHallPublicationOutcome(journalKey, foreignAttempt, 'not_sent'),
    RECORD_REFUSED,
    'foreign record'
  );
  assert.deepEqual(receiptIds(f.state), beforeIds);

  const restore = overrideOwnerIdentity(f.state, {
    ownerPid: process.pid,
    ownerStartTime: 'different-process-generation',
    ownerCommand: null
  });
  try {
    assertBindingError(() => f.state.markTownHallPublicationInFlight(journalKey, attemptId), MARK_REFUSED, 'different owner mark');
    assertBindingError(
      () => f.state.recordTownHallPublicationOutcome(journalKey, attemptId, 'not_sent'),
      RECORD_REFUSED,
      'different owner record'
    );
  } finally {
    restore();
  }
  assert.deepEqual(receiptIds(f.state), beforeIds);
  assert.equal(f.state.getTownHallPublication(journalKey).status, 'claimed');
});
