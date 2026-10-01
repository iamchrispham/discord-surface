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
const TOKEN = 'courier-route-fixture-token';
const PARENT_NATIVE = '11111111-1111-1111-1111-111111111111';
const SOURCE_NATIVE = '22222222-2222-2222-2222-222222222222';
const COURIER_NATIVE = '33333333-3333-3333-3333-333333333333';
const RECIPIENT_THREAD = PARENT_NATIVE;
const WRONG_RECIPIENT_THREAD = '44444444-4444-4444-4444-444444444444';

function fixture(t, { packetKind = KINDS.REQUEST, includeInitialAgent = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-courier-route-'));
  const sessionRoot = path.join(dir, 'sessions');
  fs.mkdirSync(sessionRoot, { recursive: true });
  const sessionFile = path.join(sessionRoot, `${PARENT_NATIVE}.jsonl`);
  fs.writeFileSync(sessionFile, `${JSON.stringify({ type: 'session_meta', payload: { id: PARENT_NATIVE, session_id: PARENT_NATIVE } })}\nold transcript\n`);
  let state = new SurfaceState(path.join(dir, 'surface.sqlite'));
  state.setConfig({ operatorId: 'operator', guildId: '100', secretFile: path.join(dir, 'secret') });
  state.bind({ channelId: '1000', guildId: '100', provider: 'codex', nativeId: PARENT_NATIVE, workspace: dir, sessionRoot }, { intakeCutoff: '100' });
  const binding = state.getBinding('1000');
  state.enrollThread({ threadId: '2000', parentChannelId: '1000', guildId: '100', adoptionCutoff: '100'}, binding);
  state.setThreadBaseline('2000', null, binding);
  state.markThreadBoundary('2000', THREAD_STATES.READY, 'courier route fixture', null, null, binding);
  const target = { guildId: '100', channelId: '2000', provider: 'codex', nativeId: PARENT_NATIVE, generation: binding.generation };
  const source = { guildId: '100', channelId: '3000', provider: 'claude', nativeId: SOURCE_NATIVE, generation: 1 };
  const packet = {
    id: packetKind === KINDS.RESULT ? 'result-1' : 'request-1',
    kind: packetKind,
    source,
    target,
    replyTo: packetKind === KINDS.RESULT ? 'request-0' : null,
    text: packetKind === KINDS.RESULT ? 'Peer child result' : 'Peer child request'
  };
  const accepted = includeInitialAgent ? state.acceptDiscordMessage({
    id: packetKind === KINDS.RESULT ? '9001' : '9000',
    guildId: '100',
    channelId: '2000',
    authorId: 'agent-bot',
    isBot: true,
    attachments: [],
    content: encodeAgentMessage(packet, TOKEN)
  }, { ready: true, expectedBinding: binding, agentToken: TOKEN }) : null;
  if (includeInitialAgent) assert.equal(accepted.accepted, true);
  const route = {
    routeId: 'route-1',
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
      hostId: 'host-local'
    }
  };
  state.registerCourierRoute(route);
  t.after(() => {
    try { state.close(); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return {
    dir,
    sessionFile,
    dbPath: path.join(dir, 'surface.sqlite'),
    get state() { return state; },
    replaceState(next) { state = next; },
    route,
    packet,
    message: includeInitialAgent ? state.getMessage(accepted.message.id) : null,
    binding
  };
}
function humanMessage(f, id = '9010', content = 'human instruction', attachments = [], channelId = '1000') {
  const accepted = f.state.acceptDiscordMessage({
    id,
    guildId: '100',
    channelId,
    authorId: 'operator',
    isBot: false,
    attachments,
    content
  }, { ready: true, expectedBinding: f.state.getBinding('1000') });
  assert.equal(accepted.accepted, true);
  return f.state.getMessage(id);
}

function interactionMessage(f, id = 'interaction-origin-1') {
  const accepted = f.state.acceptInteraction({
    id,
    guildId: '100',
    channelId: '1000',
    userId: 'operator',
    content: '/cs',
    full: false
  }, f.state.getBinding('1000'));
  assert.equal(accepted.accepted, true);
  return f.state.getMessage(id);
}

function materializedDecisionMessage(f, id = 'decision-origin-1') {
  const binding = f.state.getBinding('1000');
  const presentationId = `${id}-presentation`;
  const questionMessageId = `${id}-question`;
  const qid = `${id}-qid`;
  const questionGeneration = `${id}-generation`;
  const target = `${id}-target`;
  const registered = f.state.registerDecisionPresentation({
    namespace: 'courier-route-test',
    presentationId,
    requestId: `${id}-request`,
    qid,
    questionGeneration,
    target,
    guildId: '100',
    channelId: '1000',
    messageId: questionMessageId,
    binding,
    keys: ['approve']
  });
  assert.equal(registered.created, true);
  f.state.recordDecisionPresentationOutcome(presentationId, 'sent', questionMessageId);
  const click = {
    interactionId: id,
    presentationId,
    selectedKey: 'approve',
    actorId: 'operator',
    guildId: '100',
    channelId: '1000',
    messageId: questionMessageId,
    binding
  };
  assert.equal(f.state.admitDecisionClick(click).accepted, true);
  const imported = f.state.importDecisionWinner(id, {
    qid,
    questionGeneration,
    target,
    source: 'current',
    materialized: true,
    reference: `${id}-reference`,
    answer: `${id} answer`
  });
  assert.equal(imported.accepted, true);
  const message = f.state.getMessage(id);
  assert.ok(message.decisionResult);
  return message;
}

function parentPrompt(state, message) {
  const completion = message.agentMessage
    ? agentCompletionCommand(message, state.dbPath, undefined, path.dirname(state.dbPath))
    : null;
  return codexPrompt(message, acknowledgmentCommand(message, state.dbPath), completion);
}

function preparedInput(f, message) {
  return {
    routeId: f.route.routeId,
    prompt: parentPrompt(f.state, message),
    observerCursor: readInitialCursor(message.nativeId, f.sessionRoot)
  };
}

function consumerFor(f, { courierCalls = [], parentCalls = [], replies = [], dispatchCourier, observe, courierRoute = f.route } = {}) {
  return createSurfaceConsumer({
    state: f.state,
    courierRoute: courierRoute ? { routeId: courierRoute.routeId } : null,
    providers: {
      codex: {
        async dispatchCourier(envelope, options) {
          courierCalls.push({ envelope, options });
          return dispatchCourier ? dispatchCourier(envelope, options) : { status: COURIER_OUTCOMES.SUBMITTED };
        },
        async dispatch(message) {
          parentCalls.push(message.id);
          return { status: COURIER_OUTCOMES.SUBMITTED };
        },
        async observe(message) {
          return observe ? observe(message) : { text: `answer for ${message.id}` };
        }
      }
    },
    sendReply: async (message, reply) => {
      replies.push({ messageId: message.id, channelId: message.deliveryChannelId || message.channelId, content: reply.replyText });
      return { id: `reply-${replies.length}` };
    },
    sendTransportReceipt: async () => ({ id: 'receipt' })
  });
}
module.exports = { TOKEN, PARENT_NATIVE, SOURCE_NATIVE, COURIER_NATIVE, RECIPIENT_THREAD, WRONG_RECIPIENT_THREAD, fixture, humanMessage, interactionMessage, materializedDecisionMessage, parentPrompt, preparedInput, consumerFor };
