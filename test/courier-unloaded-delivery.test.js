// A queue-admitted courier without a forward claim must not hold its parent
// indefinitely. A claimed attempt must never be retired by the pickup deadline.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { encodeAgentMessage, KINDS } = require('../src/agent-message');
const { COURIER_RECEIPT_KINDS, SurfaceState, THREAD_STATES } = require('../src/state');
const { createSurfaceConsumer } = require('../src/discord');

const TOKEN = 'courier-unloaded-delivery-token';
const PARENT_NATIVE = '11111111-1111-1111-1111-111111111111';
const SOURCE_NATIVE = '22222222-2222-2222-2222-222222222222';
const COURIER_NATIVE = '33333333-3333-3333-3333-333333333333';

async function unloadedCourierCase(t, { restart = false } = {}) {
  const watchdog = setTimeout(() => { console.error('issue146 fixture watchdog'); process.exit(70); }, 8000);
  watchdog.unref();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'courier-unloaded-146-'));
  const sessionRoot = path.join(dir, 'sessions');
  let state = null;
  let consumer = null;
  const started = [];
  try {
    fs.mkdirSync(sessionRoot, { recursive: true });
    const sessionFile = path.join(sessionRoot, `${PARENT_NATIVE}.jsonl`);
    fs.writeFileSync(sessionFile, `${JSON.stringify({ type: 'session_meta', payload: { id: PARENT_NATIVE, session_id: PARENT_NATIVE } })}\nold transcript\n`);
    state = new SurfaceState(path.join(dir, 'surface.sqlite'));
    state.setConfig({ operatorId: 'operator', guildId: '100', secretFile: path.join(dir, 'secret') });
    state.bind({ channelId: '1000', guildId: '100', provider: 'codex', nativeId: PARENT_NATIVE, workspace: dir, sessionRoot }, { intakeCutoff: '100' });
    const binding = state.getBinding('1000');
    state.enrollThread({ threadId: '2000', parentChannelId: '1000', guildId: '100', adoptionCutoff: '100' }, binding);
    state.setThreadBaseline('2000', null, binding);
    state.markThreadBoundary('2000', THREAD_STATES.READY, 'courier unloaded delivery fixture', null, null, binding);
    const target = { guildId: '100', channelId: '2000', provider: 'codex', nativeId: PARENT_NATIVE, generation: binding.generation };
    const packet = {
      id: 'request-1',
      kind: KINDS.REQUEST,
      source: { guildId: '100', channelId: '3000', provider: 'claude', nativeId: SOURCE_NATIVE, generation: 1 },
      target,
      replyTo: null,
      text: 'Peer child request'
    };
    const accepted = state.acceptDiscordMessage({
      id: '9000',
      guildId: '100',
      channelId: '2000',
      authorId: 'agent-bot',
      isBot: true,
      attachments: [],
      content: encodeAgentMessage(packet, TOKEN)
    }, { ready: true, expectedBinding: binding, agentToken: TOKEN });
    assert.equal(accepted.accepted, true);
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
        recipientThreadId: PARENT_NATIVE,
        hostId: null
      }
    };
    state.registerCourierRoute(route);

    let enteredResolve;
    const entered = new Promise(resolve => { enteredResolve = resolve; });
    const directCalls = [];
    const makeConsumer = () => createSurfaceConsumer({
      state,
      courierRoute: { routeId: route.routeId },
      providers: {
        codex: {
          async dispatchCourier(envelope) {
            return { status: 'submitted' };
          },
          async dispatch(message) {
            directCalls.push({ nativeId: message.nativeId, messageId: message.id });
            return { status: 'submitted' };
          },
          async observe(message, _outcome, options) {
            const gate = new Promise(resolve => {
              const settle = () => resolve({ stopped: true });
              if (options.signal.aborted) settle();
              else options.signal.addEventListener('abort', settle, { once: true });
            });
            enteredResolve();
            return gate;
          }
        }
      },
      sendReply: async () => ({ id: 'reply' }),
      sendTransportReceipt: async () => ({ id: 'receipt' }),
      observeOptions: { timeoutMs: 25 }
    });
    consumer = makeConsumer();

    let first = consumer.processAccepted(state.getMessage('9000'), undefined, { continueUntilFinal: true });
    started.push(first);
    await entered;
    assert.equal(state.getMessage('9000').state, 'submitted', 'courier attempt was not admitted as submitted');
    assert.ok(state.getCourierAttempt('9000'), 'courier attempt was not persisted');
    if (restart) {
      consumer.abortNativeWork();
      await consumer.waitForNativeWork();
      await new Promise(resolve => setTimeout(resolve, 60));
      consumer = makeConsumer();
      first = consumer.resumeSubmitted(state.getMessage('9000'), undefined, { continueUntilFinal: true });
      started.push(first);
    }

    const siblingAccepted = state.acceptDiscordMessage({
      id: '9002',
      guildId: '100',
      channelId: '2000',
      authorId: 'agent-bot',
      isBot: true,
      attachments: [],
      content: encodeAgentMessage({ ...packet, id: 'request-2' }, TOKEN)
    }, { ready: true, expectedBinding: binding, agentToken: TOKEN });
    assert.equal(siblingAccepted.accepted, true);
    const sibling = consumer.processAccepted(state.getMessage('9002'));
    started.push(sibling);

    const deadline = Date.now() + 1500;
    while (Date.now() < deadline && !directCalls.some(call => call.nativeId === PARENT_NATIVE)) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.ok(directCalls.some(call => call.nativeId === PARENT_NATIVE && call.messageId === '9000'), 'unloaded courier remained submitted');
    const original = directCalls.filter(call => call.messageId === '9000' && call.nativeId === PARENT_NATIVE);
    assert.equal(original.length, 1, 'original unloaded message was not dispatched to the parent exactly once');
    const laterCalls = directCalls.filter(call => call.messageId === '9002');
    assert.equal(laterCalls.length, 0, 'later same-owner dispatch preceded native ACK');
  } finally {
    clearTimeout(watchdog);
    if (consumer) {
      consumer.abortNativeWork();
      await consumer.waitForNativeWork();
    }
    await Promise.allSettled(started);
    if (state) { try { state.close(); } catch {} }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('unloaded courier automatically retires its submitted attempt and dispatches the parent once', { timeout: 5000 }, unloadedCourierCase);
test('restart uses the durable courier deadline and dispatches the parent once', { timeout: 5000 }, t => unloadedCourierCase(t, { restart: true }));

test('a courier forward claim keeps its submitted attempt', { timeout: 5000 }, async t => {
  const watchdog = setTimeout(() => { console.error('issue146 fixture watchdog'); process.exit(70); }, 8000);
  watchdog.unref();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'courier-unloaded-146-'));
  const sessionRoot = path.join(dir, 'sessions');
  let state = null;
  let consumer = null;
  const started = [];
  try {
    fs.mkdirSync(sessionRoot, { recursive: true });
    const sessionFile = path.join(sessionRoot, `${PARENT_NATIVE}.jsonl`);
    fs.writeFileSync(sessionFile, `${JSON.stringify({ type: 'session_meta', payload: { id: PARENT_NATIVE, session_id: PARENT_NATIVE } })}\nold transcript\n`);
    state = new SurfaceState(path.join(dir, 'surface.sqlite'));
    state.setConfig({ operatorId: 'operator', guildId: '100', secretFile: path.join(dir, 'secret') });
    state.bind({ channelId: '1000', guildId: '100', provider: 'codex', nativeId: PARENT_NATIVE, workspace: dir, sessionRoot }, { intakeCutoff: '100' });
    const binding = state.getBinding('1000');
    state.enrollThread({ threadId: '2000', parentChannelId: '1000', guildId: '100', adoptionCutoff: '100' }, binding);
    state.setThreadBaseline('2000', null, binding);
    state.markThreadBoundary('2000', THREAD_STATES.READY, 'courier unloaded delivery fixture', null, null, binding);
    const target = { guildId: '100', channelId: '2000', provider: 'codex', nativeId: PARENT_NATIVE, generation: binding.generation };
    const packet = {
      id: 'request-1',
      kind: KINDS.REQUEST,
      source: { guildId: '100', channelId: '3000', provider: 'claude', nativeId: SOURCE_NATIVE, generation: 1 },
      target,
      replyTo: null,
      text: 'Peer child request'
    };
    const accepted = state.acceptDiscordMessage({
      id: '9000',
      guildId: '100',
      channelId: '2000',
      authorId: 'agent-bot',
      isBot: true,
      attachments: [],
      content: encodeAgentMessage(packet, TOKEN)
    }, { ready: true, expectedBinding: binding, agentToken: TOKEN });
    assert.equal(accepted.accepted, true);
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
        recipientThreadId: PARENT_NATIVE,
        hostId: null
      }
    };
    state.registerCourierRoute(route);

    let enteredResolve;
    const entered = new Promise(resolve => { enteredResolve = resolve; });
    const directCalls = [];
    consumer = createSurfaceConsumer({
      state,
      courierRoute: { routeId: route.routeId },
      providers: {
        codex: {
          async dispatchCourier(envelope) {
            return { status: 'submitted' };
          },
          async dispatch(message) {
            directCalls.push({ nativeId: message.nativeId, messageId: message.id });
            return { status: 'submitted' };
          },
          async observe(message, _outcome, options) {
            const gate = new Promise(resolve => {
              const settle = () => resolve({ stopped: true });
              if (options.signal.aborted) settle();
              else options.signal.addEventListener('abort', settle, { once: true });
            });
            enteredResolve();
            return gate;
          }
        }
      },
      sendReply: async () => ({ id: 'reply' }),
      sendTransportReceipt: async () => ({ id: 'receipt' }),
      observeOptions: { timeoutMs: 25 }
    });

    const first = consumer.processAccepted(state.getMessage('9000'), undefined, { continueUntilFinal: true });
    started.push(first);
    await entered;
    assert.equal(state.getMessage('9000').state, 'submitted', 'courier attempt was not admitted as submitted');

    // The persisted attempt prompt is the queue-admission prompt (it already
    // carries the acknowledgment and completion argv), so the real PreToolUse
    // hook event must quote that exact prompt. The shared forwardEvent helper
    // rebuilds it from codexPrompt(message) without those argv additions and
    // therefore cannot match; hand-build the same event shape here instead.
    const attempt = state.getCourierAttempt('9000');
    const claim = state.claimCourierForward(route.routeId, {
      session_id: COURIER_NATIVE,
      turn_id: 'fixture-turn',
      tool_use_id: 'fixture-call',
      cwd: dir,
      transcript_path: path.join(sessionRoot, `${COURIER_NATIVE}.jsonl`),
      hook_event_name: 'PreToolUse',
      tool_name: 'mcp__codex_app__send_message_to_thread',
      tool_input: { threadId: PARENT_NATIVE, prompt: attempt.attempt.prompt }
    });
    assert.equal(claim.messageId, '9000');
    const claimRows = state.db.prepare('SELECT id FROM receipts WHERE kind=? AND discord_id=?')
      .all(COURIER_RECEIPT_KINDS.FORWARD_CLAIM, '9000');
    assert.equal(claimRows.length, 1, 'forward claim was not recorded');

    await new Promise(resolve => setTimeout(resolve, 150));

    const retirementRows = state.db.prepare('SELECT * FROM receipts WHERE kind=? AND discord_id=?')
      .all(COURIER_RECEIPT_KINDS.RECONCILED_NOT_SUBMITTED, '9000');
    assert.equal(retirementRows.length, 0, 'forward-claimed attempt was retired');
    assert.equal(directCalls.filter(call => call.messageId === '9000').length, 0,
      'forward-claimed attempt was dispatched directly');
  } finally {
    clearTimeout(watchdog);
    if (consumer) {
      consumer.abortNativeWork();
      await consumer.waitForNativeWork();
    }
    await Promise.allSettled(started);
    if (state) { try { state.close(); } catch {} }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
