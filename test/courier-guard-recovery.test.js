const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { persistGuardRefusal } = require('../src/courier-guard');
const {
  COURIER_DELIVERY_STATUSES,
  COURIER_OUTCOMES,
  COURIER_RECEIPT_KINDS,
  COURIER_RECOVERY_REASONS
} = require('../src/state');
const {
  PARENT_NATIVE,
  addSyntheticAttempt,
  createFixture,
  directConsumer,
  forwardEvent,
  markSubmitted,
  rowsFor,
  submitCourierAttempt
} = require('./helpers/courier-public-recovery.cjs');

const RETIRED = COURIER_RECEIPT_KINDS.RECONCILED_NOT_SUBMITTED;
const GUARD_REASON = 'courier forwarding authorization held';
const MARKER = 'courier guard refused before host call';
const REPLACEMENT_NATIVE = '99999999-9999-9999-9999-999999999999';

function recoveryReceipts(state, messageId) {
  return rowsFor(state,
    'SELECT * FROM receipts WHERE kind=? AND discord_id=? ORDER BY id', RETIRED, messageId);
}

function forwardClaims(state, messageId) {
  return rowsFor(state,
    'SELECT * FROM receipts WHERE kind=? AND discord_id=? ORDER BY id',
    COURIER_RECEIPT_KINDS.FORWARD_CLAIM, messageId);
}

function attemptReceiptDetail(state, messageId) {
  const row = state.db.prepare(
    'SELECT detail FROM receipts WHERE kind=? AND discord_id=? ORDER BY id DESC LIMIT 1'
  ).get(COURIER_RECEIPT_KINDS.ATTEMPT, messageId);
  return JSON.parse(row.detail);
}

// A queue-admitted attempt that durably proves a pre-host guard refusal: the
// producer resets custody to accepted and persists the stable marker outcome.
function refuseAtGuard(fixture, reason = GUARD_REASON) {
  const claim = submitCourierAttempt(fixture);
  markSubmitted(fixture);
  const refused = persistGuardRefusal(
    fixture.state,
    fixture.route.routeId,
    forwardEvent(fixture),
    reason
  );
  assert.equal(refused, true, `${reason}: guard refusal was not persisted`);
  assert.equal(fixture.state.getMessage(fixture.messageId).state, 'accepted');
  const outcome = fixture.state.getCourierAttempt(fixture.messageId).outcome;
  assert.equal(outcome.outcome, COURIER_OUTCOMES.NOT_SUBMITTED);
  assert.equal(outcome.reason, MARKER);
  return claim;
}

function expectRefusedRecovery(fixture, attemptId, reason, label) {
  assert.throws(
    () => fixture.state.recoverCourierAttempt(fixture.messageId, attemptId),
    new RegExp(`courier recovery refused: ${reason}$`),
    label
  );
}

test('issue196 confirmed guard refusal can retire once without rewriting custody history', { timeout: 5000 }, t => {
  const f = createFixture(t);
  const claim = submitCourierAttempt(f);
  markSubmitted(f);

  const refused = persistGuardRefusal(
    f.state,
    f.route.routeId,
    forwardEvent(f),
    'courier forwarding authorization held'
  );

  assert.equal(refused, true);
  assert.equal(f.state.getMessage(f.messageId).state, 'accepted');
  assert.equal(f.state.getCourierAttempt(f.messageId).outcome.outcome, COURIER_OUTCOMES.NOT_SUBMITTED);
  assert.equal(f.state.hasNativeAcknowledgment(f.state.getMessage(f.messageId)), false);

  const before = rowsFor(f.state, 'SELECT * FROM receipts ORDER BY id');
  const result = f.state.recoverCourierAttempt(f.messageId, claim.attempt.attemptId);

  assert.equal(result.retired, true);
  assert.equal(result.duplicate, false);
  assert.equal(result.message.state, 'accepted');

  const after = rowsFor(f.state, 'SELECT * FROM receipts ORDER BY id');
  assert.equal(recoveryReceipts(f.state, f.messageId).length, 1);
  assert.equal(after.length, before.length + 1);
  assert.deepEqual(after.slice(0, before.length), before, 'custody history was rewritten');

  const repeat = f.state.recoverCourierAttempt(f.messageId, claim.attempt.attemptId);
  assert.equal(repeat.duplicate, true);
  assert.deepEqual(rowsFor(f.state, 'SELECT * FROM receipts ORDER BY id'), after, 'repeat wrote receipts');
});

test('issue196 recovery permits exactly one fresh delivery after guard refusal', { timeout: 5000 }, async t => {
  const f = createFixture(t);
  const claim = submitCourierAttempt(f);
  markSubmitted(f);

  const refused = persistGuardRefusal(
    f.state,
    f.route.routeId,
    forwardEvent(f),
    'courier forwarding authorization held'
  );

  assert.equal(refused, true);
  assert.equal(f.state.getMessage(f.messageId).state, 'accepted');

  const retired = f.state.recoverCourierAttempt(f.messageId, claim.attempt.attemptId);
  assert.equal(retired.retired, true);
  assert.equal(retired.duplicate, false);
  assert.equal(retired.message.state, 'accepted');

  const courier = [];
  const dispatch = [];
  const consumer = directConsumer(f, { courier, dispatch });
  try {
    await consumer.processAccepted(f.state.getMessage(f.messageId));
    assert.deepEqual(dispatch, [f.messageId]);
    assert.deepEqual(courier, []);

    await consumer.processAccepted(f.state.getMessage(f.messageId));
    assert.deepEqual(dispatch, [f.messageId], 'repeat processing dispatched twice');
    assert.deepEqual(courier, []);
  } finally {
    consumer.abortNativeWork();
    await consumer.waitForNativeWork();
  }
});

test('confirmed guard refusal projects eligible without changing receipts', t => {
  const facade = require('../src/state/courier-route');
  assert.equal(facade.COURIER_OUTCOME_REASONS.GUARD_REFUSED_BEFORE_HOST_CALL, MARKER,
    'persisted guard-refusal marker bytes changed');

  const f = createFixture(t);
  const claim = refuseAtGuard(f);
  const before = rowsFor(f.state, 'SELECT * FROM receipts ORDER BY id');
  const messageBefore = f.state.getMessage(f.messageId);

  assert.deepEqual(f.state.getCourierDeliveryStatus(f.messageId), [{
    messageId: f.messageId,
    attemptId: claim.attempt.attemptId,
    status: COURIER_DELIVERY_STATUSES.GUARD_REFUSED,
    recoveryEligible: true,
    recoveryReason: COURIER_RECOVERY_REASONS.ELIGIBLE
  }]);

  assert.deepEqual(rowsFor(f.state, 'SELECT * FROM receipts ORDER BY id'), before,
    'status projection wrote receipts');
  assert.deepEqual(f.state.getMessage(f.messageId), messageBefore, 'status projection changed custody');

  const result = f.state.recoverCourierAttempt(f.messageId, claim.attempt.attemptId);
  assert.equal(result.retired, true);
  assert.equal(result.duplicate, false);
  assert.equal(result.message.state, 'accepted');
  assert.equal(result.message.error, null);

  const after = rowsFor(f.state, 'SELECT * FROM receipts ORDER BY id');
  assert.equal(after.length, before.length + 1, 'retirement did not append exactly one receipt');
  assert.deepEqual(after.slice(0, before.length), before, 'retirement rewrote custody history');
  assert.equal(recoveryReceipts(f.state, f.messageId).length, 1);
  assert.equal(after[after.length - 1].kind, RETIRED);
  assert.equal(JSON.parse(after[after.length - 1].detail).attemptId, claim.attempt.attemptId);

  const repeat = f.state.recoverCourierAttempt(f.messageId, claim.attempt.attemptId);
  assert.equal(repeat.duplicate, true);
  assert.deepEqual(rowsFor(f.state, 'SELECT * FROM receipts ORDER BY id'), after, 'repeat wrote receipts');
});

test('incomplete or unqualified guard outcomes remain refused', t => {
  const variants = [
    {
      name: 'missing marker',
      custody: 'accepted',
      prepare(f, claim) {
        f.state.recordCourierOutcome(f.messageId, claim.attempt.attemptId, COURIER_OUTCOMES.NOT_SUBMITTED, {
          guardReason: GUARD_REASON
        });
      }
    },
    {
      name: 'wrong marker',
      custody: 'accepted',
      prepare(f, claim) {
        f.state.recordCourierOutcome(f.messageId, claim.attempt.attemptId, COURIER_OUTCOMES.NOT_SUBMITTED, {
          reason: 'courier guard refused after host call',
          guardReason: GUARD_REASON
        });
      }
    },
    {
      name: 'missing guardReason',
      custody: 'accepted',
      prepare(f, claim) {
        f.state.recordCourierOutcome(f.messageId, claim.attempt.attemptId, COURIER_OUTCOMES.NOT_SUBMITTED, {
          reason: MARKER
        });
      }
    },
    {
      name: 'invalid guardReason',
      custody: 'accepted',
      prepare(f, claim) {
        f.state.recordCourierOutcome(f.messageId, claim.attempt.attemptId, COURIER_OUTCOMES.NOT_SUBMITTED, {
          reason: MARKER,
          guardReason: 'courier hook event is invalid'
        });
      }
    },
    {
      name: 'generic NOT_SUBMITTED',
      custody: 'accepted',
      prepare(f, claim) {
        f.state.recordCourierOutcome(f.messageId, claim.attempt.attemptId, COURIER_OUTCOMES.NOT_SUBMITTED, {
          reason: 'courier dispatch stopped before queue submission'
        });
      }
    },
    { name: 'unknown/no outcome', prepare() {} },
    {
      name: 'nonaccepted guard evidence',
      prepare(f) {
        const refused = persistGuardRefusal(f.state, f.route.routeId, forwardEvent(f), GUARD_REASON);
        assert.equal(refused, true);
        f.state.db.prepare('UPDATE messages SET state=? WHERE discord_id=?').run('submitted', f.messageId);
      }
    }
  ];

  for (const variant of variants) {
    const f = createFixture(t);
    const claim = submitCourierAttempt(f, { outcome: null });
    markSubmitted(f);
    variant.prepare(f, claim);
    // Unqualified guard evidence still means accepted custody: the producer only
    // resets to accepted on a real refusal, so an accepted message carrying a
    // marker-less NOT_SUBMITTED outcome must stay a refusal.
    if (variant.custody === 'accepted') {
      f.state.db.prepare('UPDATE messages SET state=? WHERE discord_id=?').run('accepted', f.messageId);
    }
    assert.equal(f.state.getMessage(f.messageId).state, variant.custody || 'submitted', variant.name);

    const before = rowsFor(f.state, 'SELECT * FROM receipts ORDER BY id');
    const projected = f.state.getCourierDeliveryStatus(f.messageId);
    assert.equal(projected[0].recoveryEligible, false, variant.name);
    assert.equal(projected[0].recoveryReason, COURIER_RECOVERY_REASONS.NOT_SUBMITTED, variant.name);
    assert.equal(projected[0].status, COURIER_DELIVERY_STATUSES.NOT_APPLICABLE, variant.name);

    expectRefusedRecovery(f, claim.attempt.attemptId, 'not_submitted', variant.name);
    assert.deepEqual(rowsFor(f.state, 'SELECT * FROM receipts ORDER BY id'), before, variant.name);
    assert.equal(recoveryReceipts(f.state, f.messageId).length, 0, variant.name);
  }
});

test('guard refusal refuses stale binding and attempt identity', t => {
  const variants = [
    {
      name: 'changed binding generation',
      reason: 'stale_binding',
      mutate(f) {
        f.state.db.prepare('UPDATE bindings SET generation=generation+1 WHERE channel_id=?').run('1000');
      }
    },
    {
      name: 'attempt parent identity',
      reason: 'attempt_identity_mismatch',
      mutate(f) {
        const detail = attemptReceiptDetail(f.state, f.messageId);
        detail.parent.nativeId = REPLACEMENT_NATIVE;
        f.state.db.prepare('UPDATE receipts SET detail=? WHERE kind=? AND discord_id=?')
          .run(JSON.stringify(detail), COURIER_RECEIPT_KINDS.ATTEMPT, f.messageId);
      }
    },
    {
      name: 'delivery channel',
      reason: 'stale_binding',
      mutate(f) {
        const detail = attemptReceiptDetail(f.state, f.messageId);
        detail.deliveryChannelId = '9999';
        f.state.db.prepare('UPDATE receipts SET detail=? WHERE kind=? AND discord_id=?')
          .run(JSON.stringify(detail), COURIER_RECEIPT_KINDS.ATTEMPT, f.messageId);
      }
    }
  ];

  for (const variant of variants) {
    const f = createFixture(t);
    const claim = refuseAtGuard(f);
    variant.mutate(f);

    const before = rowsFor(f.state, 'SELECT * FROM receipts ORDER BY id');
    const projected = f.state.getCourierDeliveryStatus(f.messageId);
    assert.equal(projected[0].recoveryEligible, false, variant.name);
    assert.equal(projected[0].recoveryReason, variant.reason, variant.name);
    assert.equal(projected[0].status, COURIER_DELIVERY_STATUSES.GUARD_REFUSED, variant.name);

    expectRefusedRecovery(f, claim.attempt.attemptId, variant.reason, variant.name);
    assert.deepEqual(rowsFor(f.state, 'SELECT * FROM receipts ORDER BY id'), before, variant.name);
    assert.equal(recoveryReceipts(f.state, f.messageId).length, 0, variant.name);
    assert.equal(f.state.getMessage(f.messageId).state, 'accepted', variant.name);
  }
});

test('guard refusal refuses a newer attempt without writes', t => {
  const f = createFixture(t);
  const claim = refuseAtGuard(f);
  const newer = addSyntheticAttempt(f, { suffix: 'newer' });
  assert.notEqual(newer, claim.attempt.attemptId);

  const before = rowsFor(f.state, 'SELECT * FROM receipts ORDER BY id');
  const projected = f.state.getCourierDeliveryStatus(f.messageId);
  const older = projected.find(row => row.attemptId === claim.attempt.attemptId);
  assert.equal(older.recoveryEligible, false);
  assert.equal(older.recoveryReason, COURIER_RECOVERY_REASONS.STALE_ATTEMPT);

  expectRefusedRecovery(f, claim.attempt.attemptId, 'stale_attempt', 'superseded guard refusal');
  assert.deepEqual(rowsFor(f.state, 'SELECT * FROM receipts ORDER BY id'), before);
  assert.equal(recoveryReceipts(f.state, f.messageId).length, 0);
  assert.equal(f.state.getMessage(f.messageId).state, 'accepted');
  assert.equal(f.state.getCourierAttempt(f.messageId).attempt.attemptId, newer);
});

test('guard refusal refuses native acknowledgment without writes', t => {
  const f = createFixture(t);
  const claim = refuseAtGuard(f);
  // The guard producer refuses to persist a refusal once a native
  // acknowledgment exists, so this evidence order is only reachable through a
  // legacy/direct native-ack receipt. Persist the same identity shape the
  // acknowledgment owner writes and prove the recovery fence still refuses.
  f.state.receipt(f.messageId, 'native-ack', {
    provider: 'codex',
    nativeId: PARENT_NATIVE,
    generation: f.binding.generation,
    source: 'explicit-native-ack'
  });
  assert.equal(f.state.hasNativeAcknowledgment(f.state.getMessage(f.messageId)), true);

  const before = rowsFor(f.state, 'SELECT * FROM receipts ORDER BY id');
  const projected = f.state.getCourierDeliveryStatus(f.messageId);
  assert.equal(projected[0].recoveryEligible, false);
  assert.equal(projected[0].recoveryReason, COURIER_RECOVERY_REASONS.NATIVE_ACKNOWLEDGED);
  assert.equal(projected[0].status, COURIER_DELIVERY_STATUSES.NATIVE_ACKNOWLEDGED);

  expectRefusedRecovery(f, claim.attempt.attemptId, 'native_acknowledged', 'acknowledged guard refusal');
  assert.deepEqual(rowsFor(f.state, 'SELECT * FROM receipts ORDER BY id'), before);
  assert.equal(recoveryReceipts(f.state, f.messageId).length, 0);
});

test('guard refusal refuses any forwarding claim without writes', t => {
  const older = createFixture(t);
  const olderClaim = refuseAtGuard(older);
  const newer = addSyntheticAttempt(older, { suffix: 'after-claim' });
  older.state.receipt(older.messageId, COURIER_RECEIPT_KINDS.FORWARD_CLAIM, {
    attemptId: olderClaim.attempt.attemptId,
    routeId: older.route.routeId
  });
  const olderBefore = rowsFor(older.state, 'SELECT * FROM receipts ORDER BY id');
  const olderProjected = older.state.getCourierDeliveryStatus(older.messageId);
  const olderNewerRow = olderProjected.find(row => row.attemptId === newer);
  assert.equal(olderNewerRow.recoveryEligible, false);
  assert.equal(olderNewerRow.recoveryReason, COURIER_RECOVERY_REASONS.FORWARD_CLAIMED);
  expectRefusedRecovery(older, newer, 'forward_claimed', 'older attempt forward claim');
  assert.deepEqual(rowsFor(older.state, 'SELECT * FROM receipts ORDER BY id'), olderBefore, 'older claim');
  assert.equal(recoveryReceipts(older.state, older.messageId).length, 0, 'older claim');
  assert.equal(forwardClaims(older.state, older.messageId).length, 1, 'older claim persisted');
  assert.equal(older.state.getMessage(older.messageId).state, 'accepted', 'older claim');

  const same = createFixture(t);
  const sameClaim = refuseAtGuard(same);
  same.state.receipt(same.messageId, COURIER_RECEIPT_KINDS.FORWARD_CLAIM, {
    attemptId: sameClaim.attempt.attemptId,
    routeId: same.route.routeId
  });
  const sameBefore = rowsFor(same.state, 'SELECT * FROM receipts ORDER BY id');
  const sameProjected = same.state.getCourierDeliveryStatus(same.messageId);
  assert.equal(sameProjected[0].recoveryEligible, false, 'same attempt claim');
  assert.equal(sameProjected[0].recoveryReason, COURIER_RECOVERY_REASONS.FORWARD_CLAIMED, 'same attempt claim');
  assert.equal(sameProjected[0].status, COURIER_DELIVERY_STATUSES.FORWARD_CLAIMED, 'same attempt claim');
  expectRefusedRecovery(same, sameClaim.attempt.attemptId, 'forward_claimed', 'same attempt claim');
  assert.deepEqual(rowsFor(same.state, 'SELECT * FROM receipts ORDER BY id'), sameBefore, 'same claim');
  assert.equal(recoveryReceipts(same.state, same.messageId).length, 0, 'same claim');
  assert.equal(forwardClaims(same.state, same.messageId).length, 1, 'same claim persisted');
  assert.equal(same.state.getMessage(same.messageId).state, 'accepted', 'same claim');
});

test('guard refusal recovery survives restart and rolls back failed retirement', { timeout: 5000 }, t => {
  const f = createFixture(t);
  const claim = refuseAtGuard(f);
  const first = f.state.recoverCourierAttempt(f.messageId, claim.attempt.attemptId);
  assert.equal(first.retired, true);
  assert.equal(first.duplicate, false);
  assert.equal(first.message.state, 'accepted');
  const after = rowsFor(f.state, 'SELECT * FROM receipts ORDER BY id');

  f.reopen();
  assert.equal(f.state.getMessage(f.messageId).state, 'accepted');
  assert.equal(f.state.getCourierAttempt(f.messageId).outcome.reason, MARKER);
  const repeat = f.state.recoverCourierAttempt(f.messageId, claim.attempt.attemptId);
  assert.equal(repeat.retired, true);
  assert.equal(repeat.duplicate, true);
  assert.equal(recoveryReceipts(f.state, f.messageId).length, 1);
  assert.deepEqual(rowsFor(f.state, 'SELECT * FROM receipts ORDER BY id'), after,
    'restart repeat wrote receipts');

  const rollback = createFixture(t);
  const rollbackClaim = refuseAtGuard(rollback);
  const receiptsBefore = rowsFor(rollback.state, 'SELECT * FROM receipts ORDER BY id');
  const messageBefore = rollback.state.getMessage(rollback.messageId);
  const originalReceipt = rollback.state.receipt;
  rollback.state.receipt = () => { throw new Error('simulated retirement receipt failure'); };
  try {
    assert.throws(
      () => rollback.state.recoverCourierAttempt(rollback.messageId, rollbackClaim.attempt.attemptId),
      /simulated retirement receipt failure/
    );
  } finally {
    rollback.state.receipt = originalReceipt;
  }
  assert.equal(recoveryReceipts(rollback.state, rollback.messageId).length, 0, 'rollback wrote retirement');
  assert.deepEqual(rowsFor(rollback.state, 'SELECT * FROM receipts ORDER BY id'), receiptsBefore,
    'rollback wrote receipts');
  assert.deepEqual(rollback.state.getMessage(rollback.messageId), messageBefore,
    'rollback changed accepted custody');
  assert.equal(rollback.state.getMessage(rollback.messageId).state, 'accepted');
});

test('guard refusal eligibility has one shared evidence owner', t => {
  const sourceRoot = path.join(__dirname, '..', 'src');
  const recoverySource = fs.readFileSync(
    path.join(sourceRoot, 'state', 'courier-route', 'recovery.ts'), 'utf8');
  const guardRefusalSource = fs.readFileSync(
    path.join(sourceRoot, 'state', 'courier-route', 'guard-refusal.ts'), 'utf8');
  const guardSource = fs.readFileSync(path.join(sourceRoot, 'courier-guard.js'), 'utf8');

  const markerOwners = fs.readdirSync(sourceRoot, { recursive: true })
    .filter(file => /\.(?:js|ts)$/.test(file))
    .filter(file => /COURIER_OUTCOME_REASONS\.GUARD_REFUSED_BEFORE_HOST_CALL|['"]courier guard refused before host call['"]/.test(
      fs.readFileSync(path.join(sourceRoot, file), 'utf8')))
    .sort();
  assert.deepEqual(markerOwners, [
    'courier-guard.js',
    'state/courier-route/constants.ts',
    'state/courier-route/guard-refusal.ts',
  ], 'new private guard evidence owner must use the shared classifier');

  const mutationStart = recoverySource.indexOf('export function recoverCourierAttempt');
  const projectionStart = recoverySource.indexOf('export function getCourierDeliveryStatus');
  const projectedStart = recoverySource.indexOf('function projectedStatus');
  const refusalStart = recoverySource.indexOf('function refusal(');
  assert.ok(mutationStart > 0 && projectionStart > mutationStart, 'recovery consumers are missing');
  assert.ok(projectedStart > 0 && refusalStart > projectedStart, 'projectedStatus is missing');
  const mutationBody = recoverySource.slice(mutationStart, projectionStart);
  const projectionBody = recoverySource.slice(projectionStart);
  const projectedBody = recoverySource.slice(projectedStart, refusalStart);

  assert.equal((recoverySource.match(/recoveryReason\(/g) || []).length, 3,
    'expected one recoveryReason definition and exactly two consumers');
  assert.match(mutationBody, /recoveryReason\(deps, state, message, latest, attemptId\)/,
    'mutation must call the shared recoveryReason owner');
  assert.match(projectionBody, /recoveryReason\(deps, state, message, attempt,/,
    'projection must call the shared recoveryReason owner');

  assert.doesNotMatch(mutationBody, /isConfirmedCourierGuardRefusal/,
    'mutation duplicated the guard-evidence check');
  assert.doesNotMatch(mutationBody, /COURIER_OUTCOMES\.SUBMITTED/,
    'mutation duplicated the submitted-outcome check');

  assert.match(projectedBody, /isConfirmedCourierGuardRefusal\(attempt\.outcome\)/,
    'projectedStatus must use the shared guard-evidence classifier');
  assert.equal((recoverySource.match(/isConfirmedCourierGuardRefusal\(/g) || []).length, 2,
    'guard evidence must be classified once per decision site, never duplicated inline');

  assert.match(recoverySource, /import \{ isConfirmedCourierGuardRefusal \} from '\.\/guard-refusal'/,
    'recovery does not import the shared classifier');
  assert.match(guardRefusalSource, /export function isCourierGuardRefusalReason/);
  assert.match(guardRefusalSource, /export function isConfirmedCourierGuardRefusal/);
  assert.match(guardSource, /isCourierGuardRefusalReason/,
    'guard producer does not import the shared classifier');
  assert.match(guardSource, /COURIER_OUTCOME_REASONS\.GUARD_REFUSED_BEFORE_HOST_CALL/,
    'guard producer does not use the shared marker constant');
  assert.doesNotMatch(guardSource, /reason !== 'courier hook caller or route is not current'/,
    'guard producer kept a copied reason list');

  const facade = require('../src/state/courier-route');
  assert.equal(facade.COURIER_OUTCOME_REASONS.GUARD_REFUSED_BEFORE_HOST_CALL, MARKER);
  assert.equal(facade.COURIER_DELIVERY_STATUSES.GUARD_REFUSED, 'guard_refused');
  assert.equal(typeof facade.isCourierGuardRefusalReason, 'function');
  assert.equal(typeof facade.isConfirmedCourierGuardRefusal, 'function');
});
