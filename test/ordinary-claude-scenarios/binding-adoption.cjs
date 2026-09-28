const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { ordinaryClaudeBind } = require('../../src/cli');
const { READINESS, SurfaceState } = require('../../src/state');
const { CLAUDE, OTHER, fakeClient, fixture, transcript } = require('./fixture.cjs');

test('ordinary Claude state bind rejects an identity that differs from nativeId before persistence', t => {
  const f = fixture(t, { bind: false });
  assert.throws(() => f.state.bindOrdinaryClaude({
    channelId: 'claude-channel', guildId: 'guild', provider: 'claude', nativeId: CLAUDE,
    workspace: f.dir, endpoint: f.socketPath
  }, { sessionId: OTHER, threadId: OTHER, harness: 'claude-code' }), /does not match the native session/);
  assert.equal(f.state.getBinding('claude-channel'), null);
  assert.equal(f.state.listReceipts().some(receipt => receipt.kind === 'ordinary-bound'), false);
});

test('generic rebind cannot mutate ordinary Claude owner or endpoint, while tombstone rebind remains valid', t => {
  const f = fixture(t);
  const alternateEndpoint = path.join(f.dir, 'alternate.sock');
  assert.throws(() => f.state.rebind({
    channelId: f.binding.channelId, guildId: 'guild', provider: 'claude', nativeId: OTHER,
    workspace: f.dir, endpoint: alternateEndpoint,
    ordinaryIdentity: { sessionId: OTHER, threadId: OTHER, harness: 'claude-code' }
  }), /ordinary Claude bindings require matching owner and endpoint/);
  assert.throws(() => f.state.rebind({
    channelId: f.binding.channelId, guildId: 'guild', provider: 'claude', nativeId: CLAUDE,
    workspace: f.dir, endpoint: alternateEndpoint,
    ordinaryIdentity: { sessionId: CLAUDE, threadId: CLAUDE, harness: 'claude-code' }
  }), /ordinary Claude bindings require matching owner and endpoint/);
  assert.deepEqual(f.state.getBinding(f.binding.channelId), f.binding);

  f.state.unbind(f.binding.channelId);
  const rebound = f.state.rebindOrdinaryClaude({
    channelId: f.binding.channelId, guildId: 'guild', provider: 'claude', nativeId: CLAUDE,
    workspace: f.dir, endpoint: f.socketPath
  }, { sessionId: CLAUDE, threadId: CLAUDE, harness: 'claude-code' });
  assert.equal(rebound.generation, 2);
  assert.equal(rebound.nativeId, CLAUDE);
  assert.equal(rebound.endpoint, f.socketPath);
});

test('ordinary Claude bind compares resolved channel selectors before mutation', async t => {
  const f = fixture(t, { bind: false });
  const channel = { id: '123456789012345678', guildId: 'guild', name: 'dev', isTextBased: () => true };
  const deps = {
    resolveClaudeCaller: () => ({ sessionId: CLAUDE, harness: 'claude-code' }),
    requireInstalled: () => ({ Client: fakeClient(channel), GatewayIntentBits: { Guilds: 1 } }),
    readSecret: () => 'fixture-token',
    gatewayProcessStatus: () => ({ state: 'stopped' }),
    print: () => {}
  };
  const args = { 'state-dir': f.dir, channel: '#dev', 'channel-id': channel.id,
    transcript: f.session.file, socket: f.socketPath };
  await assert.rejects(() => ordinaryClaudeBind({ ...args, 'channel-id': '223456789012345678' }, deps));
  assert.equal(f.state.getBinding(channel.id), null);
  const bound = await ordinaryClaudeBind(args, deps);
  assert.equal(bound.binding.channelId, channel.id);
  assert.equal(bound.binding.nativeId, CLAUDE);
  assert.equal(bound.nativeProof.status, 'verified');
});

test('ordinary Claude bind refuses an incompatible running Gateway before mutation', async t => {
  const f = fixture(t, { bind: false });
  const channel = { id: 'claude-channel', guildId: 'guild', name: 'dev', isTextBased: () => true };
  let printed = false;
  const deps = {
    resolveClaudeCaller: () => ({ sessionId: CLAUDE, harness: 'claude-code' }),
    requireInstalled: () => ({ Client: fakeClient(channel), GatewayIntentBits: { Guilds: 1 } }),
    readSecret: () => 'fixture-token',
    gatewayProcessStatus: () => ({ state: 'running', pid: 4242, capabilities: [] }),
    print: () => { printed = true; }
  };
  await assert.rejects(() => ordinaryClaudeBind({
    'state-dir': f.dir, channel: '#dev', transcript: f.session.file, socket: f.socketPath
  }, deps), /does not support ordinary binding wake/);
  assert.equal(f.state.getBinding(channel.id), null);
  assert.equal(printed, false);
});

test('ordinary Claude bind rejects conflicting endpoint aliases before mutation', async t => {
  const f = fixture(t, { bind: false });
  const channel = { id: 'claude-channel', guildId: 'guild', name: 'dev', isTextBased: () => true };
  const deps = {
    resolveClaudeCaller: () => ({ sessionId: CLAUDE, harness: 'claude-code' }),
    requireInstalled: () => ({ Client: fakeClient(channel), GatewayIntentBits: { Guilds: 1 } }),
    readSecret: () => 'fixture-token',
    gatewayProcessStatus: () => ({ state: 'stopped' }),
    print: () => {}
  };
  const args = {
    'state-dir': f.dir, channel: '#dev', transcript: f.session.file,
    endpoint: f.socketPath, socket: path.join(f.dir, 'other.sock')
  };
  await assert.rejects(() => ordinaryClaudeBind(args, deps), /must identify the same socket/);
  assert.equal(f.state.getBinding(channel.id), null);
});

test('ordinary Claude bind uses exact caller and transcript, reuses and rebinds only same owner', async t => {
  const f = fixture(t, { bind: false });
  const channel = { id: 'claude-channel', guildId: 'guild', name: 'dev', isTextBased: () => true };
  const deps = {
    resolveClaudeCaller: () => ({ sessionId: CLAUDE, harness: 'claude-code', caller: { pid: 12, processStartTime: 34 } }),
    requireInstalled: () => ({ Client: fakeClient(channel), GatewayIntentBits: { Guilds: 1 } }),
    readSecret: () => 'fixture-token',
    gatewayProcessStatus: () => ({ state: 'stopped' }),
    print: () => {}
  };
  const args = { 'state-dir': f.dir, channel: '#dev', transcript: f.session.file, socket: f.socketPath };
  const first = await ordinaryClaudeBind(args, deps);
  const second = await ordinaryClaudeBind(args, deps);
  assert.equal(first.reused, false);
  assert.equal(second.reused, true);
  assert.equal(first.binding.provider, 'claude');
  assert.equal(first.binding.readiness, READINESS.PENDING);
  assert.equal(first.nativeProof.status, 'verified');
  assert.equal(first.monitor.status, 'pending');
  const tombstone = new SurfaceState(f.db);
  tombstone.unbind(channel.id);
  tombstone.close();
  const rebound = await ordinaryClaudeBind(args, deps);
  assert.equal(rebound.reused, false);
  assert.equal(rebound.binding.generation, 2);
  const otherSession = transcript(t, f.dir, OTHER);
  await assert.rejects(() => ordinaryClaudeBind({ ...args, transcript: otherSession.file }, {
    ...deps,
    resolveClaudeCaller: () => ({ sessionId: OTHER, harness: 'claude-code', caller: { pid: 12, processStartTime: 34 } })
  }), /already bound/);
});

test('ordinary Claude first adoption commits a latest cutoff before intake', async t => {
  const f = fixture(t, { bind: false });
  let fetches = 0;
  const channel = {
    id: 'claude-channel', guildId: 'guild', name: 'dev', isTextBased: () => true,
    messages: { fetch: async () => { fetches += 1; return new Map([['latest', { id: '200' }]]); } }
  };
  const deps = {
    resolveClaudeCaller: () => ({ sessionId: CLAUDE, harness: 'claude-code', caller: { pid: 12, processStartTime: 34 } }),
    requireInstalled: () => ({ Client: fakeClient(channel), GatewayIntentBits: { Guilds: 1 } }),
    readSecret: () => 'fixture-token',
    gatewayProcessStatus: () => ({ state: 'stopped' }),
    print: () => {}
  };
  const result = await ordinaryClaudeBind({ 'state-dir': f.dir, channel: '#dev', transcript: f.session.file, socket: f.socketPath }, deps);
  assert.equal(result.binding.generation, 1);
  assert.equal(fetches, 1);
  const watermark = f.state.getIntakeWatermark(channel.id);
  assert.equal(watermark.last_seen_id, '200');
  assert.equal(watermark.recovered_through_id, '200');
  assert.equal(watermark.state, READINESS.PENDING);
});

test('ordinary Claude inactive adoption commits a latest cutoff while active reuse does not fetch', async t => {
  const f = fixture(t);
  f.state.setIntakeCutoff(f.binding.channelId, 'guild', '100', 'seed');
  let fetches = 0;
  const channel = {
    id: f.binding.channelId, guildId: 'guild', name: 'dev', isTextBased: () => true,
    messages: { fetch: async () => { fetches += 1; return new Map([['latest', { id: '200' }]]); } }
  };
  const deps = {
    resolveClaudeCaller: () => ({ sessionId: CLAUDE, harness: 'claude-code', caller: { pid: 12, processStartTime: 34 } }),
    requireInstalled: () => ({ Client: fakeClient(channel), GatewayIntentBits: { Guilds: 1 } }),
    readSecret: () => 'fixture-token',
    gatewayProcessStatus: () => ({ state: 'stopped' }),
    print: () => {}
  };
  const args = { 'state-dir': f.dir, channel: '#dev', transcript: f.session.file, socket: f.socketPath };
  const reused = await ordinaryClaudeBind(args, deps);
  assert.equal(reused.reused, true);
  assert.equal(fetches, 0);
  f.state.unbind(f.binding.channelId);
  const rebound = await ordinaryClaudeBind(args, deps);
  assert.equal(rebound.reused, false);
  assert.equal(rebound.binding.generation, 2);
  assert.equal(fetches, 1);
  const watermark = f.state.getIntakeWatermark(f.binding.channelId);
  assert.equal(watermark.last_seen_id, '200');
  assert.equal(watermark.recovered_through_id, '200');
  assert.equal(watermark.state, READINESS.PENDING);
});

test('ordinary Claude inactive adoption uses the empty numeric channel cutoff', async t => {
  const f = fixture(t, { bind: false });
  const channelId = '123456789012345678';
  const binding = f.state.bindOrdinaryClaude({
    channelId, guildId: 'guild', provider: 'claude', nativeId: CLAUDE, workspace: f.dir, endpoint: f.socketPath
  }, { sessionId: CLAUDE, threadId: CLAUDE, harness: 'claude-code' });
  f.state.unbind(channelId);
  const channel = {
    id: channelId, guildId: 'guild', name: 'dev', isTextBased: () => true,
    messages: { fetch: async () => new Map() }
  };
  const deps = {
    resolveClaudeCaller: () => ({ sessionId: CLAUDE, harness: 'claude-code', caller: { pid: 12, processStartTime: 34 } }),
    requireInstalled: () => ({ Client: fakeClient(channel), GatewayIntentBits: { Guilds: 1 } }),
    readSecret: () => 'fixture-token',
    gatewayProcessStatus: () => ({ state: 'stopped' }),
    print: () => {}
  };
  const result = await ordinaryClaudeBind({ 'state-dir': f.dir, channel: channelId, transcript: f.session.file, socket: f.socketPath }, deps);
  assert.equal(result.binding.generation, binding.generation + 1);
  const watermark = f.state.getIntakeWatermark(channelId);
  assert.equal(watermark.last_seen_id, channelId);
  assert.equal(watermark.recovered_through_id, channelId);
  assert.equal(watermark.state, READINESS.PENDING);
});

test('ordinary Claude cutoff fetch failure preserves the tombstone and watermark', async t => {
  const f = fixture(t);
  f.state.setIntakeCutoff(f.binding.channelId, 'guild', '100', 'seed');
  f.state.unbind(f.binding.channelId);
  const beforeBinding = f.state.getBinding(f.binding.channelId);
  const beforeWatermark = f.state.getIntakeWatermark(f.binding.channelId);
  const channel = {
    id: f.binding.channelId, guildId: 'guild', name: 'dev', isTextBased: () => true,
    messages: { fetch: async () => { throw new Error('history unavailable'); } }
  };
  const deps = {
    resolveClaudeCaller: () => ({ sessionId: CLAUDE, harness: 'claude-code', caller: { pid: 12, processStartTime: 34 } }),
    requireInstalled: () => ({ Client: fakeClient(channel), GatewayIntentBits: { Guilds: 1 } }),
    readSecret: () => 'fixture-token',
    gatewayProcessStatus: () => ({ state: 'stopped' }),
    print: () => {}
  };
  await assert.rejects(() => ordinaryClaudeBind({ 'state-dir': f.dir, channel: '#dev', transcript: f.session.file, socket: f.socketPath }, deps), /history unavailable/);
  assert.deepEqual(f.state.getBinding(f.binding.channelId), beforeBinding);
  assert.deepEqual(f.state.getIntakeWatermark(f.binding.channelId), beforeWatermark);
});
