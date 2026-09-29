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
const { PREFIX } = require('../src/agent-message');
const { startReconciliationLookup } = require('../dist/discord/reconciliation-lookups');

function insertLegacyParentRequest(f, id) {
  const binding = f.state.getBinding(f.parent.id);
  const packet = {
    id: `legacy-${id}`,
    kind: 'request',
    source: { guildId: f.parent.guildId, channelId: '3000', provider: 'claude', nativeId: '11111111-1111-1111-1111-111111111111', generation: 1 },
    target: { guildId: f.parent.guildId, channelId: f.parent.id, provider: binding.provider, nativeId: binding.nativeId, generation: binding.generation },
    replyTo: null,
    text: 'legacy parent request'
  };
  const timestamp = new Date().toISOString();
  f.state.db.prepare(`INSERT INTO messages(discord_id, guild_id, channel_id, delivery_channel_id, author_id, content, attachments,
    provider, native_id, workspace, endpoint, conductor_id, repo_key, generation, state, created_at, updated_at)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    id, f.parent.guildId, f.parent.id, f.parent.id, 'operator', `${PREFIX}legacy`, '[]', binding.provider, binding.nativeId,
    binding.workspace, binding.endpoint, binding.conductorId, binding.repoKey, binding.generation, MESSAGE_STATES.ACCEPTED,
    timestamp, timestamp
  );
  f.state.receipt(id, 'agent-message', { packet, authorId: 'operator' });
  f.state.receipt(id, 'accepted', { channelId: f.parent.id, generation: binding.generation, readiness: 'ready' });
}
const { fixture, NATIVE, SUCCESSOR } = require('./issue-thread-fixture');
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
  assert.equal(f.state.getIntakeWatermark(f.parent.id).recovered_through_id, '0');
});

test('enrolled child bot attachment failure fences only child recovery', async t => {
  let fetchCalls = 0;
  const f = fixture(t, {
    agentAttachmentFetch: async () => {
      fetchCalls += 1;
      throw new Error('CDN unavailable');
    }
  });
  f.ready();
  const message = {
    ...f.message('101'),
    content: 'readable child bot attachment preview',
    author: { id: 'bot', bot: true },
    attachments: [{
      url: 'https://cdn.discordapp.com/attachments/1000/2000/agent-message.tether',
      filename: 'agent-message.tether',
      contentType: 'application/octet-stream',
      size: 64
    }]
  };

  f.gateway.boundMessage(message);
  await Promise.all([...f.gateway.inFlight]);

  assert.equal(fetchCalls, 1);
  assert.equal(f.state.getIntakeWatermark(f.parent.id).recovered_through_id, '0');
  assert.equal(f.state.getBinding(f.parent.id).readiness, READINESS.READY);
  assert.equal(f.state.getThreadEnrollment(f.child.id).state, THREAD_STATES.GAP);
  assert.equal(f.state.getThreadEnrollment(f.child.id).lastSeenId, null);
  assert.equal(f.state.getMessage(message.id), null);
  assert.deepEqual(f.dispatched, []);
  assert.deepEqual(f.sends, []);
  assert.deepEqual(f.reactions, []);
  assert.equal(f.gateway.attachmentIntakeRetryMessages.get(f.child.id)?.binding.channelId, f.parent.id);
  assert.equal(f.gateway.attachmentIntakeBlockedChannels.has(f.child.id), true);
});

test('pending child holds live work, recovery deduplicates it and replies after child readiness', async t => {
  const f = fixture(t);
  f.state.enrollThread({ threadId: f.child.id, parentChannelId: f.parent.id, guildId: 'guild' , adoptionCutoff: '0'}, f.state.getBinding(f.parent.id));
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

test('live checkpoint wakes a legacy parent request held before child readiness', async t => {
  const f = fixture(t);
  const binding = f.state.getBinding(f.parent.id);
  insertLegacyParentRequest(f, 'legacy-checkpoint-parent');
  assert.equal(f.state.claimDispatch('legacy-checkpoint-parent').reason, 'legacy-agent-route-not-unique');
  f.state.enrollThread({ threadId: f.child.id, parentChannelId: f.parent.id, guildId: 'guild', adoptionCutoff: '0' }, binding);
  f.gateway.ready = true;
  f.histories.set(f.child.id, []);
  f.gateway.beginLiveCheckpoint(new Map([[f.child.id, 1]]));
  await f.gateway.liveCheckpointPromise;
  await f.gateway.consumer.waitForNativeWork();
  assert.equal(f.state.getThreadEnrollment(f.child.id).state, THREAD_STATES.READY);
  assert.equal(f.state.getMessage('legacy-checkpoint-parent').agentRoute, f.child.id);
  assert.deepEqual(f.dispatched.map(message => message.id), ['legacy-checkpoint-parent']);
});

test('child-scoped reconciliation includes its legacy parent custody', async t => {
  const f = fixture(t);
  const binding = f.state.getBinding(f.parent.id);
  insertLegacyParentRequest(f, 'legacy-child-scope-parent');
  assert.equal(f.state.claimDispatch('legacy-child-scope-parent').reason, 'legacy-agent-route-not-unique');
  f.state.enrollThread({ threadId: f.child.id, parentChannelId: f.parent.id, guildId: 'guild', adoptionCutoff: '0' }, binding);
  f.state.setThreadBaseline(f.child.id, null, binding);
  f.state.markThreadBoundary(f.child.id, THREAD_STATES.READY, 'fixture ready', null, null, binding);
  f.gateway.ready = true;
  await f.gateway.reconcilePending(undefined, { readyOnly: true, channelIds: [f.child.id] });
  await f.gateway.consumer.waitForNativeWork();
  assert.equal(f.state.getMessage('legacy-child-scope-parent').agentRoute, f.child.id);
  assert.deepEqual(f.dispatched.map(message => message.id), ['legacy-child-scope-parent']);
});

test('thread demotion wakes an ambiguous legacy parent when one sibling remains', async t => {
  const f = fixture(t);
  const binding = f.state.getBinding(f.parent.id);
  insertLegacyParentRequest(f, 'legacy-demotion-parent');
  const sibling = f.makeChannel('3000', ChannelType.PublicThread);
  f.channels.set(sibling.id, sibling);
  f.histories.set(sibling.id, []);
  for (const threadId of [f.child.id, sibling.id]) {
    f.state.enrollThread({ threadId, parentChannelId: f.parent.id, guildId: 'guild', adoptionCutoff: '0' }, binding);
    f.state.setThreadBaseline(threadId, null, binding);
    f.state.markThreadBoundary(threadId, THREAD_STATES.READY, 'fixture ready', null, null, binding);
  }
  f.gateway.ready = true;
  assert.equal(f.state.claimDispatch('legacy-demotion-parent').reason, 'legacy-agent-route-not-unique');
  const timestamp = new Date().toISOString();
  f.state.db.prepare(`INSERT INTO messages(discord_id, guild_id, channel_id, delivery_channel_id, author_id, content, attachments,
    provider, native_id, workspace, endpoint, conductor_id, repo_key, generation, state, created_at, updated_at)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    'legacy-demotion-probe', f.parent.guildId, f.parent.id, f.child.id, 'operator', 'probe', '[]', binding.provider,
    binding.nativeId, binding.workspace, binding.endpoint, binding.conductorId, binding.repoKey, binding.generation,
    MESSAGE_STATES.ACCEPTED, timestamp, timestamp
  );
  f.gateway.markThreadDeliveryUnavailable(f.state.getMessage('legacy-demotion-probe'), new Error('child fetch failed'));
  await new Promise(resolve => setImmediate(resolve));
  await f.gateway.recoveryPromise;
  await f.gateway.consumer.waitForNativeWork();
  assert.equal(f.state.getThreadEnrollment(f.child.id).state, THREAD_STATES.UNAVAILABLE);
  assert.equal(f.state.getMessage('legacy-demotion-parent').agentRoute, sibling.id);
  assert.deepEqual(f.dispatched.map(message => message.id), ['legacy-demotion-parent']);
});

test('bound message demotion wakes an ambiguous legacy parent when one sibling remains', async t => {
  const f = fixture(t);
  const binding = f.state.getBinding(f.parent.id);
  insertLegacyParentRequest(f, 'legacy-bound-demotion-parent');
  const sibling = f.makeChannel('3000', ChannelType.PublicThread);
  f.channels.set(sibling.id, sibling);
  f.histories.set(sibling.id, []);
  for (const threadId of [f.child.id, sibling.id]) {
    f.state.enrollThread({ threadId, parentChannelId: f.parent.id, guildId: 'guild', adoptionCutoff: '0' }, binding);
    f.state.setThreadBaseline(threadId, null, binding);
    f.state.markThreadBoundary(threadId, THREAD_STATES.READY, 'fixture ready', null, null, binding);
  }
  f.gateway.ready = true;
  assert.equal(f.state.claimDispatch('legacy-bound-demotion-parent').reason, 'legacy-agent-route-not-unique');
  f.child.locked = true;
  f.state.setThreadBoundaryObserver(null);
  f.gateway.boundMessage(f.message('legacy-bound-demotion-child'));
  await new Promise(resolve => setImmediate(resolve));
  await f.gateway.recoveryPromise;
  await f.gateway.consumer.waitForNativeWork();
  assert.equal(f.state.getThreadEnrollment(f.child.id).state, THREAD_STATES.UNAVAILABLE);
  assert.equal(f.state.getMessage('legacy-bound-demotion-parent').agentRoute, sibling.id);
  assert.deepEqual(f.dispatched.map(message => message.id), ['legacy-bound-demotion-parent']);
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
  assert.equal(f.state.getIntakeWatermark(f.parent.id).recovered_through_id, '0');
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
  assert.equal(result.ready, false);
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
  assert.equal(f.state.getIntakeWatermark(f.parent.id).recovered_through_id, '0');
});

test('child checkpoint preserves a concurrent scoped recovery', { timeout: 5000 }, async t => {
  const f = fixture(t); f.ready('100');
  f.histories.set(f.child.id, [f.message('101')]);
  const other = f.makeChannel('3000', ChannelType.GuildText);
  f.channels.set(other.id, other);
  f.histories.set(other.id, [f.message('901', other)]);
  const binding = f.state.bind({ channelId: other.id, guildId: 'guild', provider: 'codex', nativeId: SUCCESSOR, workspace: f.dir }, { intakeCutoff: '100' });
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
  f.state.bind({ channelId: other.id, guildId: 'guild', provider: 'codex', nativeId: SUCCESSOR, workspace: f.dir }, { intakeCutoff: '100' });
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
  f.state.enrollThread({ threadId: second.id, parentChannelId: f.parent.id, guildId: 'guild' , adoptionCutoff: '100'}, binding);
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
