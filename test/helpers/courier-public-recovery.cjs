'use strict';

// Shared disposable fixture for test/courier-public-recovery.test.js. Every
// fixture uses a mkdtemp SQLite file and a temp transcript root; nothing here
// opens a socket, a live database, Discord, or a Gateway process.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SurfaceState, THREAD_STATES, COURIER_OUTCOMES, COURIER_RECEIPT_KINDS } = require('../../src/state');
const { encodeAgentMessage, KINDS } = require('../../src/agent-message');
const { codexPrompt } = require('../../src/native');

const TOKEN = 'courier-public-recovery-token';
const PARENT_NATIVE = '11111111-1111-1111-1111-111111111111';
const SOURCE_NATIVE = '22222222-2222-2222-2222-222222222222';
const COURIER_NATIVE = '33333333-3333-3333-3333-333333333333';
const RECIPIENT_THREAD = PARENT_NATIVE;

function createFixture(t, { messageId = '9000', routeId = 'route-1' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'courier-public-recovery-'));
  const sessionRoot = path.join(dir, 'sessions');
  fs.mkdirSync(sessionRoot, { recursive: true });
  const dbPath = path.join(dir, 'surface.sqlite');
  let state = new SurfaceState(dbPath);
  state.setConfig({ operatorId: 'operator', guildId: '100', secretFile: path.join(dir, 'secret') });
  state.bind({ channelId: '1000', guildId: '100', provider: 'codex', nativeId: PARENT_NATIVE, workspace: dir, sessionRoot }, { intakeCutoff: '100' });
  const binding = state.getBinding('1000');
  state.enrollThread({ threadId: '2000', parentChannelId: '1000', guildId: '100', adoptionCutoff: '100' }, binding);
  state.setThreadBaseline('2000', null, binding);
  state.markThreadBoundary('2000', THREAD_STATES.READY, 'courier public recovery fixture', null, null, binding);
  const target = { guildId: '100', channelId: '2000', provider: 'codex', nativeId: PARENT_NATIVE, generation: binding.generation };
  const packet = {
    id: 'request-1',
    kind: KINDS.REQUEST,
    source: { guildId: '100', channelId: '3000', provider: 'claude', nativeId: SOURCE_NATIVE, generation: 1 },
    target,
    replyTo: null,
    text: 'Courier public recovery fixture'
  };
  const accepted = state.acceptDiscordMessage({
    id: messageId,
    guildId: '100',
    channelId: '2000',
    authorId: 'agent-bot',
    isBot: true,
    attachments: [],
    content: encodeAgentMessage(packet, TOKEN)
  }, { ready: true, expectedBinding: binding, agentToken: TOKEN });
  if (!accepted.accepted) throw new Error('courier recovery fixture message was not accepted');
  const route = {
    routeId,
    routeGeneration: 1,
    guildId: '100',
    parentChannelId: '1000',
    deliveryChannelId: '2000',
    target,
    courier: {
      provider: 'codex',
      nativeId: COURIER_NATIVE,
      workspace: dir,
      sessionRoot,
      recipientThreadId: RECIPIENT_THREAD,
      hostId: null
    }
  };
  state.registerCourierRoute(route);
  const fixture = {
    dir,
    dbPath,
    sessionRoot,
    route,
    packet,
    binding,
    messageId,
    get state() { return state; },
    reopen() { state.close(); state = new SurfaceState(dbPath); },
    close() { try { state.close(); } catch {} }
  };
  t.after(() => {
    fixture.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return fixture;
}

// Queue-admitted courier attempt for the fixture message. Default outcome is the
// submitted queue admission that explicit retirement targets.
function submitCourierAttempt(fixture, { outcome = 'submitted', messageId = fixture.messageId } = {}) {
  const claimed = fixture.state.claimDispatch(messageId);
  if (!claimed.claimed) throw new Error('courier recovery fixture dispatch was not claimed');
  const claim = fixture.state.beginCourierAttempt(messageId, {
    routeId: fixture.route.routeId,
    prompt: codexPrompt(fixture.state.getMessage(messageId))
  });
  if (!claim.accepted) throw new Error('courier recovery fixture attempt was not accepted');
  if (outcome) fixture.state.recordCourierOutcome(messageId, claim.attempt.attemptId, outcome);
  return claim;
}

function markSubmitted(fixture, messageId = fixture.messageId) {
  fixture.state.markSubmitted(messageId);
}

// Real PreToolUse hook event accepted by the existing claimCourierForward owner.
function forwardEvent(fixture, messageId = fixture.messageId) {
  const prompt = codexPrompt(fixture.state.getMessage(messageId));
  return {
    session_id: COURIER_NATIVE,
    turn_id: 'fixture-turn',
    tool_use_id: 'fixture-call',
    cwd: fixture.dir,
    transcript_path: path.join(fixture.sessionRoot, `${COURIER_NATIVE}.jsonl`),
    hook_event_name: 'PreToolUse',
    tool_name: 'mcp__codex_app__send_message_to_thread',
    tool_input: { threadId: RECIPIENT_THREAD, prompt }
  };
}

// A second, newer attempt receipt for refusal-order tests. It intentionally does
// not go through queue admission; only the latest-attempt identity matters here.
function addSyntheticAttempt(fixture, { messageId = fixture.messageId, suffix = 'newer' } = {}) {
  const latest = fixture.state.getCourierAttempt(messageId);
  if (!latest) throw new Error('courier recovery fixture has no prior attempt');
  const { receiptId, createdAt, ...base } = latest.attempt;
  const attemptId = `courier-synthetic-${suffix}`;
  fixture.state.receipt(messageId, 'courier-attempt', { ...base, attemptId, attemptKey: `synthetic-${suffix}` });
  return attemptId;
}

function receiptCount(state) {
  return Number(state.db.prepare('SELECT COUNT(*) AS count FROM receipts').get().count);
}

function rowsFor(state, sql, ...params) {
  return JSON.parse(JSON.stringify(state.db.prepare(sql).all(...params)));
}

module.exports = {
  COURIER_NATIVE,
  PARENT_NATIVE,
  SOURCE_NATIVE,
  TOKEN,
  addSyntheticAttempt,
  createFixture,
  forwardEvent,
  markSubmitted,
  receiptCount,
  rowsFor,
  submitCourierAttempt
};
