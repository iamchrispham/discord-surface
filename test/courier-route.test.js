const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { encodeAgentMessage, KINDS } = require('../src/agent-message');
const { acknowledgmentCommand } = require('../src/acknowledgment');
const { codexPrompt, readInitialCursor, CodexProvider } = require('../src/native');
const {
  COURIER_OUTCOMES,
  COURIER_SOURCE_KINDS,
  MESSAGE_STATES,
  SurfaceState,
  THREAD_STATES
} = require('../src/state');
const { createSurfaceConsumer } = require('../src/discord');

const TOKEN = 'courier-route-fixture-token';
const PARENT_NATIVE = '11111111-1111-1111-1111-111111111111';
const SOURCE_NATIVE = '22222222-2222-2222-2222-222222222222';
const COURIER_NATIVE = '33333333-3333-3333-3333-333333333333';
const RECIPIENT_THREAD = '44444444-4444-4444-4444-444444444444';

function fixture(t, { packetKind = KINDS.REQUEST, includeInitialAgent = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-courier-route-'));
  const sessionRoot = path.join(dir, 'sessions');
  fs.mkdirSync(sessionRoot, { recursive: true });
  const sessionFile = path.join(sessionRoot, `${PARENT_NATIVE}.jsonl`);
  fs.writeFileSync(sessionFile, `${JSON.stringify({ type: 'session_meta', payload: { id: PARENT_NATIVE, session_id: PARENT_NATIVE } })}\nold transcript\n`);
  let state = new SurfaceState(path.join(dir, 'surface.sqlite'));
  state.setConfig({ operatorId: 'operator', guildId: '100', secretFile: path.join(dir, 'secret') });
  state.bind({ channelId: '1000', guildId: '100', provider: 'codex', nativeId: PARENT_NATIVE, workspace: dir, sessionRoot });
  const binding = state.getBinding('1000');
  state.enrollThread({ threadId: '2000', parentChannelId: '1000', guildId: '100' }, binding);
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

function humanMessage(f, id = 'human-1', content = 'human instruction', attachments = [], channelId = '1000') {
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
  return codexPrompt(message, acknowledgmentCommand(message, state.dbPath));
}

function preparedInput(f, message) {
  return {
    routeId: f.route.routeId,
    prompt: parentPrompt(f.state, message),
    observerCursor: readInitialCursor(message.nativeId, f.sessionFile)
  };
}

function consumerFor(f, { courierCalls = [], parentCalls = [], replies = [], dispatchCourier, observe } = {}) {
  return createSurfaceConsumer({
    state: f.state,
    courierRoute: { routeId: f.route.routeId },
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

test('selected agent route uses exact parent prompt and existing native lifecycle', async t => {
  const f = fixture(t);
  const courierCalls = [];
  const parentCalls = [];
  const replies = [];
  const consumer = consumerFor(f, { courierCalls, parentCalls, replies });
  const expectedPrompt = parentPrompt(f.state, f.message);
  const result = await consumer.processAccepted(f.message);

  assert.equal(result.message.state, MESSAGE_STATES.REPLIED);
  assert.equal(f.state.getMessage(f.message.id).state, MESSAGE_STATES.REPLIED);
  assert.equal(parentCalls.length, 0);
  assert.equal(courierCalls.length, 1);
  assert.equal(courierCalls[0].envelope.prompt, expectedPrompt);
  assert.equal(Object.isFrozen(courierCalls[0].envelope), true);
  assert.equal(courierCalls[0].envelope.source.kind, COURIER_SOURCE_KINDS.AGENT);
  assert.deepEqual(courierCalls[0].envelope.packet, f.packet);
  assert.equal(courierCalls[0].envelope.parent.channelId, '1000');
  assert.equal(courierCalls[0].envelope.parent.nativeId, PARENT_NATIVE);
  assert.equal(courierCalls[0].envelope.observerCursor.file, f.sessionFile);
  assert.ok(courierCalls[0].envelope.observerCursor.offset > 0);
  assert.equal(f.state.getMessage(f.message.id).observerCursor.file, f.sessionFile);
  assert.equal(f.state.listReceipts().filter(row => row.kind === 'native-ack').length, 1);
  assert.deepEqual(replies, [{ messageId: f.message.id, channelId: '2000', content: `answer for ${f.message.id}` }]);
  assert.equal(f.state.getCourierAttempt(f.message.id).outcome.outcome, COURIER_OUTCOMES.SUBMITTED);

  const duplicate = await consumer.processAccepted(f.state.getMessage(f.message.id));
  assert.equal(duplicate.message.state, MESSAGE_STATES.REPLIED);
  assert.equal(courierCalls.length, 1);
  assert.equal(parentCalls.length, 0);
  assert.equal(replies.length, 1);
});

test('human parent route keeps authority and original Discord destination', async t => {
  const f = fixture(t, { includeInitialAgent: false });
  const message = humanMessage(f, 'human-1', 'approve the release', [{
    url: 'https://example.test/release.txt',
    filename: 'release.txt',
    contentType: 'text/plain',
    size: 12
  }]);
  const courierCalls = [];
  const parentCalls = [];
  const replies = [];
  const result = await consumerFor(f, { courierCalls, parentCalls, replies }).processAccepted(message);

  assert.equal(result.message.state, MESSAGE_STATES.REPLIED);
  assert.equal(parentCalls.length, 0);
  assert.equal(courierCalls.length, 1);
  const envelope = courierCalls[0].envelope;
  assert.equal(envelope.source.kind, COURIER_SOURCE_KINDS.HUMAN);
  assert.equal(envelope.source.authorId, 'operator');
  assert.equal(envelope.source.isBot, false);
  assert.equal(envelope.source.content, 'approve the release');
  assert.deepEqual(envelope.source.attachments, message.attachments);
  assert.deepEqual(envelope.sourceDestination, { guildId: '100', channelId: '1000' });
  assert.equal(envelope.deliveryChannelId, '1000');
  assert.equal(envelope.prompt, parentPrompt(f.state, message));
  assert.deepEqual(replies, [{ messageId: 'human-1', channelId: '1000', content: 'answer for human-1' }]);
  assert.equal(f.state.getMessage(message.id).authorId, 'operator');
  assert.equal(f.state.listReceipts().filter(row => row.kind === 'native-ack').length, 1);

  const childMessage = humanMessage(f, 'human-child-1', 'child instruction', [], '2000');
  const childResult = await consumerFor(f, { courierCalls, parentCalls, replies }).processAccepted(childMessage);
  assert.equal(childResult.message.state, MESSAGE_STATES.REPLIED);
  assert.equal(courierCalls.length, 2);
  assert.deepEqual(courierCalls[1].envelope.sourceDestination, { guildId: '100', channelId: '2000' });
  assert.equal(courierCalls[1].envelope.deliveryChannelId, '2000');
  assert.equal(parentCalls.length, 0);
  assert.deepEqual(replies.map(reply => ({ messageId: reply.messageId, channelId: reply.channelId })), [
    { messageId: 'human-1', channelId: '1000' },
    { messageId: 'human-child-1', channelId: '2000' }
  ]);
});

test('ordinary agent and human origins remain courier-eligible', async t => {
  const f = fixture(t);
  const human = humanMessage(f, 'human-origin-guard', 'ordinary human instruction');
  assert.equal(f.state.isInteractionMessage(human.id), false);
  assert.equal(human.decisionResult, undefined);
  const courierCalls = [];
  const parentCalls = [];
  const consumer = consumerFor(f, { courierCalls, parentCalls });

  await consumer.processAccepted(f.message);
  await consumer.processAccepted(human);

  assert.equal(courierCalls.length, 2);
  assert.deepEqual(courierCalls.map(call => call.envelope.source.kind === COURIER_SOURCE_KINDS.AGENT
    ? call.envelope.packet.id
    : call.envelope.messageId), ['request-1', human.id]);
  assert.equal(parentCalls.length, 0);
  assert.equal(f.state.getCourierAttempt(f.message.id).outcome.outcome, COURIER_OUTCOMES.SUBMITTED);
  assert.equal(f.state.getCourierAttempt(human.id).outcome.outcome, COURIER_OUTCOMES.SUBMITTED);
});

test('interaction-origin and materialized decision messages cannot mint courier custody', async t => {
  const f = fixture(t, { includeInitialAgent: false });
  const interaction = interactionMessage(f);
  const decision = materializedDecisionMessage(f);
  assert.equal(f.state.isInteractionMessage(interaction.id), true);
  assert.equal(f.state.isInteractionMessage(decision.id), true);

  for (const message of [interaction, decision]) {
    const rejected = f.state.beginCourierAttempt(message.id, preparedInput(f, message));
    assert.equal(rejected.accepted, false);
    assert.equal(rejected.status, 'no_route');
    assert.equal(f.state.getCourierAttempt(message.id), null);
  }

  const courierCalls = [];
  const parentCalls = [];
  const consumer = consumerFor(f, { courierCalls, parentCalls });
  await consumer.processAccepted(interaction);
  await consumer.processAccepted(decision);

  assert.equal(courierCalls.length, 0);
  assert.deepEqual(parentCalls, [interaction.id, decision.id]);
  assert.equal(f.state.listReceipts().filter(row => row.kind === 'courier-attempt').length, 0);
});

test('selected and unselected messages share parent owner FIFO', async t => {
  const f = fixture(t);
  const binding = f.state.getBinding('1000');
  f.state.enrollThread({ threadId: '2001', parentChannelId: '1000', guildId: '100' }, binding);
  f.state.setThreadBaseline('2001', null, binding);
  f.state.markThreadBoundary('2001', THREAD_STATES.READY, 'second child fixture', null, null, binding);
  const otherTarget = { ...f.route.target, channelId: '2001' };
  const otherPacket = { ...f.packet, id: 'request-2', target: otherTarget };
  const otherAccepted = f.state.acceptDiscordMessage({
    id: '9004', guildId: '100', channelId: '2001', authorId: 'agent-bot', isBot: true, attachments: [],
    content: encodeAgentMessage(otherPacket, TOKEN)
  }, { ready: true, expectedBinding: binding, agentToken: TOKEN });
  assert.equal(otherAccepted.accepted, true);
  const parent = humanMessage(f, '9005', 'human parent work');
  const courierCalls = [];
  const parentCalls = [];
  const replies = [];
  const consumer = consumerFor(f, {
    courierCalls,
    parentCalls,
    replies,
    dispatchCourier: async envelope => {
      await new Promise(resolve => setImmediate(resolve));
      return { status: COURIER_OUTCOMES.SUBMITTED };
    }
  });
  const results = await Promise.all([
    consumer.processAccepted(f.message),
    consumer.processAccepted(f.state.getMessage(otherAccepted.message.id)),
    consumer.processAccepted(parent)
  ]);

  assert.deepEqual(courierCalls.map(call => call.envelope.source.kind === COURIER_SOURCE_KINDS.AGENT
    ? call.envelope.packet.id
    : call.envelope.messageId), ['request-1', '9005']);
  assert.deepEqual(parentCalls, ['9004']);
  assert.deepEqual(replies.map(reply => reply.messageId), ['9000', '9004', '9005']);
  assert.equal(results[0].message.state, MESSAGE_STATES.REPLIED);
  assert.equal(f.state.getMessage(otherAccepted.message.id).state, MESSAGE_STATES.REPLIED);
  assert.equal(f.state.getMessage(parent.id).state, MESSAGE_STATES.REPLIED);
});

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

test('route revoked after queue result blocks parent observation', async t => {
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

  assert.equal(result.status, COURIER_OUTCOMES.NOT_SUBMITTED);
  assert.equal(f.state.getMessage(f.message.id).state, MESSAGE_STATES.ACCEPTED);
  assert.equal(f.state.getCourierAttempt(f.message.id).outcome.outcome, COURIER_OUTCOMES.SUBMITTED);
  assert.equal(courierCalls.length, 1);
  assert.equal(parentCalls.length, 0);
  assert.equal(replies.length, 0);
  assert.equal(f.state.listReceipts().filter(row => row.kind === 'native-ack').length, 0);
});

test('Codex courier queue uses a fixed forwarding call and exact parent payload', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-courier-provider-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calls = [];
  const provider = new CodexProvider({
    command: '/isolated/codex',
    root: path.join(dir, '.codex', 'sessions'),
    run: async (command, args, options) => {
      calls.push({ command, args, options });
      return { status: COURIER_OUTCOMES.SUBMITTED };
    }
  });
  const envelope = {
    type: 'discord-surface:courier:v1',
    attemptId: 'courier-attempt-1',
    messageId: 'parent-message-1',
    prompt: 'exact parent prompt with marker',
    route: { routeId: 'route-1', routeGeneration: 1 },
    parent: {
      guildId: '100',
      channelId: '1000',
      provider: 'codex',
      nativeId: PARENT_NATIVE,
      generation: 1
    },
    deliveryChannelId: '2000',
    sourceDestination: { guildId: '100', channelId: '2000' },
    source: { kind: 'agent', authorId: 'agent-bot' },
    packet: null,
    wire: 'exact parent prompt with marker',
    payloadHash: 'payload-hash-1',
    observerCursor: null,
    recipient: { threadId: RECIPIENT_THREAD, hostId: 'host-local' },
    courier: {
      provider: 'codex',
      nativeId: COURIER_NATIVE,
      workspace: dir,
      sessionRoot: path.join(dir, '.codex', 'sessions'),
      recipientThreadId: RECIPIENT_THREAD,
      hostId: 'host-local'
    }
  };
  const result = await provider.dispatchCourier(envelope);
  assert.equal(result.status, COURIER_OUTCOMES.SUBMITTED);
  assert.equal(calls.length, 1);
  const queuedPrompt = calls[0].args[calls[0].args.indexOf('--message') + 1];
  assert.notEqual(queuedPrompt, envelope.prompt);
  assert.match(queuedPrompt, /send_message_to_thread tool exactly once/);
  const toolInputLine = queuedPrompt.split('\n').find(line => line.startsWith('Tool input: '));
  assert.ok(toolInputLine);
  assert.deepEqual(JSON.parse(toolInputLine.slice('Tool input: '.length)), {
    threadId: RECIPIENT_THREAD,
    prompt: envelope.prompt,
    hostId: 'host-local'
  });
  const custodyLine = queuedPrompt.split('\n').find(line => line.startsWith('Courier custody: '));
  assert.ok(custodyLine);
  const custody = JSON.parse(custodyLine.slice('Courier custody: '.length));
  assert.equal(custody.payloadHash, envelope.payloadHash);
  assert.deepEqual(custody.recipient, envelope.recipient);
  assert.deepEqual(calls[0].args, ['queue', '--thread', COURIER_NATIVE, '--message', queuedPrompt, '--cd', dir]);
  assert.equal(calls[0].options.cwd, dir);
  assert.ok(calls[0].options.env.CODEX_HOME.endsWith('/.codex'));

  const mismatched = { ...envelope, recipient: { threadId: PARENT_NATIVE, hostId: 'host-local' } };
  const rejected = await provider.dispatchCourier(mismatched);
  assert.equal(rejected.status, COURIER_OUTCOMES.NOT_SUBMITTED);
  assert.equal(calls.length, 1);
});
