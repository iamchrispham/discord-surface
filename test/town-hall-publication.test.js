'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');

const { SurfaceState, BindingError, StateCorruptError, discordNonce } = require('../src/state');
const {
  TOWN_HALL_PUBLICATION_RECEIPTS,
  TOWN_HALL_PUBLICATION_EVENTS,
  createTownHallPublicationHandlers
} = require('../dist/state/town-hall-publication/index.js');

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
  const original = state.directPostOwnerAlive;
  state.directPostOwnerAlive = function ownerAliveOverride() { return value; };
  return () => { state.directPostOwnerAlive = original; };
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

const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const selfDestruct = setTimeout(() => process.exit(1), workerData.timeoutMs);
selfDestruct.unref();
let state = null;
try {
  const { SurfaceState } = require(workerData.statePath);
  state = new SurfaceState(workerData.dbPath);
  const result = state.reserveTownHallPublication(workerData.journalKey);
  parentPort.postMessage({
    ok: true,
    claimed: result.claimed,
    status: result.publication.status,
    attemptId: result.publication.attemptId
  });
} catch (error) {
  parentPort.postMessage({
    ok: false,
    kind: error && error.constructor ? error.constructor.name : null,
    message: error && error.message ? error.message : String(error)
  });
} finally {
  clearTimeout(selfDestruct);
  if (state) { try { state.close(); } catch {} }
}
`;

const CHILD_SOURCE = `
const { SurfaceState } = require(process.env.DOWN_STATE);
let state = null;
try {
  state = new SurfaceState(process.env.DOWN_DB);
  const result = state.reserveTownHallPublication(process.env.DOWN_JOURNAL_KEY);
  process.stdout.write(JSON.stringify({
    claimed: result.claimed,
    status: result.publication.status,
    attemptId: result.publication.attemptId,
    journalKey: result.publication.journalKey
  }));
} catch (error) {
  process.stderr.write(String((error && error.stack) || error));
  process.exitCode = 1;
} finally {
  if (state) { try { state.close(); } catch {} }
}
`;

function reserveWithChild(dbPath, journalKey, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', CHILD_SOURCE], {
      env: {
        ...process.env,
        DOWN_DB: dbPath,
        DOWN_JOURNAL_KEY: journalKey,
        DOWN_STATE: require.resolve('../src/state')
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      settle(reject, new Error('publication child reservation timed out'));
    }, timeoutMs);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', error => settle(reject, error));
    child.once('exit', (code, signal) => {
      if (code !== 0) {
        settle(reject, new Error(`publication child exited code ${code} signal ${signal}: ${stderr}`));
        return;
      }
      try {
        settle(resolve, { pid: child.pid, result: JSON.parse(stdout.trim()) });
      } catch (error) {
        settle(reject, new Error(`publication child produced unusable output ${JSON.stringify(stdout)}: ${error.message}`));
      }
    });
  });
}

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

function foreignAttemptId() {
  return '00000000-0000-4000-8000-0000000000ff';
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

function insertRawReceipt(state, kind, detail, discordId = null) {
  state.db.prepare('INSERT INTO receipts(discord_id, kind, detail, created_at) VALUES(?, ?, ?, ?)')
    .run(discordId, kind, typeof detail === 'string' ? detail : JSON.stringify(detail), '2026-01-01T00:00:00.000Z');
}

test('malformed execution histories refuse without changing journal or unrelated rows', t => {
  const f = fixture(t);
  const created = f.state.createTownHallBroadcast(input());
  const journalKey = created.broadcast.journalKey;
  const fingerprint = created.broadcast.plan.fingerprint;
  const plan = created.broadcast.plan;
  const publicationKey = publicationKeyFor(journalKey);
  const nonce = discordNonce(publicationKey);
  const kind = PUBLICATION_PREFIX + journalKey;
  const otherKey = 'e'.repeat(64);
  const owner = () => ({ ownerPid: process.pid, ownerStartTime: 'publication-owner-start', ownerCommand: '/usr/bin/node' });
  const common = (event, attemptId, ownerValue = owner()) => ({
    version: 1,
    journalKey,
    fingerprint,
    event,
    attemptId,
    nonce,
    owner: ownerValue
  });
  const reserved = (attemptId, ownerValue) => common('reserved', attemptId, ownerValue);
  const inFlight = (attemptId, ownerValue) => common('in_flight', attemptId, ownerValue);
  const outcome = (attemptId, value, messageId = null, ownerValue) => ({
    ...common('outcome', attemptId, ownerValue),
    outcome: value,
    messageId
  });
  const confirmed = (attemptId, messageId, ownerValue) => ({
    ...common('confirmed', attemptId, ownerValue),
    messageId,
    guildId: plan.townHall.guildId,
    channelId: plan.townHall.channelId
  });
  const A1 = 'attempt-0000-0000-0000-000000000001';
  const A2 = 'attempt-0000-0000-0000-000000000002';

  f.state.receipt(null, 'unrelated-receipt', { note: 'x' });
  f.state.receipt(null, PUBLICATION_PREFIX + otherKey, { version: 1, journalKey: otherKey, fingerprint: 'ignored' });
  insertMessagesRow(f.state, 'publication-metadata-foreign');

  const expressionIndexes = dropExpressionIndexes(f.state);
  try {
    const baselineRows = f.state.listReceipts();

    const scenarios = [
      {
        label: 'raw discord id',
        setup: () => {
          const detail = reserved(A1);
          insertRawReceipt(f.state, kind, detail, 'publication-metadata-foreign');
        }
      },
      { label: 'invalid json', rows: ['{not json'] },
      { label: 'extra key', rows: [{ ...reserved(A1), extra: true }] },
      { label: 'unsupported version', rows: [{ ...reserved(A1), version: 2 }] },
      { label: 'wrong journal key', rows: [{ ...reserved(A1), journalKey: otherKey }] },
      { label: 'wrong fingerprint', rows: [{ ...reserved(A1), fingerprint: '0'.repeat(64) }] },
      { label: 'wrong nonce', rows: [{ ...reserved(A1), nonce: 'ds-' + 'a'.repeat(21) }] },
      { label: 'unknown event', rows: [{ ...reserved(A1), event: 'bogus' }] },
      { label: 'malformed owner', rows: [reserved(A1, { ownerPid: process.pid, ownerStartTime: '', ownerCommand: null })] },
      { label: 'duplicate reservation', rows: [reserved(A1), reserved(A1)] },
      { label: 'outcome before in-flight', rows: [reserved(A1), outcome(A1, 'unknown')] },
      {
        label: 'two outcomes for one attempt',
        rows: [reserved(A1), inFlight(A1), outcome(A1, 'not_sent'), outcome(A1, 'unknown')]
      },
      {
        label: 'confirmation without unknown',
        rows: [reserved(A1), inFlight(A1), outcome(A1, 'sent', 'msg-1'), confirmed(A1, 'msg-1')]
      },
      { label: 'later event uses another attempt', rows: [reserved(A1), inFlight(A2)] }
    ];

    for (const scenario of scenarios) {
      f.state.db.prepare('DELETE FROM receipts WHERE kind=?').run(kind);
      if (scenario.setup) scenario.setup();
      for (const row of scenario.rows || []) insertRawReceipt(f.state, kind, row);
      const corruptRows = f.state.listReceipts();
      const corruptIds = corruptRows.map(row => row.id);
      const unrelatedRows = corruptRows.filter(row => row.kind !== kind);

      assertCorrupt(() => f.state.getTownHallPublication(journalKey), scenario.label);
      assertCorrupt(() => f.state.reserveTownHallPublication(journalKey), `${scenario.label} reserve`);

      const afterRows = f.state.listReceipts();
      assert.deepEqual(afterRows.map(row => row.id), corruptIds, `${scenario.label}: refusal mutated receipts`);
      assert.deepEqual(
        afterRows.filter(row => row.kind !== kind),
        unrelatedRows,
        `${scenario.label}: unrelated rows changed`
      );
      assert.equal(
        f.state.getTownHallBroadcast(journalKey).publication.status,
        'planned',
        `${scenario.label}: journal changed`
      );
    }

    f.state.db.prepare('DELETE FROM receipts WHERE kind=?').run(kind);
    assert.deepEqual(
      f.state.listReceipts().map(row => row.id),
      baselineRows.map(row => row.id),
      'corruption fixtures must not leave publication rows behind'
    );
    assert.equal(f.state.getTownHallPublication(journalKey).status, 'planned');
    assert.equal(f.state.getTownHallBroadcast(journalKey).publication.status, 'planned');

    f.state.db.prepare('UPDATE receipts SET discord_id=NULL WHERE kind=?').run(PUBLICATION_PREFIX + otherKey);
    const foreign = f.state.listReceipts().filter(row => row.kind === PUBLICATION_PREFIX + otherKey);
    assert.equal(foreign.length, 1);
    assert.equal(foreign[0].discord_id, null);
    assert.equal(f.state.getTownHallPublication(journalKey).status, 'planned');
  } finally {
    restoreExpressionIndexes(f.state, expressionIndexes);
  }
});
