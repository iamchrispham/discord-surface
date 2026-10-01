const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { encodeAgentMessage, KINDS } = require('../src/agent-message');
const { acknowledgmentCommand } = require('../src/acknowledgment');
const { agentCompletionCommand, codexPrompt, readInitialCursor, CodexProvider } = require('../src/native');
const { parseArgs, resolveCourierRoute, start } = require('../src/cli');
const {
  COURIER_OUTCOMES,
  COURIER_SOURCE_KINDS,
  MESSAGE_STATES,
  SurfaceState,
  THREAD_STATES
} = require('../src/state');
const { createSurfaceConsumer } = require('../src/discord');
const { persistGuardRefusal } = require('../src/courier-guard');
const { TOKEN, PARENT_NATIVE, SOURCE_NATIVE, COURIER_NATIVE, RECIPIENT_THREAD, WRONG_RECIPIENT_THREAD, fixture, humanMessage, interactionMessage, materializedDecisionMessage, parentPrompt, preparedInput, consumerFor } = require('./courier-route-fixture');
test('restarted claimed courier custody becomes uncertain without resend', async t => {
  const f = fixture(t);
  assert.equal(f.state.claimDispatch(f.message.id).claimed, true);
  const claimed = f.state.beginCourierAttempt(f.message.id, preparedInput(f, f.message));
  assert.equal(claimed.accepted, true);
  f.state.close();
  const reopened = new SurfaceState(f.dbPath);
  f.replaceState(reopened);
  const recovery = reopened.recoverAfterRestart();
  assert.equal(recovery.courierAttempts, 1);
  assert.equal(reopened.getMessage(f.message.id).state, MESSAGE_STATES.UNCERTAIN);
  const courierCalls = [];
  const result = await consumerFor(f, { courierCalls }).processAccepted(reopened.getMessage(f.message.id));
  assert.equal(result.status, MESSAGE_STATES.UNCERTAIN);
  assert.equal(courierCalls.length, 0);
});

test('resumed courier refusal blocks later owner work with or without route selection', async t => {
  for (const selected of [true, false]) {
    const f = fixture(t);
    const later = humanMessage(f, selected ? '9007' : '9008', 'later parent work');
    assert.equal(f.state.claimDispatch(f.message.id).claimed, true);
    const claimed = f.state.beginCourierAttempt(f.message.id, preparedInput(f, f.message));
    assert.equal(claimed.accepted, true);
    f.state.recordCourierOutcome(f.message.id, claimed.attempt.attemptId, COURIER_OUTCOMES.SUBMITTED);
    f.state.markSubmitted(f.message.id);
    if (!selected) f.state.revokeCourierRoute(f.route.routeId, 'route paused during restart');

    let release;
    let started;
    const observed = new Promise(resolve => { started = resolve; });
    const parentCalls = [];
    const consumer = consumerFor(f, {
      courierRoute: selected ? f.route : null,
      parentCalls,
      observe: async message => {
        assert.equal(message.id, f.message.id);
        started();
        return new Promise(resolve => { release = resolve; });
      }
    });
    const resumed = consumer.resumeSubmitted(f.state.getMessage(f.message.id));
    await observed;
    const queued = consumer.processAccepted(later);
    const prompt = preparedInput(f, f.message).prompt;
    const refused = persistGuardRefusal(f.state, f.route.routeId, {
      session_id: COURIER_NATIVE,
      cwd: f.dir,
      tool_input: { threadId: RECIPIENT_THREAD, hostId: 'host-local', prompt }
    }, 'courier forwarding authorization held');
    assert.equal(refused, true);
    release({ text: 'late after refusal' });
    await resumed;
    assert.equal(f.state.getMessage(f.message.id).state, MESSAGE_STATES.ACCEPTED);
    assert.equal(f.state.getMessage(later.id).state, MESSAGE_STATES.ACCEPTED);
    assert.deepEqual(parentCalls, []);
    consumer.abortNativeWork();
    await queued;
  }
});

test('held accepted courier custody does not fall back to the parent provider', async t => {
  const f = fixture(t);
  assert.equal(f.state.claimDispatch(f.message.id).claimed, true);
  const claimed = f.state.beginCourierAttempt(f.message.id, preparedInput(f, f.message));
  assert.equal(claimed.accepted, true);
  f.state.recordCourierOutcome(f.message.id, claimed.attempt.attemptId, COURIER_OUTCOMES.SUBMITTED);
  f.state.markSubmitted(f.message.id);
  assert.equal(persistGuardRefusal(f.state, f.route.routeId, {
    session_id: COURIER_NATIVE,
    cwd: f.dir,
    tool_input: { threadId: RECIPIENT_THREAD, hostId: 'host-local', prompt: preparedInput(f, f.message).prompt }
  }, 'courier forwarding authorization held'), true);

  const courierCalls = [];
  const parentCalls = [];
  const result = await consumerFor(f, { courierRoute: null, courierCalls, parentCalls })
    .processAccepted(f.state.getMessage(f.message.id));
  assert.equal(result.status, COURIER_OUTCOMES.NOT_SUBMITTED);
  assert.equal(f.state.getMessage(f.message.id).state, MESSAGE_STATES.ACCEPTED);
  assert.deepEqual(courierCalls, []);
  assert.deepEqual(parentCalls, []);
});

test('revoked selected route returns to accepted without parent fallback', async t => {
  const f = fixture(t);
  f.state.revokeCourierRoute(f.route.routeId, 'route paused');
  const courierCalls = [];
  const parentCalls = [];
  const result = await consumerFor(f, { courierCalls, parentCalls }).processAccepted(f.message);

  assert.equal(result.status, COURIER_OUTCOMES.NOT_SUBMITTED);
  assert.equal(f.state.getMessage(f.message.id).state, MESSAGE_STATES.ACCEPTED);
  assert.equal(courierCalls.length, 0);
  assert.equal(parentCalls.length, 0);
  assert.equal(f.state.listReceipts().some(row => row.kind === 'courier-rejection'), true);
});

test('route revoked after queue result preserves parent observation', async t => {
  const f = fixture(t);
  const courierCalls = [];
  const parentCalls = [];
  const replies = [];
  const result = await consumerFor(f, {
    courierCalls,
    parentCalls,
    replies,
    dispatchCourier: async () => {
      f.state.revokeCourierRoute(f.route.routeId, 'revoked during queue call');
      return { status: COURIER_OUTCOMES.SUBMITTED };
    }
  }).processAccepted(f.message);

  assert.equal(result.message.state, MESSAGE_STATES.REPLIED);
  assert.equal(f.state.getMessage(f.message.id).state, MESSAGE_STATES.REPLIED);
  assert.equal(f.state.getCourierAttempt(f.message.id).outcome.outcome, COURIER_OUTCOMES.SUBMITTED);
  assert.equal(courierCalls.length, 1);
  assert.equal(parentCalls.length, 0);
  assert.deepEqual(replies, [{ messageId: f.message.id, channelId: '2000', content: `answer for ${f.message.id}` }]);
  assert.equal(f.state.listReceipts().filter(row => row.kind === 'native-ack').length, 1);
});

test('guard refusal wins over a later queue return without observing or replaying', async t => {
  for (const returned of [COURIER_OUTCOMES.SUBMITTED, COURIER_OUTCOMES.UNCERTAIN]) {
    const f = fixture(t);
    const courierCalls = [];
    const parentCalls = [];
    const replies = [];
    let observations = 0;
    const consumer = consumerFor(f, {
      courierCalls, parentCalls, replies,
      dispatchCourier: async envelope => {
        f.state.markThreadBoundary('2000', THREAD_STATES.GAP, 'changed before forwarding', null, null, f.binding);
        const result = spawnSync(process.execPath, [path.resolve(__dirname, '../src/cli.js'),
          'courier-guard', '--db', f.dbPath, '--courier-route-id', f.route.routeId], {
          input: JSON.stringify({ session_id: COURIER_NATIVE, cwd: f.dir,
            transcript_path: path.join(f.route.courier.sessionRoot, 'courier.jsonl'),
            hook_event_name: 'PreToolUse', tool_name: 'mcp__codex_app__send_message_to_thread',
            tool_input: { threadId: RECIPIENT_THREAD, hostId: 'host-local', prompt: envelope.prompt } }),
          encoding: 'utf8', timeout: 5000
        });
        assert.equal(result.status, 2, result.stderr);
        return { status: returned };
      },
      observe: async () => { observations++; return null; }
    });
    const result = await consumer.processAccepted(f.message);
    assert.equal(result.status, COURIER_OUTCOMES.NOT_SUBMITTED);
    assert.equal(f.state.getMessage(f.message.id).state, MESSAGE_STATES.ACCEPTED);
    assert.equal(f.state.getCourierAttempt(f.message.id).outcome.outcome, COURIER_OUTCOMES.NOT_SUBMITTED);
    f.state.markThreadBoundary('2000', THREAD_STATES.READY, 'recovered', null, null, f.binding);
    await consumer.processAccepted(f.state.getMessage(f.message.id));
    assert.equal(courierCalls.length, 1);
    assert.equal(observations, 0);
    assert.equal(parentCalls.length, 0);
    assert.equal(replies.length, 0);
  }
});

test('recovered definite non-submission retains custody without resend', async t => {
  const f = fixture(t);
  const courierCalls = [];
  const parentCalls = [];
  const replies = [];
  const dispatchCourier = async () => ({ status: COURIER_OUTCOMES.NOT_SUBMITTED, error: new Error('courier unavailable') });

  const consumer = consumerFor(f, { courierCalls, parentCalls, replies, dispatchCourier });
  const first = await consumer.processAccepted(f.message);
  assert.equal(first.status, COURIER_OUTCOMES.NOT_SUBMITTED);
  assert.equal(f.state.getMessage(f.message.id).state, MESSAGE_STATES.ACCEPTED);

  f.state.close();
  const reopened = new SurfaceState(f.dbPath);
  f.replaceState(reopened);
  const recoveredConsumer = consumerFor(f, { courierCalls, parentCalls, replies, dispatchCourier });
  const recovered = await recoveredConsumer.handleStoredMessage(reopened.getMessage(f.message.id), new AbortController().signal);
  await recoveredConsumer.waitForReceipts();

  assert.equal(recovered.status, COURIER_OUTCOMES.NOT_SUBMITTED);
  assert.equal(reopened.getMessage(f.message.id).state, MESSAGE_STATES.ACCEPTED);
  assert.equal(courierCalls.length, 1);
  assert.equal(reopened.listReceipts().filter(row => row.kind === 'courier-attempt').length, 1);
  assert.equal(reopened.getCourierAttempt(f.message.id).outcome.outcome, COURIER_OUTCOMES.NOT_SUBMITTED);
  assert.equal(parentCalls.length, 0);
  assert.equal(replies.length, 0);
});

test('restart preserves a durable submitted courier outcome for observation', t => {
  const f = fixture(t);
  assert.equal(f.state.claimDispatch(f.message.id).claimed, true);
  const claimed = f.state.beginCourierAttempt(f.message.id, preparedInput(f, f.message));
  assert.equal(claimed.accepted, true);
  f.state.recordCourierOutcome(f.message.id, claimed.attempt.attemptId, COURIER_OUTCOMES.SUBMITTED);

  f.state.close();
  const reopened = new SurfaceState(f.dbPath);
  f.replaceState(reopened);
  const recovery = reopened.recoverAfterRestart();

  assert.equal(recovery.courierAttempts, 0);
  assert.equal(reopened.getMessage(f.message.id).state, MESSAGE_STATES.SUBMITTED);
  assert.deepEqual(reopened.recoveryCandidates().map(message => message.id), [f.message.id]);
  assert.equal(reopened.getCourierAttempt(f.message.id).outcome.outcome, COURIER_OUTCOMES.SUBMITTED);
});

test('restart restores a durable not-submitted courier outcome to retryable custody', t => {
  const f = fixture(t);
  assert.equal(f.state.claimDispatch(f.message.id).claimed, true);
  const claimed = f.state.beginCourierAttempt(f.message.id, preparedInput(f, f.message));
  assert.equal(claimed.accepted, true);
  f.state.recordCourierOutcome(f.message.id, claimed.attempt.attemptId, COURIER_OUTCOMES.NOT_SUBMITTED);

  f.state.close();
  const reopened = new SurfaceState(f.dbPath);
  f.replaceState(reopened);
  reopened.recoverAfterRestart();

  assert.equal(reopened.getMessage(f.message.id).state, MESSAGE_STATES.ACCEPTED);
  assert.deepEqual(reopened.recoveryCandidates().map(message => message.id), [f.message.id]);
  assert.equal(reopened.getCourierAttempt(f.message.id).outcome.outcome, COURIER_OUTCOMES.NOT_SUBMITTED);
});

test('courier outcome detail cannot override authoritative receipt fields', t => {
  const f = fixture(t);
  const claimed = f.state.beginCourierAttempt(f.message.id, preparedInput(f, f.message));
  const attemptId = claimed.attempt.attemptId;
  const result = f.state.recordCourierOutcome(f.message.id, attemptId, COURIER_OUTCOMES.SUBMITTED, {
    attemptId: 'spoofed-attempt',
    outcome: COURIER_OUTCOMES.NOT_SUBMITTED,
    note: 'caller metadata'
  });

  assert.equal(result.outcome.attemptId, attemptId);
  assert.equal(result.outcome.outcome, COURIER_OUTCOMES.SUBMITTED);
  const receipt = f.state.listReceipts().find(row => row.kind === 'courier-outcome');
  const receiptDetail = JSON.parse(receipt.detail);
  assert.equal(receiptDetail.attemptId, attemptId);
  assert.equal(receiptDetail.outcome, COURIER_OUTCOMES.SUBMITTED);
  assert.equal(receiptDetail.note, 'caller metadata');
});
