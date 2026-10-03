'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');

const { planTownHallBroadcast } = require('../dist/peer/town-hall-plan');
const { SurfaceState, BindingError, StateCorruptError } = require('../src/state');
const {
  TOWN_HALL_JOURNAL_RECEIPTS,
  TOWN_HALL_JOURNAL_STATES
} = require('../dist/state/town-hall-journal/index.js');

const MANIFEST_PREFIX = 'town-hall-manifest/v1:';
const RECIPIENT_PREFIX = 'town-hall-recipient/v1:';
const CONFLICT = 'town-hall broadcast identity conflict';
const CORRUPT = 'town-hall broadcast journal is corrupt';
const INVALID_KEY = 'invalid town-hall journal key';
const KEY_DOMAIN = 'discord-surface/town-hall-journal/v1';

const SOURCE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CODEX_ID = '11111111-1111-4111-8111-aabbccddeeff';
const CLAUDE_ID = '22222222-2222-4222-8222-222222222222';

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

function twoRecipients() {
  return [
    address({ channelId: '300' }),
    address({ channelId: '301', provider: 'claude', nativeId: CLAUDE_ID })
  ];
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

function expectedJournalKey(plan) {
  return crypto.createHash('sha256').update(JSON.stringify([
    KEY_DOMAIN,
    plan.source.guildId,
    plan.source.channelId,
    plan.source.provider,
    plan.source.nativeId,
    plan.source.generation,
    plan.broadcastId
  ])).digest('hex');
}

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'town-hall-journal-'));
  const dbPath = path.join(dir, 'surface.sqlite');
  const state = new SurfaceState(dbPath);
  t.after(() => {
    try { state.close(); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, dbPath, state };
}

function ownedRows(state) {
  return state.listReceipts().filter(row =>
    row.kind.startsWith(MANIFEST_PREFIX) || row.kind.startsWith(RECIPIENT_PREFIX));
}

function assertConflict(run) {
  assert.throws(run, error => {
    assert.ok(error instanceof BindingError, `expected BindingError, got ${error?.constructor?.name}: ${error?.message}`);
    assert.equal(error.message, CONFLICT);
    return true;
  });
}

function assertCorrupt(run) {
  assert.throws(run, error => {
    assert.ok(error instanceof StateCorruptError, `expected StateCorruptError, got ${error?.constructor?.name}: ${error?.message}`);
    assert.equal(error.message, CORRUPT);
    return true;
  });
}

const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const selfDestruct = setTimeout(() => process.exit(1), workerData.timeoutMs);
selfDestruct.unref();
let state = null;
try {
  const { SurfaceState } = require(workerData.statePath);
  state = new SurfaceState(workerData.dbPath);
  const result = state.createTownHallBroadcast(workerData.input);
  parentPort.postMessage({ ok: true, created: result.created, journalKey: result.broadcast.journalKey });
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

test('canonical broadcast creates one complete planned journal', t => {
  const f = fixture(t);
  const source = input({ recipients: twoRecipients() });
  const expectedPlan = planTownHallBroadcast(source);
  const journalKey = expectedJournalKey(expectedPlan);

  const result = f.state.createTownHallBroadcast(source);
  assert.deepEqual(Object.keys(result), ['created', 'broadcast']);
  assert.equal(result.created, true);

  const snapshot = result.broadcast;
  assert.deepEqual(Object.keys(snapshot), ['journalKey', 'plan', 'publication', 'recipients']);
  assert.equal(snapshot.journalKey, journalKey);
  assert.match(snapshot.journalKey, /^[a-f0-9]{64}$/);
  assert.deepEqual(snapshot.plan, expectedPlan);
  assert.equal(snapshot.plan.text, 'hello');
  assert.deepEqual(snapshot.publication, { status: TOWN_HALL_JOURNAL_STATES.PLANNED });
  assert.deepEqual(
    snapshot.recipients,
    expectedPlan.recipients.map(entry => ({
      target: entry.target,
      packetId: entry.packetId,
      status: TOWN_HALL_JOURNAL_STATES.PLANNED
    }))
  );
  for (const recipient of snapshot.recipients) {
    assert.deepEqual(Object.keys(recipient), ['target', 'packetId', 'status']);
  }
  assert.equal('id' in snapshot, false);
  assert.equal('createdAt' in snapshot, false);
  assert.equal('created_at' in snapshot, false);

  assert.equal(TOWN_HALL_JOURNAL_RECEIPTS.MANIFEST_PREFIX, MANIFEST_PREFIX);
  assert.equal(TOWN_HALL_JOURNAL_RECEIPTS.RECIPIENT_PREFIX, RECIPIENT_PREFIX);
  assert.equal(TOWN_HALL_JOURNAL_STATES.PLANNED, 'planned');

  const rows = f.state.listReceipts();
  const manifestRows = rows.filter(row => row.kind === MANIFEST_PREFIX + journalKey);
  const recipientRows = rows.filter(row => row.kind === RECIPIENT_PREFIX + journalKey);
  assert.equal(manifestRows.length, 1);
  assert.equal(recipientRows.length, expectedPlan.recipients.length);
  assert.equal(manifestRows[0].discord_id, null);

  const manifestDetail = JSON.parse(manifestRows[0].detail);
  assert.deepEqual(Object.keys(manifestDetail), ['version', 'journalKey', 'plan']);
  assert.equal(manifestDetail.version, 1);
  assert.equal(manifestDetail.journalKey, journalKey);
  assert.deepEqual(manifestDetail.plan, expectedPlan);

  for (let index = 0; index < expectedPlan.recipients.length; index += 1) {
    const row = recipientRows[index];
    assert.equal(row.discord_id, null);
    assert.ok(row.id > manifestRows[0].id);
    const detail = JSON.parse(row.detail);
    assert.deepEqual(Object.keys(detail), ['version', 'journalKey', 'fingerprint', 'packetId', 'target']);
    assert.equal(detail.version, 1);
    assert.equal(detail.journalKey, journalKey);
    assert.equal(detail.fingerprint, expectedPlan.fingerprint);
    assert.equal(detail.packetId, expectedPlan.recipients[index].packetId);
    assert.deepEqual(detail.target, expectedPlan.recipients[index].target);
  }
});

test('repeated canonical creation writes no additional receipts', t => {
  const f = fixture(t);
  const first = f.state.createTownHallBroadcast(input());
  const before = f.state.listReceipts();
  const second = f.state.createTownHallBroadcast(input());
  assert.equal(second.created, false);
  assert.deepEqual(second.broadcast, first.broadcast);
  const after = f.state.listReceipts();
  assert.deepEqual(after.map(row => row.id), before.map(row => row.id));
  assert.deepEqual(after.map(row => row.detail), before.map(row => row.detail));
  assert.deepEqual(f.state.getTownHallBroadcast(first.broadcast.journalKey), first.broadcast);
});

test('conflicting text refuses without replacing the original journal', t => {
  const f = fixture(t);
  const first = f.state.createTownHallBroadcast(input({ text: 'original text' }));
  const before = f.state.listReceipts();
  assertConflict(() => f.state.createTownHallBroadcast(input({ text: 'different text' })));
  const after = f.state.listReceipts();
  assert.deepEqual(
    after.map(row => ({ id: row.id, kind: row.kind, detail: row.detail })),
    before.map(row => ({ id: row.id, kind: row.kind, detail: row.detail }))
  );
  const stored = f.state.getTownHallBroadcast(first.broadcast.journalKey);
  assert.equal(stored.plan.text, 'original text');
  assert.deepEqual(stored, first.broadcast);
});

test('changed room or recipient generation conflicts with frozen identity', t => {
  const f = fixture(t);
  const first = f.state.createTownHallBroadcast(input());
  const before = f.state.listReceipts();
  assertConflict(() => f.state.createTownHallBroadcast(input({
    townHall: { guildId: '100', channelId: '901' }
  })));
  assertConflict(() => f.state.createTownHallBroadcast(input({
    recipients: [address({ channelId: '300', generation: 2 })]
  })));
  assert.deepEqual(f.state.listReceipts().map(row => row.id), before.map(row => row.id));
  const stored = f.state.getTownHallBroadcast(first.broadcast.journalKey);
  assert.equal(stored.plan.townHall.channelId, '900');
  assert.equal(stored.plan.recipients[0].target.generation, 1);
  assert.equal(stored.plan.text, 'hello');
});

test('distinct source identity has an independent journal', t => {
  const f = fixture(t);
  const base = f.state.createTownHallBroadcast(input());
  const changedGeneration = f.state.createTownHallBroadcast(input({
    source: address({ channelId: '200', nativeId: SOURCE_ID, generation: 2 })
  }));
  const changedBroadcast = f.state.createTownHallBroadcast(input({ broadcastId: 'b2' }));

  assert.notEqual(base.broadcast.journalKey, changedGeneration.broadcast.journalKey);
  assert.notEqual(base.broadcast.journalKey, changedBroadcast.broadcast.journalKey);
  assert.notEqual(changedGeneration.broadcast.journalKey, changedBroadcast.broadcast.journalKey);
  assert.equal(f.state.listTownHallBroadcasts().length, 3);
  assert.equal(f.state.getTownHallBroadcast(base.broadcast.journalKey).plan.text, 'hello');
  assert.equal(f.state.getTownHallBroadcast(changedGeneration.broadcast.journalKey).plan.source.generation, 2);
  assert.equal(f.state.getTownHallBroadcast(changedBroadcast.broadcast.journalKey).plan.broadcastId, 'b2');
});

test('write failure rolls back manifest and every recipient', t => {
  const f = fixture(t);
  const source = input({ recipients: twoRecipients() });
  const originalReceipt = f.state.receipt;
  let calls = 0;
  try {
    f.state.receipt = function injectedReceipt(...args) {
      calls += 1;
      if (calls === 3) throw new Error('injected town-hall journal write failure');
      return originalReceipt.apply(this, args);
    };
    assert.throws(
      () => f.state.createTownHallBroadcast(source),
      /injected town-hall journal write failure/
    );
  } finally {
    f.state.receipt = originalReceipt;
  }
  assert.equal(calls, 3);
  assert.deepEqual(ownedRows(f.state), []);
  assert.deepEqual(f.state.listReceipts(), []);
  assert.equal(f.state.getTownHallBroadcast(expectedJournalKey(planTownHallBroadcast(source))), null);

  const recovered = f.state.createTownHallBroadcast(source);
  assert.equal(recovered.created, true);
  assert.equal(recovered.broadcast.recipients.length, 2);
  assert.equal(ownedRows(f.state).length, 3);
});

test('competing connections preserve one immutable manifest', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'town-hall-journal-race-'));
  const dbPath = path.join(dir, 'surface.sqlite');
  const seed = new SurfaceState(dbPath);
  seed.close();
  const statePath = require.resolve('../src/state');
  const workers = [];
  const runWorker = source => new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { dbPath, statePath, timeoutMs: 10000, input: source }
    });
    workers.push(worker);
    worker.once('message', resolve);
    worker.once('error', reject);
  });
  try {
    const results = await Promise.all([
      runWorker(input({ recipients: twoRecipients(), text: 'race original text' })),
      runWorker(input({ recipients: twoRecipients(), text: 'race competing text' }))
    ]);
    const winners = results.filter(result => result.ok === true);
    const losers = results.filter(result => result.ok === false);
    assert.equal(winners.length, 1, JSON.stringify(results));
    assert.equal(winners[0].created, true);
    assert.equal(losers.length, 1, JSON.stringify(results));
    assert.equal(losers[0].kind, 'BindingError');
    assert.equal(losers[0].message, CONFLICT);

    const reopened = new SurfaceState(dbPath);
    try {
      const listed = reopened.listTownHallBroadcasts();
      assert.equal(listed.length, 1);
      const snapshot = reopened.getTownHallBroadcast(listed[0].journalKey);
      assert.equal(snapshot.recipients.length, 2);
      assert.ok(['race original text', 'race competing text'].includes(snapshot.plan.text));
      const kinds = reopened.listReceipts().map(row => row.kind);
      assert.equal(kinds.filter(kind => kind === MANIFEST_PREFIX + snapshot.journalKey).length, 1);
      assert.equal(kinds.filter(kind => kind === RECIPIENT_PREFIX + snapshot.journalKey).length, 2);
    } finally {
      reopened.close();
    }
  } finally {
    for (const worker of workers) await worker.terminate();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('reopen preserves exact instruction and frozen recipient generations', t => {
  const f = fixture(t);
  const text = '  spaced\nline\ttab \u00e9  ';
  const source = input({
    text,
    recipients: [
      address({ channelId: '300', generation: 2 }),
      address({ channelId: '301', provider: 'claude', nativeId: CLAUDE_ID, generation: 7 })
    ]
  });
  const created = f.state.createTownHallBroadcast(source);
  f.state.close();

  const reopened = new SurfaceState(f.dbPath);
  t.after(() => { try { reopened.close(); } catch {} });
  const stored = reopened.getTownHallBroadcast(created.broadcast.journalKey);
  assert.equal(stored.plan.text, text);
  assert.equal(Buffer.from(stored.plan.text, 'utf8').toString('utf8'), text);
  assert.deepEqual(stored, created.broadcast);
  assert.deepEqual(stored.recipients.map(entry => entry.target.generation), [2, 7]);
  assert.equal(reopened.listTownHallBroadcasts().length, 1);
});

test('malformed owned manifest refuses instead of appearing absent', t => {
  const f = fixture(t);
  const created = f.state.createTownHallBroadcast(input());
  const journalKey = created.broadcast.journalKey;
  const manifest = f.state.listReceipts()
    .find(row => row.kind === MANIFEST_PREFIX + journalKey);
  assert.ok(manifest);
  const originalDetail = manifest.detail;
  const originalPlan = JSON.parse(originalDetail).plan;
  const update = detail => f.state.db.prepare('UPDATE receipts SET detail=? WHERE id=?').run(detail, manifest.id);
  // receipts carries expression indexes over json_extract(detail, ...) that SQLite
  // re-evaluates on UPDATE, so a malformed detail cannot be written while they exist.
  // Drop and restore them around the raw fixture write; restore is in finally.
  const expressionIndex = f.state.db.prepare(
    "SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='receipts' AND sql LIKE '%json_extract%'"
  ).all();
  for (const index of expressionIndex) f.state.db.exec(`DROP INDEX ${index.name}`);
  try {
    update('{not json');
    assertCorrupt(() => f.state.getTownHallBroadcast(journalKey));
    assertCorrupt(() => f.state.listTownHallBroadcasts());

    update(JSON.stringify({ version: 1, journalKey, plan: originalPlan, extra: true }));
    assertCorrupt(() => f.state.getTownHallBroadcast(journalKey));

    update(JSON.stringify({ version: 2, journalKey, plan: originalPlan }));
    assertCorrupt(() => f.state.getTownHallBroadcast(journalKey));

    const alteredPlan = JSON.parse(originalDetail).plan;
    alteredPlan.text = 'tampered text';
    update(JSON.stringify({ version: 1, journalKey, plan: alteredPlan }));
    assertCorrupt(() => f.state.getTownHallBroadcast(journalKey));
  } finally {
    update(originalDetail);
    for (const index of expressionIndex) f.state.db.exec(index.sql);
  }
  assert.equal(f.state.getTownHallBroadcast(journalKey).plan.text, 'hello');

  for (const key of ['', journalKey.toUpperCase(), journalKey.slice(0, 63), journalKey + '0', 'not-a-key']) {
    assert.throws(() => f.state.getTownHallBroadcast(key), error => {
      assert.ok(error instanceof BindingError, `expected BindingError for ${JSON.stringify(key)}`);
      assert.equal(error.message, INVALID_KEY);
      return true;
    });
  }
});

test('missing duplicate or orphan recipient records refuse', t => {
  const missing = fixture(t);
  const missingCreated = missing.state.createTownHallBroadcast(input({ recipients: twoRecipients() }));
  const missingRecipient = missing.state.listReceipts()
    .find(row => row.kind === RECIPIENT_PREFIX + missingCreated.broadcast.journalKey);
  assert.ok(missingRecipient);
  missing.state.db.prepare('DELETE FROM receipts WHERE id=?').run(missingRecipient.id);
  assertCorrupt(() => missing.state.getTownHallBroadcast(missingCreated.broadcast.journalKey));
  assertCorrupt(() => missing.state.listTownHallBroadcasts());

  const duplicate = fixture(t);
  const duplicateCreated = duplicate.state.createTownHallBroadcast(input());
  const duplicateManifest = duplicate.state.listReceipts()
    .find(row => row.kind === MANIFEST_PREFIX + duplicateCreated.broadcast.journalKey);
  assert.ok(duplicateManifest);
  duplicate.state.db.prepare('INSERT INTO receipts(discord_id, kind, detail, created_at) VALUES(?, ?, ?, ?)')
    .run(null, duplicateManifest.kind, duplicateManifest.detail, duplicateManifest.created_at);
  assertCorrupt(() => duplicate.state.getTownHallBroadcast(duplicateCreated.broadcast.journalKey));
  assertCorrupt(() => duplicate.state.listTownHallBroadcasts());

  const orphan = fixture(t);
  const orphanKey = expectedJournalKey(planTownHallBroadcast(input()));
  orphan.state.receipt(null, RECIPIENT_PREFIX + orphanKey, {
    version: 1,
    journalKey: orphanKey,
    fingerprint: 'a'.repeat(64),
    packetId: 'townhall_' + 'b'.repeat(64),
    target: address()
  });
  assertCorrupt(() => orphan.state.getTownHallBroadcast(orphanKey));
  assertCorrupt(() => orphan.state.listTownHallBroadcasts());
});

test('list keeps creation order and ignores unrelated receipts', t => {
  const f = fixture(t);
  f.state.receipt(null, 'unrelated-receipt', { note: 'not a journal' });
  const first = f.state.createTownHallBroadcast(input());
  f.state.receipt(null, 'town-hall-manifest/v0:' + 'f'.repeat(64), { version: 0 });
  f.state.receipt(null, 'town-hall-recipient/v0:' + 'f'.repeat(64), { version: 0 });
  const second = f.state.createTownHallBroadcast(input({ broadcastId: 'b2' }));

  const listed = f.state.listTownHallBroadcasts();
  assert.deepEqual(
    listed.map(snapshot => snapshot.journalKey),
    [first.broadcast.journalKey, second.broadcast.journalKey]
  );
  assert.equal(listed.length, 2);
  assert.deepEqual(listed[0], first.broadcast);
  assert.deepEqual(listed[1], second.broadcast);
});

test('returned snapshots and nested values are immutable', t => {
  const f = fixture(t);
  const created = f.state.createTownHallBroadcast(input({ recipients: twoRecipients() }));
  const snapshots = [
    created.broadcast,
    f.state.getTownHallBroadcast(created.broadcast.journalKey),
    f.state.listTownHallBroadcasts()[0]
  ];
  for (const snapshot of snapshots) {
    assert.ok(Object.isFrozen(snapshot));
    assert.ok(Object.isFrozen(snapshot.plan));
    assert.ok(Object.isFrozen(snapshot.plan.townHall));
    assert.ok(Object.isFrozen(snapshot.plan.source));
    assert.ok(Object.isFrozen(snapshot.plan.recipients));
    assert.ok(Object.isFrozen(snapshot.publication));
    assert.ok(Object.isFrozen(snapshot.recipients));
    for (const recipient of snapshot.recipients) {
      assert.ok(Object.isFrozen(recipient));
      assert.ok(Object.isFrozen(recipient.target));
    }
    assert.throws(() => { snapshot.plan.text = 'mutated'; }, TypeError);
    assert.throws(() => { snapshot.publication.status = 'published'; }, TypeError);
    assert.throws(() => { snapshot.recipients[0].status = 'delivered'; }, TypeError);
    assert.throws(() => { snapshot.recipients[0].target.generation = 99; }, TypeError);
    assert.throws(() => { snapshot.recipients.push({}); }, TypeError);
    assert.throws(() => { snapshot.plan.recipients.push({}); }, TypeError);
  }
  const stored = f.state.getTownHallBroadcast(created.broadcast.journalKey);
  assert.equal(stored.plan.text, 'hello');
  assert.deepEqual(stored, created.broadcast);
});
