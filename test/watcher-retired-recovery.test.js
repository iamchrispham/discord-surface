const test = require('node:test');
const assert = require('node:assert/strict');
const { recordNativeAcknowledgment } = require('../src/acknowledgment');
const { COURIER_OUTCOMES } = require('../src/state');
const { COURIER_NATIVE, fixture, humanMessage } = require('./courier-route-fixture');
const {
  attemptSuffix,
  beginPredecessor,
  consumerInput,
  createWatcherFixture,
  deadline,
  forwardClaims,
  forwardEvent,
  receiptCount,
  reopen,
  retireByPublicRecovery,
  retireByUncertainReconciliation,
  retirementReceipts,
  scenarioConsumer
} = require('./helpers/watcher-retired-recovery.cjs');

const TUNABLE = 'retired signed watcher resumes courier after uncertain not-submitted reconciliation';
const PUBLIC = 'retired signed watcher resumes courier after explicit public recovery';

function duplicateBegin(f, message) {
  return f.state.beginCourierAttempt(message.id, consumerInput(f, message));
}

function processToDispatch(consumer, message, signal) {
  return consumer.processAccepted(message, signal, { continueUntilFinal: false, awaitDispatchOutcome: true });
}

function uncertainWatcher(t, messageId, armKey, triggerKey) {
  const { f, message } = createWatcherFixture(t, { messageId, armKey, triggerKey });
  const { input, claim } = beginPredecessor(f, message);
  f.state.markUncertain(message.id, new Error('fixture uncertain queue outcome'));
  f.state.recordCourierOutcome(message.id, claim.attempt.attemptId, COURIER_OUTCOMES.UNCERTAIN);
  return { f, message, input, claim };
}

function refuseForwarding(f, message, prompt, claim, expected = /not eligible|not current|refused|changed after admission/) {
  assert.throws(() => f.state.claimCourierForward(f.route.routeId, forwardEvent(f, message, prompt)),
    expected, 'hook did not refuse');
  assert.throws(() => f.state.readCourierInput(f.route.routeId, message.id, claim.attempt.attemptId, COURIER_NATIVE, f.dir),
    expected, 'readonly input did not refuse');
  assert.equal(forwardClaims(f.state, message.id).length, 0, 'refusal wrote a forward claim');
}

async function runConsumer(f, messageId, signal) {
  const courier = [];
  const direct = [];
  const consumer = scenarioConsumer(f, { courier, direct });
  try {
    await processToDispatch(consumer, f.state.getMessage(messageId), signal);
  } finally {
    consumer.abortNativeWork();
    await consumer.waitForNativeWork();
  }
  return { courier, direct };
}

test(TUNABLE, { timeout: 5000 }, async t => {
  const { f, message } = createWatcherFixture(t);
  const { input, claim } = beginPredecessor(f, message);
  retireByUncertainReconciliation(f, message, claim);
  const retired = f.state.getCourierAttempt(message.id);
  assert.equal(retired.attempt.attemptId, claim.attempt.attemptId, 'predecessor attempt changed');
  assert.equal(f.state.hasRetiredCourierAttempt(message.id, retired.attempt.receiptId), true, 'predecessor was not durably retired');
  assert.equal(f.state.getMessage(message.id).state, 'accepted', 'accepted custody was not retained');

  const courier = [];
  const direct = [];
  const consumer = scenarioConsumer(f, { courier, direct });
  const { controller, expired, clear } = deadline();
  let successor;
  try {
    await Promise.race([
      processToDispatch(consumer, f.state.getMessage(message.id), controller.signal),
      expired
    ]);
    assert.equal(courier.length, 1, `courier dispatch count expected 1 received ${courier.length}`);
    assert.equal(direct.length, 0, `watcher fell back to direct dispatch ${direct.length} time(s)`);
    successor = f.state.getCourierAttempt(message.id);
    assert.notEqual(successor.attempt.attemptId, claim.attempt.attemptId, 'successor reused the predecessor identity');
    assert.equal(f.state.hasRetiredCourierAttempt(message.id, retired.attempt.receiptId), true, 'predecessor retirement was cleared');
    assert.equal(courier[0].prompt.startsWith(input.prompt), true, 'successor envelope dropped the original instruction prefix');
    assert.equal(courier[0].prompt, `${input.prompt}${attemptSuffix(successor.attempt.attemptId)}`, 'successor envelope prompt is not the anchored suffix form');

    const repeated = duplicateBegin(f, message);
    assert.equal(repeated.accepted, false, 'repeating admission minted another attempt');
    assert.equal(repeated.attempt.attemptId, successor.attempt.attemptId, 'repeating admission changed the successor identity');
  } finally {
    clear();
    controller.abort();
    consumer.abortNativeWork();
    await consumer.waitForNativeWork();
  }
  reopen(f);
  const restartedCourier = [];
  const restartedDirect = [];
  const restartedConsumer = scenarioConsumer(f, { courier: restartedCourier, direct: restartedDirect });
  const restartedDeadline = deadline();
  try {
    await Promise.race([
      processToDispatch(restartedConsumer, f.state.getMessage(message.id), restartedDeadline.controller.signal),
      restartedDeadline.expired
    ]);
    const afterWake = f.state.getCourierAttempt(message.id);
    assert.equal(afterWake.attempt.attemptId, successor.attempt.attemptId, 'restart wake minted a third attempt identity');
    assert.equal(restartedCourier.length, 0, 'restart wake duplicated courier dispatch');
    assert.equal(restartedDirect.length, 0, 'restart wake fell back to direct dispatch');
    const afterRestart = duplicateBegin(f, f.state.getMessage(message.id));
    assert.equal(afterRestart.attempt.attemptId, successor.attempt.attemptId, 'restart minted a third attempt identity');
  } finally {
    restartedDeadline.clear();
    restartedDeadline.controller.abort();
    restartedConsumer.abortNativeWork();
    await restartedConsumer.waitForNativeWork();
  }
});

test(PUBLIC, { timeout: 5000 }, async t => {
  const { f, message } = createWatcherFixture(t, {
    messageId: '9021',
    armKey: 'watcher-retired-public-arm',
    triggerKey: 'watcher-retired-public-trigger'
  });
  const { input, claim } = beginPredecessor(f, message);
  const recovered = retireByPublicRecovery(f, message, claim);
  const predecessorReceiptId = f.state.getCourierAttempt(message.id).attempt.receiptId;
  assert.equal(recovered.retired, true, 'public recovery did not retire the submitted attempt');
  assert.equal(f.state.hasRetiredCourierAttempt(message.id, f.state.getCourierAttempt(message.id).attempt.receiptId), true, 'retirement receipt is not durable');
  assert.equal(f.state.getMessage(message.id).state, 'accepted', 'accepted custody was not retained');

  const courier = [];
  const direct = [];
  const consumer = scenarioConsumer(f, { courier, direct });
  const { controller, expired, clear } = deadline();
  try {
    await Promise.race([
      processToDispatch(consumer, f.state.getMessage(message.id), controller.signal),
      expired
    ]);
    assert.equal(courier.length, 1, `courier dispatch count expected 1 received ${courier.length}`);
    assert.equal(direct.length, 0, `watcher fell back to direct dispatch ${direct.length} time(s)`);
    const successor = f.state.getCourierAttempt(message.id);
    assert.notEqual(successor.attempt.attemptId, claim.attempt.attemptId, 'successor reused the predecessor identity');
    assert.equal(f.state.hasRetiredCourierAttempt(message.id, predecessorReceiptId), true, 'predecessor retirement was cleared');
    assert.equal(courier[0].prompt.startsWith(input.prompt), true, 'successor envelope dropped the original instruction prefix');
    assert.equal(courier[0].prompt, `${input.prompt}${attemptSuffix(successor.attempt.attemptId)}`, 'successor envelope prompt is not the anchored suffix form');
  } finally {
    clear();
    controller.abort();
    consumer.abortNativeWork();
    await consumer.waitForNativeWork();
  }
});

test('retired predecessor input remains refused across disposable restart', { timeout: 5000 }, t => {
  const { controller, clear } = deadline();
  const { f, message } = createWatcherFixture(t, {
    messageId: '9022',
    armKey: 'watcher-retired-restart-arm',
    triggerKey: 'watcher-retired-restart-trigger'
  });
  const { input, claim } = beginPredecessor(f, message, { outcome: COURIER_OUTCOMES.SUBMITTED });
  f.state.markSubmitted(message.id);
  const recovered = f.state.recoverCourierAttempt(message.id, claim.attempt.attemptId);
  assert.equal(recovered.retired, true, 'public recovery did not retire the attempt');
  assert.equal(f.state.getMessage(message.id).state, 'accepted', 'recovery did not restore accepted custody');
  // Re-admit the retired message so forwarding is refused by the durable
  // retirement fence rather than by the restored accepted-custody guard.
  assert.equal(f.state.claimDispatch(message.id).claimed, true, 'retired message was not re-admitted');
  assert.equal(f.state.getMessage(message.id).state, 'dispatching');
  const event = forwardEvent(f, message, input.prompt);
  const receiptsBefore = receiptCount(f.state);
  try {
    for (const phase of ['before restart', 'after restart']) {
      if (phase === 'after restart') reopen(f);
      assert.throws(() => f.state.claimCourierForward(f.route.routeId, event),
        /courier queue submission was refused/, `${phase}: hook did not reach the retirement fence`);
      assert.throws(() => f.state.readCourierInput(f.route.routeId, message.id, claim.attempt.attemptId, COURIER_NATIVE, f.dir),
        /courier queue submission was refused/, `${phase}: readonly input did not reach the retirement fence`);
      assert.equal(forwardClaims(f.state, message.id).length, 0, `${phase}: forward claim count changed`);
      assert.equal(retirementReceipts(f.state, message.id).length, 1, `${phase}: retirement receipt count changed`);
      assert.equal(receiptCount(f.state), receiptsBefore, `${phase}: a refused hook wrote a receipt`);
    }
  } finally {
    clear();
    controller.abort();
  }
});

test('uncertain watcher without durable retirement remains ineligible for retry', { timeout: 5000 }, t => {
  const { controller, clear } = deadline();
  try {
    const base = uncertainWatcher(t, '9023', 'watcher-uncertain-arm', 'watcher-uncertain-trigger');
    const duplicate = duplicateBegin(base.f, base.message);
    assert.equal(duplicate.accepted, false, 'duplicate begin was accepted');
    assert.equal(duplicate.duplicate, true, 'duplicate begin did not report duplicate');
    assert.equal(duplicate.attempt.attemptId, base.claim.attempt.attemptId, 'duplicate begin changed the attempt identity');
    assert.throws(() => base.f.state.recoverCourierAttempt(base.message.id, base.claim.attempt.attemptId),
      /courier recovery refused: not_submitted/, 'uncertain attempt was retired');

    const staleRoute = uncertainWatcher(t, '9024', 'watcher-stale-route-arm', 'watcher-stale-route-trigger');
    staleRoute.f.state.revokeCourierRoute(staleRoute.f.route.routeId, 'fixture route paused');
    refuseForwarding(staleRoute.f, staleRoute.message, staleRoute.input.prompt, staleRoute.claim);

    const staleGeneration = uncertainWatcher(t, '9025', 'watcher-stale-generation-arm', 'watcher-stale-generation-trigger');
    const predecessor = staleGeneration.f.binding;
    const predecessorAttempt = staleGeneration.f.state.getCourierAttempt(staleGeneration.message.id);
    assert.equal(predecessorAttempt.attempt.parent.generation, predecessor.generation);
    staleGeneration.f.state.recordNativeReply({
      provider: 'codex',
      messageId: staleGeneration.message.id,
      nativeId: predecessor.nativeId,
      generation: predecessor.generation,
      text: 'fixture reply'
    });
    staleGeneration.f.state.beginReply(staleGeneration.message.id);
    staleGeneration.f.state.markReplySent(staleGeneration.message.id, 'fixture-reply');
    const rebound = staleGeneration.f.state.rebind({
      channelId: '1000',
      guildId: '100',
      provider: 'codex',
      nativeId: predecessor.nativeId,
      workspace: staleGeneration.f.dir,
      sessionRoot: staleGeneration.f.sessionRoot
    }, { intakeCutoff: '100' });
    assert.notEqual(rebound.generation, predecessor.generation, 'public rebind did not advance the generation');
    // The recovery owner checks current-binding generation before custody, so this
    // refusal is generation-driven. The forwarding hook cannot be generation-
    // discriminating here: public rebind refuses while work is active, so any
    // rebound message is already terminal and custody-refused first.
    assert.throws(() => staleGeneration.f.state.recoverCourierAttempt(staleGeneration.message.id, staleGeneration.claim.attempt.attemptId),
      /courier recovery refused: stale_binding/, 'stale generation did not reach the binding check');
    assert.equal(retirementReceipts(staleGeneration.f.state, staleGeneration.message.id).length, 0, 'stale generation gained a retirement receipt');
    refuseForwarding(staleGeneration.f, staleGeneration.message, staleGeneration.input.prompt, staleGeneration.claim);

    const acknowledged = uncertainWatcher(t, '9026', 'watcher-ack-arm', 'watcher-ack-trigger');
    recordNativeAcknowledgment(acknowledged.f.state, {
      provider: 'codex',
      messageId: acknowledged.message.id,
      nativeId: acknowledged.f.binding.nativeId,
      generation: acknowledged.f.binding.generation
    });
    assert.throws(() => acknowledged.f.state.recoverCourierAttempt(acknowledged.message.id, acknowledged.claim.attempt.attemptId),
      /courier recovery refused: native_acknowledged/, 'acknowledged attempt retired');
    assert.equal(retirementReceipts(acknowledged.f.state, acknowledged.message.id).length, 0, 'acknowledged attempt gained a retirement receipt');

    const claimed = uncertainWatcher(t, '9027', 'watcher-prior-claim-arm', 'watcher-prior-claim-trigger');
    const claimResult = claimed.f.state.claimCourierForward(claimed.f.route.routeId, forwardEvent(claimed.f, claimed.message, claimed.input.prompt));
    assert.equal(claimResult.attemptId, claimed.claim.attempt.attemptId, 'prior forward claim did not bind the uncertain attempt');
    assert.equal(forwardClaims(claimed.f.state, claimed.message.id).length, 1);
    assert.throws(() => claimed.f.state.recoverCourierAttempt(claimed.message.id, claimed.claim.attempt.attemptId),
      /courier recovery refused: forward_claimed/, 'forward-claimed attempt retired');
    assert.equal(retirementReceipts(claimed.f.state, claimed.message.id).length, 0, 'forward-claimed attempt gained a retirement receipt');
    assert.throws(() => claimed.f.state.readCourierInput(claimed.f.route.routeId, claimed.message.id, claimed.claim.attempt.attemptId, COURIER_NATIVE, claimed.f.dir),
      /already claimed/, 'readonly reader ignored the prior forward claim');
  } finally {
    clear();
    controller.abort();
  }
});

test('ordinary retired human and agent messages retain direct retry', { timeout: 5000 }, async t => {
  const { controller, clear } = deadline();
  try {
    for (const variant of ['human', 'agent']) {
      const humanRun = variant === 'human';
      const f = humanRun ? fixture(t, { includeInitialAgent: false }) : fixture(t, { includeInitialAgent: true });
      const subject = humanRun ? humanMessage(f, '9030', 'ordinary human instruction') : f.message;
      const { claim } = beginPredecessor(f, subject);
      retireByUncertainReconciliation(f, subject, claim);
      assert.equal(f.state.getMessage(subject.id).state, 'accepted', `${variant}: custody was not retained`);

      const { courier, direct } = await runConsumer(f, subject.id, controller.signal);
      assert.equal(courier.length, 0, `${variant}: ordinary retry used the courier queue`);
      assert.equal(direct.length, 1, `${variant}: direct dispatch count expected 1 received ${direct.length}`);
      assert.deepEqual(direct, [subject.id], `${variant}: direct dispatch changed the message identity`);
      assert.equal(f.state.getMessage(subject.id).state, 'accepted', `${variant}: custody was not retained`);
      assert.equal(f.state.getMessage(subject.id).content, subject.content, `${variant}: message content changed`);
      assert.equal(f.state.getMessage(subject.id).generation, subject.generation, `${variant}: message generation changed`);
    }
  } finally {
    clear();
    controller.abort();
  }
});

test('unanchored courier input preserves its exact forwarding prompt', { timeout: 5000 }, t => {
  const { controller, clear } = deadline();
  try {
    const { f, message } = createWatcherFixture(t, {
      messageId: '9028',
      armKey: 'watcher-unanchored-arm',
      triggerKey: 'watcher-unanchored-trigger'
    });
    const { input, claim } = beginPredecessor(f, message);
    const authorized = f.state.authorizeCourierAttempt(message.id, claim.attempt.attemptId, input);
    assert.equal(authorized.authorized, true, 'unanchored attempt did not authorize');
    assert.equal(claim.attempt.prompt, input.prompt, 'unanchored attempt did not persist the original prompt');
    assert.equal(f.state.getMessage(message.id).state, 'dispatching');

    const countBefore = receiptCount(f.state);
    const projected = f.state.readCourierInput(f.route.routeId, message.id, claim.attempt.attemptId, COURIER_NATIVE, f.dir);
    assert.equal(projected.prompt, input.prompt, 'readonly projection rewrote the unanchored prompt');
    assert.equal(projected.prompt.includes('discord-courier-delivery-attempt:'), false, 'unanchored prompt gained a successor marker');
    assert.equal(receiptCount(f.state), countBefore, 'readonly projection wrote a receipt');
  } finally {
    clear();
    controller.abort();
  }
});

test('two retirement paths for one predecessor permit one forwarding claim', { timeout: 5000 }, t => {
  const { f, message } = createWatcherFixture(t);
  const { input, claim } = beginPredecessor(f, message);
  retireByPublicRecovery(f, message, claim);
  assert.equal(f.state.claimDispatch(message.id).claimed, true);
  f.state.markUncertain(message.id, new Error('fixture repeated reconciliation'));
  f.state.reconcileUncertain(message.id, 'not_submitted');
  assert.equal(retirementReceipts(f.state, message.id).length, 2);
  assert.equal(f.state.claimDispatch(message.id).claimed, true);
  const successorInput = consumerInput(f, message);
  const successor = f.state.beginCourierAttempt(message.id, successorInput);
  assert.equal(successor.accepted, true);
  assert.equal(successor.attempt.predecessorAttemptId, claim.attempt.attemptId);
  assert.equal(duplicateBegin(f, message).attempt.attemptId, successor.attempt.attemptId);
  assert.equal(f.state.authorizeCourierAttempt(message.id, successor.attempt.attemptId, successorInput).authorized, true);
  const countBefore = receiptCount(f.state);
  const projected = f.state.readCourierInput(f.route.routeId, message.id, successor.attempt.attemptId, COURIER_NATIVE, f.dir);
  assert.equal(projected.prompt, `${input.prompt}${attemptSuffix(successor.attempt.attemptId)}`);
  assert.equal(receiptCount(f.state), countBefore);
  assert.throws(() => f.state.readCourierInput(f.route.routeId, message.id, claim.attempt.attemptId, COURIER_NATIVE, f.dir), /submission was refused/);
  assert.throws(() => f.state.claimCourierForward(f.route.routeId, forwardEvent(f, message, input.prompt)), /submission was refused/);
  const event = forwardEvent(f, message, projected.prompt);
  assert.equal(f.state.claimCourierForward(f.route.routeId, event).attemptId, successor.attempt.attemptId);
  assert.equal(forwardClaims(f.state, message.id).length, 1);
  assert.throws(() => f.state.claimCourierForward(f.route.routeId, event), /not eligible|already claimed/);
  assert.throws(() => f.state.readCourierInput(f.route.routeId, message.id, successor.attempt.attemptId, COURIER_NATIVE, f.dir), /not eligible|already claimed/);
  f.state.markSubmitted(message.id);
  f.state.recordCourierOutcome(message.id, successor.attempt.attemptId, COURIER_OUTCOMES.SUBMITTED);
  assert.throws(() => f.state.recoverCourierAttempt(message.id, successor.attempt.attemptId), /forward_claimed/);
  reopen(f);
  assert.throws(() => f.state.claimCourierForward(f.route.routeId, event), /not eligible|already claimed/);
  assert.equal(forwardClaims(f.state, message.id).length, 1);
});

test('a newly retired successor permits another attempt while uncertainty and restart do not', { timeout: 5000 }, t => {
  const { f, message } = createWatcherFixture(t);
  const { claim } = beginPredecessor(f, message);
  retireByPublicRecovery(f, message, claim);
  const second = duplicateBegin(f, message);
  assert.equal(second.accepted, true);
  assert.equal(f.state.claimDispatch(message.id).claimed, true);
  retireByPublicRecovery(f, message, second);
  const third = duplicateBegin(f, message);
  assert.equal(third.accepted, true);
  assert.equal(third.attempt.predecessorAttemptId, second.attempt.attemptId);
  assert.notEqual(third.attempt.attemptId, second.attempt.attemptId);
  assert.throws(() => f.state.recoverCourierAttempt(message.id, claim.attempt.attemptId), /stale_attempt/);
  assert.equal(f.state.claimDispatch(message.id).claimed, true);
  f.state.markUncertain(message.id, new Error('fixture successor unknown outcome'));
  f.state.recordCourierOutcome(message.id, third.attempt.attemptId, COURIER_OUTCOMES.UNCERTAIN);
  assert.equal(duplicateBegin(f, message).accepted, false);
  assert.equal(duplicateBegin(f, message).attempt.attemptId, third.attempt.attemptId);
  reopen(f);
  f.state.recoverAfterRestart();
  assert.equal(duplicateBegin(f, message).accepted, false);
  assert.equal(duplicateBegin(f, message).attempt.attemptId, third.attempt.attemptId);
  assert.equal(retirementReceipts(f.state, message.id).length, 2);
});

test('concurrent retired-notice wakes queue only one successor', { timeout: 5000 }, async t => {
  const { f, message } = createWatcherFixture(t);
  const { claim } = beginPredecessor(f, message);
  retireByPublicRecovery(f, message, claim);
  const courier = [];
  const direct = [];
  const consumer = scenarioConsumer(f, { courier, direct });
  const bound = deadline();
  try {
    await Promise.race([
      Promise.all(Array.from({ length: 4 }, () => consumer.processAccepted(
        f.state.getMessage(message.id), bound.controller.signal,
        { continueUntilFinal: false, awaitExisting: false, awaitDispatchOutcome: true }
      ))),
      bound.expired
    ]);
    assert.equal(courier.length, 1);
    assert.equal(direct.length, 0);
    assert.equal(f.state.getCourierAttempt(message.id).attempt.predecessorAttemptId, claim.attempt.attemptId);
  } finally {
    bound.clear();
    bound.controller.abort();
    consumer.abortNativeWork();
    await consumer.waitForNativeWork();
  }
});

test('successor admission preserves route and acknowledgment fences and refuses prompt overflow', { timeout: 5000 }, t => {
  const revoked = createWatcherFixture(t);
  const predecessor = beginPredecessor(revoked.f, revoked.message);
  retireByPublicRecovery(revoked.f, revoked.message, predecessor.claim);
  revoked.f.state.revokeCourierRoute(revoked.f.route.routeId, 'fixture route revoked');
  assert.equal(duplicateBegin(revoked.f, revoked.message).accepted, false);
  assert.equal(revoked.f.state.getCourierAttempt(revoked.message.id).attempt.attemptId, predecessor.claim.attempt.attemptId);

  const acknowledged = createWatcherFixture(t);
  const original = beginPredecessor(acknowledged.f, acknowledged.message);
  retireByPublicRecovery(acknowledged.f, acknowledged.message, original.claim);
  assert.equal(acknowledged.f.state.claimDispatch(acknowledged.message.id).claimed, true);
  recordNativeAcknowledgment(acknowledged.f.state, {
    provider: 'codex', messageId: acknowledged.message.id,
    nativeId: acknowledged.f.binding.nativeId, generation: acknowledged.f.binding.generation
  });
  assert.equal(duplicateBegin(acknowledged.f, acknowledged.message).accepted, false);
  assert.equal(acknowledged.f.state.getCourierAttempt(acknowledged.message.id).attempt.attemptId, original.claim.attempt.attemptId);

  const overflow = createWatcherFixture(t);
  const prior = beginPredecessor(overflow.f, overflow.message);
  retireByPublicRecovery(overflow.f, overflow.message, prior.claim);
  const before = receiptCount(overflow.f.state);
  assert.throws(() => overflow.f.state.beginCourierAttempt(overflow.message.id, {
    ...prior.input, prompt: 'x'.repeat(100000)
  }), /exceeds 100000/);
  assert.equal(receiptCount(overflow.f.state), before);
  assert.equal(overflow.f.state.getCourierAttempt(overflow.message.id).attempt.attemptId, prior.claim.attempt.attemptId);
});
