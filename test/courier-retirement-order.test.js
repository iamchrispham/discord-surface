const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { encodeAgentMessage, KINDS } = require('../src/agent-message');
const { recordNativeAcknowledgment } = require('../src/acknowledgment');
const {
  COURIER_RECEIPT_KINDS,
  SurfaceState,
  THREAD_STATES
} = require('../src/state');
const { createSurfaceConsumer } = require('../src/discord');

const TOKEN = 'courier-route-fixture-token';
const PARENT_NATIVE = '11111111-1111-1111-1111-111111111111';
const SOURCE_NATIVE = '22222222-2222-2222-2222-222222222222';
const COURIER_NATIVE = '33333333-3333-3333-3333-333333333333';
const RECIPIENT_THREAD = PARENT_NATIVE;

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
    sessionRoot,
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

async function turns(n = 100) {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

function deferred() {
  let resolve;
  const promise = new Promise(resolvePromise => { resolve = resolvePromise; });
  return { promise, resolve };
}

function retireAcceptedCourierAttempt(f, messageId) {
  f.state.transaction(() => {
    f.state.db.prepare('UPDATE messages SET state=? WHERE discord_id=?').run('accepted', messageId);
    f.state.receipt(messageId, COURIER_RECEIPT_KINDS.RECONCILED_NOT_SUBMITTED, {});
  });
}

test('retired observer settlement holds queued sibling before wake', { todo: process.env.ISSUE128_STRICT !== '1', timeout: 3000 }, async t => {
  const watchdog = setTimeout(() => { console.error('issue128 fixture watchdog'); process.exit(70); }, 5000);
  watchdog.unref();
  const f = fixture(t);
  const courierCalls = [];
  const directCalls = [];
  const held = deferred();
  const entered = deferred();
  const consumer = createSurfaceConsumer({
    state: f.state,
    courierRoute: { routeId: f.route.routeId },
    providers: {
      codex: {
        async dispatchCourier(envelope) {
          courierCalls.push(envelope.packet.id);
          return { status: 'submitted' };
        },
        async dispatch(message) {
          directCalls.push(message.id);
          return { status: 'submitted' };
        },
        async observe(message, _outcome, options) {
          if (message.id !== '9000') return { stopped: true };
          const settle = () => held.resolve({ stopped: true });
          if (options.signal.aborted) settle();
          else options.signal.addEventListener('abort', settle, { once: true });
          entered.resolve();
          return held.promise;
        }
      }
    },
    sendReply: async () => ({ id: 'reply' }),
    sendTransportReceipt: async () => ({ id: 'receipt' })
  });
  const started = [];
  try {
    const first = consumer.processAccepted(f.message);
    started.push(first);
    await entered.promise;
    const siblingAccepted = f.state.acceptDiscordMessage({
      id: '9002',
      guildId: '100',
      channelId: '2000',
      authorId: 'agent-bot',
      isBot: true,
      attachments: [],
      content: encodeAgentMessage({ ...f.packet, id: 'request-2' }, TOKEN)
    }, { ready: true, expectedBinding: f.binding, agentToken: TOKEN });
    assert.equal(siblingAccepted.accepted, true);
    const sibling = consumer.processAccepted(f.state.getMessage('9002'));
    started.push(sibling);
    retireAcceptedCourierAttempt(f, '9000');
    held.resolve({ stopped: true });
    await first;
    await turns();
    assert.equal(courierCalls.length, 1, 'queued sibling dispatched before retired message retry');
  } finally {
    clearTimeout(watchdog);
    consumer.abortNativeWork();
    await Promise.allSettled(started);
    await consumer.waitForNativeWork();
  }
});

test('retired recovery cancels only its old observer before direct retry', { todo: process.env.ISSUE128_STRICT !== '1', timeout: 3000 }, async t => {
  const watchdog = setTimeout(() => { console.error('issue128 fixture watchdog'); process.exit(70); }, 5000);
  watchdog.unref();
  const f = fixture(t);
  const courierCalls = [];
  const directCalls = [];
  const oldHeld = deferred();
  const otherHeld = deferred();
  const entered = deferred();
  const otherEntered = deferred();
  let oldSignal = null;
  let otherSignal = null;
  let observedOld = false;
  const consumer = createSurfaceConsumer({
    state: f.state,
    courierRoute: { routeId: f.route.routeId },
    providers: {
      codex: {
        async dispatchCourier(envelope) {
          courierCalls.push(envelope.packet.id);
          return { status: 'submitted' };
        },
        async dispatch(message) {
          directCalls.push(message.id);
          return { status: 'submitted' };
        },
        async observe(message, _outcome, options) {
          if (message.id === '9100') {
            otherSignal = options.signal;
            const settle = () => otherHeld.resolve({ stopped: true });
            if (options.signal.aborted) settle();
            else options.signal.addEventListener('abort', settle, { once: true });
            otherEntered.resolve();
            return otherHeld.promise;
          }
          if (message.id !== '9000' || observedOld) return { stopped: true };
          observedOld = true;
          oldSignal = options.signal;
          const settle = () => oldHeld.resolve({ stopped: true });
          if (options.signal.aborted) settle();
          else options.signal.addEventListener('abort', settle, { once: true });
          entered.resolve();
          return oldHeld.promise;
        }
      }
    },
    sendReply: async () => ({ id: 'reply' }),
    sendTransportReceipt: async () => ({ id: 'receipt' })
  });
  const started = [];
  try {
    const first = consumer.processAccepted(f.state.getMessage('9000'));
    started.push(first);
    await entered.promise;
    f.state.bind({
      channelId: '1001',
      guildId: '100',
      provider: 'codex',
      nativeId: '55555555-5555-5555-5555-555555555555',
      workspace: f.dir,
      sessionRoot: f.sessionRoot
    }, { intakeCutoff: '100' });
    const otherBinding = f.state.getBinding('1001');
    const otherAccepted = f.state.acceptDiscordMessage({
      id: '9100',
      guildId: '100',
      channelId: '1001',
      authorId: 'operator',
      isBot: false,
      attachments: [],
      content: 'other owner work'
    }, { ready: true, expectedBinding: otherBinding });
    assert.equal(otherAccepted.accepted, true);
    const other = consumer.processAccepted(f.state.getMessage('9100'));
    started.push(other);
    await otherEntered.promise;
    retireAcceptedCourierAttempt(f, '9000');
    const recovery = consumer.processAccepted(f.state.getMessage('9000'), undefined, { awaitExisting: false, continueUntilFinal: false });
    started.push(recovery);
    await turns();
    assert.equal(oldSignal.aborted, true, 'retired observer was not cancelled');
    assert.equal(otherSignal.aborted, false, 'other owner observer was cancelled');
    assert.equal(directCalls.filter(id => id === '9000').length, 1, 'retired message direct retry did not occur once');
  } finally {
    clearTimeout(watchdog);
    consumer.abortNativeWork();
    await Promise.allSettled(started);
    await consumer.waitForNativeWork();
  }
});

test('concurrent retired recovery dispatches directly once before sibling', { todo: process.env.ISSUE128_STRICT !== '1', timeout: 3000 }, async t => {
  const watchdog = setTimeout(() => { console.error('issue128 fixture watchdog'); process.exit(70); }, 5000);
  watchdog.unref();
  const f = fixture(t);
  const courierCalls = [];
  const directCalls = [];
  const held = deferred();
  const entered = deferred();
  let observedOld = false;
  const consumer = createSurfaceConsumer({
    state: f.state,
    courierRoute: { routeId: f.route.routeId },
    providers: {
      codex: {
        async dispatchCourier(envelope) {
          courierCalls.push(envelope.packet.id);
          return { status: 'submitted' };
        },
        async dispatch(message) {
          directCalls.push(message.id);
          return { status: 'submitted' };
        },
        async observe(message, _outcome, options) {
          if (message.id !== '9000' || observedOld) return { stopped: true };
          observedOld = true;
          const settle = () => held.resolve({ stopped: true });
          if (options.signal.aborted) settle();
          else options.signal.addEventListener('abort', settle, { once: true });
          entered.resolve();
          return held.promise;
        }
      }
    },
    sendReply: async () => ({ id: 'reply' }),
    sendTransportReceipt: async () => ({ id: 'receipt' })
  });
  const started = [];
  try {
    const first = consumer.processAccepted(f.state.getMessage('9000'));
    started.push(first);
    await entered.promise;
    const siblingAccepted = f.state.acceptDiscordMessage({
      id: '9002',
      guildId: '100',
      channelId: '2000',
      authorId: 'agent-bot',
      isBot: true,
      attachments: [],
      content: encodeAgentMessage({ ...f.packet, id: 'request-2' }, TOKEN)
    }, { ready: true, expectedBinding: f.binding, agentToken: TOKEN });
    assert.equal(siblingAccepted.accepted, true);
    const sibling = consumer.processAccepted(f.state.getMessage('9002'));
    started.push(sibling);
    retireAcceptedCourierAttempt(f, '9000');
    const recoveryA = consumer.processAccepted(f.state.getMessage('9000'), undefined, { awaitExisting: false, continueUntilFinal: false });
    const recoveryB = consumer.processAccepted(f.state.getMessage('9000'), undefined, { awaitExisting: false, continueUntilFinal: false });
    started.push(recoveryA, recoveryB);
    await turns();
    assert.equal(directCalls.filter(id => id === '9000').length, 1, 'retired message direct recovery did not occur once');
    assert.equal(courierCalls.filter(id => id === 'request-1').length, 1, 'retired message wrote a second courier queue entry');
    assert.equal(courierCalls.filter(id => id === 'request-2').length, 0, 'sibling dispatched before retried message native acknowledgment');
    assert.equal(directCalls.filter(id => id === '9002').length, 0, 'sibling dispatched before retried message native acknowledgment');
    recordNativeAcknowledgment(f.state, {
      provider: 'codex',
      messageId: '9000',
      nativeId: PARENT_NATIVE,
      generation: f.binding.generation
    });
    consumer.releaseAcknowledged('9000');
    await turns();
    assert.equal(courierCalls.filter(id => id === 'request-2').length, 1, 'sibling was not released by native acknowledgment');
  } finally {
    clearTimeout(watchdog);
    consumer.abortNativeWork();
    await Promise.allSettled(started);
    await consumer.waitForNativeWork();
  }
});
