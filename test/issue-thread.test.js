const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ChannelType, GatewayIntentBits } = require('discord.js');
const { SurfaceState, MESSAGE_STATES, READINESS } = require('../src/state');
const { THREAD_STATES } = require('../src/state/thread-enrollment');
const { DiscordGateway, waitForRecoveryOperation } = require('../src/discord');
const { enrollPublicThread, recoverThread } = require('../src/discord/thread-enrollment');
const { GATEWAY_CAPABILITIES, gatewayProcessStatus, main, pathsFor, threadEnroll } = require('../src/cli');
const { recordNativeAcknowledgment } = require('../src/acknowledgment');

const NATIVE = '9caa5d21-2169-429d-918b-5f08651b5dbd';
const SUCCESSOR = 'f8296579-092b-4503-bf98-1f3c2b6d4913';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-issue-thread-'));
  const state = new SurfaceState(path.join(dir, 'surface.sqlite'));
  state.setConfig({ operatorId: 'operator', guildId: 'guild', secretFile: path.join(dir, 'unused.secret') });
  state.bind({ channelId: '1000', guildId: 'guild', provider: 'codex', nativeId: NATIVE, workspace: dir });
  const sends = [], reactions = [], dispatched = [], fetched = [];
  const histories = new Map([['1000', []], ['2000', []]]);
  const channels = new Map();
  const makeChannel = (id, type) => ({
    id, guildId: 'guild', type, ...(type === ChannelType.PublicThread ? { parentId: '1000', locked: false, archived: false } : {}),
    isThread: () => type === ChannelType.PublicThread,
    permissionsFor: () => ({ has: () => true }),
    async send(options) { sends.push({ channelId: id, ...options }); return { id: `sent-${sends.length}` }; },
    messages: { async fetch(options) {
      if (typeof options === 'string') return { react: async reaction => reactions.push({ channelId: id, messageId: options, reaction }) };
      const history = histories.get(id);
      if (options.limit === 1 && !options.after) return history.slice(-1);
      return history.filter(message => !options.after || BigInt(message.id) > BigInt(options.after)).slice(0, options.limit);
    } }
  });
  const parent = makeChannel('1000', ChannelType.GuildText);
  const child = makeChannel('2000', ChannelType.PublicThread);
  channels.set(parent.id, parent); channels.set(child.id, child);
  const client = { user: { id: 'bot' }, on() {}, off() {}, async destroy() {},
    channels: { async fetch(id) { fetched.push(id); return channels.get(id) || null; } }
  };
  const gateway = new DiscordGateway({ state, client, providers: { codex: {
    async dispatch(message) {
      dispatched.push(message);
      recordNativeAcknowledgment(state, { provider: 'codex', messageId: message.id, nativeId: message.nativeId, generation: message.generation });
      return { status: 'submitted' };
    },
    async observe() { return { text: 'thread answer' }; }
  } }, recoveryOptions: { ordinaryNativePreflight: async () => true } });
  t.after(async () => { await gateway.stop(); state.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const message = (id, channel = child) => ({ id, guildId: 'guild', channelId: channel.id, content: 'thread question', author: { id: 'operator', bot: false }, channel });
  function ready(baseline = null) {
    state.enrollThread({ threadId: child.id, parentChannelId: parent.id, guildId: 'guild' }, state.getBinding(parent.id));
    state.setThreadBaseline(child.id, baseline, state.getBinding(parent.id));
    state.markThreadBoundary(child.id, THREAD_STATES.READY, 'fixture adoption', null, null, state.getBinding(parent.id));
    gateway.ready = true;
  }
  return { dir, state, parent, child, channels, client, gateway, histories, sends, reactions, dispatched, fetched, message, ready, makeChannel };
}

test('public enrollment command keeps parent owner and pending child until Gateway recovery', async t => {
  const f = fixture(t);
  let destroyed = 0, wakes = 0;
  class Client {
    constructor() { Object.assign(this, f.client); this.destroy = async () => destroyed++; }
    async login() {}
  }
  const result = await threadEnroll({ db: f.state.dbPath, 'state-dir': f.dir, 'channel-id': f.parent.id, 'thread-id': f.child.id }, {
    requireInstalled: () => ({ Client, GatewayIntentBits }), readSecret: () => 'disposable', print() {},
    requestGatewayRecovery: () => { wakes++; return { requested: true }; }
  });
  assert.equal(result.gatewayWake.requested, true);
  assert.equal(f.state.getThreadEnrollment(f.child.id).state, THREAD_STATES.PENDING);
  assert.equal(f.state.listBindings().length, 1);
  assert.equal(f.state.getBinding(f.parent.id).nativeId, NATIVE);
  assert.equal(wakes, 1); assert.equal(destroyed, 1);
  assert.equal(f.sends.length, 0);
});

test('enrollment refuses wrong parent, private thread, locked or unreadable channel', async t => {
  const f = fixture(t);
  for (const overrides of [{ parentId: 'elsewhere' }, { type: ChannelType.PrivateThread }, { locked: true }, { permissionsFor: () => null }]) {
    f.channels.set(f.child.id, { ...f.child, ...overrides });
    await assert.rejects(enrollPublicThread(f.state, f.client, f.parent.id, f.child.id));
    assert.equal(f.state.getThreadEnrollment(f.child.id), null);
  }
});

test('enrollment cancelled during Discord fetch cannot commit late', async t => {
  const f = fixture(t);
  const controller = new AbortController();
  const original = f.client.channels.fetch;
  f.client.channels.fetch = async id => {
    const channel = await original(id);
    if (id === f.child.id) controller.abort();
    return channel;
  };
  await assert.rejects(enrollPublicThread(f.state, f.client, f.parent.id, f.child.id, controller.signal), /stopped/);
  assert.equal(f.state.getThreadEnrollment(f.child.id), null);
});

test('live enrolled thread keeps native owner and sends receipt, eyes and answer to child', async t => {
  const f = fixture(t); f.ready();
  f.gateway.boundMessage(f.message('100'));
  await Promise.all([...f.gateway.inFlight]);
  await f.gateway.consumer.waitForNativeWork();
  await f.gateway.consumer.waitForReceipts();
  const stored = f.state.getMessage('100');
  assert.equal(stored.channelId, f.parent.id);
  assert.equal(stored.deliveryChannelId, f.child.id);
  assert.equal(stored.nativeId, NATIVE); assert.equal(stored.generation, 1);
  assert.equal(stored.state, MESSAGE_STATES.REPLIED);
  assert.equal(f.dispatched.length, 1);
  assert.ok(f.sends.some(send => send.content === 'thread answer'));
  assert.ok(f.reactions.some(reaction => reaction.reaction === '👀'));
  assert.ok([...f.sends, ...f.reactions].every(send => send.channelId === f.child.id));
  assert.equal(f.state.getIntakeWatermark(f.parent.id), null);
});

test('pending child holds live work, recovery deduplicates it and replies after child readiness', async t => {
  const f = fixture(t);
  f.state.enrollThread({ threadId: f.child.id, parentChannelId: f.parent.id, guildId: 'guild' }, f.state.getBinding(f.parent.id));
  f.gateway.ready = true;
  f.gateway.boundMessage(f.message('100'));
  await Promise.all([...f.gateway.inFlight]);
  await f.gateway.consumer.waitForReceipts();
  assert.equal(f.dispatched.length, 0);
  assert.ok([...f.sends, ...f.reactions].some(item => item.channelId === f.child.id));
  assert.equal(f.state.getMessage('100').state, MESSAGE_STATES.ACCEPTED);
  f.histories.set(f.child.id, [f.message('100')]);
  const controller = new AbortController();
  await f.gateway.recoverInbound(controller.signal, 'fixture');
  await f.gateway._reconcilePending(null, controller.signal, true);
  await f.gateway.consumer.waitForNativeWork();
  assert.equal(f.dispatched.length, 1);
  assert.equal(f.state.getMessage('100').state, MESSAGE_STATES.REPLIED);
  assert.equal(f.state.getThreadEnrollment(f.child.id).state, THREAD_STATES.READY);
  assert.equal(f.state.getBinding(f.parent.id).readiness, READINESS.READY);
});

test('archived unlocked thread backfills after its own cursor without unarchive operation', async t => {
  const f = fixture(t); f.ready('100'); f.child.archived = true;
  f.child.setArchived = async () => assert.fail('discovery must not unarchive');
  f.histories.set(f.child.id, [f.message('100'), f.message('101'), f.message('102')]);
  const controller = new AbortController();
  assert.equal(await recoverThread(f.gateway, f.state.getThreadEnrollment(f.child.id), controller.signal, f.gateway.lifecycleEpoch, waitForRecoveryOperation), true);
  assert.equal(f.state.getMessage('100'), null);
  assert.equal(f.state.getMessage('101').deliveryChannelId, f.child.id);
  assert.equal(f.state.getThreadEnrollment(f.child.id).recoveredThroughId, '102');
  assert.equal(f.state.getIntakeWatermark(f.parent.id), null);
  await f.gateway._reconcilePending(null, controller.signal, true);
  await f.gateway.consumer.waitForNativeWork();
  assert.equal(f.dispatched.length, 2);
  assert.ok(f.sends.every(send => send.channelId === f.child.id));
});

test('unavailable child does not demote parent or send accepted work to it', async t => {
  const f = fixture(t); f.ready();
  await f.gateway.consumer.intakeMessage(f.message('100'), false, null, f.state.getBinding(f.parent.id));
  f.child.locked = true;
  const controller = new AbortController();
  const result = await f.gateway.recoverInbound(controller.signal, 'fixture');
  assert.equal(result.ready, true);
  assert.equal(f.state.getBinding(f.parent.id).readiness, READINESS.READY);
  assert.equal(f.state.getThreadEnrollment(f.child.id).state, THREAD_STATES.UNAVAILABLE);
  await f.gateway._reconcilePending(null, controller.signal, true);
  assert.equal(f.dispatched.length, 0); assert.equal(f.sends.length, 0);
  assert.equal(f.state.getMessage('100').state, MESSAGE_STATES.ACCEPTED);
});

test('terminal child work releases its native owner after route demotion', { timeout: 3000 }, async t => {
  const f = fixture(t); f.ready();
  let observeStarted;
  let releaseObserve;
  const started = new Promise(resolve => { observeStarted = resolve; });
  const gate = new Promise(resolve => { releaseObserve = resolve; });
  f.gateway.providers.codex.observe = async message => {
    if (message.id === '100') {
      observeStarted();
      await gate;
    }
    return { text: 'thread answer' };
  };

  f.gateway.boundMessage(f.message('100'));
  await started;
  f.gateway.boundMessage(f.message('101', f.parent));
  f.state.markThreadBoundary(f.child.id, THREAD_STATES.UNAVAILABLE, 'child route demoted during native work', null, null, f.state.getBinding(f.parent.id));
  releaseObserve();
  await Promise.all([...f.gateway.inFlight]);
  await f.gateway.consumer.waitForNativeWork();

  assert.deepEqual(f.dispatched.map(message => message.id), ['100', '101']);
  assert.equal(f.state.getMessage('100').state, MESSAGE_STATES.REPLIED);
  assert.equal(f.state.getMessage('101').state, MESSAGE_STATES.REPLIED);
});

test('thread checkpoint delivers recovered custody without an unrelated wake', async t => {
  const f = fixture(t); f.ready('100');
  f.histories.set(f.child.id, [f.message('101')]);
  f.gateway.beginLiveCheckpoint(new Map([[f.child.id, 1]]));
  await f.gateway.liveCheckpointPromise;
  await f.gateway.consumer.waitForNativeWork();
  assert.equal(f.state.getThreadEnrollment(f.child.id).recoveredThroughId, '101');
  assert.equal(f.state.getThreadEnrollment(f.child.id).state, THREAD_STATES.READY);
  assert.equal(f.state.getMessage('101').state, MESSAGE_STATES.REPLIED);
  assert.deepEqual(f.dispatched.map(message => message.id), ['101']);
  assert.deepEqual(f.sends.map(message => message.channelId), [f.child.id]);
  assert.equal(f.state.getIntakeWatermark(f.parent.id), null);
});

test('child checkpoint preserves a concurrent scoped recovery', { timeout: 5000 }, async t => {
  const f = fixture(t); f.ready('100');
  f.histories.set(f.child.id, [f.message('101')]);
  const other = f.makeChannel('3000', ChannelType.GuildText);
  f.channels.set(other.id, other);
  f.histories.set(other.id, [f.message('901', other)]);
  const binding = f.state.bind({ channelId: other.id, guildId: 'guild', provider: 'codex', nativeId: SUCCESSOR, workspace: f.dir });
  f.state.acceptDiscordMessage({ id: '901', guildId: 'guild', channelId: other.id, authorId: 'operator', isBot: false, content: 'other owner' }, { ready: true, expectedBinding: binding });
  let checkpointReady, releaseCheckpoint, recoveryStarted, releaseRecovery;
  const checkpointReached = new Promise(resolve => { checkpointReady = resolve; });
  const checkpointGate = new Promise(resolve => { releaseCheckpoint = resolve; });
  const recoveryReached = new Promise(resolve => { recoveryStarted = resolve; });
  const recoveryGate = new Promise(resolve => { releaseRecovery = resolve; });
  const checkpointHealthy = f.gateway.checkpointHealthyIntake.bind(f.gateway);
  f.gateway.checkpointHealthyIntake = async (...args) => {
    const result = await checkpointHealthy(...args);
    checkpointReady();
    await checkpointGate;
    return result;
  };
  const fetchChannel = f.client.channels.fetch;
  f.client.channels.fetch = async id => {
    if (id === other.id) { recoveryStarted(); await recoveryGate; }
    return fetchChannel(id);
  };
  f.gateway.beginLiveCheckpoint(new Map([[f.child.id, 1]]));
  const checkpoint = f.gateway.liveCheckpointPromise;
  await checkpointReached;
  const recovery = (async () => {
    await f.gateway.recoverTransport('concurrent owner recovery', f.gateway.lifecycleEpoch, new Set([other.id]));
    await f.gateway.reconcilePending(undefined, { channelIds: [other.id] });
  })();
  try {
    await recoveryReached;
    releaseCheckpoint();
    releaseRecovery();
    await Promise.all([checkpoint, recovery]);
    await f.gateway.consumer.waitForNativeWork();
    assert.equal(f.state.getMessage('101').state, MESSAGE_STATES.REPLIED);
    assert.equal(f.state.getMessage('901').state, MESSAGE_STATES.REPLIED);
    assert.deepEqual(f.dispatched.map(message => message.id).sort(), ['101', '901']);
  } finally {
    releaseCheckpoint(); releaseRecovery();
    await Promise.allSettled([checkpoint, recovery]);
  }
});

test('cancelled child checkpoint preserves custody without dispatching late', async t => {
  const f = fixture(t); f.ready('100');
  f.histories.set(f.child.id, [f.message('101')]);
  const checkpointHealthy = f.gateway.checkpointHealthyIntake.bind(f.gateway);
  f.gateway.checkpointHealthyIntake = async (...args) => {
    const result = await checkpointHealthy(...args);
    f.gateway.pauseConnection('checkpoint cancellation control');
    return result;
  };
  f.gateway.beginLiveCheckpoint(new Map([[f.child.id, 1]]));
  await f.gateway.liveCheckpointPromise;
  await f.gateway.consumer.waitForNativeWork();
  assert.equal(f.state.getMessage('101').state, MESSAGE_STATES.ACCEPTED);
  assert.deepEqual(f.dispatched, []);
  assert.deepEqual(f.sends, []);
});

for (const exit of ['disconnect', 'stop']) {
  test(`waiting reconciliation preserves custody on ${exit}`, { timeout: 5000 }, async t => {
    const f = fixture(t); f.ready('100');
    f.state.acceptDiscordMessage({ id: '101', guildId: 'guild', channelId: f.child.id, authorId: 'operator', isBot: false, content: 'held custody' },
      { ready: true, expectedBinding: f.state.getBinding(f.parent.id) });
    let reached, release;
    const fetching = new Promise(resolve => { reached = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const fetchChannel = f.client.channels.fetch;
    f.client.channels.fetch = async id => { reached(); await gate; return fetchChannel(id); };
    const first = f.gateway.reconcilePending(undefined, { channelIds: [f.child.id] });
    await fetching;
    const waiting = f.gateway.reconcilePending(undefined, { channelIds: [f.child.id] });
    try {
      if (exit === 'stop') await f.gateway.stop();
      else f.gateway.pauseConnection('waiting recovery cancellation control');
      await Promise.all([first, waiting]);
      release();
      await f.gateway.consumer.waitForNativeWork();
      assert.equal(f.state.getMessage('101').state, MESSAGE_STATES.ACCEPTED);
      assert.deepEqual(f.dispatched, []);
      assert.deepEqual(f.sends, []);
    } finally {
      release();
      await Promise.allSettled([first, waiting]);
    }
  });
}

test('global recovery preserves admission order across separate native owners', async t => {
  const f = fixture(t); f.ready('100');
  const other = f.makeChannel('3000', ChannelType.GuildText);
  f.channels.set(other.id, other);
  f.state.bind({ channelId: other.id, guildId: 'guild', provider: 'codex', nativeId: SUCCESSOR, workspace: f.dir });
  for (const [id, channel] of [['900', f.parent], ['101', other]]) {
    f.state.acceptDiscordMessage({ id, guildId: 'guild', channelId: channel.id, authorId: 'operator', isBot: false, content: 'owner recovery' },
      { ready: true, expectedBinding: f.state.getBinding(channel.id) });
  }
  await f.gateway.reconcilePending();
  await f.gateway.consumer.waitForNativeWork();
  assert.deepEqual(f.dispatched.map(message => message.id), ['900', '101']);
  assert.equal(f.state.getMessage('900').state, MESSAGE_STATES.REPLIED);
  assert.equal(f.state.getMessage('101').state, MESSAGE_STATES.REPLIED);
});

test('child recovery attempts share one deadline across sequential children', async t => {
  const f = fixture(t);
  f.ready('100');
  const second = { ...f.child, id: '2001', parentId: f.parent.id };
  f.channels.set(second.id, second);
  f.histories.set(second.id, []);
  second.messages = { async fetch(options) {
    const history = f.histories.get(second.id);
    if (options.limit === 1 && !options.after) return history.slice(-1);
    return history.filter(message => !options.after || BigInt(message.id) > BigInt(options.after)).slice(0, options.limit);
  } };
  const binding = f.state.getBinding(f.parent.id);
  f.state.enrollThread({ threadId: second.id, parentChannelId: f.parent.id, guildId: 'guild' }, binding);
  f.state.setThreadBaseline(second.id, '100', binding);
  f.state.markThreadBoundary(second.id, THREAD_STATES.READY, 'fixture adoption', null, null, binding);
  f.gateway.recoveryTimeoutMs = 1200;
  const calls = [];
  f.gateway.fetchHistory = async channel => {
    calls.push(channel.id);
    await new Promise(resolve => setTimeout(resolve, 1300));
    return [];
  };
  const started = Date.now();
  const advanced = await f.gateway.checkpointHealthyIntake(
    new AbortController().signal,
    f.gateway.lifecycleEpoch,
    new Map([[f.child.id, 1], [second.id, 1]])
  );
  const elapsed = Date.now() - started;
  assert.equal(advanced.size, 0);
  assert.deepEqual(calls, [f.child.id]);
  assert.ok(elapsed < 2200, `shared deadline elapsed ${elapsed}ms`);
  assert.equal(f.state.getThreadEnrollment(f.child.id).recoveredThroughId, '100');
  assert.equal(f.state.getThreadEnrollment(second.id).recoveredThroughId, '100');
});

test('thread recovery keeps an untouched child pending after deadline exhaustion', async t => {
  const f = fixture(t); f.ready('100');
  const result = await recoverThread(
    f.gateway,
    f.state.getThreadEnrollment(f.child.id),
    new AbortController().signal,
    f.gateway.lifecycleEpoch,
    waitForRecoveryOperation,
    false,
    Date.now() - 1
  );
  assert.equal(result, false);
  assert.equal(f.state.getThreadEnrollment(f.child.id).state, THREAD_STATES.PENDING);
  assert.equal(f.fetched.length, 0);
  assert.equal(f.dispatched.length, 0);
  await recoverThread(f.gateway, f.state.getThreadEnrollment(f.child.id), new AbortController().signal, f.gateway.lifecycleEpoch, waitForRecoveryOperation);
  assert.equal(f.state.getThreadEnrollment(f.child.id).state, THREAD_STATES.READY);
});

test('closing recovery refuses READY when live child custody overtakes its final page', async t => {
  const f = fixture(t);
  f.ready('100');
  f.gateway.historyPageLimit = 1;
  let calls = 0;
  f.gateway.fetchHistory = async () => {
    calls += 1;
    if (calls === 1) return [f.message('101')];
    const live = f.state.acceptDiscordMessage({
      id: '102',
      guildId: 'guild',
      channelId: f.child.id,
      authorId: 'operator',
      isBot: false,
      content: 'arrived during recovery',
      attachments: []
    }, { ready: false, expectedBinding: f.state.getBinding(f.parent.id) });
    assert.equal(live.accepted, true);
    return [];
  };
  const result = await recoverThread(
    f.gateway,
    f.state.getThreadEnrollment(f.child.id),
    new AbortController().signal,
    f.gateway.lifecycleEpoch,
    waitForRecoveryOperation
  );
  const enrollment = f.state.getThreadEnrollment(f.child.id);
  assert.equal(result, false);
  assert.equal(enrollment.state, THREAD_STATES.GAP);
  assert.equal(enrollment.gapTo, '102');
  assert.equal(calls, 2);
  assert.equal(f.state.getBinding(f.parent.id).readiness, READINESS.READY);
});

test('thread recovery keeps pre-existing custody ahead fenced until history catches up', async t => {
  const f = fixture(t); f.ready('100');
  const accepted = f.state.acceptDiscordMessage({
    id: '102', guildId: 'guild', channelId: f.child.id, authorId: 'operator', isBot: false,
    content: 'thread question', attachments: []
  }, {
    ready: false,
    expectedBinding: f.state.getBinding(f.parent.id)
  });
  assert.equal(accepted.accepted, true);
  f.gateway.fetchHistory = async () => [];
  const result = await recoverThread(
    f.gateway,
    f.state.getThreadEnrollment(f.child.id),
    new AbortController().signal,
    f.gateway.lifecycleEpoch,
    waitForRecoveryOperation
  );
  const enrollment = f.state.getThreadEnrollment(f.child.id);
  assert.equal(result, false);
  assert.equal(enrollment.state, THREAD_STATES.GAP);
  assert.equal(enrollment.gapTo, '102');
});

test('checkpoint-only recovery reports no advancement when history has no new messages', async t => {
  const f = fixture(t);
  f.ready('100');
  f.gateway.fetchHistory = async () => [];
  const advanced = await f.gateway.checkpointHealthyIntake(
    new AbortController().signal,
    f.gateway.lifecycleEpoch,
    new Map([[f.child.id, 1]])
  );
  assert.equal(advanced.has(f.child.id), false);
  assert.equal(f.state.getThreadEnrollment(f.child.id).recoveredThroughId, '100');
});

test('failed child lookup leaves accepted reply definitely unsent and marks child unavailable', async t => {
  const f = fixture(t);
  f.ready();
  const stored = f.state.acceptDiscordMessage({
    id: '100',
    guildId: 'guild',
    channelId: f.child.id,
    authorId: 'operator',
    isBot: false,
    content: 'thread question',
    attachments: []
  }, { expectedBinding: f.state.getBinding(f.parent.id) }).message;
  const originalFetch = f.client.channels.fetch;
  f.client.channels.fetch = async id => {
    if (id === f.child.id) throw new Error('child fetch failed');
    return originalFetch(id);
  };
  await assert.rejects(
    f.gateway.sendReply(stored, { id: '100', replyText: 'answer', replyNonce: 'reply-100' }),
    error => error.outcome === 'not_sent' && error.message === 'child fetch failed'
  );
  assert.equal(f.sends.length, 0);
  assert.equal(f.state.getThreadEnrollment(f.child.id).state, THREAD_STATES.UNAVAILABLE);
  assert.equal(f.state.getMessage('100').state, MESSAGE_STATES.ACCEPTED);
});

test('recover child CLI wake requests the thread-specific Gateway capability', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-cli-thread-recover-'));
  const db = path.join(dir, 'surface.sqlite');
  const state = new SurfaceState(db);
  state.setConfig({ operatorId: 'operator', guildId: 'guild', secretFile: path.join(dir, 'unused.secret') });
  const binding = state.bind({ channelId: 'parent', guildId: 'guild', provider: 'codex', nativeId: NATIVE, workspace: dir });
  state.enrollThread({ threadId: 'child', parentChannelId: 'parent', guildId: 'guild' }, binding);
  state.close();
  const paths = pathsFor({ 'state-dir': dir, db });
  const cliPath = path.resolve(__dirname, '..', 'src', 'cli.js');
  const title = `${process.execPath} ${cliPath} run --state-dir ${paths.stateDir}`;
  const fakeGateway = require('node:child_process').spawn(process.execPath, ['-e',
    `process.title=${JSON.stringify(title)}; process.on('SIGUSR2', () => {}); setTimeout(() => process.exit(0), 5000);`
  ], { stdio: 'ignore' });
  fs.writeFileSync(paths.pid, JSON.stringify({
    pid: fakeGateway.pid,
    guildId: 'guild',
    stateDir: paths.stateDir,
    db: paths.db,
    command: 'run',
    startedAt: new Date().toISOString(),
    capabilities: [GATEWAY_CAPABILITIES.ordinaryBindWake]
  }), { mode: 0o600 });
  t.after(async () => {
    if (fakeGateway.exitCode === null && fakeGateway.signalCode === null) fakeGateway.kill('SIGTERM');
    if (fakeGateway.exitCode === null && fakeGateway.signalCode === null) {
      await new Promise(resolve => {
        const timer = setTimeout(() => { try { fakeGateway.kill('SIGKILL'); } catch {} resolve(); }, 1000);
        fakeGateway.once('exit', () => { clearTimeout(timer); resolve(); });
      });
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const statusDeadline = Date.now() + 1000;
  while (Date.now() < statusDeadline && gatewayProcessStatus(paths).state !== 'running') {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(gatewayProcessStatus(paths).state, 'running');
  const originalArgv = process.argv;
  let output = '';
  const originalWrite = process.stdout.write;
  process.argv = [process.execPath, cliPath, 'recover', '--state-dir', dir, '--db', db, '--intake-channel-id', 'child'];
  process.stdout.write = chunk => { output += String(chunk); return true; };
  try {
    await main();
  } finally {
    process.argv = originalArgv;
    process.stdout.write = originalWrite;
  }
  const result = JSON.parse(output);
  assert.deepEqual(result.gatewayWake, {
    requested: false,
    pid: fakeGateway.pid,
    state: 'running',
    reason: 'gateway-wake-unsupported',
    capability: GATEWAY_CAPABILITIES.threadEnrollmentRecoveryWake
  });
});


test('history bounds and cancellation preserve custody without touching parent', async t => {
  const f = fixture(t); f.ready('100');
  f.gateway.historyPageLimit = 1; f.gateway.historyMaxPages = 1;
  f.histories.set(f.child.id, [f.message('101'), f.message('102')]);
  const controller = new AbortController();
  await recoverThread(f.gateway, f.state.getThreadEnrollment(f.child.id), controller.signal, f.gateway.lifecycleEpoch, waitForRecoveryOperation);
  assert.equal(f.state.getThreadEnrollment(f.child.id).state, THREAD_STATES.GAP);
  assert.equal(f.state.getMessage('101').state, MESSAGE_STATES.ACCEPTED);
  assert.equal(f.state.getMessage('102'), null);
  assert.equal(f.state.getBinding(f.parent.id).readiness, READINESS.READY);
  controller.abort();
  assert.equal(await recoverThread(f.gateway, f.state.getThreadEnrollment(f.child.id), controller.signal, f.gateway.lifecycleEpoch, waitForRecoveryOperation), false);
});

test('enrollment fetched under predecessor cannot claim successor authority', async t => {
  const f = fixture(t);
  const original = f.client.channels.fetch;
  f.client.channels.fetch = async id => {
    const channel = await original(id);
    if (id === f.child.id) f.state.rebind({ channelId: f.parent.id, guildId: 'guild', provider: 'codex', nativeId: SUCCESSOR, workspace: f.dir });
    return channel;
  };
  await assert.rejects(enrollPublicThread(f.state, f.client, f.parent.id, f.child.id));
  assert.equal(f.state.getThreadEnrollment(f.child.id), null);
});

test('persisted child receipt uses child REST destination even when authority field is parent', async t => {
  const f = fixture(t); f.ready();
  await f.gateway.consumer.intakeMessage(f.message('100'), true);
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    requests.push({ url, method: options.method });
    return { ok: true, status: 204, body: { async cancel() {} } };
  };
  try {
    f.gateway.discordToken = 'disposable-test-token';
    f.client.rest = {};
    await f.gateway.sendTransportReceipt(f.state.getMessage('100'), { reaction: '📥' });
    assert.equal(requests.length, 1);
    assert.ok(requests[0].url.includes(`/channels/${f.child.id}/messages/100/reactions/`));
    assert.equal(requests[0].method, 'PUT');
    assert.equal(f.state.getMessage('100').channelId, f.parent.id);
  } finally {
    globalThis.fetch = originalFetch;
    f.gateway.discordToken = null;
    delete f.client.rest;
  }
});

test('child transport receipt preserves a definite not-sent lookup outcome', async t => {
  const f = fixture(t); f.ready();
  f.gateway.sendTransportReceipt = async () => {
    throw Object.assign(new Error('child lookup failed'), { outcome: 'not_sent' });
  };
  const intake = await f.gateway.consumer.intakeMessage(
    f.message('100'),
    true,
    null,
    f.state.getBinding(f.parent.id),
    true
  );
  assert.equal(intake.accepted, true);
  await f.gateway.consumer.waitForReceipts();
  assert.equal(f.state.getTransportReceipt('100').outcome.outcome, 'not_sent');
});

test('late child delivery failure cannot demote a successor enrollment', async t => {
  const f = fixture(t); f.ready();
  f.gateway.boundMessage(f.message('100'));
  await Promise.all([...f.gateway.inFlight]);
  await f.gateway.consumer.waitForNativeWork();
  await f.gateway.consumer.waitForReceipts();
  const stored = f.state.getMessage('100');
  assert.equal(stored.state, MESSAGE_STATES.REPLIED);

  let startFetch;
  let rejectFetch;
  const fetchStarted = new Promise(resolve => { startFetch = resolve; });
  const originalFetch = f.client.channels.fetch;
  f.client.channels.fetch = async id => {
    if (id === f.child.id) {
      startFetch();
      return new Promise((_resolve, reject) => { rejectFetch = reject; });
    }
    return originalFetch(id);
  };
  try {
    const receipt = f.gateway.sendTransportReceipt(stored, { reaction: '👀', targetMessageId: stored.id });
    await fetchStarted;

    const original = f.state.getBinding(f.parent.id);
    const successor = f.state.rebind({ ...original, nativeId: SUCCESSOR, readiness: READINESS.READY });
    assert.equal(successor.generation, original.generation + 1);
    assert.equal(f.state.getThreadEnrollment(f.child.id).state, THREAD_STATES.READY);

    rejectFetch(new Error('late child lookup failed'));
    await assert.rejects(receipt, /late child lookup failed/);
    assert.equal(f.state.getThreadEnrollment(f.child.id).state, THREAD_STATES.READY);
  } finally {
    f.client.channels.fetch = originalFetch;
  }
});

test('unbound Gateway traffic does not throw or dispatch native work', async t => {
  const f = fixture(t); f.gateway.ready = true;
  const unbound = { ...f.parent, id: '3000' };
  assert.doesNotThrow(() => f.gateway.boundMessage(f.message('100', unbound)));
  await Promise.all([...f.gateway.inFlight]);
  assert.equal(f.state.getMessage('100'), null);
  assert.equal(f.dispatched.length, 0);
});

test('accepted reply survives temporary parent and child recovery readiness', async t => {
  const f = fixture(t); f.ready();
  await f.gateway.consumer.intakeMessage(f.message('100'), true);
  f.state.claimDispatch('100'); f.state.markSubmitted('100');
  f.state.recordNativeReply({ provider: 'codex', messageId: '100', nativeId: NATIVE, generation: 1, text: 'accepted answer' });
  f.state.markThreadBoundary(f.child.id, THREAD_STATES.PENDING, 'reconnect', null, null, f.state.getBinding(f.parent.id));
  f.state.setBindingReadiness(f.parent.id, READINESS.RECOVERING, 'reconnect');
  const result = await f.gateway.consumer.deliverReply(f.state.getMessage('100'), {
    status: MESSAGE_STATES.REPLY_READY, message: f.state.getMessage('100')
  });
  assert.equal(result.message.state, MESSAGE_STATES.REPLIED);
  assert.ok(f.sends.some(send => send.channelId === f.child.id && send.content === 'accepted answer'));
});

test('initial adoption excludes old thread backlog without executing it', async t => {
  const f = fixture(t);
  await enrollPublicThread(f.state, f.client, f.parent.id, f.child.id);
  f.histories.set(f.child.id, [f.message('100')]);
  await recoverThread(f.gateway, f.state.getThreadEnrollment(f.child.id), new AbortController().signal, f.gateway.lifecycleEpoch, waitForRecoveryOperation);
  assert.equal(f.state.getMessage('100'), null);
  assert.equal(f.state.getThreadEnrollment(f.child.id).adoptedThroughId, '100');
  assert.equal(f.state.getThreadEnrollment(f.child.id).state, THREAD_STATES.READY);
  assert.equal(f.dispatched.length, 0);
});

test('empty adoption baseline retains live child custody as the history cursor', async t => {
  const f = fixture(t);
  await enrollPublicThread(f.state, f.client, f.parent.id, f.child.id);
  const binding = f.state.getBinding(f.parent.id);
  let calls = 0;
  f.gateway.fetchHistory = async () => {
    calls += 1;
    if (calls === 1) {
      const live = f.state.acceptDiscordMessage({
        id: '101', guildId: 'guild', channelId: f.child.id, authorId: 'operator', isBot: false,
        content: 'live child question', attachments: []
      }, { ready: false, expectedBinding: binding });
      assert.equal(live.accepted, true);
      return [];
    }
    return [f.message('50')];
  };
  await recoverThread(f.gateway, f.state.getThreadEnrollment(f.child.id), new AbortController().signal, f.gateway.lifecycleEpoch, waitForRecoveryOperation);
  assert.equal(f.state.getMessage('50'), null);
  assert.equal(f.state.getThreadEnrollment(f.child.id).recoveredThroughId, '101');
  assert.equal(f.state.getMessage('101').state, MESSAGE_STATES.ACCEPTED);
});

test('adoption baseline transaction keeps custody that arrives after the fetched snapshot', async t => {
  const f = fixture(t);
  await enrollPublicThread(f.state, f.client, f.parent.id, f.child.id);
  let baselineRead = true;
  f.gateway.fetchHistory = async (_channel, options) => {
    if (baselineRead && options.limit === 1 && !options.after) {
      baselineRead = false;
      return [f.message('50')];
    }
    return options.after === '102' ? [] : [f.message('51'), f.message('101')];
  };
  const setThreadBaseline = f.state.setThreadBaseline.bind(f.state);
  f.state.setThreadBaseline = (threadId, latestId, binding) => {
    const live = f.state.acceptDiscordMessage({
      id: '102', guildId: 'guild', channelId: f.child.id, authorId: 'operator', isBot: false,
      content: 'thread question', attachments: []
    }, { ready: false, expectedBinding: binding });
    assert.equal(live.accepted, true);
    return setThreadBaseline(threadId, latestId, binding);
  };
  const result = await recoverThread(
    f.gateway,
    f.state.getThreadEnrollment(f.child.id),
    new AbortController().signal,
    f.gateway.lifecycleEpoch,
    waitForRecoveryOperation
  );
  const enrollment = f.state.getThreadEnrollment(f.child.id);
  assert.equal(result, true);
  assert.equal(enrollment.adoptedThroughId, '102');
  assert.equal(enrollment.recoveredThroughId, '102');
  assert.equal(f.state.getMessage('51'), null);
  assert.equal(f.state.getMessage('101'), null);
  assert.equal(f.state.getMessage('102').state, MESSAGE_STATES.ACCEPTED);
});

test('missing or invalid history reader cannot falsely prove an empty ready thread', async t => {
  const f = fixture(t);
  await enrollPublicThread(f.state, f.client, f.parent.id, f.child.id);
  delete f.child.messages;
  const controller = new AbortController();
  await recoverThread(f.gateway, f.state.getThreadEnrollment(f.child.id), controller.signal, f.gateway.lifecycleEpoch, waitForRecoveryOperation);
  assert.equal(f.state.getThreadEnrollment(f.child.id).state, THREAD_STATES.UNAVAILABLE);
  assert.equal(f.state.getThreadEnrollment(f.child.id).adoptedAt, null);
  f.state.reconcileIntake(f.child.id);
  f.gateway.fetchHistoryInjected = true;
  f.gateway.fetchHistory = async () => undefined;
  await recoverThread(f.gateway, f.state.getThreadEnrollment(f.child.id), controller.signal, f.gateway.lifecycleEpoch, waitForRecoveryOperation);
  assert.equal(f.state.getThreadEnrollment(f.child.id).state, THREAD_STATES.UNAVAILABLE);
  assert.equal(f.state.getThreadEnrollment(f.child.id).adoptedAt, null);
  assert.equal(f.state.getBinding(f.parent.id).readiness, READINESS.READY);
});

test('reopened custody dispatches once and reconciles the stored child destination', async t => {
  const f = fixture(t); f.ready('100');
  await f.gateway.consumer.intakeMessage(f.message('101'), true);
  f.histories.set(f.child.id, [f.message('101')]);
  await f.gateway.consumer.waitForReceipts();
  await f.gateway.stop();
  const reopened = new SurfaceState(f.state.dbPath);
  let dispatches = 0;
  const restarted = new DiscordGateway({ state: reopened, client: f.client, providers: { codex: {
    async dispatch(message) {
      dispatches++;
      recordNativeAcknowledgment(reopened, { provider: 'codex', messageId: message.id, nativeId: message.nativeId, generation: message.generation });
      return { status: 'submitted' };
    },
    async observe() { return { text: 'recovered child answer' }; }
  } }, recoveryOptions: { ordinaryNativePreflight: async () => true } });
  try {
    const signal = new AbortController().signal;
    await restarted.recoverInbound(signal, 'restart');
    f.fetched.length = 0;
    await restarted._reconcilePending(null, signal, true);
    await restarted.consumer.waitForNativeWork();
    await restarted._reconcilePending(null, signal, true);
    assert.equal(dispatches, 1);
    assert.equal(reopened.getMessage('101').state, MESSAGE_STATES.REPLIED);
    assert.equal(reopened.getMessage('101').nativeId, NATIVE);
    assert.equal(reopened.getThreadEnrollment(f.child.id).adoptedThroughId, '100');
    assert.ok(f.fetched.length > 0 && f.fetched.every(id => id === f.child.id));
    assert.equal(f.sends.filter(send => send.content === 'recovered child answer' && send.channelId === f.child.id).length, 1);
  } finally {
    await restarted.stop();
    reopened.close();
  }
});

test('recovery admits same-owner parent and child history in Discord order', async t => {
  const f = fixture(t); f.ready('100');
  const binding = f.state.getBinding(f.parent.id);
  f.state.setBindingReadiness(f.parent.id, READINESS.READY, 'fixture ready', binding);
  const parentMessage = f.state.acceptDiscordMessage({
    id: '102', guildId: 'guild', channelId: f.parent.id, authorId: 'operator', isBot: false,
    content: 'parent question', attachments: []
  }, {
    ready: true,
    expectedBinding: binding
  });
  const childMessage = f.state.acceptDiscordMessage({
    id: '101', guildId: 'guild', channelId: f.child.id, authorId: 'operator', isBot: false,
    content: 'child question', attachments: []
  }, {
    ready: true,
    expectedBinding: binding
  });
  assert.equal(parentMessage.accepted, true);
  assert.equal(childMessage.accepted, true);
  await f.gateway._reconcilePending(null, new AbortController().signal, true);
  await f.gateway.consumer.waitForNativeWork();
  assert.deepEqual(f.dispatched.map(message => message.id), ['101', '102']);
});

test('recovery preserves owner order when another owner is interleaved', async t => {
  const f = fixture(t); f.ready('100');
  const other = f.makeChannel('3000', ChannelType.GuildText);
  f.channels.set(other.id, other);
  f.state.bind({ channelId: other.id, guildId: 'guild', provider: 'codex', nativeId: SUCCESSOR, workspace: f.dir });
  for (const [id, channel] of [['102', f.parent], ['900', other], ['101', f.child]]) {
    const binding = f.state.getMessageRoute(channel.id).binding;
    const accepted = f.state.acceptDiscordMessage({
      id, guildId: 'guild', channelId: channel.id, authorId: 'operator', isBot: false,
      content: 'ordered recovery question', attachments: []
    }, { ready: true, expectedBinding: binding });
    assert.equal(accepted.accepted, true);
  }
  await f.gateway._reconcilePending(null, new AbortController().signal, true);
  await f.gateway.consumer.waitForNativeWork();
  assert.deepEqual(f.dispatched.filter(message => message.nativeId === NATIVE).map(message => message.id), ['101', '102']);
  assert.deepEqual(f.dispatched.filter(message => message.nativeId === SUCCESSOR).map(message => message.id), ['900']);
  for (const id of ['101', '102', '900']) assert.equal(f.state.getMessage(id).state, MESSAGE_STATES.REPLIED);
});

test('parent handoff waits for child custody then new child work inherits successor', async t => {
  const f = fixture(t); f.ready('100');
  await f.gateway.consumer.intakeMessage(f.message('101'), true);
  const successor = { channelId: f.parent.id, guildId: 'guild', provider: 'codex', nativeId: SUCCESSOR, workspace: f.dir };
  assert.throws(() => f.state.rebind(successor), /drains/);
  assert.equal(f.state.getMessage('101').generation, 1);
  const signal = new AbortController().signal;
  await f.gateway._reconcilePending(null, signal, true);
  await f.gateway.consumer.waitForNativeWork();
  assert.equal(f.state.getMessage('101').state, MESSAGE_STATES.REPLIED);
  f.state.rebind(successor);
  f.state.setBindingReadiness(f.parent.id, READINESS.READY, 'successor ready');
  f.gateway.boundMessage(f.message('102'));
  await Promise.all([...f.gateway.inFlight]);
  await f.gateway.consumer.waitForNativeWork();
  assert.equal(f.state.getMessage('101').nativeId, NATIVE);
  assert.equal(f.state.getMessage('102').nativeId, SUCCESSOR);
  assert.equal(f.state.getMessage('102').generation, 2);
  assert.equal(f.state.getMessage('102').state, MESSAGE_STATES.REPLIED);
  assert.equal(f.state.listBindings().length, 1);
  assert.ok(f.sends.every(send => send.channelId === f.child.id));
});


test('public recovery preserves a direct binding after its enrollment is retired', async t => {
  const f = fixture(t); f.ready('100');
  f.state.unbind(f.parent.id);
  const direct = f.state.bind({ channelId: f.child.id, guildId: 'guild', provider: 'codex', nativeId: SUCCESSOR, workspace: f.dir });
  f.state.markIntakeBoundary(f.child.id, READINESS.PENDING, 'fixture recovery', null, null, direct);
  const originalArgv = process.argv;
  const originalWrite = process.stdout.write;
  let output = '';
  process.argv = [process.execPath, require.resolve('../src/cli'), 'recover', '--state-dir', f.dir,
    '--db', f.state.dbPath, '--intake-channel-id', f.child.id];
  process.stdout.write = chunk => { output += String(chunk); return true; };
  try { await main(); } finally { process.argv = originalArgv; process.stdout.write = originalWrite; }
  const result = JSON.parse(output);
  assert.equal(result.channel_id, f.child.id);
  assert.equal(Object.hasOwn(result, 'enrollment'), false);
  assert.equal(Object.hasOwn(result, 'gatewayWake'), false);
  assert.equal(f.state.getBinding(f.child.id).nativeId, SUCCESSOR);
  assert.equal(f.state.getThreadEnrollment(f.child.id).active, false);
});

test('restoring a parent pause dispatches its held child once to the original owner', async t => {
  const f = fixture(t); f.ready('100');
  const binding = f.state.getBinding(f.parent.id);
  f.state.pauseOrdinaryHandoffIntake(f.parent.id, binding);
  f.gateway.boundMessage(f.message('101'));
  await Promise.all([...f.gateway.inFlight]);
  await f.gateway.consumer.waitForReceipts();
  assert.equal(f.dispatched.length, 0);
  assert.equal(f.state.getMessage('101').state, MESSAGE_STATES.ACCEPTED);
  f.state.restoreOrdinaryHandoffIntake(f.parent.id, binding);
  await f.gateway._reconcilePending(null, new AbortController().signal, true);
  await f.gateway.consumer.waitForNativeWork();
  assert.equal(f.dispatched.length, 1);
  assert.equal(f.dispatched[0].nativeId, NATIVE);
  assert.equal(f.dispatched[0].generation, binding.generation);
  assert.equal(f.state.getMessage('101').state, MESSAGE_STATES.REPLIED);
  assert.ok(f.sends.every(send => send.channelId === f.child.id));
  await f.gateway._reconcilePending(null, new AbortController().signal, true);
  assert.equal(f.dispatched.length, 1);
  assert.equal(f.state.unbind(f.parent.id, { expectedBinding: binding }), true);
});

test('deadline expiring before the first fetch leaves unattempted child custody pending', async t => {
  const f = fixture(t); f.ready('100');
  const deadline = Date.now() + 60000;
  const waitAtDeadline = async (operation, signal, until) => {
    const originalNow = Date.now;
    Date.now = () => until;
    try { return await waitForRecoveryOperation(operation, signal, until); }
    finally { Date.now = originalNow; }
  };
  await recoverThread(f.gateway, f.state.getThreadEnrollment(f.child.id), new AbortController().signal,
    f.gateway.lifecycleEpoch, waitAtDeadline, false, deadline);
  assert.equal(f.fetched.length, 0);
  assert.equal(f.state.getThreadEnrollment(f.child.id).state, THREAD_STATES.PENDING);
});

test('live child accepted while checkpoint reconciliation waits reaches native delivery', { timeout: 5000 }, async t => {
  const f = fixture(t); f.ready('100');
  f.histories.set(f.child.id, [f.message('101')]);
  const other = f.makeChannel('3000', ChannelType.GuildText);
  f.channels.set(other.id, other);
  f.histories.set(other.id, [f.message('901', other)]);
  const binding = f.state.bind({ channelId: other.id, guildId: 'guild', provider: 'codex', nativeId: SUCCESSOR, workspace: f.dir });
  f.state.acceptDiscordMessage({ id: '901', guildId: 'guild', channelId: other.id, authorId: 'operator', isBot: false, content: 'other' }, { ready: true, expectedBinding: binding });
  let checkpointReady, releaseCheckpoint, recoveryStarted, releaseRecovery, waiting;
  const checkpointReached = new Promise(r => { checkpointReady = r; });
  const checkpointGate = new Promise(r => { releaseCheckpoint = r; });
  const recoveryReached = new Promise(r => { recoveryStarted = r; });
  const recoveryGate = new Promise(r => { releaseRecovery = r; });
  const waitingReached = new Promise(r => { waiting = r; });
  const checkpointHealthy = f.gateway.checkpointHealthyIntake.bind(f.gateway);
  f.gateway.checkpointHealthyIntake = async (...args) => { const result = await checkpointHealthy(...args); checkpointReady(); await checkpointGate; return result; };
  const reconcile = f.gateway.reconcilePending.bind(f.gateway);
  f.gateway.reconcilePending = (...args) => { const promise = reconcile(...args); if(args[1]?.channelIds?.includes(f.child.id)) waiting(); return promise; };
  const fetchChannel = f.client.channels.fetch;
  f.client.channels.fetch = async id => { if(id === other.id) { recoveryStarted(); await recoveryGate; } return fetchChannel(id); };
  f.gateway.beginLiveCheckpoint(new Map([[f.child.id, 1]]));
  const checkpoint = f.gateway.liveCheckpointPromise;
  await checkpointReached;
  const recovery = (async () => { await f.gateway.recoverTransport('ordinary-handoff', f.gateway.lifecycleEpoch, new Set([other.id])); await f.gateway.reconcilePending(undefined, { channelIds: [other.id] }); })();
  try {
    await recoveryReached; releaseCheckpoint(); await waitingReached;
    await new Promise(r => setTimeout(r, 20));
    f.gateway.boundMessage(f.message('102'));
    assert.ok(f.state.getMessage('102'));
    releaseRecovery();
    await Promise.all([checkpoint, recovery]);
    await Promise.all([...f.gateway.inFlight]);
    await f.gateway.consumer.waitForNativeWork();
    assert.deepEqual(f.dispatched.filter(m => m.nativeId === NATIVE).map(m => m.id), ['101', '102']);
    for (const id of ['101', '102', '901']) assert.equal(f.state.getMessage(id).state, MESSAGE_STATES.REPLIED);
    assert.equal(f.sends.filter(m => m.channelId === f.child.id).length, 2);
  } finally { releaseCheckpoint(); releaseRecovery(); await Promise.allSettled([checkpoint, recovery]); }
});

test('later parent arrival cannot release an already blocked child route', { timeout: 3000 }, async t => {
 const f = fixture(t); f.ready('99');
 const claim = f.state.claimDispatch.bind(f.state);
 let changed = false;
 f.state.claimDispatch = id => {
   if(id === '100' && !changed) { changed = true; f.state.markThreadBoundary(f.child.id, THREAD_STATES.PENDING, 'concurrent boundary', null, null, f.state.getBinding(f.parent.id)); }
   return claim(id);
 };
 f.gateway.boundMessage(f.message('100'));
 f.gateway.boundMessage(f.message('101', f.parent));
 const other = f.makeChannel('3000', ChannelType.GuildText);
 f.channels.set(other.id, other); f.histories.set(other.id, []);
 f.state.bind({ channelId: other.id, guildId: 'guild', provider: 'codex', nativeId: SUCCESSOR, workspace: f.dir });
 f.gateway.boundMessage(f.message('901', other));
 await new Promise(r => setTimeout(r, 40));
 await f.gateway.consumer.waitForNativeWork();
 assert.equal(changed, true);
 assert.deepEqual(f.dispatched.filter(m => m.nativeId === NATIVE).map(m=>m.id), []);
 assert.deepEqual(f.dispatched.filter(m => m.nativeId === SUCCESSOR).map(m=>m.id), ['901']);
 f.gateway.boundMessage(f.message('102', f.parent));
 await new Promise(resolve => setTimeout(resolve, 40));
 assert.deepEqual(f.dispatched.filter(m => m.nativeId === NATIVE).map(m=>m.id), []);
 f.state.markThreadBoundary(f.child.id, THREAD_STATES.READY, 'explicit recovery complete', null, null, f.state.getBinding(f.parent.id));
 await f.gateway.reconcilePending(undefined, { readyOnly: true, channelIds: [f.child.id] });
 await Promise.all([...f.gateway.inFlight]);
 await f.gateway.consumer.waitForNativeWork();
 assert.deepEqual(f.dispatched.filter(m => m.nativeId === NATIVE).map(m=>m.id), ['100', '101', '102']);
 for (const id of ['100','101','102','901']) assert.equal(f.state.getMessage(id).state, MESSAGE_STATES.REPLIED);
 assert.equal(f.sends.filter(m => m.channelId === f.child.id).length, 1);
 assert.equal(f.sends.filter(m => m.channelId === f.parent.id).length, 2);
});

test('old enrolled receipt cannot finish under a new direct binding', { timeout: 5000 }, async t => {
  const f = fixture(t); f.ready('100');
  f.gateway.boundMessage(f.message('101'));
  await Promise.all([...f.gateway.inFlight]);
  await f.gateway.consumer.waitForNativeWork();
  await f.gateway.consumer.waitForReceipts();
  const stored = f.state.getMessage('101');
  assert.equal(stored.state, MESSAGE_STATES.REPLIED);
  const parent = f.state.getBinding(f.parent.id);
  const before = f.reactions.length;
  const fetch = f.client.channels.fetch;
  let release, entered;
  const blocked = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  f.client.channels.fetch = async id => { if (id === f.child.id) { entered(); await blocked; } return fetch(id); };
  const pending = f.gateway.sendTransportReceipt(stored, { reaction: 'eyes-control', targetMessageId: stored.id });
  try {
    await started;
    assert.equal(f.state.unbind(f.parent.id, { expectedBinding: parent }), true);
    const direct = f.state.bind({ channelId: f.child.id, guildId: 'guild', provider: 'codex', nativeId: parent.nativeId, workspace: f.dir });
    assert.equal(direct.generation, stored.generation);
    release();
    await assert.rejects(pending, /message binding generation is stale/);
  } finally { release(); f.client.channels.fetch = fetch; }
  assert.equal(f.reactions.length, before, 'old authority must not publish a receipt after parent retirement');
});

test('checkpoint deadline before recursive fetch retains a bounded recovery wake', { timeout: 5000 }, async t => {
  const f = fixture(t); f.ready('100');
  f.gateway.liveCheckpointThreshold = 50;
  f.histories.set(f.child.id, [f.message('101')]);
  const originalNow = Date.now;
  const hasEvidence = f.state.hasIntakeEvidence.bind(f.state);
  let expired = false;
  f.state.hasIntakeEvidence = id => {
    const exists = hasEvidence(id);
    if (!exists && !expired) { expired = true; const later = originalNow() + f.gateway.recoveryTimeoutMs + 10; Date.now = () => later; }
    return exists;
  };
  try {
    f.gateway.beginLiveCheckpoint(new Map([[f.child.id, 50]]));
    await f.gateway.liveCheckpointPromise;
  } finally { Date.now = originalNow; f.state.hasIntakeEvidence = hasEvidence; }
  assert.equal(expired, true);
  assert.equal(f.state.getThreadEnrollment(f.child.id).state, THREAD_STATES.PENDING);
  f.histories.set(f.child.id, [f.message('101'), f.message('102')]);
  f.gateway.boundMessage(f.message('102'));
  await Promise.all([...f.gateway.inFlight]);
  await f.gateway.consumer.waitForReceipts();
  const retry = f.gateway.liveCheckpointPromise || f.gateway.recoveryPromise;
  if (retry) await retry;
  await f.gateway.consumer.waitForNativeWork();
  assert.equal(f.state.getThreadEnrollment(f.child.id).state, THREAD_STATES.READY);
  assert.deepEqual(f.dispatched.map(message => message.id), ['101', '102']);
  for (const id of ['101', '102']) assert.equal(f.state.getMessage(id).state, MESSAGE_STATES.REPLIED);
});

async function pendingScenario(t, secondDeadline) {
  const f = fixture(t);
  let checkpointStarts = 0;
  const checkpointEntries = [];
  const originalBegin = f.gateway.beginLiveCheckpoint.bind(f.gateway);
  let capped = null;
  f.gateway.beginLiveCheckpoint = function(counts = new Map(), ...options) {
    checkpointStarts++;
    const entry = { start: checkpointStarts, at: performance.now(), channels: [...counts.keys()] };
    if (checkpointStarts <= 4 || checkpointStarts === 64) checkpointEntries.push(entry);
    if (checkpointStarts === 64) {
      capped = { counts: [...counts], live: [...this.liveIntakeCounts], recovery: Boolean(this.recoveryPromise) };
      return;
    }
    return originalBegin(counts, ...options);
  };
  f.gateway.recoveryTimeoutMs = 30;
  const slowChild = f.makeChannel('1500', ChannelType.PublicThread);
  if (secondDeadline) {
    f.channels.set(slowChild.id, slowChild);
    f.histories.set(slowChild.id, []);
    f.state.enrollThread({ threadId: slowChild.id, parentChannelId: f.parent.id, guildId: 'guild' }, f.state.getBinding(f.parent.id));
  }
  f.state.enrollThread({ threadId: f.child.id, parentChannelId: f.parent.id, guildId: 'guild' }, f.state.getBinding(f.parent.id));
  f.state.setThreadBaseline(f.child.id, '100', f.state.getBinding(f.parent.id));
  f.histories.set(f.child.id, [f.message('101')]);
  f.gateway.boundMessage(f.message('101'));
  await Promise.all([...f.gateway.inFlight]);
  await f.gateway.consumer.waitForReceipts();
  const slowParent = f.makeChannel('3000', ChannelType.GuildText);
  f.channels.set(slowParent.id, slowParent);
  f.histories.set(slowParent.id, []);
  f.state.bind({ channelId: slowParent.id, guildId: 'guild', provider: 'codex', nativeId: SUCCESSOR, workspace: f.dir });
  const fetch = f.client.channels.fetch;
  let slowParentCalls = 0;
  let slowChildCalls = 0;
  f.client.channels.fetch = async id => {
    if (id === slowParent.id) { slowParentCalls++; await new Promise(resolve => setTimeout(resolve, 60)); }
    if (secondDeadline && id === slowChild.id && slowChildCalls++ === 0) await new Promise(resolve => setTimeout(resolve, 60));
    return fetch(id);
  };
  await f.gateway.recoverTransport('reconnect');
  const firstRetry = f.gateway.liveCheckpointPromise;
  if (firstRetry) await firstRetry;
  await new Promise(resolve => setTimeout(resolve, 120));
  await f.gateway.consumer.waitForReceipts();
  await f.gateway.consumer.waitForNativeWork();
  const snapshot = {
    secondDeadline, checkpointStarts, checkpointEntries, capped, slowParentCalls, slowChildCalls, firstRetryStarted: Boolean(firstRetry),
    parentState: f.state.getBinding(f.parent.id).readiness,
    childState: f.state.getThreadEnrollment(f.child.id).state,
    messageState: f.state.getMessage('101').state,
    dispatched: f.dispatched.map(message => message.id),
    checkpointActive: Boolean(f.gateway.liveCheckpointPromise),
    recoveryActive: Boolean(f.gateway.recoveryPromise),
    heldCount: f.gateway.liveIntakeCounts.get(f.child.id)
  };
  assert.equal(capped, null, 'checkpoint recursion exceeded fixed 64-entry observation cap');
  assert.equal(snapshot.childState, THREAD_STATES.READY);
  assert.equal(snapshot.messageState, MESSAGE_STATES.REPLIED);
  assert.deepEqual(snapshot.dispatched, ['101']);
}

test('untouched pending child resumes after one shared deadline without arrival', { timeout: 3000 }, async t => {
  await pendingScenario(t, false);
});

test('healthy pending child is not stranded after an earlier retry consumes the deadline', { timeout: 3000 }, async t => {
  await pendingScenario(t, true);
});

test('live arrivals respect an existing checkpoint retry timer', { timeout: 3000 }, async t => {
  const f = fixture(t);
  f.ready('100');
  let calls = 0;
  f.gateway.checkpointHealthyIntake = async () => { calls++; return new Set(); };
  f.gateway.beginLiveCheckpoint(new Map([[f.child.id, f.gateway.liveCheckpointThreshold]]));
  await f.gateway.liveCheckpointPromise;
  assert.ok(f.gateway.liveCheckpointRetryTimer);
  const initialCalls = calls;
  for (let index = 0; index < 5; index++) {
    f.gateway.noteLiveIntake(f.message(String(101 + index)));
    if (f.gateway.liveCheckpointPromise) await f.gateway.liveCheckpointPromise;
  }
  f.gateway.liveIntakeCounts.set(f.child.id, f.gateway.liveCheckpointThreshold);
  f.gateway.scheduleHeldLiveCheckpoints();
  assert.equal(calls, initialCalls, 'arrivals must not bypass the pending retry delay');
});
