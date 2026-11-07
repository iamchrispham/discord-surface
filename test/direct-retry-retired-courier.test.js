const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, humanMessage } = require('./courier-route-fixture');
const { COURIER_OUTCOMES, MESSAGE_STATES } = require('../src/state');
const { beginPredecessor, retireByPublicRecovery, retirementReceipts, reopen } = require('./helpers/watcher-retired-recovery.cjs');
const { recordNativeAcknowledgment } = require('../src/acknowledgment');

function directRetry(t, actor, oldOutcome) {
  const f = fixture(t, { includeInitialAgent: actor === 'agent' });
  const message = actor === 'agent' ? f.message : humanMessage(f, '9010', 'direct retry', [], '2000');
  const { claim } = beginPredecessor(f, message);
  if (oldOutcome === COURIER_OUTCOMES.SUBMITTED) {
    assert.equal(retireByPublicRecovery(f, message, claim).retired, true);
  } else {
    f.state.recordCourierOutcome(message.id, claim.attempt.attemptId, oldOutcome);
    f.state.markUncertain(message.id, new Error('predecessor stopped before delivery'));
    f.state.reconcileUncertain(message.id, 'not_submitted');
  }
  const attempt = f.state.getCourierAttempt(message.id);
  assert.equal(f.state.hasRetiredCourierAttempt(message.id, attempt.attempt.receiptId), true);
  assert.equal(f.state.getMessage(message.id).state, MESSAGE_STATES.ACCEPTED);
  assert.equal(f.state.claimDispatch(message.id).claimed, true);
  return { f, message, attempt };
}

for (const actor of ['human', 'agent']) {
  for (const outcome of [COURIER_OUTCOMES.SUBMITTED, COURIER_OUTCOMES.NOT_SUBMITTED]) {
    test(`${actor} interrupted direct retry ignores retired ${outcome} outcome`, t => {
      const { f, message, attempt } = directRetry(t, actor, outcome);
      const retirement = retirementReceipts(f.state, message.id);
      reopen(f).recoverAfterRestart();
      assert.equal(f.state.getMessage(message.id).state, MESSAGE_STATES.UNCERTAIN);
      assert.equal(f.state.recoveryCandidates().some(row => row.id === message.id), false);
      assert.equal(f.state.claimDispatch(message.id).claimed, false);
      reopen(f).recoverAfterRestart();
      assert.equal(f.state.getMessage(message.id).state, MESSAGE_STATES.UNCERTAIN);
      assert.deepEqual(f.state.getCourierAttempt(message.id), attempt);
      assert.deepEqual(retirementReceipts(f.state, message.id), retirement);
      f.state.reconcileUncertain(message.id, 'not_submitted');
      assert.equal(f.state.getMessage(message.id).state, MESSAGE_STATES.ACCEPTED);
      assert.equal(f.state.recoveryCandidates().some(row => row.id === message.id), true);
    });

    test(`${actor} uncertain direct retry stays held after retired ${outcome} outcome`, t => {
      const { f, message } = directRetry(t, actor, outcome);
      f.state.markUncertain(message.id, new Error('direct submission outcome unknown'));
      reopen(f).recoverAfterRestart();
      reopen(f).recoverAfterRestart();
      assert.equal(f.state.getMessage(message.id).state, MESSAGE_STATES.UNCERTAIN);
      assert.equal(f.state.recoveryCandidates().some(row => row.id === message.id), false);
      assert.equal(f.state.claimDispatch(message.id).claimed, false);
    });

    test(`${actor} acknowledged direct retry stays submitted after retired ${outcome} outcome`, t => {
      const { f, message } = directRetry(t, actor, outcome);
      recordNativeAcknowledgment(f.state, {
        messageId: message.id,
        provider: message.provider,
        nativeId: message.nativeId,
        generation: message.generation
      });
      assert.equal(f.state.getMessage(message.id).state, MESSAGE_STATES.SUBMITTED);
      reopen(f).recoverAfterRestart();
      reopen(f).recoverAfterRestart();
      assert.equal(f.state.getMessage(message.id).state, MESSAGE_STATES.SUBMITTED);
      assert.equal(f.state.hasNativeAcknowledgment(f.state.getMessage(message.id)), true);
      assert.equal(f.state.claimDispatch(message.id).claimed, false);
      assert.throws(() => f.state.reconcileUncertain(message.id, 'not_submitted'), /native acknowledgment prevents retrying delivery/);
    });

    test(`${actor} active courier ${outcome} outcome retains restart behavior`, t => {
      const f = fixture(t, { includeInitialAgent: actor === 'agent' });
      const message = actor === 'agent' ? f.message : humanMessage(f, '9010', 'current courier', [], '2000');
      beginPredecessor(f, message, { outcome });
      const attempt = f.state.getCourierAttempt(message.id);
      assert.equal(f.state.hasRetiredCourierAttempt(message.id, attempt.attempt.receiptId), false);
      reopen(f).recoverAfterRestart();
      const expected = outcome === COURIER_OUTCOMES.SUBMITTED ? MESSAGE_STATES.SUBMITTED : MESSAGE_STATES.ACCEPTED;
      assert.equal(f.state.getMessage(message.id).state, expected);
      assert.equal(f.state.recoveryCandidates().some(row => row.id === message.id), true);
    });
  }
}
