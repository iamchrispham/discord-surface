const test = require('node:test');
const assert = require('node:assert/strict');
const { SurfaceState, UnresolvedWorkError, MESSAGE_STATES, READINESS } = require('../src/state');
const { createSurfaceConsumer, DiscordGateway } = require('../src/discord');
const { conductorMarker } = require('../src/cli');
const { conductorMarkerMatches } = require('../src/topic');
const { CODEX_ID, SUCCESSOR_ID, fixture, discordMessage, historyPermissions, providers } = require('./surface-fixtures');

test('simulated: pending recovery channel fetch is bounded and stop settles without losing custody', async () => {
  const { dir, state } = fixture();
  state.bind({ channelId: 'channel-codex', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir });
  await createSurfaceConsumer({ state, providers: {}, sendReply: async () => ({ id: 'unused' }) })
    .intakeMessage(discordMessage({ id: 'pending-recovery', channelId: 'channel-codex' }), true);
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const client = {
    on() {},
    off() {},
    channels: { fetch: async () => blocked },
    async destroy() {}
  };
  const gateway = new DiscordGateway({ state, client, recoveryOptions: { timeoutMs: 1000 } });
  gateway.ready = true;
  let recoverySettled = false;
  const recovery = gateway.reconcilePending(new Date(Date.now() + 1).toISOString()).finally(() => { recoverySettled = true; });
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.equal(recoverySettled, true);
  let stopSettled = false;
  const stop = gateway.stop().finally(() => { stopSettled = true; });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(stopSettled, true);
  release(null);
  await Promise.all([recovery, stop]);
  assert.equal(state.getMessage('pending-recovery').state, MESSAGE_STATES.ACCEPTED);
  state.close();
});

test('simulated: static address survives successor handoff without a topic rewrite', async () => {
  const { dir, state } = fixture();
  state.bind({ channelId: 'handoff-recovery', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir, conductorId: 'handoff-recovery-conductor', repoKey: 'repo:alpha' });
  state.markIntakeBoundary('handoff-recovery', 'ready');
  const oldMarker = conductorMarker({ provider: 'codex', nativeId: CODEX_ID, conductorId: 'handoff-recovery-conductor', repoKey: 'repo:alpha', generation: 1, readiness: READINESS.READY });
  const channel = {
    id: 'handoff-recovery',
    topic: oldMarker,
    permissionsFor: () => historyPermissions(),
    async setTopic(topic) { this.topic = topic; }
  };
  const client = {
    user: { id: 'bot-1' },
    on() {},
    off() {},
    channels: { fetch: async () => channel },
    async destroy() {}
  };
  state.handoffConductor({
    channelId: 'handoff-recovery',
    provider: 'codex',
    conductorId: 'handoff-recovery-conductor',
    repoKey: 'repo:alpha',
    fromNativeId: CODEX_ID,
    fromGeneration: 1,
    nativeId: SUCCESSOR_ID,
    workspace: dir,
    handoffId: 'handoff-recovery-1'
  });
  let historyCalls = 0;
  const gateway = new DiscordGateway({ state, client, fetchHistory: async () => { historyCalls += 1; return []; } });
  const result = await gateway.recoverTransport('restart');
  assert.equal(result.ready, true);
  assert.equal(result.state, 'ready');
  assert.equal(state.getBinding('handoff-recovery').readiness, READINESS.READY);
  assert.equal(historyCalls, 1);
  assert.equal(channel.topic, oldMarker);
  await gateway.stop();
  state.close();
});

test('simulated: handoff during history fetch cannot authorize the successor', async () => {
  const { dir, state } = fixture();
  state.bind({ channelId: 'mid-fetch-handoff', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir, conductorId: 'mid-fetch-conductor', repoKey: 'repo:alpha' });
  state.setIntakeBaseline('mid-fetch-handoff', '100', 'previous completed recovery');
  state.markIntakeBoundary('mid-fetch-handoff', 'ready');
  const old = state.getBinding('mid-fetch-handoff');
  let topicWrites = 0;
  const channel = {
    id: 'mid-fetch-handoff',
    topic: conductorMarker({ provider: 'codex', nativeId: CODEX_ID, conductorId: 'mid-fetch-conductor', repoKey: 'repo:alpha', generation: 1, readiness: READINESS.READY }),
    permissionsFor: () => historyPermissions(),
    async setTopic(topic) { topicWrites += 1; this.topic = topic; }
  };
  const client = {
    user: { id: 'bot-1' },
    on() {},
    off() {},
    channels: { fetch: async () => channel },
    async destroy() {}
  };
  let historyCalls = 0;
  const gateway = new DiscordGateway({
    state,
    client,
    fetchHistory: async () => {
      historyCalls += 1;
      state.handoffConductor({ ...old, fromNativeId: old.nativeId, fromGeneration: old.generation, nativeId: SUCCESSOR_ID, handoffId: 'mid-fetch-handoff-1' });
      return [];
    }
  });
  const result = await gateway.recoverTransport('restart');
  const current = state.getBinding('mid-fetch-handoff');
  assert.equal(result.ready, false);
  assert.equal(result.state, 'unavailable');
  assert.equal(current.nativeId, SUCCESSOR_ID);
  assert.equal(current.generation, 2);
  assert.equal(current.readiness, READINESS.PENDING);
  assert.equal(historyCalls, 1);
  assert.equal(topicWrites, 0);
  assert.equal(channel.topic, conductorMarker({ provider: 'codex', nativeId: CODEX_ID, conductorId: 'mid-fetch-conductor', repoKey: 'repo:alpha', generation: 1, readiness: READINESS.READY }));
  await gateway.stop();
  state.close();
});

test('simulated: recovery and successor handoff share a static topic address', async () => {
  const { dir, state } = fixture();
  state.bind({ channelId: 'mid-topic-handoff', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir, conductorId: 'mid-topic-conductor', repoKey: 'repo:alpha' });
  state.setIntakeBaseline('mid-topic-handoff', '100', 'previous completed recovery');
  state.markIntakeBoundary('mid-topic-handoff', 'ready');
  const old = state.getBinding('mid-topic-handoff');
  let handedOff = false;
  const channel = {
    id: 'mid-topic-handoff',
    topic: conductorMarker({ provider: 'codex', nativeId: CODEX_ID, conductorId: 'mid-topic-conductor', repoKey: 'repo:alpha', generation: 1, readiness: READINESS.READY }),
    permissionsFor: () => historyPermissions(),
    async setTopic(topic) {
      if (!handedOff) {
        handedOff = true;
        try {
          state.handoffConductor({ ...old, fromNativeId: old.nativeId, fromGeneration: old.generation, nativeId: SUCCESSOR_ID, handoffId: 'mid-topic-handoff-1' });
        } catch (error) {
          assert.ok(error instanceof UnresolvedWorkError);
          throw error;
        }
      }
      this.topic = topic;
    }
  };
  const client = {
    user: { id: 'bot-1' },
    on() {},
    off() {},
    channels: { fetch: async () => channel },
    async destroy() {}
  };
  let historyCalls = 0;
  const gateway = new DiscordGateway({ state, client, fetchHistory: async () => { historyCalls += 1; return []; } });
  const result = await gateway.recoverTransport('restart');
  const current = state.getBinding('mid-topic-handoff');
  assert.equal(result.ready, true);
  assert.equal(result.state, 'ready');
  assert.equal(current.nativeId, CODEX_ID);
  assert.equal(current.generation, 1);
  assert.equal(current.readiness, READINESS.READY);
  assert.equal(historyCalls, 1);
  assert.equal(channel.topic, conductorMarker({ provider: 'codex', nativeId: CODEX_ID, conductorId: 'mid-topic-conductor', repoKey: 'repo:alpha' }));
  assert.equal(conductorMarkerMatches(channel.topic, { provider: 'codex', nativeId: SUCCESSOR_ID, conductorId: 'mid-topic-conductor', repoKey: 'repo:alpha', generation: 2 }), true);
  await gateway.stop();
  state.close();
});

test('simulated: terminal recovery does not create publication custody', async () => {
  const { dir, state } = fixture();
  state.bind({ channelId: 'terminal-topic-handoff', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir, conductorId: 'terminal-topic-conductor', repoKey: 'repo:alpha' });
  state.setIntakeBaseline('terminal-topic-handoff', '100', 'previous completed recovery');
  state.markIntakeBoundary('terminal-topic-handoff', 'ready');
  const old = state.getBinding('terminal-topic-handoff');
  let topicWrites = 0;
  const channel = {
    id: 'terminal-topic-handoff',
    topic: conductorMarker({ provider: 'codex', nativeId: CODEX_ID, conductorId: 'terminal-topic-conductor', repoKey: 'repo:alpha', generation: 1, readiness: READINESS.READY }),
    permissionsFor: () => historyPermissions(),
    async setTopic(topic) {
      topicWrites += 1;
      try {
        state.handoffConductor({ ...old, fromNativeId: old.nativeId, fromGeneration: old.generation, nativeId: SUCCESSOR_ID, handoffId: 'terminal-topic-handoff-1' });
      } catch (error) {
        assert.ok(error instanceof UnresolvedWorkError);
        throw error;
      }
      this.topic = topic;
    }
  };
  const client = {
    user: { id: 'bot-1' },
    on() {},
    off() {},
    channels: { fetch: async () => channel },
    async destroy() {}
  };
  const gateway = new DiscordGateway({ state, client, fetchHistory: async () => [] });
  const result = await gateway.recoverTransport('restart');
  const current = state.getBinding('terminal-topic-handoff');
  assert.equal(result.ready, true);
  assert.equal(result.state, 'ready');
  assert.equal(topicWrites, 0);
  assert.equal(current.nativeId, CODEX_ID);
  assert.equal(current.generation, 1);
  assert.equal(current.readiness, READINESS.READY);
  assert.equal(conductorMarkerMatches(channel.topic, { provider: 'codex', nativeId: SUCCESSOR_ID, conductorId: 'terminal-topic-conductor', repoKey: 'repo:alpha', generation: 2 }), true);
  assert.equal(state.getReadiness().legacyTopicPublications.length, 0);
  await gateway.stop();
  state.close();
});

test('simulated: old topic rate limits are irrelevant to static recovery', async () => {
  for (const [label, makeError, expectedOutcome] of [
    ['rate limit', () => Object.assign(new Error('RateLimitError[/channels/:id]'), { name: 'RateLimitError[/channels/:id]' }), 'rate_limited'],
    ['ambiguous send', () => Object.assign(new Error('socket closed after topic send'), { code: 'ECONNRESET' }), 'unknown']
  ]) {
    const { dir, state } = fixture();
    state.bind({ channelId: `topic-${label.replace(/\s/g, '-')}`, guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir, conductorId: `topic-${label}`, repoKey: 'repo:alpha' });
    const channelId = `topic-${label.replace(/\s/g, '-')}`;
    state.setIntakeBaseline(channelId, '100', 'previous completed recovery');
    state.markIntakeBoundary(channelId, 'ready');
    const marker = conductorMarker({ provider: 'codex', nativeId: CODEX_ID, conductorId: `topic-${label}`, repoKey: 'repo:alpha', generation: 1, readiness: READINESS.READY });
    const rest = { options: { rejectOnRateLimit: null }, async patch(route, options) {
      assert.equal(route, `/channels/${channelId}`);
      assert.equal(options.body.topic.includes('last-published-intake=ready'), true);
      assert.equal(rest.options.rejectOnRateLimit({ method: 'PATCH', route: '/channels/:id' }), true);
      throw makeError();
    } };
    const channel = { id: channelId, topic: marker, client: { rest }, permissionsFor: () => historyPermissions() };
    const client = { user: { id: 'bot-1' }, on() {}, off() {}, channels: { fetch: async () => channel }, async destroy() {} };
    let dispatches = 0;
    const gateway = new DiscordGateway({
      state,
      client,
      providers: { codex: { async dispatch() { dispatches += 1; return { status: 'submitted' }; }, async observe() { return { text: 'unused' }; } } },
      fetchHistory: async () => []
    });
    const result = await gateway.recoverTransport('restart');
    const watermark = state.getIntakeWatermark(channelId);
    const binding = state.getBinding(channelId);
    assert.equal(result.ready, true, label);
    assert.equal(result.state, 'ready', label);
    assert.equal(watermark.recovered_through_id, '100', label);
    assert.equal(watermark.state, READINESS.READY, label);
    assert.equal(binding.readiness, READINESS.READY, label);
    assert.equal(state.listTopicPublications().length, 0, label);
    assert.equal(rest.options.rejectOnRateLimit, null, label);
    const held = await gateway.consumer.handleMessage(discordMessage({ id: '101', channelId }));
    assert.equal(dispatches, 1, label);
    assert.equal(held.message.state, MESSAGE_STATES.REPLIED, label);
    await gateway.stop();
    state.close();
  }
});

test('simulated: uncooperative legacy topic clients are never called during recovery', async () => {
  const { dir, state } = fixture();
  const channelId = 'topic-deadline';
  state.bind({ channelId, guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir, conductorId: 'topic-deadline-conductor', repoKey: 'repo:alpha' });
  state.setIntakeBaseline(channelId, '100', 'previous completed recovery');
  state.markIntakeBoundary(channelId, 'ready');
  let topicCalls = 0;
  const rest = {
    options: { rejectOnRateLimit: null, retries: 3 },
    async patch() {
      topicCalls += 1;
      return new Promise(() => {});
    }
  };
  const channel = {
    id: channelId,
    topic: conductorMarker({ provider: 'codex', nativeId: CODEX_ID, conductorId: 'topic-deadline-conductor', repoKey: 'repo:alpha', generation: 1, readiness: READINESS.READY }),
    client: { rest },
    permissionsFor: () => historyPermissions()
  };
  const client = { user: { id: 'bot-1' }, on() {}, off() {}, channels: { fetch: async () => channel }, async destroy() {} };
  const gateway = new DiscordGateway({ state, client, recoveryOptions: { timeoutMs: 1000 }, fetchHistory: async () => [] });
  const started = Date.now();
  const result = await gateway.recoverTransport('restart');
  assert.ok(Date.now() - started < 1400);
  assert.equal(result.ready, true);
  assert.equal(result.state, 'ready');
  assert.equal(topicCalls, 0);
  assert.equal(rest.options.rejectOnRateLimit, null);
  assert.equal(rest.options.retries, 3);
  assert.equal(state.getIntakeWatermark(channelId).recovered_through_id, '100');
  assert.equal(state.getIntakeWatermark(channelId).state, READINESS.READY);
  assert.equal(state.getBinding(channelId).readiness, READINESS.READY);
  await gateway.stop();
  state.close();
});

test('simulated: unresolved legacy publication fences ownership changes, not local readiness', () => {
  const { dir, state } = fixture();
  state.bind({ channelId: 'topic-custody-guards', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir, conductorId: 'topic-custody-guards', repoKey: 'repo:alpha' });
  const binding = state.getBinding('topic-custody-guards');
  const custody = state.beginTopicPublication('topic-custody-guards', {
    desiredReadiness: READINESS.READY,
    desiredTopic: conductorMarker({ provider: 'codex', nativeId: CODEX_ID, conductorId: 'topic-custody-guards', repoKey: 'repo:alpha', generation: 1, readiness: READINESS.READY })
  }, binding);
  assert.equal(custody.status, 'in_flight');
  assert.throws(() => state.setBindingReadiness('topic-custody-guards', READINESS.READY), UnresolvedWorkError);
  assert.throws(() => state.markIntakeBoundary('topic-custody-guards', 'ready'), UnresolvedWorkError);
  assert.equal(state.getBinding('topic-custody-guards').readiness, READINESS.UNAVAILABLE);
  assert.throws(() => state.rebind({ channelId: 'topic-custody-guards', guildId: 'guild-1', provider: 'codex', nativeId: SUCCESSOR_ID, workspace: dir }), UnresolvedWorkError);
  assert.throws(() => state.unbind('topic-custody-guards'), UnresolvedWorkError);
  assert.throws(() => state.handoffConductor({
    channelId: 'topic-custody-guards', provider: 'codex', conductorId: 'topic-custody-guards', repoKey: 'repo:alpha',
    fromNativeId: CODEX_ID, fromGeneration: 1, nativeId: SUCCESSOR_ID, workspace: dir, handoffId: 'topic-custody-guards-handoff'
  }), UnresolvedWorkError);
  state.close();
});

test('simulated: legacy publication settlement cannot clear a newer intake gap', () => {
  const { dir, state } = fixture();
  const channelId = 'topic-restart-reconcile';
  state.bind({ channelId, guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir, conductorId: 'topic-restart-conductor', repoKey: 'repo:alpha' });
  const binding = state.getBinding(channelId);
  const desiredTopic = 'discord-surface:v2 conductor=topic-restart-conductor provider=codex repo=repo%3Aalpha native=' + CODEX_ID + ' generation=1 readiness=ready';
  const custody = state.beginTopicPublication(channelId, { desiredReadiness: READINESS.READY, desiredTopic }, binding);
  state.markIntakeBoundary(channelId, 'gap', 'newer history gap');
  state.recordTopicPublication(channelId, { requestId: custody.requestId, desiredReadiness: READINESS.READY, outcome: 'unknown', remoteTerminal: false }, binding);
  assert.equal(state.getBinding(channelId).readiness, READINESS.GAP);
  assert.equal(state.getIntakeWatermark(channelId).state, READINESS.GAP);
  assert.equal(state.getTopicPublication(custody.requestId).status, 'unknown');
  assert.throws(() => state.handoffConductor({
    channelId, provider: 'codex', conductorId: 'topic-restart-conductor', repoKey: 'repo:alpha',
    fromNativeId: CODEX_ID, fromGeneration: 1, nativeId: SUCCESSOR_ID, workspace: dir, handoffId: 'topic-restart-handoff'
  }), UnresolvedWorkError);
  state.close();
});

test('simulated: topic reconciliation requires remote terminal evidence and fresh readback', () => {
  const { dir, state } = fixture();
  const channelId = 'topic-reconcile-proof';
  state.bind({ channelId, guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir, conductorId: 'topic-reconcile-proof', repoKey: 'repo:alpha' });
  const binding = state.getBinding(channelId);
  const oldTopic = 'discord-surface:v2 conductor=topic-reconcile-proof provider=codex repo=repo%3Aalpha native=' + CODEX_ID + ' generation=1 readiness=pending';
  const desiredTopic = 'discord-surface:v2 conductor=topic-reconcile-proof provider=codex repo=repo%3Aalpha native=' + CODEX_ID + ' generation=1 readiness=ready';
  const custody = state.beginTopicPublication(channelId, { desiredReadiness: READINESS.READY, desiredTopic }, binding);
  state.recordTopicPublication(channelId, { requestId: custody.requestId, desiredReadiness: READINESS.READY, outcome: 'unknown', remoteTerminal: true, observedTopic: oldTopic }, binding);
  const operationEndedAt = state.getTopicPublication(custody.requestId).operationEndedAt;
  assert.ok(operationEndedAt);
  assert.throws(() => state.reconcileTopicPublication(channelId, custody.requestId, 'not_published', 'caller text'), /fresh topic readback is required/);
  assert.throws(() => state.reconcileTopicPublication(channelId, custody.requestId, 'not_published', 'caller text', {
    topic: desiredTopic,
    observedAt: new Date(Date.parse(operationEndedAt) + 1).toISOString()
  }), /confirms the desired publication/);
  state.reconcileTopicPublication(channelId, custody.requestId, 'not_published', 'Discord GET readback after remote terminal evidence', {
    topic: oldTopic,
    observedAt: new Date(Date.parse(operationEndedAt) + 1).toISOString()
  });
  assert.equal(state.getTopicPublication(custody.requestId).status, 'not_published');
  assert.equal(state.getBinding(channelId).readiness, READINESS.UNAVAILABLE);
  state.close();
});

test('simulated: explicit legacy adoption fails closed on unresolved publication custody', () => {
  const { dir, state } = fixture();
  const channelId = 'legacy-adoption';
  state.bind({ channelId, guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir, conductorId: 'legacy-adoption-conductor', repoKey: 'repo:alpha' });
  const binding = state.getBinding(channelId);
  const custody = state.beginTopicPublication(channelId, {
    desiredReadiness: READINESS.READY,
    desiredTopic: 'discord-surface:v2 conductor=legacy-adoption-conductor provider=codex repo=repo%3Aalpha native=' + CODEX_ID + ' generation=1 readiness=ready'
  }, binding);
  assert.equal(custody.status, 'in_flight');
  assert.throws(() => state.assertLegacyMigrationSafe(channelId), UnresolvedWorkError);
  state.recordTopicPublication(channelId, { requestId: custody.requestId, desiredReadiness: READINESS.READY, outcome: 'rejected', remoteTerminal: true }, binding);
  assert.doesNotThrow(() => state.assertLegacyMigrationSafe(channelId));
  assert.equal(state.getBinding(channelId).nativeId, CODEX_ID);
  state.close();
});

test('simulated: legacy publication audit cannot mutate successor readiness', () => {
  const { dir, state } = fixture();
  const channelId = 'topic-late-mutation';
  state.bind({ channelId, guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir, conductorId: 'topic-late-mutation', repoKey: 'repo:alpha' });
  const binding = state.getBinding(channelId);
  const desiredTopic = 'discord-surface:v2 conductor=topic-late-mutation provider=codex repo=repo%3Aalpha native=' + CODEX_ID + ' generation=1 readiness=ready';
  const custody = state.beginTopicPublication(channelId, { desiredReadiness: READINESS.READY, desiredTopic }, binding);
  state.recordTopicPublication(channelId, { requestId: custody.requestId, desiredReadiness: READINESS.READY, outcome: 'rate_limited', remoteTerminal: true }, binding);
  const successor = state.handoffConductor({
    channelId, provider: 'codex', conductorId: 'topic-late-mutation', repoKey: 'repo:alpha',
    fromNativeId: CODEX_ID, fromGeneration: 1, nativeId: SUCCESSOR_ID, workspace: dir, handoffId: 'topic-late-mutation-handoff'
  });
  assert.equal(successor.generation, 2);
  state.markIntakeBoundary(channelId, 'gap', 'successor history gap');
  state.recordTopicPublication(channelId, { requestId: custody.requestId, desiredReadiness: READINESS.READY, outcome: 'published', remoteTerminal: true }, binding);
  assert.equal(state.getBinding(channelId).nativeId, SUCCESSOR_ID);
  assert.equal(state.getBinding(channelId).readiness, READINESS.GAP);
  assert.equal(state.getIntakeWatermark(channelId).state, READINESS.GAP);
  state.close();
});

test('simulated: readiness transaction rejects a second-connection successor', () => {
  const { dir, db, state } = fixture();
  state.bind({ channelId: 'atomic-readiness', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir, conductorId: 'atomic-readiness-conductor', repoKey: 'repo:alpha' });
  const old = state.getBinding('atomic-readiness');
  const other = new SurfaceState(db);
  other.handoffConductor({ ...old, fromNativeId: old.nativeId, fromGeneration: old.generation, nativeId: SUCCESSOR_ID, handoffId: 'atomic-readiness-1' });
  assert.equal(state.setBindingReadiness('atomic-readiness', READINESS.RECOVERING, 'stale recovery', old), null);
  assert.equal(state.getBinding('atomic-readiness').readiness, READINESS.PENDING);
  other.close();
  state.close();
});
