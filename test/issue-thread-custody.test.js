const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ChannelType, GatewayIntentBits } = require('discord.js');
const { SurfaceState, MESSAGE_STATES, READINESS } = require('../src/state');
const { THREAD_STATES } = require('../src/state/thread-enrollment');
const { DiscordGateway, waitForRecoveryOperation } = require('../src/discord');
const { enrollPublicThread, recoverThread, AdoptionRefusalError, ADOPTION_REFUSAL_DETAILS } = require('../src/discord/thread-enrollment');
const { GATEWAY_CAPABILITIES, gatewayProcessStatus, main, pathsFor, threadEnroll } = require('../src/cli');
const { recordNativeAcknowledgment } = require('../src/acknowledgment');
const { startReconciliationLookup } = require('../dist/discord/reconciliation-lookups');
const { fixture, NATIVE, SUCCESSOR } = require('./issue-thread-fixture');
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

test('timed-out child lookup keeps later same-owner custody behind it', { timeout: 5000 }, async t => {
  const f = fixture(t, { timeoutMs: 1000 }); f.ready('100');
  const binding = f.state.getBinding(f.parent.id);
  f.state.setBindingReadiness(f.parent.id, READINESS.READY, 'fixture ready', binding);
  const listEnrollments = f.state.listThreadEnrollments.bind(f.state);
  // Isolate the phase-2 lookup branch from the earlier thread-boundary fetch.
  f.state.listThreadEnrollments = () => [];
  for (const [id, channel] of [['101', f.child], ['102', f.parent]]) {
    const accepted = f.state.acceptDiscordMessage({
      id, guildId: 'guild', channelId: channel.id, authorId: 'operator', isBot: false,
      content: 'ordered recovery question', attachments: []
    }, { ready: true, expectedBinding: binding });
    assert.equal(accepted.accepted, true);
  }

  let releaseChildLookup;
  const childLookup = new Promise(resolve => { releaseChildLookup = resolve; });
  const fetchChannel = f.client.channels.fetch.bind(f.client.channels);
  const pendingChildLookup = startReconciliationLookup(f.client, f.child.id, 'seed', () => {
    return childLookup.then(() => fetchChannel(f.child.id));
  });
  t.after(() => {
    releaseChildLookup();
    f.state.listThreadEnrollments = listEnrollments;
  });

  const retryPromises = [];
  let retryStarted;
  const retryStartedPromise = new Promise(resolve => { retryStarted = resolve; });
  const reconcile = f.gateway.reconcilePending.bind(f.gateway);
  f.gateway.reconcilePending = (...args) => {
    const promise = reconcile(...args);
    if (args[1]?.messageIds) {
      retryPromises.push(promise);
      retryStarted();
    }
    return promise;
  };

  const initial = f.gateway.reconcilePending(undefined, { readyOnly: true });
  await initial;
  assert.deepEqual(f.dispatched, [], 'same-owner successor stays queued while lookup is unresolved');

  f.state.listThreadEnrollments = listEnrollments;
  f.histories.set(f.child.id, [f.message('101')]);
  releaseChildLookup();
  await retryStartedPromise;
  await pendingChildLookup;
  await Promise.all(retryPromises);
  await f.gateway.consumer.waitForNativeWork();
  assert.deepEqual(f.dispatched.map(message => message.id), ['101', '102']);
});

test('recovery preserves owner order when another owner is interleaved', async t => {
  const f = fixture(t); f.ready('100');
  const other = f.makeChannel('3000', ChannelType.GuildText);
  f.channels.set(other.id, other);
  f.state.bind({ channelId: other.id, guildId: 'guild', provider: 'codex', nativeId: SUCCESSOR, workspace: f.dir }, { intakeCutoff: '100' });
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

test('parent handoff waits for child custody then preserves successor child route', async t => {
  const f = fixture(t); f.ready('100');
  await f.gateway.consumer.intakeMessage(f.message('101'), true);
  const successor = { channelId: f.parent.id, guildId: 'guild', provider: 'codex', nativeId: SUCCESSOR, workspace: f.dir };
  assert.throws(() => f.state.rebind(successor), /drains/);
  assert.equal(f.state.getMessage('101').generation, 1);
  const signal = new AbortController().signal;
  await f.gateway._reconcilePending(null, signal, true);
  await f.gateway.consumer.waitForNativeWork();
  assert.equal(f.state.getMessage('101').state, MESSAGE_STATES.REPLIED);
  const rebound = f.state.rebind(successor, { intakeCutoff: '101' });
  assert.equal(f.state.getThreadEnrollment(f.child.id).active, true);
  assert.equal(f.state.getThreadEnrollment(f.child.id).state, THREAD_STATES.READY);
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
  const direct = f.state.bind({ channelId: f.child.id, guildId: 'guild', provider: 'codex', nativeId: SUCCESSOR, workspace: f.dir }, { intakeCutoff: '100' });
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
  // The parent's own watermark stays 'pending' from bind() until intake recovery
  // completes; without this the pause snapshot would capture 'pending' instead of the
  // binding's actual readiness and restore would downgrade readiness forever (D2).
  f.state.markIntakeBoundary(f.parent.id, READINESS.READY, 'fixture ready', null, null, binding);
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
  const binding = f.state.bind({ channelId: other.id, guildId: 'guild', provider: 'codex', nativeId: SUCCESSOR, workspace: f.dir }, { intakeCutoff: '100' });
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
    await new Promise(resolve => setImmediate(resolve));
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
 f.state.bind({ channelId: other.id, guildId: 'guild', provider: 'codex', nativeId: SUCCESSOR, workspace: f.dir }, { intakeCutoff: '100' });
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
