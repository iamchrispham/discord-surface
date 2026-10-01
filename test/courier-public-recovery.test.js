const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { recordNativeAcknowledgment } = require('../src/acknowledgment');
const { encodeAgentMessage } = require('../src/agent-message');
const { codexPrompt } = require('../src/native');
const { recoverCourier } = require('../src/cli');
const { persistGuardRefusal } = require('../src/courier-guard');
const { createSurfaceConsumer } = require('../src/discord');
const {
  COURIER_DELIVERY_STATUSES,
  COURIER_OUTCOMES,
  COURIER_RECEIPT_KINDS,
  COURIER_RECOVERY_REASONS,
  SurfaceState
} = require('../src/state');
const {
  PARENT_NATIVE,
  TOKEN,
  addSyntheticAttempt,
  createFixture,
  forwardEvent,
  markSubmitted,
  rowsFor,
  submitCourierAttempt
} = require('./helpers/courier-public-recovery.cjs');

const CLI = path.join(__dirname, '..', 'src', 'cli.js');
const RETIRED = COURIER_RECEIPT_KINDS.RECONCILED_NOT_SUBMITTED;

function stoppedGateway() {
  return { state: 'stopped', pid: null, connection: 'unavailable', capabilities: [] };
}

function recoveryReceipts(state, messageId) {
  return rowsFor(state,
    'SELECT * FROM receipts WHERE kind=? AND discord_id=? ORDER BY id', RETIRED, messageId);
}

function forwardClaims(state, messageId) {
  return rowsFor(state,
    'SELECT * FROM receipts WHERE kind=? AND discord_id=? ORDER BY id',
    COURIER_RECEIPT_KINDS.FORWARD_CLAIM, messageId);
}

async function turns(count = 200) {
  for (let i = 0; i < count; i += 1) await Promise.resolve();
}

function deferred() {
  let resolve;
  const promise = new Promise(settle => { resolve = settle; });
  return { promise, resolve };
}

function directConsumer(fixture, { dispatch = [], observe = [], courier = [] } = {}) {
  return createSurfaceConsumer({
    state: fixture.state,
    courierRoute: { routeId: fixture.route.routeId },
    providers: {
      codex: {
        async dispatchCourier(envelope) {
          courier.push(envelope.packet.id);
          return { status: COURIER_OUTCOMES.SUBMITTED };
        },
        async dispatch(message) {
          dispatch.push(message.id);
          return { status: COURIER_OUTCOMES.SUBMITTED };
        },
        async observe(message) {
          observe.push(message.id);
          return { text: `answer for ${message.id}` };
        }
      }
    },
    sendReply: async () => ({ id: 'reply' }),
    sendTransportReceipt: async () => ({ id: 'receipt' })
  });
}

test('eligible recovery retires the attempt and leaves every unrelated row byte-identical', t => {
  const f = createFixture(t);
  const claim = submitCourierAttempt(f);
  markSubmitted(f);
  const before = rowsFor(f.state, 'SELECT * FROM receipts ORDER BY id');
  const messageBefore = f.state.getMessage(f.messageId);
  const statusBefore = f.state.getCourierDeliveryStatus(f.messageId);

  assert.deepEqual(statusBefore, [{
    messageId: f.messageId,
    attemptId: claim.attempt.attemptId,
    status: COURIER_DELIVERY_STATUSES.QUEUED_UNFORWARDED,
    recoveryEligible: true,
    recoveryReason: COURIER_RECOVERY_REASONS.ELIGIBLE
  }]);

  const result = f.state.recoverCourierAttempt(f.messageId, claim.attempt.attemptId);

  assert.equal(result.retired, true);
  assert.equal(result.duplicate, false);
  assert.equal(result.attemptId, claim.attempt.attemptId);
  const messageAfter = result.message;
  assert.equal(messageAfter.state, 'accepted');
  assert.equal(messageAfter.error, null);
  assert.notEqual(messageAfter.updatedAt, messageBefore.updatedAt);
  assert.equal(messageAfter.content, messageBefore.content);
  assert.equal(messageAfter.createdAt, messageBefore.createdAt);
  assert.equal(messageAfter.deliveryChannelId, messageBefore.deliveryChannelId);
  assert.equal(messageAfter.generation, messageBefore.generation);
  assert.equal(messageAfter.nativeId, messageBefore.nativeId);
  assert.equal(messageAfter.provider, messageBefore.provider);

  const after = rowsFor(f.state, 'SELECT * FROM receipts ORDER BY id');
  assert.equal(after.length, before.length + 1);
  assert.deepEqual(after.slice(0, before.length), before, 'unrelated receipts changed');
  const receipt = after[after.length - 1];
  assert.equal(receipt.kind, RETIRED);
  assert.equal(receipt.discord_id, f.messageId);
  assert.deepEqual(JSON.parse(receipt.detail), {
    attemptId: claim.attempt.attemptId,
    route: { routeId: f.route.routeId, routeGeneration: 1 },
    generation: f.binding.generation,
    source: 'courier-recovery'
  });

  assert.deepEqual(f.state.getCourierDeliveryStatus(f.messageId), [{
    messageId: f.messageId,
    attemptId: claim.attempt.attemptId,
    status: COURIER_DELIVERY_STATUSES.RETIRED,
    recoveryEligible: false,
    recoveryReason: COURIER_RECOVERY_REASONS.RETIRED
  }]);
});

test('a repeat after the direct native path acknowledged the message stays a duplicate with no writes', async t => {
  const f = createFixture(t);
  const claim = submitCourierAttempt(f);
  markSubmitted(f);
  const first = f.state.recoverCourierAttempt(f.messageId, claim.attempt.attemptId);
  assert.equal(first.duplicate, false);

  const consumer = directConsumer(f);
  try {
    const settled = await consumer.processAccepted(f.state.getMessage(f.messageId));
    assert.equal(settled.message.state, 'replied');
    assert.equal(f.state.listReceipts().filter(row => row.kind === 'native-ack').length, 1);
  } finally {
    consumer.abortNativeWork();
    await consumer.waitForNativeWork();
  }

  const before = rowsFor(f.state, 'SELECT * FROM receipts ORDER BY id');
  const duplicate = f.state.recoverCourierAttempt(f.messageId, claim.attempt.attemptId);
  assert.equal(duplicate.retired, true);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.message.state, 'replied');
  assert.deepEqual(rowsFor(f.state, 'SELECT * FROM receipts ORDER BY id'), before, 'duplicate wrote receipts');
  assert.equal(recoveryReceipts(f.state, f.messageId).length, 1, 'duplicate wrote a second retirement receipt');
});

test('a newer attempt refuses the old attempt with stale_attempt and no writes', t => {
  const f = createFixture(t);
  const claim = submitCourierAttempt(f);
  markSubmitted(f);
  const newer = addSyntheticAttempt(f, { suffix: 'newer' });
  assert.notEqual(newer, claim.attempt.attemptId);
  const before = rowsFor(f.state, 'SELECT * FROM receipts ORDER BY id');

  assert.throws(
    () => f.state.recoverCourierAttempt(f.messageId, claim.attempt.attemptId),
    /courier recovery refused: stale_attempt/
  );
  assert.deepEqual(rowsFor(f.state, 'SELECT * FROM receipts ORDER BY id'), before);
  assert.equal(f.state.getMessage(f.messageId).state, 'submitted');
});

test('binding and owner changes refuse without writes', t => {
  const variants = [
    {
      name: 'generation advanced',
      reason: 'stale_binding',
      mutate(fixture) {
        fixture.state.db.prepare('UPDATE bindings SET generation=generation+1 WHERE channel_id=?').run('1000');
      }
    },
    {
      name: 'owner identity replaced on message and binding',
      reason: 'attempt_identity_mismatch',
      mutate(fixture) {
        const replacement = '99999999-9999-9999-9999-999999999999';
        fixture.state.db.prepare('UPDATE bindings SET native_id=? WHERE channel_id=?').run(replacement, '1000');
        fixture.state.db.prepare('UPDATE messages SET native_id=? WHERE discord_id=?').run(replacement, fixture.messageId);
      }
    }
  ];
  for (const variant of variants) {
    const f = createFixture(t);
    const claim = submitCourierAttempt(f);
    markSubmitted(f);
    variant.mutate(f);
    const before = rowsFor(f.state, 'SELECT * FROM receipts ORDER BY id');
    assert.throws(
      () => f.state.recoverCourierAttempt(f.messageId, claim.attempt.attemptId),
      new RegExp(`courier recovery refused: ${variant.reason}$`),
      variant.name
    );
    assert.deepEqual(rowsFor(f.state, 'SELECT * FROM receipts ORDER BY id'), before, variant.name);
    assert.equal(recoveryReceipts(f.state, f.messageId).length, 0, variant.name);
    assert.equal(f.state.getMessage(f.messageId).state, 'submitted', variant.name);
  }
});

test('an attempt envelope that no longer matches the message refuses without writes', t => {
  const f = createFixture(t);
  const claim = submitCourierAttempt(f);
  markSubmitted(f);
  const row = f.state.db.prepare(
    'SELECT detail FROM receipts WHERE kind=? AND discord_id=? ORDER BY id DESC LIMIT 1'
  ).get(COURIER_RECEIPT_KINDS.ATTEMPT, f.messageId);
  const detail = JSON.parse(row.detail);
  detail.parent.nativeId = '99999999-9999-9999-9999-999999999999';
  f.state.db.prepare('UPDATE receipts SET detail=? WHERE kind=? AND discord_id=?')
    .run(JSON.stringify(detail), COURIER_RECEIPT_KINDS.ATTEMPT, f.messageId);
  const before = rowsFor(f.state, 'SELECT * FROM receipts ORDER BY id');

  assert.throws(
    () => f.state.recoverCourierAttempt(f.messageId, claim.attempt.attemptId),
    /courier recovery refused: attempt_identity_mismatch/
  );
  assert.deepEqual(rowsFor(f.state, 'SELECT * FROM receipts ORDER BY id'), before);
  assert.equal(recoveryReceipts(f.state, f.messageId).length, 0);
});

test('a native acknowledgment observed before retirement refuses without writes', t => {
  const f = createFixture(t);
  const claim = submitCourierAttempt(f);
  markSubmitted(f);
  recordNativeAcknowledgment(f.state, {
    provider: 'codex',
    messageId: f.messageId,
    nativeId: PARENT_NATIVE,
    generation: f.binding.generation
  });
  const before = rowsFor(f.state, 'SELECT * FROM receipts ORDER BY id');

  assert.throws(
    () => f.state.recoverCourierAttempt(f.messageId, claim.attempt.attemptId),
    /courier recovery refused: native_acknowledged/
  );
  assert.deepEqual(rowsFor(f.state, 'SELECT * FROM receipts ORDER BY id'), before);
  assert.equal(f.state.getCourierDeliveryStatus(f.messageId)[0].status, COURIER_DELIVERY_STATUSES.NATIVE_ACKNOWLEDGED);
  assert.equal(f.state.getCourierDeliveryStatus(f.messageId)[0].recoveryEligible, false);
});

test('a current or older real forward claim refuses recovery', t => {
  for (const variant of ['current', 'older']) {
    const f = createFixture(t);
    const claim = submitCourierAttempt(f);
    markSubmitted(f);
    f.state.claimCourierForward(f.route.routeId, forwardEvent(f));
    let requested = claim.attempt.attemptId;
    if (variant === 'older') {
      // A forward claim on the older attempt still refuses retirement of the
      // newer attempt: native execution of the claimed attempt stays uncertain.
      requested = addSyntheticAttempt(f, { suffix: 'after-claim' });
    }
    const before = rowsFor(f.state, 'SELECT * FROM receipts ORDER BY id');

    assert.throws(
      () => f.state.recoverCourierAttempt(f.messageId, requested),
      /courier recovery refused: forward_claimed/,
      variant
    );
    assert.deepEqual(rowsFor(f.state, 'SELECT * FROM receipts ORDER BY id'), before, variant);
    assert.equal(recoveryReceipts(f.state, f.messageId).length, 0, variant);
  }
});

test('non-submitted, uncertain and outcome-less custody refuses retirement', t => {
  for (const outcome of [COURIER_OUTCOMES.NOT_SUBMITTED, COURIER_OUTCOMES.UNCERTAIN, null]) {
    const f = createFixture(t);
    const claim = submitCourierAttempt(f, { outcome });
    markSubmitted(f);
    const before = rowsFor(f.state, 'SELECT * FROM receipts ORDER BY id');

    assert.throws(
      () => f.state.recoverCourierAttempt(f.messageId, claim.attempt.attemptId),
      /courier recovery refused: not_submitted/,
      String(outcome)
    );
    assert.deepEqual(rowsFor(f.state, 'SELECT * FROM receipts ORDER BY id'), before, String(outcome));
    assert.equal(recoveryReceipts(f.state, f.messageId).length, 0, String(outcome));
  }
});

test('a late real forward claim after retirement is fenced with no claim receipt', t => {
  const f = createFixture(t);
  const claim = submitCourierAttempt(f);
  markSubmitted(f);
  recoverCourier(
    { 'state-dir': f.dir, db: f.dbPath, 'courier-message-id': f.messageId, 'courier-attempt-id': claim.attempt.attemptId },
    { gatewayProcessStatus: stoppedGateway, print() {} }
  );
  // The observer fix at baseline cancels the old observer, but a stale caller can
  // still advance the message back to a forward-eligible state. The retirement
  // receipt alone must keep the late claim refused.
  f.state.db.prepare('UPDATE messages SET state=? WHERE discord_id=?').run('submitted', f.messageId);

  assert.throws(
    () => f.state.claimCourierForward(f.route.routeId, forwardEvent(f)),
    /courier queue submission was refused/
  );
  assert.deepEqual(forwardClaims(f.state, f.messageId), []);
  assert.equal(recoveryReceipts(f.state, f.messageId).length, 1);
  assert.equal(f.state.getMessage(f.messageId).state, 'submitted');
});

test('a real forward claim winning first makes recovery refuse with no retirement receipt', t => {
  const f = createFixture(t);
  const claim = submitCourierAttempt(f);
  markSubmitted(f);
  const claimed = f.state.claimCourierForward(f.route.routeId, forwardEvent(f));
  assert.equal(claimed.attemptId, claim.attempt.attemptId);
  const before = rowsFor(f.state, 'SELECT * FROM receipts ORDER BY id');

  assert.throws(
    () => f.state.recoverCourierAttempt(f.messageId, claim.attempt.attemptId),
    /courier recovery refused: forward_claimed/
  );
  assert.deepEqual(rowsFor(f.state, 'SELECT * FROM receipts ORDER BY id'), before);
  assert.equal(recoveryReceipts(f.state, f.messageId).length, 0);
  assert.equal(f.state.getMessage(f.messageId).state, 'submitted');
});

test('status vocabulary and eligibility track real receipts without mutating anything', t => {
  const queued = createFixture(t);
  const queuedClaim = submitCourierAttempt(queued);
  markSubmitted(queued);
  const queuedBefore = rowsFor(queued.state, 'SELECT * FROM receipts ORDER BY id');
  assert.deepEqual(queued.state.getCourierDeliveryStatus(queued.messageId), [{
    messageId: queued.messageId,
    attemptId: queuedClaim.attempt.attemptId,
    status: COURIER_DELIVERY_STATUSES.QUEUED_UNFORWARDED,
    recoveryEligible: true,
    recoveryReason: COURIER_RECOVERY_REASONS.ELIGIBLE
  }]);
  assert.deepEqual(rowsFor(queued.state, 'SELECT * FROM receipts ORDER BY id'), queuedBefore);
  assert.equal(queued.state.getMessage(queued.messageId).state, 'submitted');

  const claimed = createFixture(t);
  const claimedClaim = submitCourierAttempt(claimed);
  markSubmitted(claimed);
  claimed.state.claimCourierForward(claimed.route.routeId, forwardEvent(claimed));
  assert.deepEqual(claimed.state.getCourierDeliveryStatus(claimed.messageId), [{
    messageId: claimed.messageId,
    attemptId: claimedClaim.attempt.attemptId,
    status: COURIER_DELIVERY_STATUSES.FORWARD_CLAIMED,
    recoveryEligible: false,
    recoveryReason: COURIER_RECOVERY_REASONS.FORWARD_CLAIMED
  }]);

  const retired = createFixture(t);
  const retiredClaim = submitCourierAttempt(retired);
  markSubmitted(retired);
  retired.state.recoverCourierAttempt(retired.messageId, retiredClaim.attempt.attemptId);
  const retiredBefore = rowsFor(retired.state, 'SELECT * FROM receipts ORDER BY id');
  assert.deepEqual(retired.state.getCourierDeliveryStatus(retired.messageId), [{
    messageId: retired.messageId,
    attemptId: retiredClaim.attempt.attemptId,
    status: COURIER_DELIVERY_STATUSES.RETIRED,
    recoveryEligible: false,
    recoveryReason: COURIER_RECOVERY_REASONS.RETIRED
  }]);
  assert.deepEqual(rowsFor(retired.state, 'SELECT * FROM receipts ORDER BY id'), retiredBefore);
});

test('stopped-Gateway recovery drives the real consumer retry once and holds the sibling until native acknowledgment', { timeout: 5000 }, async t => {
  const f = createFixture(t);
  const gates = [];
  const direct = [];
  const courier = [];
  const consumer = createSurfaceConsumer({
    state: f.state,
    courierRoute: { routeId: f.route.routeId },
    providers: {
      codex: {
        async dispatchCourier(envelope) {
          courier.push(envelope.packet.id);
          return { status: COURIER_OUTCOMES.SUBMITTED };
        },
        async dispatch(message) {
          direct.push(message.id);
          return { status: COURIER_OUTCOMES.SUBMITTED };
        },
        async observe(message, _outcome, options) {
          const gate = deferred();
          gates.push({ id: message.id, signal: options.signal });
          if (options.signal.aborted) gate.resolve({ stopped: true });
          else options.signal.addEventListener('abort', () => gate.resolve({ stopped: true }), { once: true });
          return gate.promise;
        }
      }
    },
    sendReply: async () => ({ id: 'reply' }),
    sendTransportReceipt: async () => ({ id: 'receipt' })
  });
  const started = [];
  try {
    started.push(consumer.processAccepted(f.state.getMessage(f.messageId)));
    await turns();
    const attempt = f.state.getCourierAttempt(f.messageId);
    const sibling = f.state.acceptDiscordMessage({
      id: '9002',
      guildId: '100',
      channelId: '2000',
      authorId: 'agent-bot',
      isBot: true,
      attachments: [],
      content: encodeAgentMessage({ ...f.packet, id: 'request-2' }, TOKEN)
    }, { ready: true, expectedBinding: f.binding, agentToken: TOKEN });
    assert.equal(sibling.accepted, true);
    started.push(consumer.processAccepted(f.state.getMessage('9002')));
    await turns();
    assert.deepEqual(courier, ['request-1'], 'sibling queued before retirement');
    assert.deepEqual(direct, []);

    const wake = recoverCourier(
      { 'state-dir': f.dir, db: f.dbPath, 'courier-message-id': f.messageId, 'courier-attempt-id': attempt.attempt.attemptId },
      { gatewayProcessStatus: stoppedGateway, print() {} }
    );
    assert.equal(wake.retired, true);
    assert.equal(wake.gatewayWake.requested, false, 'stopped Gateway should not be woken');
    assert.equal(wake.gatewayWake.reason, 'gateway-not-running');

    started.push(consumer.processAccepted(f.state.getMessage(f.messageId), undefined, {
      awaitExisting: false,
      continueUntilFinal: false
    }));
    await turns();
    assert.deepEqual(direct, ['9000'], 'retired message retried exactly once');
    assert.equal(gates[0].signal.aborted, true, 'retired observer was not cancelled');
    assert.deepEqual(courier, ['request-1'], 'sibling dispatched before the retried message was acknowledged');

    recordNativeAcknowledgment(f.state, {
      provider: 'codex',
      messageId: f.messageId,
      nativeId: PARENT_NATIVE,
      generation: f.binding.generation
    });
    consumer.releaseAcknowledged(f.messageId);
    await turns();
    assert.deepEqual(courier, ['request-1', 'request-2'], 'sibling was not released by native acknowledgment');
  } finally {
    consumer.abortNativeWork();
    await Promise.allSettled(started);
    await consumer.waitForNativeWork();
  }
});

test('a running compatible Gateway is woken with the expected pid and capability after durable retirement', t => {
  const f = createFixture(t);
  const claim = submitCourierAttempt(f);
  markSubmitted(f);
  const wakes = [];
  const result = recoverCourier(
    { 'state-dir': f.dir, db: f.dbPath, 'courier-message-id': f.messageId, 'courier-attempt-id': claim.attempt.attemptId },
    {
      gatewayProcessStatus: () => ({ state: 'running', pid: 4242, capabilities: ['courier-recovery-v1'] }),
      requestGatewayRecovery(paths, options) {
        // The retirement must already be durable and visible when the wake is issued.
        wakes.push({
          options,
          state: f.state.getMessage(f.messageId).state,
          receipts: recoveryReceipts(f.state, f.messageId).length
        });
        return { requested: true, pid: 4242, signal: 'SIGUSR2' };
      },
      print() {}
    }
  );

  assert.equal(result.retired, true);
  assert.equal(result.duplicate, false);
  assert.deepEqual(result.gatewayWake, { requested: true, pid: 4242, signal: 'SIGUSR2' });
  assert.equal(wakes.length, 1);
  assert.equal(wakes[0].options.expectedPid, 4242);
  assert.equal(wakes[0].options.requiredCapability, 'courier-recovery-v1');
  assert.equal(wakes[0].state, 'accepted');
  assert.equal(wakes[0].receipts, 1);
});

test('a running Gateway without the recovery capability refuses before any mutation', t => {
  const f = createFixture(t);
  const claim = submitCourierAttempt(f);
  markSubmitted(f);
  const before = rowsFor(f.state, 'SELECT * FROM receipts ORDER BY id');

  assert.throws(
    () => recoverCourier(
      { 'state-dir': f.dir, db: f.dbPath, 'courier-message-id': f.messageId, 'courier-attempt-id': claim.attempt.attemptId },
      {
        gatewayProcessStatus: () => ({ state: 'running', pid: 4242, capabilities: ['ordinary-bind-wake-v1'] }),
        requestGatewayRecovery() { throw new Error('must not be woken'); },
        print() {}
      }
    ),
    /^Error: running Gateway does not support courier recovery; stop or restart it before recovery$/
  );
  assert.deepEqual(rowsFor(f.state, 'SELECT * FROM receipts ORDER BY id'), before);
  assert.equal(f.state.getMessage(f.messageId).state, 'submitted');
  assert.equal(recoveryReceipts(f.state, f.messageId).length, 0);
});

test('unknown or malformed runtime status refuses before any mutation', t => {
  const runtimes = [
    null,
    { state: 'weird', pid: null, capabilities: [] },
    { state: 'running', pid: true, capabilities: [] },
    { state: 'running', pid: '4242', capabilities: [] },
    { state: 'running', pid: 4242, capabilities: 'courier-recovery-v1' },
    { state: 'running', pid: 4242, capabilities: ['courier-recovery-v1', 7] }
  ];
  for (const runtime of runtimes) {
    const f = createFixture(t);
    const claim = submitCourierAttempt(f);
    markSubmitted(f);
    const before = rowsFor(f.state, 'SELECT * FROM receipts ORDER BY id');
    assert.throws(
      () => recoverCourier(
        { 'state-dir': f.dir, db: f.dbPath, 'courier-message-id': f.messageId, 'courier-attempt-id': claim.attempt.attemptId },
        {
          gatewayProcessStatus: () => runtime,
          requestGatewayRecovery() { throw new Error('must not be woken'); },
          print() {}
        }
      ),
      /^Error: Gateway status is unknown; stop or restart it before courier recovery$/,
      JSON.stringify(runtime)
    );
    assert.deepEqual(rowsFor(f.state, 'SELECT * FROM receipts ORDER BY id'), before, JSON.stringify(runtime));
    assert.equal(f.state.getMessage(f.messageId).state, 'submitted', JSON.stringify(runtime));
  }
});

test('a failed or mismatched-pid wake leaves the accepted retirement committed', t => {
  const variants = [
    {
      name: 'wake signal fails',
      options: {
        requestGatewayRecovery: () => ({ requested: false, pid: 4242, reason: 'gateway-wake-failed', error: 'no such process' })
      }
    },
    {
      name: 'pid changed before the wake',
      options: {
        requestGatewayRecovery: (paths, wakeOptions) => require('../src/cli').requestGatewayRecovery(paths, {
          ...wakeOptions,
          status: () => ({ state: 'running', pid: 5150, capabilities: ['courier-recovery-v1'] })
        })
      }
    }
  ];
  for (const variant of variants) {
    const f = createFixture(t);
    const claim = submitCourierAttempt(f);
    markSubmitted(f);
    const result = recoverCourier(
      { 'state-dir': f.dir, db: f.dbPath, 'courier-message-id': f.messageId, 'courier-attempt-id': claim.attempt.attemptId },
      {
        gatewayProcessStatus: () => ({ state: 'running', pid: 4242, capabilities: ['courier-recovery-v1'] }),
        print() {},
        ...variant.options
      }
    );
    assert.equal(result.retired, true, variant.name);
    assert.equal(result.duplicate, false, variant.name);
    assert.equal(result.gatewayWake.requested, false, variant.name);
    assert.equal(recoveryReceipts(f.state, f.messageId).length, 1, variant.name);
    assert.equal(f.state.getMessage(f.messageId).state, 'accepted', variant.name);
  }
});

test('missing, boolean and mixed courier flag pairs are rejected before any database exists', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'courier-public-recovery-flags-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const db = path.join(dir, 'surface.sqlite');
  const invocations = [
    ['recover', '--state-dir', dir, '--db', db, '--courier-message-id', '9000'],
    ['recover', '--state-dir', dir, '--db', db, '--courier-attempt-id', 'attempt-1'],
    ['recover', '--state-dir', dir, '--db', db, '--courier-message-id=9000', '--courier-attempt-id'],
    ['recover', '--state-dir', dir, '--db', db, '--courier-message-id', '--courier-attempt-id=attempt-1'],
    ['recover', '--state-dir', dir, '--db', db, '--courier-message-id=9000', '--courier-attempt-id=attempt-1',
      '--message-id', '9000', '--resolution', 'reply_sent']
  ];
  for (const argv of invocations) {
    const result = spawnSync(process.execPath, [CLI, ...argv], { encoding: 'utf8' });
    assert.notEqual(result.status, 0, argv.join(' '));
    assert.equal(fs.existsSync(db), false, `database was created for ${argv.join(' ')}`);
    assert.match(result.stderr, /courier/, argv.join(' '));
  }
});

test('real CLI status output exposes courierDeliveries without changing persisted messages', t => {
  const f = createFixture(t);
  const claim = submitCourierAttempt(f);
  markSubmitted(f);
  const expectedDeliveries = f.state.getCourierDeliveryStatus(f.messageId);
  const messageBefore = f.state.getMessage(f.messageId);

  const result = spawnSync(process.execPath, [CLI, 'status', '--state-dir', f.dir, '--db', f.dbPath], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);

  assert.deepEqual(output.courierDeliveries, expectedDeliveries);
  assert.equal(output.courierDeliveries.length, 1);
  assert.equal(output.courierDeliveries[0].attemptId, claim.attempt.attemptId);
  assert.equal(output.courierDeliveries[0].status, COURIER_DELIVERY_STATUSES.QUEUED_UNFORWARDED);
  const projected = output.messages.find(message => message.id === f.messageId);
  assert.equal(projected.state, messageBefore.state);
  assert.equal(projected.content, messageBefore.content);
  assert.equal(projected.generation, messageBefore.generation);
  assert.equal(projected.deliveryChannelId, messageBefore.deliveryChannelId);
});

test('two independent connections produce exactly one retirement and one duplicate and never touch a sibling message', t => {
  const f = createFixture(t);
  const claim = submitCourierAttempt(f);
  markSubmitted(f);
  const other = f.state.acceptDiscordMessage({
    id: '9001',
    guildId: '100',
    channelId: '2000',
    authorId: 'agent-bot',
    isBot: true,
    attachments: [],
    content: encodeAgentMessage({ ...f.packet, id: 'request-3' }, TOKEN)
  }, { ready: true, expectedBinding: f.binding, agentToken: TOKEN });
  assert.equal(other.accepted, true);
  f.state.claimDispatch('9001');
  const otherClaim = f.state.beginCourierAttempt('9001', {
    routeId: f.route.routeId,
    prompt: codexPrompt(f.state.getMessage('9001'))
  });
  f.state.recordCourierOutcome('9001', otherClaim.attempt.attemptId, COURIER_OUTCOMES.SUBMITTED);
  f.state.markSubmitted('9001');

  const otherMessageBefore = f.state.getMessage('9001');
  const otherReceiptsBefore = rowsFor(f.state, 'SELECT * FROM receipts WHERE discord_id=? ORDER BY id', '9001');
  const second = new SurfaceState(f.dbPath);
  t.after(() => second.close());
  const first = f.state.recoverCourierAttempt(f.messageId, claim.attempt.attemptId);
  const duplicate = second.recoverCourierAttempt(f.messageId, claim.attempt.attemptId);

  assert.equal(first.retired, true);
  assert.equal(first.duplicate, false);
  assert.equal(duplicate.retired, true);
  assert.equal(duplicate.duplicate, true);
  assert.equal(recoveryReceipts(second, f.messageId).length, 1);
  assert.deepEqual(rowsFor(second, 'SELECT * FROM receipts WHERE discord_id=? ORDER BY id', '9001'), otherReceiptsBefore);
  assert.deepEqual(second.getMessage('9001'), otherMessageBefore);
  assert.equal(second.getCourierDeliveryStatus(f.messageId)[0].status, COURIER_DELIVERY_STATUSES.RETIRED);
  assert.deepEqual(second.getCourierDeliveryStatus('9001'), [{
    messageId: '9001',
    attemptId: otherClaim.attempt.attemptId,
    status: COURIER_DELIVERY_STATUSES.QUEUED_UNFORWARDED,
    recoveryEligible: true,
    recoveryReason: COURIER_RECOVERY_REASONS.ELIGIBLE
  }]);
});

test('eligibility never depends on elapsed time and idempotence never follows a newer attempt', t => {
  const f = createFixture(t);
  const claim = submitCourierAttempt(f);
  markSubmitted(f);
  // Backdate every persisted timestamp far into the past. A clock-based
  // implementation would treat this attempt as expired; the contract does not.
  f.state.transaction(() => {
    f.state.db.prepare('UPDATE receipts SET created_at=?').run('2000-01-01T00:00:00.000Z');
    f.state.db.prepare('UPDATE messages SET created_at=?, updated_at=?').run('2000-01-01T00:00:00.000Z', '2000-01-01T00:00:00.000Z');
  });
  const status = f.state.getCourierDeliveryStatus(f.messageId);
  assert.equal(status[0].recoveryEligible, true, 'old attempt was treated as ineligible');
  assert.equal(status[0].recoveryReason, COURIER_RECOVERY_REASONS.ELIGIBLE);

  const retired = f.state.recoverCourierAttempt(f.messageId, claim.attempt.attemptId);
  assert.equal(retired.retired, true);
  assert.equal(retired.duplicate, false);
  const repeat = f.state.recoverCourierAttempt(f.messageId, claim.attempt.attemptId);
  assert.equal(repeat.duplicate, true);
  assert.equal(repeat.retired, true);

  // Adding a newer attempt does not let the repeat report duplicate success for a
  // now-stale attempt, and never removes the newer attempt.
  const newer = addSyntheticAttempt(f, { suffix: 'later' });
  const before = rowsFor(f.state, 'SELECT * FROM receipts ORDER BY id');
  assert.throws(
    () => f.state.recoverCourierAttempt(f.messageId, claim.attempt.attemptId),
    /courier recovery refused: stale_attempt/
  );
  assert.deepEqual(rowsFor(f.state, 'SELECT * FROM receipts ORDER BY id'), before);
  assert.ok(f.state.getCourierAttempt(f.messageId).attempt.attemptId === newer);
});

test('issue196 confirmed guard refusal can retire once without rewriting custody history', { timeout: 5000, todo: 'issue196 guard-refused custody recovery' }, t => {
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

test('issue196 recovery permits exactly one fresh delivery after guard refusal', { timeout: 5000, todo: 'issue196 guard-refused custody recovery' }, async t => {
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
    const first = await consumer.processAccepted(f.state.getMessage(f.messageId));
    const second = await consumer.processAccepted(f.state.getMessage(f.messageId));

    assert.equal(courier.length, 1, 'guard-refused custody was delivered more than once');
    assert.equal(first.status, COURIER_OUTCOMES.SUBMITTED);
    assert.equal(dispatch.length, 0, 'duplicate host delivery occurred');
    assert.ok(second, 'second processing never settled');
  } finally {
    consumer.abortNativeWork();
    await consumer.waitForNativeWork();
  }
});
