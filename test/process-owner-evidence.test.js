'use strict';

// Issue240 class fix: one typed process-owner evidence owner plus consumers that
// settle only on proved absence. These tests exercise the classifier table, the
// legacy-boolean boundary, every destructive consumer, and a structural inventory
// that goes red on a new private PID probe or a legacy-false destructive copy.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

const {
  OWNER_EVIDENCE,
  OWNER_EVIDENCE_REASON,
  classifyProcessOwner,
  normalizeOwnerEvidence
} = require('../src/state/process-owner-evidence');
const { SurfaceState } = require('../src/state');
const { runDirectPost } = require('../src/direct-post');
const { fixture, preparationSeed, multipartRecorder, response } = require('./direct-post-fixture');
const { fixture: nativeFixture, submitted } = require('./native-reply-file-fixture');
const { fixture: boardFixture, seedBoardAttempt, BOARD_OUTCOMES } = require('./board-refresh-fixture');const { createTownHallPublicationHandlers } = require('../dist/state/town-hall-publication/index.js');
const { BindingError, StateCorruptError, discordNonce } = require('../src/state');

const FAKE_PID = 424242;
const SRC_ROOT = path.join(__dirname, '..', 'src');
const PUBLICATION_PREFIX = 'town-hall-publication/v1:';

function probeError(code) {
  return Object.assign(new Error(`fixture probe ${code}`), { code });
}

function probeDeps({ probeErrorThrown = null, probeReturns = true, capture = () => ({ ownerStartTime: 'actual', ownerCommand: 'actual' }), captureThrows = false } = {}) {
  const calls = { probe: 0, capture: 0 };
  return {
    calls,
    deps: {
      probePid() {
        calls.probe += 1;
        if (probeErrorThrown) throw probeErrorThrown;
        return probeReturns;
      },
      captureIdentity() {
        calls.capture += 1;
        if (captureThrows) throw new Error('fixture capture failure');
        return capture();
      }
    }
  };
}

function mockProcessKill(code) {
  const calls = [];
  const original = process.kill;
  process.kill = (pid, signal) => {
    calls.push([pid, signal]);
    if (code) throw probeError(code);
    return true;
  };
  return { calls, restore: () => { process.kill = original; } };
}

function receiptIds(state) {
  return state.listReceipts().map(row => row.id);
}

function receiptsOfKind(state, kind) {
  return state.listReceipts().filter(row => row.kind === kind);
}

// Fixture helper for scenarios that create and close several states inside one
// top-level test; cleanup is explicit in each finally block.
function headlessFixture() {
  return fixture({ after() {} });
}

// ---------------------------------------------------------------------------
// Test 1: classifier table
// ---------------------------------------------------------------------------

test('classifier table proves absence, denial, unreadability and identity comparison', () => {
  const absent = probeDeps({ probeErrorThrown: probeError('ESRCH') });
  assert.deepEqual(classifyProcessOwner(FAKE_PID, null, absent.deps), { status: 'absent', reason: 'probe-absent' });
  assert.equal(absent.calls.probe, 1, 'ESRCH must probe before requiring identity');
  assert.equal(absent.calls.capture, 0, 'ESRCH must not capture identity');

  const denied = probeDeps({ probeErrorThrown: probeError('EPERM') });
  assert.deepEqual(classifyProcessOwner(FAKE_PID, null, denied.deps), { status: 'indeterminate', reason: 'probe-denied' });

  const failed = probeDeps({ probeErrorThrown: probeError('EIO') });
  assert.deepEqual(classifyProcessOwner(FAKE_PID, null, failed.deps), { status: 'indeterminate', reason: 'probe-error' });

  const unreadableCode = probeDeps({ probeErrorThrown: Object.defineProperty({}, 'code', {
    get() { throw new Error('unreadable probe code'); }
  }) });
  assert.deepEqual(classifyProcessOwner(FAKE_PID, null, unreadableCode.deps), { status: 'indeterminate', reason: 'probe-error' });
  assert.equal(unreadableCode.calls.capture, 0);

  const nonError = probeDeps();
  nonError.deps.probePid = () => { throw 'fixture non-error throw'; };
  assert.deepEqual(classifyProcessOwner(FAKE_PID, { ownerStartTime: 'start' }, nonError.deps), { status: 'indeterminate', reason: 'probe-error' });

  for (const pid of [0, -1, 1.5, 'x', NaN, null, undefined, -0.5]) {
    const invalid = probeDeps();
    assert.deepEqual(classifyProcessOwner(pid, { ownerStartTime: 'start' }, invalid.deps), { status: 'indeterminate', reason: 'invalid-pid' }, `pid ${String(pid)}`);
    assert.equal(invalid.calls.probe, 0, `pid ${String(pid)} must not probe`);
    assert.equal(invalid.calls.capture, 0, `pid ${String(pid)} must not capture`);
  }

  for (const recorded of [null, undefined, {}, { ownerStartTime: '', ownerCommand: '' }, { ownerStartTime: null, ownerCommand: null }, 42, 'recorded']) {
    const missing = probeDeps();
    assert.deepEqual(classifyProcessOwner(FAKE_PID, recorded, missing.deps), { status: 'indeterminate', reason: 'missing-identity' }, JSON.stringify(recorded));
    assert.equal(missing.calls.probe, 1);
  }

  const noCaptureValue = probeDeps({ capture: () => null });
  assert.deepEqual(classifyProcessOwner(FAKE_PID, { ownerStartTime: 'start' }, noCaptureValue.deps), { status: 'indeterminate', reason: 'unreadable-identity' });
  const captureThrew = probeDeps({ captureThrows: true });
  assert.deepEqual(classifyProcessOwner(FAKE_PID, { ownerStartTime: 'start' }, captureThrew.deps), { status: 'indeterminate', reason: 'unreadable-identity' });
  for (const capture of [() => 42, () => 'identity', () => true]) {
    assert.deepEqual(classifyProcessOwner(FAKE_PID, { ownerStartTime: 'start' }, probeDeps({ capture }).deps), { status: 'indeterminate', reason: 'unreadable-identity' });
  }

  const incomplete = probeDeps({ capture: () => ({ ownerStartTime: 'start' }) });
  assert.deepEqual(
    classifyProcessOwner(FAKE_PID, { ownerStartTime: 'start', ownerCommand: 'command' }, incomplete.deps),
    { status: 'indeterminate', reason: 'incomplete-identity' }
  );

  const startMatch = probeDeps({ capture: () => ({ ownerStartTime: 'start', ownerCommand: 'different-command' }) });
  assert.deepEqual(classifyProcessOwner(FAKE_PID, { ownerStartTime: 'start' }, startMatch.deps), { status: 'matching-live', reason: 'identity-match' });
  const commandMatch = probeDeps({ capture: () => ({ ownerStartTime: 'other-start', ownerCommand: 'command' }) });
  assert.deepEqual(classifyProcessOwner(FAKE_PID, { ownerCommand: 'command' }, commandMatch.deps), { status: 'matching-live', reason: 'identity-match' });

  const mismatch = probeDeps({ capture: () => ({ ownerStartTime: 'other-start', ownerCommand: 'command' }) });
  assert.deepEqual(classifyProcessOwner(FAKE_PID, { ownerStartTime: 'start' }, mismatch.deps), { status: 'absent', reason: 'identity-mismatch' });

  const ignoredReturn = probeDeps({ probeReturns: false });
  assert.deepEqual(classifyProcessOwner(FAKE_PID, null, ignoredReturn.deps), { status: 'indeterminate', reason: 'missing-identity' });
});

// ---------------------------------------------------------------------------
// Test 2: legacy and malformed normalization
// ---------------------------------------------------------------------------

test('normalizeOwnerEvidence maps typed pairs, legacy booleans and malformed values', () => {
  for (const pair of [
    { status: 'matching-live', reason: 'identity-match' },
    { status: 'matching-live', reason: 'legacy-match' },
    { status: 'absent', reason: 'probe-absent' },
    { status: 'absent', reason: 'identity-mismatch' },
    { status: 'indeterminate', reason: 'probe-denied' },
    { status: 'indeterminate', reason: 'legacy-unknown' }
  ]) {
    const normalized = normalizeOwnerEvidence(pair);
    assert.deepEqual(normalized, pair);
    assert.equal(Object.isFrozen(normalized), true, `${pair.status}/${pair.reason} must be frozen`);
  }

  assert.deepEqual(normalizeOwnerEvidence(true), { status: 'matching-live', reason: 'legacy-match' });
  assert.deepEqual(normalizeOwnerEvidence(false), { status: 'indeterminate', reason: 'legacy-unknown' });
  assert.equal(normalizeOwnerEvidence(false).status === OWNER_EVIDENCE.ABSENT, false, 'false must never mean absence');
  assert.equal(normalizeOwnerEvidence(false).status === OWNER_EVIDENCE.MATCHING_LIVE, false, 'false must never mean matching-live');

  const malformed = [
    null,
    undefined,
    0,
    1,
    'matching-live',
    {},
    { status: 'bogus', reason: 'identity-match' },
    { status: 'absent', reason: 'identity-match' },
    { status: 'matching-live', reason: 'probe-absent' },
    { status: 'matching-live' },
    { status: 'absent', reason: 'bogus' }
  ];
  for (const value of malformed) {
    assert.deepEqual(
      normalizeOwnerEvidence(value),
      { status: 'indeterminate', reason: 'invalid-evidence' },
      `malformed ${JSON.stringify(value) ?? String(value)}`
    );
  }
});

// ---------------------------------------------------------------------------
// Test 3: direct-post generic recovery
// ---------------------------------------------------------------------------

test('direct-post recovery settles only typed absence and holds legacy booleans', () => {
  const cases = [
    { label: 'legacy-false', callback: () => false, recovered: 0 },
    { label: 'legacy-true', callback: () => true, recovered: 0 },
    { label: 'typed-absent', callback: () => ({ status: 'absent', reason: 'probe-absent' }), recovered: 1 },
    { label: 'legacy-indeterminate-object', callback: () => ({ status: 'indeterminate', reason: 'probe-error' }), recovered: 0 }
  ];
  for (const scenario of cases) {
    const f = headlessFixture();
    try {
      const attemptId = `orphan-${scenario.label}`;
      f.state.receipt(null, 'direct-post-attempt', {
        journal: 'direct-post-v1',
        requestId: `request-${attemptId}`,
        attemptId,
        ownerPid: FAKE_PID,
        ownerStartTime: 'fixture-start',
        ownerCommand: 'fixture-command',
        status: 'attempted'
      });
      const before = receiptIds(f.state);
      const recovered = f.state.recoverDirectPostReceipts(scenario.callback);
      assert.equal(recovered, scenario.recovered, scenario.label);
      const outcomes = receiptsOfKind(f.state, 'direct-post-outcome')
        .filter(row => JSON.parse(row.detail).attemptId === attemptId);
      if (scenario.recovered === 0) {
        assert.deepEqual(receiptIds(f.state), before, `${scenario.label} must not write a settlement`);
        assert.equal(outcomes.length, 0, `${scenario.label} must not settle`);
      } else {
        assert.equal(outcomes.length, 1, `${scenario.label} must settle exactly once`);
        assert.equal(JSON.parse(outcomes[0].detail).outcome, 'unknown');
        assert.equal(receiptIds(f.state).length, before.length + 1);
      }
    } finally {
      f.state.close();
      fs.rmSync(f.dir, { recursive: true, force: true });
    }
  }
});

// ---------------------------------------------------------------------------
// Test 4: board generic recovery
// ---------------------------------------------------------------------------

test('board recovery settles only typed absence and holds legacy booleans', () => {
  const cases = [
    { label: 'legacy-false', callback: () => false, recovered: 0 },
    { label: 'legacy-true', callback: () => true, recovered: 0 },
    { label: 'typed-absent', callback: () => ({ status: 'absent', reason: 'probe-absent' }), recovered: 1 }
  ];
  for (const scenario of cases) {
    const f = boardFixture();
    try {
      const seeded = seedBoardAttempt(f, `owner-evidence-${scenario.label}`);
      const row = f.state.db.prepare(
        "SELECT id, detail FROM receipts WHERE kind='board-refresh-attempt' AND json_extract(detail, '$.attemptId')=?"
      ).get(seeded.attemptId);
      assert.ok(row, 'seeded board attempt must exist');
      f.state.db.prepare('UPDATE receipts SET detail=? WHERE id=?').run(
        JSON.stringify({ ...JSON.parse(row.detail), ownerPid: FAKE_PID, ownerIdentity: { ownerStartTime: 'fixture-start', ownerCommand: 'fixture-command' } }),
        row.id
      );
      const before = receiptIds(f.state);
      const recovered = f.state.recoverBoardRefreshAttempt(seeded.target, seeded.attemptId, scenario.callback);
      assert.equal(recovered, scenario.recovered, scenario.label);
      const outcomes = receiptsOfKind(f.state, 'board-refresh-outcome')
        .filter(row => JSON.parse(row.detail).attemptId === seeded.attemptId);
      if (scenario.recovered === 0) {
        assert.deepEqual(receiptIds(f.state), before, `${scenario.label} must not settle`);
        assert.equal(outcomes.length, 0);
        assert.equal(f.state.inspectBoardRequest(`owner-evidence-${scenario.label}`, seeded.target).status, BOARD_OUTCOMES.IN_FLIGHT);
      } else {
        assert.equal(outcomes.length, 1);
        assert.equal(JSON.parse(outcomes[0].detail).outcome, BOARD_OUTCOMES.UNKNOWN);
        assert.equal(receiptIds(f.state).length, before.length + 1);
      }
    } finally {
      f.state.close();
      fs.rmSync(f.dir, { recursive: true, force: true });
    }
  }
});

// ---------------------------------------------------------------------------
// Test 5: interaction generic recovery
// ---------------------------------------------------------------------------

test('interaction callback recovery settles only typed absence and holds legacy booleans', () => {
  const cases = [
    { label: 'legacy-false', callback: () => false, recovered: 0 },
    { label: 'legacy-true', callback: () => true, recovered: 0 },
    { label: 'typed-absent', callback: () => ({ status: 'absent', reason: 'probe-absent' }), recovered: 1 }
  ];
  for (const scenario of cases) {
    const f = headlessFixture();
    const messageId = `97020${cases.indexOf(scenario)}`;
    try {
      f.state.acceptDiscordMessage({ id: messageId, guildId: 'guild', channelId: 'channel', authorId: 'operator', isBot: false, content: 'question' });
      f.state.receipt(messageId, 'transport-receipt-attempt', {
        transport: 'interaction-callback',
        nonce: `nonce-${scenario.label}`,
        ownerPid: FAKE_PID,
        ownerIdentity: { ownerStartTime: 'fixture-start', ownerCommand: 'fixture-command' },
        status: 'attempted'
      });
      const before = receiptIds(f.state);
      const recovered = f.state.recoverInteractionCallbacksInTransaction(scenario.callback);
      assert.equal(recovered, scenario.recovered, scenario.label);
      const outcomes = f.state.listReceipts().filter(row =>
        row.discord_id === messageId && row.kind === 'transport-receipt-outcome');
      if (scenario.recovered === 0) {
        assert.deepEqual(receiptIds(f.state), before, `${scenario.label} must not settle`);
        assert.equal(outcomes.length, 0);
      } else {
        assert.equal(outcomes.length, 1);
        assert.equal(JSON.parse(outcomes[0].detail).outcome, 'unknown');
        assert.equal(JSON.parse(outcomes[0].detail).terminal, true);
        assert.equal(receiptIds(f.state).length, before.length + 1);
      }
    } finally {
      f.state.close();
      fs.rmSync(f.dir, { recursive: true, force: true });
    }
  }
});

// ---------------------------------------------------------------------------
// Test 6: town-hall domain policy
// ---------------------------------------------------------------------------

const TOWN_HALL_RECORDED = { ownerPid: process.pid, ownerStartTime: 'recorded-start', ownerCommand: 'recorded-command' };
const TOWN_HALL_SOURCE_NATIVE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TOWN_HALL_NATIVE = '11111111-1111-4111-8111-aabbccddeeff';

function townHallAddress(channelId, nativeId) {
  return { guildId: '100', channelId, provider: 'codex', nativeId, generation: 1 };
}

function townHallPlan(broadcastId) {
  return {
    broadcastId,
    townHall: { guildId: '100', channelId: '900' },
    source: townHallAddress('200', TOWN_HALL_SOURCE_NATIVE),
    recipients: [townHallAddress('300', TOWN_HALL_NATIVE)],
    text: 'hello'
  };
}

function townHallFixture(t, broadcastId) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-evidence-town-hall-'));
  const state = new SurfaceState(path.join(dir, 'surface.sqlite'));
  t.after(() => {
    try { state.close(); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  });
  state.directPostOwnerIdentity = () => TOWN_HALL_RECORDED;
  const created = state.createTownHallBroadcast(townHallPlan(broadcastId));
  const journalKey = created.broadcast.journalKey;
  const reserved = state.reserveTownHallPublication(journalKey);
  return { state, journalKey, attemptId: reserved.publication.attemptId };
}

function townHallHandlers(probePid) {
  return createTownHallPublicationHandlers({ BindingError, StateCorruptError, discordNonce, probePid });
}

function publicationRows(state, journalKey) {
  return state.listReceipts().filter(row => row.kind === PUBLICATION_PREFIX + journalKey);
}

test('town-hall preserves claimed hold and in-flight unknown under shared evidence', t => {
  // CLAIMED + probe proves absence (ESRCH): the domain releases the matching claim.
  {
    const { state, journalKey, attemptId } = townHallFixture(t, 'b1');
    const before = receiptIds(state);
    const recovered = townHallHandlers(() => { throw probeError('ESRCH'); }).recoverTownHallPublication(state, journalKey);
    assert.equal(recovered.status, 'not_sent');
    assert.equal(recovered.attemptId, attemptId);
    const outcomes = publicationRows(state, journalKey).filter(row => JSON.parse(row.detail).event === 'outcome');
    assert.equal(outcomes.length, 1);
    assert.equal(JSON.parse(outcomes[0].detail).outcome, 'not_sent');
    assert.deepEqual(receiptIds(state), before.concat([outcomes[0].id]));
  }

  // CLAIMED + matching-live identity: hold, no settlement.
  {
    const { state, journalKey } = townHallFixture(t, 'b2');
    const before = receiptIds(state);
    const held = townHallHandlers(() => true).recoverTownHallPublication(state, journalKey);
    assert.equal(held.status, 'claimed');
    assert.deepEqual(receiptIds(state), before);
    assert.equal(publicationRows(state, journalKey).some(row => JSON.parse(row.detail).event === 'outcome'), false);
  }

  // CLAIMED + proved identity mismatch: domain downgrades absence to indeterminate and holds.
  {
    const { state, journalKey } = townHallFixture(t, 'b3');
    state.directPostOwnerIdentity = () => ({ ownerPid: process.pid, ownerStartTime: 'other-start', ownerCommand: 'recorded-command' });
    const before = receiptIds(state);
    const held = townHallHandlers(() => true).recoverTownHallPublication(state, journalKey);
    assert.equal(held.status, 'claimed');
    assert.deepEqual(receiptIds(state), before);
    assert.equal(publicationRows(state, journalKey).some(row => JSON.parse(row.detail).event === 'outcome'), false);
  }

  // CLAIMED + unreadable identity (unobservable evidence): hold, no settlement.
  {
    const { state, journalKey } = townHallFixture(t, 'b4');
    state.directPostOwnerIdentity = () => null;
    const before = receiptIds(state);
    const held = townHallHandlers(() => true).recoverTownHallPublication(state, journalKey);
    assert.equal(held.status, 'claimed');
    assert.deepEqual(receiptIds(state), before);
  }

  // IN_FLIGHT + indeterminate probe: existing unknown-outcome transition.
  {
    const { state, journalKey, attemptId } = townHallFixture(t, 'b5');
    state.markTownHallPublicationInFlight(journalKey, attemptId);
    const before = receiptIds(state);
    const observed = townHallHandlers(() => { throw probeError('EPERM'); }).recoverTownHallPublication(state, journalKey);
    assert.equal(observed.status, 'unknown');
    assert.equal(observed.messageId, null);
    const outcomes = publicationRows(state, journalKey).filter(row => JSON.parse(row.detail).event === 'outcome');
    assert.equal(outcomes.length, 1);
    assert.equal(JSON.parse(outcomes[0].detail).outcome, 'unknown');
    assert.deepEqual(receiptIds(state), before.concat([outcomes[0].id]));
  }

  // IN_FLIGHT + matching-live: hold in flight, no settlement.
  {
    const { state, journalKey, attemptId } = townHallFixture(t, 'b6');
    state.markTownHallPublicationInFlight(journalKey, attemptId);
    const before = receiptIds(state);
    const held = townHallHandlers(() => true).recoverTownHallPublication(state, journalKey);
    assert.equal(held.status, 'in_flight');
    assert.deepEqual(receiptIds(state), before);
    assert.equal(publicationRows(state, journalKey).some(row => JSON.parse(row.detail).event === 'outcome'), false);
  }

  // Missing recorded start time cannot be presented through the typed journal:
  // the journal decoder refuses the row as corrupt before classification, so the
  // weak claim is never released and no outcome is written. The domain adapter's
  // empty-start rule is therefore defensive for this path.
  {
    const { state, journalKey } = townHallFixture(t, 'b7');
    const row = state.db.prepare('SELECT id, detail FROM receipts WHERE kind=?').get(PUBLICATION_PREFIX + journalKey);
    const detail = JSON.parse(row.detail);
    detail.owner.ownerStartTime = '';
    state.db.prepare('UPDATE receipts SET detail=? WHERE id=?').run(JSON.stringify(detail), row.id);
    const before = receiptIds(state);
    assert.throws(
      () => townHallHandlers(() => true).recoverTownHallPublication(state, journalKey),
      StateCorruptError
    );
    assert.deepEqual(receiptIds(state), before, 'a corrupt missing-start row must not write an outcome');
    assert.equal(publicationRows(state, journalKey).some(candidate => JSON.parse(candidate.detail).event === 'outcome'), false);
  }
});

// ---------------------------------------------------------------------------
// Test 7: PREPARING retention and ESRCH release
// ---------------------------------------------------------------------------

test('direct and native preparing cleanup retain bytes on indeterminate evidence and release on ESRCH', t => {
  const direct = fixture(t);
  const directSeed = preparationSeed(direct, '44444444-4444-4444-8444-444444444444', {
    ownerPid: FAKE_PID,
    ownerStartTime: null,
    ownerCommand: null
  });
  const directPreparation = direct.state.beginDirectPostFilePreparation(directSeed);
  const directPartial = `${directPreparation.stagedPath}.partial`;
  fs.mkdirSync(path.dirname(directPartial), { recursive: true, mode: 0o700 });
  fs.writeFileSync(directPartial, Buffer.from('direct held bytes'), { mode: 0o600 });

  const directBefore = receiptIds(direct.state).length;
  const directActiveBefore = direct.state.activeFilePreparationCount();
  const allowProbe = mockProcessKill(null);
  try {
    assert.throws(
      () => direct.state.releaseDirectPostFilePreparation(directPreparation.preparationId),
      /direct post file preparation owner is still active/
    );
  } finally {
    allowProbe.restore();
    assert.deepEqual(allowProbe.calls, [[FAKE_PID, 0]]);
  }
  assert.equal(direct.state.directPostFilePreparation(directPreparation.requestId).phase, 'preparing');
  assert.deepEqual(fs.readFileSync(directPartial), Buffer.from('direct held bytes'));
  assert.equal(receiptIds(direct.state).length, directBefore);
  assert.equal(direct.state.activeFilePreparationCount(), directActiveBefore);

  const esrchProbe = mockProcessKill('ESRCH');
  let directReleased;
  try {
    directReleased = direct.state.releaseDirectPostFilePreparation(directPreparation.preparationId);
  } finally {
    esrchProbe.restore();
    assert.deepEqual(esrchProbe.calls, [[FAKE_PID, 0]]);
  }
  assert.equal(directReleased.phase, 'released');
  assert.equal(direct.state.directPostFilePreparation(directPreparation.requestId).phase, 'released');
  assert.equal(fs.existsSync(directPartial), false);
  assert.equal(receiptIds(direct.state).length, directBefore + 1);
  assert.equal(directActiveBefore - direct.state.activeFilePreparationCount(), 1);

  const native = nativeFixture(t);
  const messageId = '970001';
  const preparationId = '44444444-4444-4444-8444-444444444444';
  submitted(native, messageId);
  const stagedPath = path.join(native.dir, '.direct-post-files', `${preparationId}.bin`);
  fs.mkdirSync(path.dirname(stagedPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(`${stagedPath}.partial`, Buffer.from('native held bytes'), { mode: 0o600 });
  native.state.receipt(messageId, 'native-reply-file-preparation', {
    journal: 'native-reply-file-v1',
    phase: 'preparing',
    preparationId,
    stagedPath,
    ownerPid: FAKE_PID,
    ownerStartTime: null,
    ownerCommand: null
  });

  const nativeBefore = receiptIds(native.state).length;
  const nativeActiveBefore = native.state.activeFilePreparationCount();
  const nativeAllow = mockProcessKill(null);
  try {
    assert.throws(
      () => native.state.releaseNativeReplyFilePreparation(messageId, preparationId),
      /native reply file preparation owner is still active/
    );
  } finally {
    nativeAllow.restore();
    assert.deepEqual(nativeAllow.calls, [[FAKE_PID, 0]]);
  }
  assert.equal(native.state.nativeReplyFilePreparation(messageId).phase, 'preparing');
  assert.deepEqual(fs.readFileSync(`${stagedPath}.partial`), Buffer.from('native held bytes'));
  assert.equal(receiptIds(native.state).length, nativeBefore);
  assert.equal(native.state.activeFilePreparationCount(), nativeActiveBefore);

  const nativeEsrch = mockProcessKill('ESRCH');
  let nativeReleased;
  try {
    nativeReleased = native.state.releaseNativeReplyFilePreparation(messageId, preparationId);
  } finally {
    nativeEsrch.restore();
    assert.deepEqual(nativeEsrch.calls, [[FAKE_PID, 0]]);
  }
  assert.equal(nativeReleased.phase, 'released');
  assert.equal(native.state.nativeReplyFilePreparation(messageId).phase, 'released');
  assert.equal(fs.existsSync(`${stagedPath}.partial`), false);
  assert.equal(receiptIds(native.state).length, nativeBefore + 1);
  assert.equal(nativeActiveBefore - native.state.activeFilePreparationCount(), 1);
});

// ---------------------------------------------------------------------------
// Test 8: dynamic probe and capture are read at call time
// ---------------------------------------------------------------------------

test('directPostOwnerEvidence reads the current capture method and probe at call time', t => {
  const f = fixture(t);
  const originalIdentity = f.state.directPostOwnerIdentity;
  const originalKill = process.kill;
  let mode = 'ok';
  const calls = [];
  process.kill = (pid, signal) => {
    calls.push([pid, signal]);
    if (mode !== 'ok') throw probeError(mode);
    return true;
  };
  try {
    f.state.directPostOwnerIdentity = () => ({ ownerStartTime: 'A', ownerCommand: 'command' });
    assert.deepEqual(
      f.state.directPostOwnerEvidence(FAKE_PID, { ownerStartTime: 'A', ownerCommand: 'command' }),
      { status: 'matching-live', reason: 'identity-match' }
    );

    f.state.directPostOwnerIdentity = () => ({ ownerStartTime: 'B', ownerCommand: 'command' });
    assert.deepEqual(
      f.state.directPostOwnerEvidence(FAKE_PID, { ownerStartTime: 'A', ownerCommand: 'command' }),
      { status: 'absent', reason: 'identity-mismatch' }
    );

    mode = 'ESRCH';
    assert.deepEqual(
      f.state.directPostOwnerEvidence(FAKE_PID, null),
      { status: 'absent', reason: 'probe-absent' }
    );
    assert.deepEqual(calls, [[FAKE_PID, 0], [FAKE_PID, 0], [FAKE_PID, 0]], 'probe must be read dynamically each call');
  } finally {
    process.kill = originalKill;
    f.state.directPostOwnerIdentity = originalIdentity;
  }
});

// ---------------------------------------------------------------------------
// Test 9: callback errors, defaults and missing evidence method
// ---------------------------------------------------------------------------

test('recovery propagates callback errors and defaults missing owner evidence to indeterminate', t => {
  const direct = fixture(t);
  direct.state.receipt(null, 'direct-post-attempt', {
    journal: 'direct-post-v1',
    requestId: 'callback-error',
    attemptId: 'callback-error',
    ownerPid: FAKE_PID,
    status: 'attempted'
  });
  const beforeThrow = receiptIds(direct.state);
  assert.throws(
    () => direct.state.recoverDirectPostReceipts(() => { throw new Error('owner callback exploded'); }),
    /owner callback exploded/
  );
  assert.deepEqual(receiptIds(direct.state), beforeThrow, 'thrown callback must not settle');

  const omitted = fixture(t);
  omitted.state.receipt(null, 'direct-post-attempt', {
    journal: 'direct-post-v1',
    requestId: 'omitted-default',
    attemptId: 'omitted-default'
  });
  const beforeOmitted = receiptIds(omitted.state);
  assert.equal(omitted.state.recoverDirectPostReceipts(undefined), 0, 'missing pid defaults to hold');
  assert.deepEqual(receiptIds(omitted.state), beforeOmitted);

  const board = boardFixture();
  try {
    const seeded = seedBoardAttempt(board, 'default-owner-hold');
    const beforeBoard = receiptIds(board.state);
    assert.equal(board.state.recoverBoardRefreshAttempt(seeded.target, seeded.attemptId), 0, 'default board callback must hold without owner evidence');
    assert.deepEqual(receiptIds(board.state), beforeBoard);
    assert.equal(board.state.inspectBoardRequest('default-owner-hold', seeded.target).status, BOARD_OUTCOMES.IN_FLIGHT);
  } finally {
    board.state.close();
    fs.rmSync(board.dir, { recursive: true, force: true });
  }

  const bare = fixture(t);
  const messageId = '970029';
  bare.state.acceptDiscordMessage({ id: messageId, guildId: 'guild', channelId: 'channel', authorId: 'operator', isBot: false, content: 'question' });
  bare.state.receipt(messageId, 'transport-receipt-attempt', {
    transport: 'interaction-callback',
    nonce: 'missing-method',
    ownerPid: FAKE_PID,
    ownerIdentity: { ownerStartTime: 'fixture-start' },
    status: 'attempted'
  });
  const originalEvidence = bare.state.directPostOwnerEvidence;
  bare.state.directPostOwnerEvidence = undefined;
  const beforeBare = receiptIds(bare.state);
  try {
    assert.equal(bare.state.recoverInteractionCallbacksInTransaction(null), 0, 'missing evidence method must hold, never prove absence');
    assert.deepEqual(receiptIds(bare.state), beforeBare);
    assert.equal(
      bare.state.listReceipts().some(row => row.discord_id === messageId && row.kind === 'transport-receipt-outcome'),
      false
    );
  } finally {
    bare.state.directPostOwnerEvidence = originalEvidence;
  }
});

// ---------------------------------------------------------------------------
// Test 10: admitted-file network/manifest checks are unchanged
// ---------------------------------------------------------------------------

test('admitted-file cleanup still enforces sent-part and resolved-network-outcome checks', async t => {
  const native = nativeFixture(t);
  const nativeId = '970010';
  const source = path.join(native.dir, 'answer.bin');
  fs.writeFileSync(source, Buffer.from('native payload'));
  submitted(native, nativeId);
  const manifest = native.state.prepareNativeReplyFile({
    provider: 'codex', messageId: nativeId, nativeId: native.nativeId, generation: 1,
    stateDir: native.dir, sourcePath: source, caption: 'caption'
  });
  native.state.recordNativeReply({ provider: 'codex', messageId: nativeId, nativeId: native.nativeId, generation: 1, text: 'caption', fileManifest: manifest });
  native.state.beginReply(nativeId);
  native.state.markReplyFailure(nativeId, new Error('transport uncertain'), true, 0);
  native.state.reconcileReplyDelivery(nativeId, 'not_sent');
  assert.equal(native.state.nativeReplyFilePreparation(nativeId).phase, 'admitted');
  assert.throws(
    () => native.state.releaseNativeReplyFilePreparation(nativeId, manifest.preparationId),
    /native reply file cleanup requires a sent file part/
  );
  assert.deepEqual(fs.readFileSync(manifest.stagedPath), Buffer.from('native payload'));
  assert.equal(native.state.activeFilePreparationCount(), 1);
  native.state.beginReply(nativeId);
  native.state.markReplyPartSent(nativeId, 0, 'posted');
  const nativeReleased = native.state.releaseNativeReplyFilePreparation(nativeId, manifest.preparationId);
  assert.equal(nativeReleased.phase, 'released');
  assert.equal(fs.existsSync(manifest.stagedPath), false);
  assert.equal(native.state.activeFilePreparationCount(), 0);

  const direct = fixture(t);
  const captionFile = path.join(direct.dir, 'caption.txt');
  const sourceFile = path.join(direct.dir, 'source.bin');
  fs.writeFileSync(captionFile, 'direct caption');
  fs.writeFileSync(sourceFile, Buffer.from([7, 8, 9]));
  const recorder = multipartRecorder();
  const sent = await runDirectPost({
    state: direct.state, token: 'fixture', nativeId: direct.nativeId, generation: 1,
    textFile: captionFile, attachmentFile: sourceFile, dedupeKey: 'admitted-direct-success', fetchImpl: recorder.fetchImpl
  });
  assert.equal(sent.status, 'sent');
  const successful = direct.state.directPostFilePreparation('admitted-direct-success');
  assert.equal(successful.phase, 'admitted');
  const directReleased = direct.state.releaseDirectPostFilePreparation(successful.preparationId);
  assert.equal(directReleased.phase, 'released');
  assert.equal(fs.existsSync(successful.stagedPath), false);

  const unresolved = fixture(t);
  const unresolvedCaption = path.join(unresolved.dir, 'caption.txt');
  const unresolvedSource = path.join(unresolved.dir, 'source.bin');
  fs.writeFileSync(unresolvedCaption, 'unresolved caption');
  fs.writeFileSync(unresolvedSource, Buffer.from([1, 2, 3]));
  const unknown = await runDirectPost({
    state: unresolved.state, token: 'fixture', nativeId: unresolved.nativeId, generation: 1,
    textFile: unresolvedCaption, attachmentFile: unresolvedSource, dedupeKey: 'admitted-direct-unresolved',
    fetchImpl: async () => response('rejected', 500)
  });
  assert.equal(unknown.status, 'unknown');
  const unresolvedPreparation = unresolved.state.directPostFilePreparation('admitted-direct-unresolved');
  assert.equal(unresolvedPreparation.phase, 'admitted');
  assert.throws(
    () => unresolved.state.releaseDirectPostFilePreparation(unresolvedPreparation.preparationId),
    /direct post file cleanup requires a resolved network outcome/
  );
  assert.equal(fs.existsSync(unresolvedPreparation.stagedPath), true);
});

// ---------------------------------------------------------------------------
// Test 11: structural inventory
// ---------------------------------------------------------------------------

test('attempts retain a known producer PID when optional identity capture fails', async t => {
  const f = fixture(t);
  fs.writeFileSync(f.textFile, 'capture unavailable');
  f.state.directPostOwnerIdentity = () => null;
  const result = await runDirectPost({ state: f.state, token: 'fixture', nativeId: f.nativeId,
    generation: 1, textFile: f.textFile, dedupeKey: 'known-pid-without-identity',
    fetchImpl: async () => response('uncertain', 500) });
  assert.equal(result.status, 'unknown');
  const row = f.state.directPostRows('known-pid-without-identity').find(item => item.kind === 'direct-post-attempt');
  assert.ok(row);
  assert.equal(row.detail.ownerPid, process.pid);
});

const PRESERVED_PROBES = new Map([
  ['state/intake.js\u0000processAlive', 'independent EPERM-hold sibling probe, deferred from this class fix'],
  ['claude/socket-ownership/lock-owner.ts\u0000isSocketLockOwnerAlive', 'socket lock-owner liveness, distinct lock domain'],
  ['cli/gateway-process.js\u0000gatewayProcessStatus', 'gateway runtime supervision'],
  ['cli/gateway-process.js\u0000waitForExit', 'gateway runtime exit wait'],
  ['cli/runtime-lifecycle.js\u0000stop', 'runtime shutdown'],
  ['cli/runtime-custody.js\u0000acquireHeldLock', 'generated lock guardian, distinct existing supervision domain'],
  ['state.js\u0000probePid', 'injected probe dependency feeding the typed process-owner classifier']
]);

function sourceFiles(root) {
  const found = [];
  const walk = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(?:js|ts)$/.test(entry.name)) found.push(full);
    }
  };
  walk(root);
  return found;
}

function enclosingOwner(node) {
  let current = node.parent;
  while (current) {
    if (ts.isFunctionDeclaration(current) && current.name) return current.name.text;
    if (ts.isMethodDeclaration(current) && current.name) return current.name.getText();
    if (ts.isPropertyAssignment(current) && current.name &&
      (ts.isFunctionExpression(current.initializer) || ts.isArrowFunction(current.initializer))) {
      return current.name.getText();
    }
    if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name) && current.initializer &&
      (ts.isFunctionExpression(current.initializer) || ts.isArrowFunction(current.initializer))) {
      return current.name.text;
    }
    if (ts.isClassDeclaration(current)) return null;
    current = current.parent;
  }
  return null;
}

function parseOwnerSites(fileName, text, generatedOwner = null) {
  const kind = fileName.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const virtualPath = path.resolve(fileName);
  const options = { noLib: true, noResolve: true, allowJs: true };
  const sourceFile = ts.createSourceFile(virtualPath, text, ts.ScriptTarget.Latest, true, kind);
  const host = ts.createCompilerHost(options);
  host.getSourceFile = name => path.resolve(name) === virtualPath ? sourceFile : undefined;
  const program = ts.createProgram([virtualPath], options, host);
  const checker = program.getTypeChecker();
  const kills = [];
  const legacyCalls = [];

  function staticValue(node, seen = new Set()) {
    if (!node || seen.has(node)) return null;
    seen = new Set(seen).add(node);
    if (ts.isParenthesizedExpression(node)) return staticValue(node.expression, seen);
    if (ts.isNumericLiteral(node)) return Number(node.text);
    if (ts.isStringLiteral(node)) return node.text;
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const name = ts.isPropertyAccessExpression(node) ? node.name.text : staticValue(node.argumentExpression, seen);
      if (name === 'directPostOwnerAlive') return 'legacy-owner';
      if (name === 'kill' && staticValue(node.expression, seen) === 'process-object') return 'pid-probe';
      return null;
    }
    if (!ts.isIdentifier(node)) return null;
    const symbol = checker.getSymbolAtLocation(node);
    const declaration = symbol && symbol.valueDeclaration;
    if (!declaration) return node.text === 'process' ? 'process-object'
      : node.text === 'directPostOwnerAlive' ? 'legacy-owner' : null;
    if (ts.isVariableDeclaration(declaration) &&
        (declaration.parent.flags & ts.NodeFlags.Const)) {
      return staticValue(declaration.initializer, seen);
    }
    if (ts.isBindingElement(declaration) && ts.isObjectBindingPattern(declaration.parent)) {
      const variable = declaration.parent.parent;
      if (!ts.isVariableDeclaration(variable) || !(variable.parent.flags & ts.NodeFlags.Const)) return null;
      const name = declaration.propertyName ? declaration.propertyName.getText(sourceFile) : declaration.name.getText(sourceFile);
      if (name === 'directPostOwnerAlive') return 'legacy-owner';
      if (name === 'kill' && staticValue(variable.initializer, seen) === 'process-object') return 'pid-probe';
    }
    return null;
  }

  const visit = node => {
    if (ts.isCallExpression(node)) {
      const callee = staticValue(node.expression);
      const owner = generatedOwner || enclosingOwner(node);
      if (callee === 'pid-probe' && node.arguments.length >= 2 && staticValue(node.arguments[1]) === 0) {
        kills.push({ file: fileName, owner });
      }
      if (callee === 'legacy-owner') legacyCalls.push({ file: fileName, owner });
    }
    if (!generatedOwner && ts.isStringLiteral(node) && node.text.includes('process.kill')) {
      const nested = parseOwnerSites(fileName, node.text, enclosingOwner(node));
      kills.push(...nested.kills);
      legacyCalls.push(...nested.legacyCalls);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { kills, legacyCalls };
}

function inventoryProcessOwnerSites(root) {
  const kills = [];
  const legacyCalls = [];
  const violations = [];
  for (const full of sourceFiles(root)) {
    const relative = path.relative(root, full).split(path.sep).join('/');
    const parsed = parseOwnerSites(relative, fs.readFileSync(full, 'utf8'));
    for (const site of parsed.kills) {
      const key = `${site.file}\u0000${site.owner}`;
      kills.push(key);
      if (!PRESERVED_PROBES.has(key)) violations.push(`unclassified process probe ${site.file}:${site.owner}`);
    }
    for (const site of parsed.legacyCalls) {
      legacyCalls.push(`${site.file}\u0000${site.owner}`);
      violations.push(`legacy directPostOwnerAlive callsite ${site.file}:${site.owner}`);
    }
  }
  return { kills, legacyCalls, violations };
}

test('structural inventory accounts for every PID probe and leaves no legacy destructive callsite', () => {
  const inventory = inventoryProcessOwnerSites(SRC_ROOT);
  assert.deepEqual(inventory.violations, [], `owner-evidence inventory violations:\n${inventory.violations.join('\n')}`);
  const expected = [
    'claude/socket-ownership/lock-owner.ts\u0000isSocketLockOwnerAlive',
    'cli/gateway-process.js\u0000gatewayProcessStatus',
    'cli/gateway-process.js\u0000waitForExit',
    'cli/runtime-lifecycle.js\u0000stop',
    'cli/runtime-custody.js\u0000acquireHeldLock',
    'state.js\u0000probePid',
    'state.js\u0000probePid',
    'state/intake.js\u0000processAlive'
  ].sort();
  assert.deepEqual([...inventory.kills].sort(), expected, 'every process.kill(pid,0) site must be explicitly inventoried');
  assert.deepEqual(inventory.legacyCalls, [], 'no production callsite may use the legacy boolean destructive path');
});

// ---------------------------------------------------------------------------
// Test 12: inventory red controls
// ---------------------------------------------------------------------------

test('inventory goes red for a new private PID probe and a legacy-false destructive copy', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-evidence-inventory-'));
  try {
    const emptyRoot = path.join(tmpRoot, 'clean');
    fs.mkdirSync(path.join(emptyRoot, 'src'), { recursive: true });
    fs.writeFileSync(path.join(emptyRoot, 'src', 'index.js'), "'use strict';\nmodule.exports = {};\n");
    assert.deepEqual(inventoryProcessOwnerSites(emptyRoot).violations, [], 'clean source must not false-positive');

    const probeRoot = path.join(tmpRoot, 'private-probe');
    fs.mkdirSync(path.join(probeRoot, 'src', 'state'), { recursive: true });
    fs.writeFileSync(path.join(probeRoot, 'src', 'state', 'new-probe.js'), [
      "'use strict';",
      'function privateOwnerProbe(pid) {',
      '  try { process.kill(pid, 0); } catch { return false; }',
      '  return true;',
      '}',
      'module.exports = { privateOwnerProbe };'
    ].join('\n'));
    assert.throws(
      () => {
        const found = inventoryProcessOwnerSites(probeRoot);
        if (found.violations.length > 0) throw new Error(found.violations.join('\n'));
        throw new Error('inventory unexpectedly accepted a new private PID probe');
      },
      /unclassified process probe src\/state\/new-probe.js:privateOwnerProbe/
    );

    const siblings = [
      "function newProbe(pid) { process['kill'](pid, 0); }",
      'const signal = 0; function newProbe(pid) { process.kill(pid, signal); }',
      'const probe = process.kill; function newProbe(pid) { probe(pid, 0); }',
      'const proc = process; function newProbe(pid) { proc.kill(pid, 0); }',
      'const {kill} = process; function newProbe(pid) { kill(pid, 0); }',
      "function newCleanup(state,pid,identity) { return state['directPostOwnerAlive'](pid,identity); }"
    ];
    for (const [index, code] of siblings.entries()) {
      const siblingRoot = path.join(tmpRoot, `sibling-${index}`);
      fs.mkdirSync(siblingRoot);
      fs.writeFileSync(path.join(siblingRoot, 'new-owner.js'), code);
      assert.equal(inventoryProcessOwnerSites(siblingRoot).violations.length, 1, code);
    }

    const legacyRoot = path.join(tmpRoot, 'legacy-cleanup');
    fs.mkdirSync(path.join(legacyRoot, 'src', 'state'), { recursive: true });
    fs.writeFileSync(path.join(legacyRoot, 'src', 'state', 'legacy-cleanup.js'), [
      "'use strict';",
      "const fs = require('node:fs');",
      'function legacyFalseCleanup(state, pid, identity, stagedPath) {',
      '  const alive = state.directPostOwnerAlive(pid, identity);',
      '  if (!alive) fs.unlinkSync(stagedPath);',
      '}',
      'module.exports = { legacyFalseCleanup };'
    ].join('\n'));
    assert.throws(
      () => {
        const found = inventoryProcessOwnerSites(legacyRoot);
        if (found.violations.length > 0) throw new Error(found.violations.join('\n'));
        throw new Error('inventory unexpectedly accepted a legacy boolean destructive copy');
      },
      /legacy directPostOwnerAlive callsite src\/state\/legacy-cleanup.js:legacyFalseCleanup/
    );
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
