const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { SurfaceState, MESSAGE_STATES, READINESS } = require('../src/state');
const { createSurfaceConsumer, DiscordGateway } = require('../src/discord');
const { conductorMarker } = require('../src/cli');
const { CODEX_ID, CLAUDE_ID, SUCCESSOR_ID, fixture, discordMessage, historyPermissions, providers } = require('./surface-fixtures');

test('simulated: handoff rechecks unresolved message custody inside its commit transaction', () => {
  const { dir, db, state } = fixture();
  const channelId = 'atomic-message-custody';
  state.bind({ channelId, guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir, conductorId: 'atomic-message-custody-conductor', repoKey: 'repo:alpha' });
  const old = state.getBinding(channelId);
  const other = new SurfaceState(db);
  const originalHasUnresolved = state.hasUnresolved.bind(state);
  let injected = false;
  state.hasUnresolved = channel => {
    if (!injected) {
      injected = true;
      other.acceptDiscordMessage({ id: 'atomic-message-custody-input', guildId: 'guild-1', channelId, authorId: 'operator-1', isBot: false, content: 'arrived during handoff' });
      return false;
    }
    return originalHasUnresolved(channel);
  };
  try {
    assert.throws(() => state.handoffConductor({
      ...old, fromNativeId: old.nativeId, fromGeneration: old.generation,
      nativeId: SUCCESSOR_ID, handoffId: 'atomic-message-custody-1'
    }), /cannot handoff while work is unresolved/);
    assert.equal(state.getBinding(channelId).nativeId, CODEX_ID);
    assert.equal(state.getMessage('atomic-message-custody-input').state, MESSAGE_STATES.ACCEPTED);
  } finally {
    state.hasUnresolved = originalHasUnresolved;
    other.close();
    state.close();
  }
});

test('simulated: boundary transaction rejects a handoff committed by a second connection', async () => {
  const { dir, db, state } = fixture();
  state.bind({ channelId: 'atomic-boundary', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir, conductorId: 'atomic-boundary-conductor', repoKey: 'repo:alpha' });
  state.setIntakeBaseline('atomic-boundary', '100', 'previous completed recovery');
  state.markIntakeBoundary('atomic-boundary', 'ready');
  const old = state.getBinding('atomic-boundary');
  const other = new SurfaceState(db);
  const original = state.markIntakeBoundary.bind(state);
  let changed = false;
  state.markIntakeBoundary = (...args) => {
    if (args[1] === 'ready' && !changed) {
      changed = true;
      other.handoffConductor({ ...old, fromNativeId: old.nativeId, fromGeneration: old.generation, nativeId: SUCCESSOR_ID, handoffId: 'atomic-boundary-1' });
    }
    return original(...args);
  };
  const channel = {
    id: 'atomic-boundary',
    topic: conductorMarker({ provider: 'codex', nativeId: CODEX_ID, conductorId: 'atomic-boundary-conductor', repoKey: 'repo:alpha', generation: 1, readiness: READINESS.READY }),
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
  const gateway = new DiscordGateway({ state, client, fetchHistory: async () => [] });
  try {
    const result = await gateway.recoverTransport('restart');
    assert.equal(result.ready, false);
    assert.equal(result.state, 'unavailable');
    assert.equal(state.getBinding('atomic-boundary').readiness, READINESS.PENDING);
    assert.equal(state.getIntakeWatermark('atomic-boundary').state, 'ready');
  } finally {
    state.markIntakeBoundary = original;
    await gateway.stop();
    other.close();
    state.close();
  }
});

test('simulated: baseline transaction rejects a handoff before cutoff custody', async () => {
  const { dir, db, state } = fixture();
  state.bind({ channelId: 'atomic-baseline', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir, conductorId: 'atomic-baseline-conductor', repoKey: 'repo:alpha' });
  const old = state.getBinding('atomic-baseline');
  const other = new SurfaceState(db);
  const original = state.setIntakeBaseline.bind(state);
  let changed = false;
  state.setIntakeBaseline = (...args) => {
    if (args[3] && !changed) {
      changed = true;
      other.handoffConductor({ ...old, fromNativeId: old.nativeId, fromGeneration: old.generation, nativeId: SUCCESSOR_ID, handoffId: 'atomic-baseline-1' });
    }
    return original(...args);
  };
  const channel = {
    id: 'atomic-baseline',
    topic: conductorMarker({ provider: 'codex', nativeId: CODEX_ID, conductorId: 'atomic-baseline-conductor', repoKey: 'repo:alpha', generation: 1, readiness: READINESS.PENDING }),
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
  const gateway = new DiscordGateway({ state, client, fetchHistory: async () => [{ id: '101', guildId: 'guild-1', channelId: 'atomic-baseline', author: { id: 'operator-1', bot: false }, content: 'cutoff' }] });
  try {
    const result = await gateway.recoverTransport('restart');
    assert.equal(result.ready, false);
    assert.equal(result.state, 'unavailable');
    assert.equal(state.getBinding('atomic-baseline').readiness, READINESS.PENDING);
    assert.equal(state.getIntakeWatermark('atomic-baseline'), null);
  } finally {
    state.setIntakeBaseline = original;
    await gateway.stop();
    other.close();
    state.close();
  }
});

test('simulated: history admission transaction rejects a handoff before coverage custody', async () => {
  const { dir, db, state } = fixture();
  state.bind({ channelId: 'atomic-admission', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir, conductorId: 'atomic-admission-conductor', repoKey: 'repo:alpha' });
  state.setIntakeBaseline('atomic-admission', '100', 'previous completed recovery');
  state.markIntakeBoundary('atomic-admission', 'ready');
  const old = state.getBinding('atomic-admission');
  const other = new SurfaceState(db);
  const original = state.acceptDiscordMessage.bind(state);
  let changed = false;
  state.acceptDiscordMessage = (event, options) => {
    if (options?.expectedBinding && !changed) {
      changed = true;
      other.handoffConductor({ ...old, fromNativeId: old.nativeId, fromGeneration: old.generation, nativeId: SUCCESSOR_ID, handoffId: 'atomic-admission-1' });
    }
    return original(event, options);
  };
  const channel = {
    id: 'atomic-admission',
    topic: conductorMarker({ provider: 'codex', nativeId: CODEX_ID, conductorId: 'atomic-admission-conductor', repoKey: 'repo:alpha', generation: 1, readiness: READINESS.READY }),
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
  const gateway = new DiscordGateway({ state, client, fetchHistory: async () => [{ id: '101', guildId: 'guild-1', channelId: 'atomic-admission', author: { id: 'operator-1', bot: false }, content: 'history' }] });
  try {
    const result = await gateway.recoverTransport('restart');
    assert.equal(result.ready, false);
    assert.equal(result.state, 'unavailable');
    assert.equal(state.getBinding('atomic-admission').readiness, READINESS.PENDING);
    assert.equal(state.getIntakeWatermark('atomic-admission').recovered_through_id, '100');
    assert.equal(state.getMessage('101'), null);
  } finally {
    state.acceptDiscordMessage = original;
    await gateway.stop();
    other.close();
    state.close();
  }
});

test('simulated: disconnect pauses dispatch and shard ready performs fresh recovery', async () => {
  const { dir, state } = fixture();
  state.bind({ channelId: 'channel-codex', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir });
  state.setIntakeBaseline('channel-codex', '100', 'previous completed recovery');
  state.markIntakeBoundary('channel-codex', 'ready');
  const client = new EventEmitter();
  client.user = { id: 'bot-1' };
  client.channels = { fetch: async () => ({ id: 'channel-codex', permissionsFor: () => historyPermissions() }) };
  client.login = async () => {};
  client.destroy = async () => {};
  let scans = 0;
  const gateway = new DiscordGateway({ state, client, fetchHistory: async () => { scans += 1; return []; } });
  const secret = path.join(dir, 'discord.env');
  fs.writeFileSync(secret, 'DISCORD_TOKEN=fake-token\n', { mode: 0o600 });
  await gateway.start(secret);
  const scansBefore = scans;
  client.emit('shardDisconnect', new Error('socket lost'), 0);
  assert.equal(gateway.ready, false);
  client.emit('shardReconnecting', 0);
  client.emit('shardReady', 0, new Set());
  await gateway.reconnectPromise;
  assert.ok(scans > scansBefore);
  assert.equal(gateway.ready, true);
  await gateway.stop();
  state.close();
});

test('simulated: initial shard ready stays startup-owned and does not duplicate recovery', async () => {
  const { dir, state } = fixture();
  state.bind({ channelId: 'channel-codex', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir });
  const client = new EventEmitter();
  client.user = { id: 'bot-1' };
  client.channels = { fetch: async () => ({ id: 'channel-codex', topic: '', permissionsFor: () => historyPermissions() }) };
  client.login = async () => { client.emit('shardReady', 0, new Set()); };
  client.destroy = async () => {};
  const recoveries = [];
  let scans = 0;
  const gateway = new DiscordGateway({ state, client, fetchHistory: async () => { scans += 1; return []; } });
  const recoverTransport = gateway.recoverTransport.bind(gateway);
  gateway.recoverTransport = async (reason, epoch) => {
    recoveries.push(reason);
    return recoverTransport(reason, epoch);
  };
  const secret = path.join(dir, 'discord.env');
  fs.writeFileSync(secret, 'DISCORD_TOKEN=fake-token\n', { mode: 0o600 });
  await gateway.start(secret);
  assert.deepEqual(recoveries, ['startup']);
  assert.equal(scans, 1);
  assert.equal(gateway.ready, true);
  assert.equal(gateway.reconnectPromise, null);
  await gateway.stop();
  state.close();
});

test('simulated: pending successor custody stays accepted until readiness is restored', async () => {
  const { dir, state } = fixture();
  state.bind({ channelId: 'pending-successor', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir, conductorId: 'pending-conductor', repoKey: 'repo:alpha' });
  let dispatches = 0;
  const consumer = createSurfaceConsumer({
    state,
    providers: { codex: { async dispatch() { dispatches += 1; return { status: 'submitted' }; }, async observe() { return { text: 'answer' }; } } },
    sendReply: async () => ({ id: 'pending-successor-reply' })
  });
  const held = await consumer.handleMessage(discordMessage({ id: 'pending-successor-input', channelId: 'pending-successor' }));
  assert.equal(held.status, 'binding-not-ready');
  assert.equal(held.message.state, MESSAGE_STATES.ACCEPTED);
  assert.equal(dispatches, 0);
  state.markIntakeBoundary('pending-successor', 'ready');
  const resumed = await consumer.handleStoredMessage(discordMessage({ id: 'pending-successor-input', channelId: 'pending-successor' }));
  assert.equal(resumed.message.state, MESSAGE_STATES.REPLIED);
  assert.equal(dispatches, 1);
  state.close();
});

test('simulated: handoff changes local owner without a topic write', () => {
  const { dir, state } = fixture();
  state.bind({ channelId: 'handoff-channel', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir, conductorId: 'handoff-conductor', repoKey: 'repo:alpha' });
  state.markIntakeBoundary('handoff-channel', 'ready');
  const channel = {
    parentId: 'codex-category',
    topic: conductorMarker({ provider: 'codex', nativeId: CODEX_ID, conductorId: 'handoff-conductor', repoKey: 'repo:alpha', generation: 1, readiness: READINESS.READY }),
    async setTopic() { throw new Error('handoff must not patch the static address'); }
  };
  const handoff = {
    channelId: 'handoff-channel', provider: 'codex', conductorId: 'handoff-conductor', repoKey: 'repo:alpha',
    fromNativeId: CODEX_ID, fromGeneration: 1, nativeId: SUCCESSOR_ID, workspace: dir, handoffId: 'handoff-repair-1'
  };
  const successor = state.handoffConductor(handoff);
  assert.equal(channel.topic, conductorMarker({ provider: 'codex', nativeId: CODEX_ID, conductorId: 'handoff-conductor', repoKey: 'repo:alpha' }));
  const repaired = state.handoffConductor(handoff);
  assert.equal(repaired.handoffReconciled, true);
  assert.equal(repaired.generation, 2);
  assert.equal(channel.topic, conductorMarker({ provider: 'codex', nativeId: CODEX_ID, conductorId: 'handoff-conductor', repoKey: 'repo:alpha' }));
  assert.throws(() => state.handoffConductor({ ...handoff, handoffId: 'handoff-repair-1', nativeId: CLAUDE_ID }), /already used/);
  state.close();
});
