'use strict';

// Disposable scenario builder for the Issue267 signed-watcher retirement suite.
// It composes the existing courier-route fixture and the real public watcher,
// courier and consumer facades. No socket, live database, Gateway or credential
// is opened here.

const assert = require('node:assert/strict');
const path = require('node:path');
const { SurfaceState, COURIER_OUTCOMES, COURIER_RECEIPT_KINDS } = require('../../src/state');
const { createWatcherNotice, encodeWatcherNotice } = require('../../src/watcher-notice');
const { acknowledgmentCommand } = require('../../src/acknowledgment');
const { agentCompletionCommand, codexPrompt, readInitialCursor, watcherNoticeCompletionCommand } = require('../../src/native');
const { createSurfaceConsumer } = require('../../src/discord');
const {
  COURIER_NATIVE,
  PARENT_NATIVE,
  RECIPIENT_THREAD,
  TOKEN,
  fixture,
  humanMessage
} = require('../courier-route-fixture');

// The F1 transport marker: appended only to an anchored successor prompt.
function attemptSuffix(attemptId) {
  return `\n\n[discord-courier-delivery-attempt:${attemptId}]`;
}

// Mirrors src/discord/surface-consumer.js dispatchAtCourierBoundary input
// construction, including the explicit stateDir the consumer is given.
function consumerInput(f, message, stateDir = f.dir) {
  const binding = f.state.currentMessageBinding(message)?.binding;
  const observerCursor = readInitialCursor(message.nativeId, binding?.sessionRoot || undefined);
  const completion = message.watcherNotice
    ? watcherNoticeCompletionCommand(message, f.state.dbPath, undefined, stateDir)
    : message.agentMessage ? agentCompletionCommand(message, f.state.dbPath, undefined, stateDir) : null;
  const prompt = codexPrompt(message, acknowledgmentCommand(message, f.state.dbPath), completion);
  return { routeId: f.route.routeId, prompt, observerCursor };
}

// Real signed intake: enroll, arm, publish a notice wire, accept it, then prove
// the provenance reached the stored message.
function createWatcherFixture(t, {
  messageId = '9020',
  armKey = 'watcher-retired-arm',
  triggerKey = 'watcher-retired-trigger',
  text = 'Watcher completion is ready.'
} = {}) {
  const f = fixture(t, { includeInitialAgent: false });
  f.state.setBindingReadiness('1000', 'ready');
  f.state.armWatcherNotice({
    armKey,
    parentChannelId: '1000',
    childChannelId: '2000',
    provider: 'codex',
    nativeId: PARENT_NATIVE,
    generation: f.binding.generation,
    caller: { harness: 'codex', sessionId: PARENT_NATIVE, threadId: PARENT_NATIVE }
  });
  const packet = createWatcherNotice({
    armKey,
    triggerKey,
    source: { ...f.route.target, channelId: '1000' },
    target: f.route.target,
    text
  });
  const accepted = f.state.acceptDiscordMessage({
    id: messageId,
    guildId: '100',
    channelId: '2000',
    authorId: 'watcher-bot',
    isBot: true,
    attachments: [],
    content: encodeWatcherNotice(packet, TOKEN)
  }, { ready: true, expectedBinding: f.binding, agentToken: TOKEN });
  assert.equal(accepted.accepted, true, `watcher notice ${messageId} was not accepted`);
  const message = f.state.getMessage(messageId);
  assert.ok(message.watcherNotice, `watcher notice ${messageId} has no signed provenance`);
  return { f, message, packet };
}

// Queue-admits the fixture message and opens its first courier attempt.
function beginPredecessor(f, message, { outcome = null } = {}) {
  assert.equal(f.state.claimDispatch(message.id).claimed, true, 'dispatch claim was refused');
  const input = consumerInput(f, message);
  const claim = f.state.beginCourierAttempt(message.id, input);
  assert.equal(claim.accepted, true, `courier attempt was not accepted: ${claim.status}`);
  if (outcome) f.state.recordCourierOutcome(message.id, claim.attempt.attemptId, outcome);
  return { input, claim };
}

function retireByUncertainReconciliation(f, message, claim) {
  f.state.markUncertain(message.id, new Error('fixture uncertain queue outcome'));
  f.state.recordCourierOutcome(message.id, claim.attempt.attemptId, COURIER_OUTCOMES.UNCERTAIN);
  f.state.reconcileUncertain(message.id, 'not_submitted');
}

function retireByPublicRecovery(f, message, claim) {
  f.state.recordCourierOutcome(message.id, claim.attempt.attemptId, COURIER_OUTCOMES.SUBMITTED);
  f.state.markSubmitted(message.id);
  return f.state.recoverCourierAttempt(message.id, claim.attempt.attemptId);
}

// Direct provider mock. Courier dispatch records the envelope; direct dispatch
// records the message id. Observation honors the signal and settles immediately.
function scenarioConsumer(f, { courier = [], direct = [] } = {}) {
  return createSurfaceConsumer({
    state: f.state,
    stateDir: f.dir,
    courierRoute: { routeId: f.route.routeId },
    providers: {
      codex: {
        async dispatchCourier(envelope) {
          courier.push(envelope);
          return { status: COURIER_OUTCOMES.SUBMITTED };
        },
        async dispatch(message) {
          direct.push(message.id);
          return { status: COURIER_OUTCOMES.NOT_SUBMITTED };
        },
        async observe(_message, _outcome, options) {
          if (options.signal.aborted) return { stopped: true };
          return { stopped: true };
        }
      }
    },
    sendReply: async () => ({ id: 'fixture-reply' }),
    sendTransportReceipt: async () => ({ id: 'fixture-receipt' })
  });
}

// The exact PreToolUse event the real forwarding owner validates.
function forwardEvent(f, message, prompt) {
  return {
    session_id: COURIER_NATIVE,
    turn_id: 'fixture-turn',
    tool_use_id: 'fixture-call',
    cwd: f.dir,
    transcript_path: path.join(f.sessionRoot, `${COURIER_NATIVE}.jsonl`),
    hook_event_name: 'PreToolUse',
    tool_name: 'mcp__codex_app__send_message_to_thread',
    tool_input: { threadId: RECIPIENT_THREAD, hostId: f.route.courier.hostId, prompt }
  };
}

function receiptCount(state) {
  return Number(state.db.prepare('SELECT COUNT(*) AS count FROM receipts').get().count);
}

function receiptRows(state, kind, messageId) {
  return JSON.parse(JSON.stringify(
    state.db.prepare('SELECT * FROM receipts WHERE kind=? AND discord_id=? ORDER BY id').all(kind, messageId)
  ));
}

function forwardClaims(state, messageId) {
  return receiptRows(state, COURIER_RECEIPT_KINDS.FORWARD_CLAIM, messageId);
}

function retirementReceipts(state, messageId) {
  return receiptRows(state, COURIER_RECEIPT_KINDS.RECONCILED_NOT_SUBMITTED, messageId);
}

function reopen(f) {
  try { f.state.close(); } catch {}
  const reopened = new SurfaceState(f.dbPath);
  f.replaceState(reopened);
  return reopened;
}

function deadline(ms = 3000) {
  const controller = new AbortController();
  const expired = new Promise((_resolve, reject) => {
    controller.signal.addEventListener('abort', () => reject(new Error('scenario deadline exceeded')), { once: true });
  });
  expired.catch(() => {});
  const timer = setTimeout(() => controller.abort(), ms);
  return { controller, expired, clear: () => clearTimeout(timer) };
}

module.exports = {
  attemptSuffix,
  beginPredecessor,
  consumerInput,
  createWatcherFixture,
  deadline,
  forwardClaims,
  forwardEvent,
  humanMessage,
  receiptCount,
  reopen,
  retireByPublicRecovery,
  retireByUncertainReconciliation,
  retirementReceipts,
  scenarioConsumer
};
