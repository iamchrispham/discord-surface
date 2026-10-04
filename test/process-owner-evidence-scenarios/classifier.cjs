'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  OWNER_EVIDENCE,
  classifyProcessOwner,
  normalizeOwnerEvidence
} = require('../../src/state/process-owner-evidence');
const { probeError, probeDeps, FAKE_PID } = require('./fixtures.cjs');

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
