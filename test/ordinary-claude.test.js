const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const http = require('node:http');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createOrdinaryClaudeRequest, ordinaryBindingDecision, resolveExistingChannel } = require('../src/ordinary-codex');
const { ClaudeChannel } = require('../src/claude-channel');
const { createClaudeMonitor, createMonitorMcp } = require('../src/claude-monitor');
const { attachOrdinaryListener, detachOrdinaryListener, ordinaryClaudeBind, servedOrdinaryBinding } = require('../src/cli');
const { DiscordGateway } = require('../src/discord');
const { ClaudeProvider, dispatchAndObserve, postUnixJson, probeClaudeChannel, probeUnixSocket, validateClaudeSessionIdentity, waitForReply } = require('../src/native');
const { MESSAGE_STATES, READINESS, SurfaceState, StaleGenerationError } = require('../src/state');
const { runDirectPost } = require('../src/direct-post');
const { GATEWAY_CAPABILITIES } = require('../src/ordinary-bind/constants');

const CLAUDE = '79e3da8e-94b4-4aff-8f88-b45b3a451dd1';
const OTHER = '9caa5d21-2169-429d-918b-5f08651b5dbd';
const CLI_PATH = path.resolve(__dirname, '../src/cli.js');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(10);
  }
  throw new Error('timed out waiting for ordinary Claude condition');
}

function transcript(t, workspace, nativeId = CLAUDE, cwd = workspace) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinary-claude-transcript-'));
  const file = path.join(root, 'session.jsonl');
  fs.writeFileSync(file, [
    JSON.stringify({ type: 'custom-title', sessionId: nativeId }),
    JSON.stringify({ type: 'attachment', sessionId: nativeId, cwd, entrypoint: 'cli', version: '1.0.0', attachment: { hookEvent: 'SessionStart' } })
  ].join('\n') + '\n');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, file };
}

function fixture(t, { bind = true, endpoint = null, preflight = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinary-claude-'));
  const db = path.join(dir, 'surface.sqlite');
  const state = new SurfaceState(db);
  state.setConfig({ operatorId: 'operator', guildId: 'guild', secretFile: path.join(dir, 'discord.env') });
  const socketPath = endpoint || path.join(dir, 'claude.sock');
  const session = transcript(t, dir);
  let binding = null;
  if (bind) {
    binding = state.bindOrdinaryClaude({ channelId: 'claude-channel', guildId: 'guild', provider: 'claude', nativeId: CLAUDE, workspace: dir, endpoint: socketPath },
      { sessionId: CLAUDE, threadId: CLAUDE, harness: 'claude-code' });
    if (preflight) state.recordOrdinaryPreflight(binding, {
      file: session.file, sessionId: CLAUDE, threadId: CLAUDE, workspace: dir, endpoint: socketPath, harness: 'claude-code'
    });
  }
  t.after(() => {
    try { state.close(); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, db, state, socketPath, session, binding };
}

function fakeClient(channel) {
  return class FakeClient {
    constructor() {
      this.guilds = { fetch: async () => ({ channels: {
        fetch: async selection => selection ? channel : new Map([[channel.id, channel]])
      } }) };
    }
    async login() {}
    async destroy() {}
  };
}

test('ordinary Claude request requires exact harness, UUID, endpoint, and transcript workspace', t => {
  const f = fixture(t, { bind: false });
  const proof = validateClaudeSessionIdentity(CLAUDE, f.session.file);
  assert.equal(proof.sessionId, CLAUDE);
  assert.equal(proof.threadId, CLAUDE);
  assert.equal(proof.workspace, f.dir);
  assert.throws(() => validateClaudeSessionIdentity(CLAUDE, f.session.file, '/tmp/other-workspace'), /does not match/);
  const wrong = transcript(t, f.dir, OTHER);
  assert.throws(() => validateClaudeSessionIdentity(CLAUDE, wrong.file), /identity or workspace/);
  assert.throws(() => createOrdinaryClaudeRequest({
    channelId: 'channel', guildId: 'guild', nativeId: OTHER, workspace: f.dir, endpoint: f.socketPath,
    identity: { sessionId: CLAUDE, threadId: CLAUDE, harness: 'claude-code' }
  }), /conflicts/);
  assert.throws(() => createOrdinaryClaudeRequest({
    channelId: 'channel', guildId: 'guild', workspace: f.dir, endpoint: f.socketPath,
    identity: { sessionId: CLAUDE, threadId: CLAUDE, harness: 'codex' }
  }), /harness/);
});

test('ordinary Claude accepts single or equal transcript IDs and rejects conflicts', t => {
  const f = fixture(t, { bind: false });
  const metadata = { cwd: f.dir, entrypoint: 'cli', version: '1.0.0' };
  const write = (name, row) => {
    const file = path.join(f.dir, name);
    fs.writeFileSync(file, `${JSON.stringify(row)}\n`, { mode: 0o600 });
    return file;
  };
  const topLevel = write('top-level.jsonl', { ...metadata, sessionId: CLAUDE });
  const payloadOnly = write('payload-only.jsonl', { ...metadata, payload: { session_id: CLAUDE } });
  const equalAliases = write('equal-aliases.jsonl', { ...metadata, sessionId: CLAUDE, payload: { session_id: CLAUDE } });
  const conflicting = write('conflicting-aliases.jsonl', { ...metadata, sessionId: CLAUDE, payload: { session_id: OTHER } });
  const lateConflict = path.join(f.dir, 'late-conflict.jsonl');
  fs.writeFileSync(lateConflict, [
    ...Array.from({ length: 5000 }, () => ({ ...metadata, sessionId: CLAUDE })),
    { ...metadata, sessionId: OTHER }
  ].map(row => JSON.stringify(row)).join('\n') + '\n', { mode: 0o600 });
  assert.equal(validateClaudeSessionIdentity(CLAUDE, topLevel).sessionId, CLAUDE);
  assert.equal(validateClaudeSessionIdentity(CLAUDE, payloadOnly).sessionId, CLAUDE);
  assert.equal(validateClaudeSessionIdentity(CLAUDE, equalAliases).sessionId, CLAUDE);
  assert.throws(() => validateClaudeSessionIdentity(CLAUDE, conflicting), /Claude transcript identity is ambiguous/);
  assert.throws(() => validateClaudeSessionIdentity(CLAUDE, lateConflict), /identity is ambiguous/);

  const growing = write('growing.jsonl', { ...metadata, sessionId: CLAUDE });
  const realReadSync = fs.readSync;
  let appended = false;
  t.mock.method(fs, 'readSync', (fd, buffer, offset, length, position) => {
    const count = realReadSync(fd, buffer, offset, length, position);
    if (!appended) {
      appended = true;
      fs.appendFileSync(growing, `${JSON.stringify({ ...metadata, sessionId: OTHER })}\n`);
    }
    return count;
  });
  assert.equal(validateClaudeSessionIdentity(CLAUDE, growing).sessionId, CLAUDE);
});

test('ordinary Claude rejects a transcript shortened during metadata scanning', t => {
  const f = fixture(t, { bind: false });
  fs.appendFileSync(f.session.file, 'x'.repeat(70 * 1024));
  const realReadSync = fs.readSync;
  let reads = 0;
  t.mock.method(fs, 'readSync', (fd, buffer, offset, length, position) => {
    reads += 1;
    if (reads === 2) return 0;
    return realReadSync(fd, buffer, offset, length, position);
  });
  assert.throws(() => validateClaudeSessionIdentity(CLAUDE, f.session.file), /transcript shortened during read/);
});

test('oversized Claude metadata records fail closed', t => {
  const f = fixture(t, { bind: false });
  const file = path.join(f.dir, 'oversized-conflict.jsonl');
  fs.writeFileSync(file, [
    JSON.stringify({ cwd: f.dir, entrypoint: 'cli', version: '1.0.0', sessionId: OTHER, filler: 'x'.repeat(1024 * 1024) }),
    JSON.stringify({ cwd: f.dir, entrypoint: 'cli', version: '1.0.0', sessionId: CLAUDE })
  ].join('\n') + '\n', { mode: 0o600 });
  assert.throws(() => validateClaudeSessionIdentity(CLAUDE, file), /record is too large/);
});

test('ordinary Claude selection and same-owner decision preserve channel custody', () => {
  const channels = [
    { id: '123', guildId: 'guild', name: 'ops', messageCapable: true },
    { id: '456', guildId: 'guild', name: 'dev', messageCapable: true },
    { id: '789', guildId: 'other', name: 'ops', messageCapable: true },
    { id: 'cat', guildId: 'guild', name: 'category', messageCapable: false }
  ];
  assert.equal(resolveExistingChannel('123', 'guild', channels).id, '123');
  assert.equal(resolveExistingChannel('<#456>', 'guild', channels).id, '456');
  assert.equal(resolveExistingChannel('#dev', 'guild', channels).id, '456');
  assert.throws(() => resolveExistingChannel('<#789>', 'guild', channels), /outside/);
  assert.throws(() => resolveExistingChannel('#category', 'guild', channels), /message-capable/);
  const request = {
    provider: 'claude', channelId: 'channel', guildId: 'guild', nativeId: CLAUDE, workspace: '/tmp/workspace', endpoint: '/tmp/claude.sock',
    identity: { sessionId: CLAUDE, threadId: CLAUDE, harness: 'claude-code' }
  };
  assert.equal(ordinaryBindingDecision(null, request), 'bind');
  assert.equal(ordinaryBindingDecision({ ...request, active: true }, request, true), 'reuse');
  assert.equal(ordinaryBindingDecision({ ...request, active: false }, request, true), 'rebind');
  assert.throws(() => ordinaryBindingDecision({ ...request, endpoint: '/tmp/other.sock', active: true }, request, true), /already bound/);
  assert.throws(() => ordinaryBindingDecision({ ...request, conductorId: 'owner', active: true }, request, false), /already bound/);
  const foreign = { ...request, nativeId: OTHER, identity: { sessionId: OTHER, threadId: OTHER, harness: 'claude-code' } };
  assert.throws(() => ordinaryBindingDecision({ ...request, active: true }, foreign, true), error => {
    assert.match(error.message, /Claude owner replacement requires an explicit supported handoff/);
    assert.doesNotMatch(error.message, /provider codex/);
    return true;
  });
});

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

test('ordinary Claude Monitor readiness is unavailable without a live socket and holds intake', async t => {
  const f = fixture(t);
  const channel = {
    id: f.binding.channelId,
    guildId: 'guild',
    permissionsFor: () => ({ has: () => true })
  };
  const gateway = new DiscordGateway({
    state: f.state,
    client: { user: { id: 'bot' }, channels: { fetch: async () => channel }, on() {}, off() {}, async destroy() {} },
    fetchHistory: async () => [],
    providers: { claude: { async dispatch() { throw new Error('must stay held'); } } }
  });
  gateway.historyPermission = () => ({ known: true, allowed: true });
  const recovery = await gateway.recoverTransport('monitor-unavailable', 0);
  assert.equal(recovery.ready, false);
  assert.equal(f.state.getBinding(f.binding.channelId).readiness, READINESS.UNAVAILABLE);
  const accepted = f.state.acceptDiscordMessage({
    id: 'held-without-monitor', guildId: 'guild', channelId: f.binding.channelId,
    authorId: 'operator', isBot: false, content: 'hold this'
  }, { ready: false });
  assert.equal(accepted.accepted, true);
  assert.equal(f.state.claimDispatch(accepted.message.id).reason, 'binding-not-ready');
  assert.equal(f.state.getMessage(accepted.message.id).state, MESSAGE_STATES.ACCEPTED);
  await assert.rejects(() => probeUnixSocket(f.socketPath), /connect|socket|ENOENT|refused/i);
  await gateway.stop();
});

test('ordinary Claude preflight rejects an unrelated accepting listener', async t => {
  const f = fixture(t, { preflight: false });
  const listener = http.createServer((_request, response) => {
    response.writeHead(202);
    response.end('accepted');
  });
  await new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(f.socketPath, resolve);
  });
  t.after(() => listener.close());
  const gateway = new DiscordGateway({
    state: f.state,
    client: { user: { id: 'bot' }, on() {}, off() {}, async destroy() {} },
    providers: { claude: { async dispatch() { throw new Error('must not dispatch'); } } }
  });
  await assert.rejects(() => gateway.verifyOrdinaryNative(f.binding), /identity|status|Claude channel/);
  assert.equal(f.state.hasOrdinaryPreflight(f.binding), false);
  await gateway.stop();
});

test('Claude identity probe enforces an absolute deadline despite response progress', async t => {
  const f = fixture(t, { preflight: false });
  const listener = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    let writes = 0;
    const interval = setInterval(() => {
      response.write(' ');
      writes += 1;
      if (writes >= 20) {
        clearInterval(interval);
        response.end();
      }
    }, 10);
    _request.on('close', () => clearInterval(interval));
  });
  await new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(f.socketPath, resolve);
  });
  t.after(() => listener.close());
  const startedAt = Date.now();
  await assert.rejects(() => probeClaudeChannel(f.socketPath, {
    nativeId: CLAUDE, generation: f.binding.generation, workspace: f.dir, endpoint: f.socketPath
  }, { timeoutMs: 30 }), /timed out/);
  assert.ok(Date.now() - startedAt < 120, 'probe deadline must be absolute, not inactivity based');
});

test('Claude identity probe settles success, no-response, and transport-error paths', async t => {
  const f = fixture(t, { preflight: false });
  const expected = { nativeId: CLAUDE, generation: f.binding.generation, workspace: f.dir, endpoint: f.socketPath };
  const successListener = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ provider: 'claude', ...expected, channelReady: true }));
  });
  await new Promise((resolve, reject) => {
    successListener.once('error', reject);
    successListener.listen(f.socketPath, resolve);
  });
  const proof = await probeClaudeChannel(f.socketPath, expected, { timeoutMs: 100 });
  assert.equal(proof.channelReady, true);
  await new Promise((resolve, reject) => successListener.close(error => error ? reject(error) : resolve()));

  const noResponseListener = http.createServer(() => {});
  await new Promise((resolve, reject) => {
    noResponseListener.once('error', reject);
    noResponseListener.listen(f.socketPath, resolve);
  });
  await assert.rejects(() => probeClaudeChannel(f.socketPath, expected, { timeoutMs: 30 }), /timed out/);
  await new Promise((resolve, reject) => noResponseListener.close(error => error ? reject(error) : resolve()));

  await assert.rejects(() => probeClaudeChannel(f.socketPath, expected, { timeoutMs: 100 }), /ENOENT|connect|socket/i);
});

test('old ordinary Claude Monitor stop cannot revoke a successor generation', async t => {
  const f = fixture(t);
  f.state.close();
  const child = spawn(process.execPath, [CLI_PATH, 'claude-monitor', '--state-dir', f.dir, '--db', f.db, '--native-id', CLAUDE, '--socket', f.socketPath], {
    stdio: ['ignore', 'pipe', 'pipe']
  });
  t.after(async () => {
    if (child.exitCode === null) child.kill('SIGTERM');
  });
  const observed = new SurfaceState(f.db);
  await waitFor(() => fs.existsSync(f.socketPath));
  const before = observed.getBinding(f.binding.channelId);
  assert.equal(before.readiness, READINESS.PENDING);
  const successorState = new SurfaceState(f.db);
  successorState.unbind(f.binding.channelId);
  const successor = successorState.rebindOrdinaryClaude({
    channelId: f.binding.channelId, guildId: 'guild', provider: 'claude', nativeId: CLAUDE, workspace: f.dir, endpoint: f.socketPath
  }, { sessionId: CLAUDE, threadId: CLAUDE, harness: 'claude-code' });
  successorState.close();
  assert.equal(successor.generation, 2);
  assert.equal(successor.readiness, READINESS.PENDING);
  child.kill('SIGTERM');
  await new Promise((resolve, reject) => {
    child.once('close', resolve);
    child.once('error', reject);
  });
  await waitFor(() => observed.getBinding(f.binding.channelId)?.generation === 2);
  assert.equal(observed.getBinding(f.binding.channelId).readiness, READINESS.PENDING);
  observed.close();
});

test('ordinary Claude Monitor startup preserves unrelated recovery-unavailable state', async t => {
  const f = fixture(t);
  f.state.markIntakeBoundary(f.binding.channelId, 'unavailable', 'prior recovery failure', null, null, f.binding);
  f.state.close();
  const child = spawn(process.execPath, [CLI_PATH, 'claude-monitor', '--state-dir', f.dir, '--db', f.db, '--native-id', CLAUDE, '--socket', f.socketPath], {
    stdio: ['ignore', 'pipe', 'pipe']
  });
  t.after(async () => {
    if (child.exitCode === null) child.kill('SIGTERM');
  });
  const observed = new SurfaceState(f.db);
  await waitFor(() => fs.existsSync(f.socketPath));
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(observed.getBinding(f.binding.channelId).readiness, READINESS.UNAVAILABLE);
  assert.equal(observed.getIntakeWatermark(f.binding.channelId).state, READINESS.UNAVAILABLE);
  child.kill('SIGTERM');
  await new Promise((resolve, reject) => {
    child.once('close', resolve);
    child.once('error', reject);
  });
  observed.close();
});

for (const terminalState of [READINESS.UNAVAILABLE, READINESS.GAP]) {
  test(`ordinary Claude channel does not promote an unresolved ${terminalState} intake boundary when Gateway wake fails`, t => {
    const f = fixture(t);
    const detail = `prior ${terminalState} recovery failure`;
    f.state.markIntakeBoundary(f.binding.channelId, terminalState, detail, null, null, f.binding);
    const stderr = [];
    const identity = {
      channelId: f.binding.channelId, guildId: f.binding.guildId, provider: f.binding.provider,
      nativeId: f.binding.nativeId, workspace: f.binding.workspace, endpoint: f.binding.endpoint,
      generation: f.binding.generation
    };
    const wake = attachOrdinaryListener({
      state: f.state,
      paths: { stateDir: f.dir, db: f.db },
      startupBinding: f.binding,
      identity,
      label: 'Claude channel',
      requestRecovery: () => ({ requested: false, reason: 'gateway-not-running' }),
      stderr: { write(chunk) { stderr.push(String(chunk)); } }
    });
    assert.deepEqual(wake, { requested: false, reason: 'gateway-not-running' });
    assert.equal(f.state.getBinding(f.binding.channelId).readiness, terminalState);
    const watermark = f.state.getIntakeWatermark(f.binding.channelId);
    assert.equal(watermark.state, terminalState);
    assert.equal(watermark.detail, detail);
    assert.match(stderr.join(''), /Claude channel startup could not wake Gateway/);
  });
}

test('ordinary Claude channel attach fails when the running Gateway cannot be woken', t => {
  const f = fixture(t);
  // Held intake from an endpoint failure, so the attach reconciles to pending before it learns
  // the wake is unsupported. The throw must not leave that pending behind.
  f.state.markIntakeBoundary(f.binding.channelId, 'unavailable', 'Claude endpoint unavailable before event write: connect ENOENT', null, null, f.binding);
  assert.equal(f.state.getBinding(f.binding.channelId).readiness, READINESS.UNAVAILABLE);
  const identity = {
    channelId: f.binding.channelId, guildId: f.binding.guildId, provider: f.binding.provider,
    nativeId: f.binding.nativeId, workspace: f.binding.workspace, endpoint: f.binding.endpoint,
    generation: f.binding.generation
  };
  assert.throws(() => attachOrdinaryListener({
    state: f.state,
    paths: { stateDir: f.dir, db: f.db },
    startupBinding: f.binding,
    identity,
    label: 'Claude channel',
    requestRecovery: () => ({ requested: false, reason: 'gateway-wake-unsupported', capability: 'ordinary-bind-wake-v1' }),
    stderr: { write() {} }
  }), /Claude channel startup could not wake Gateway \(gateway-wake-unsupported\)/);
  assert.equal(f.state.getBinding(f.binding.channelId).readiness, READINESS.UNAVAILABLE);
  assert.equal(readinessReceipts(f.state, f.binding.channelId).at(-1).detail, 'Claude channel unavailable');
});

test('Claude transport close runs the listener revoke before releasing its socket', async t => {
  const f = fixture(t);
  const events = [];
  const mcp = { notification: async () => {}, close: async () => {} };
  const channel = new ClaudeChannel({
    state: f.state, nativeId: CLAUDE, socketPath: f.socketPath, mcp,
    beforeTransportClose: () => events.push({ phase: 'before', socket: fs.existsSync(f.socketPath) }),
    onTransportClose: () => events.push({ phase: 'after', socket: fs.existsSync(f.socketPath) })
  });
  await channel.start();
  mcp.onclose();
  await waitFor(() => events.length === 2);
  assert.deepEqual(events, [
    { phase: 'before', socket: true },
    { phase: 'after', socket: false }
  ]);
});

test('ordinary Claude Monitor startup reopens an endpoint-unavailable recovery watermark', async t => {
  const f = fixture(t);
  f.state.markIntakeBoundary(f.binding.channelId, 'unavailable', 'Claude endpoint unavailable before event write: connect ENOENT', null, null, f.binding);
  f.state.close();
  const child = spawn(process.execPath, [CLI_PATH, 'claude-monitor', '--state-dir', f.dir, '--db', f.db, '--native-id', CLAUDE, '--socket', f.socketPath], {
    stdio: ['ignore', 'pipe', 'pipe']
  });
  t.after(async () => {
    if (child.exitCode === null) child.kill('SIGTERM');
  });
  const observed = new SurfaceState(f.db);
  await waitFor(() => fs.existsSync(f.socketPath) && observed.getIntakeWatermark(f.binding.channelId)?.state === READINESS.PENDING);
  assert.equal(observed.getBinding(f.binding.channelId).readiness, READINESS.PENDING);
  assert.equal(observed.getIntakeWatermark(f.binding.channelId).state, READINESS.PENDING);
  child.kill('SIGTERM');
  await new Promise((resolve, reject) => {
    child.once('close', resolve);
    child.once('error', reject);
  });
  observed.close();
});

for (const terminalState of [READINESS.UNAVAILABLE, READINESS.GAP]) {
  test(`ordinary Claude recovery restores durable ${terminalState} readiness`, async t => {
    const f = fixture(t);
    const detail = `prior ${terminalState} recovery failure`;
    f.state.markIntakeBoundary(f.binding.channelId, terminalState, detail, null, null, f.binding);
    const gateway = new DiscordGateway({
      state: f.state,
      client: { user: { id: 'bot' }, on() {}, off() {}, async destroy() {} },
      providers: { claude: { async dispatch() { throw new Error('must stay held'); } } }
    });
    const result = await gateway.recoverTransport(`terminal-${terminalState}`, 0);
    assert.deepEqual(result, { ready: false, state: terminalState });
    assert.equal(f.state.getBinding(f.binding.channelId).readiness, terminalState);
    assert.equal(f.state.getIntakeWatermark(f.binding.channelId).state, terminalState);
    assert.equal(f.state.getIntakeWatermark(f.binding.channelId).detail, detail);
    assert.equal(gateway.recoveryPromise, null);
    assert.equal(gateway.recoveryController, null);
    const accepted = f.state.acceptDiscordMessage({
      id: `held-${terminalState}`, guildId: 'guild', channelId: f.binding.channelId,
      authorId: 'operator', isBot: false, content: `hold during ${terminalState}`
    }, { ready: false });
    assert.equal(accepted.accepted, true);
    assert.equal(f.state.claimDispatch(accepted.message.id).reason, 'binding-not-ready');
    await gateway.stop();
  });
}

test('ordinary Claude bind-time endpoint failure keeps an endpoint watermark', async t => {
  const f = fixture(t);
  const channel = { id: f.binding.channelId, guildId: 'guild' };
  let preflightCalls = 0;
  const gateway = new DiscordGateway({
    state: f.state,
    client: { user: { id: 'bot' }, channels: { fetch: async () => channel }, on() {}, off() {}, async destroy() {} },
    providers: { claude: { async dispatch() { throw new Error('must stay held'); } } },
    recoveryOptions: {
      ordinaryNativePreflight: async () => { preflightCalls += 1; throw new Error('connect ENOENT'); }
    }
  });
  const result = await gateway.recoverTransport('ordinary-bind', 0);
  assert.equal(preflightCalls, 1);
  assert.equal(result.ready, false);
  assert.equal(result.state, READINESS.UNAVAILABLE);
  assert.equal(f.state.getBinding(f.binding.channelId).readiness, READINESS.UNAVAILABLE);
  assert.match(f.state.getIntakeWatermark(f.binding.channelId).detail, /^Claude endpoint unavailable before event write: connect ENOENT/);
  await gateway.stop();
});

test('ordinary Claude recovery cannot restore a stale terminal binding', async t => {
  const f = fixture(t);
  f.state.markIntakeBoundary(f.binding.channelId, READINESS.UNAVAILABLE, 'prior unavailable recovery failure', null, null, f.binding);
  const originalGetIntakeWatermark = f.state.getIntakeWatermark.bind(f.state);
  let successor = null;
  f.state.getIntakeWatermark = channelId => {
    const watermark = originalGetIntakeWatermark(channelId);
    if (!successor && channelId === f.binding.channelId) {
      f.state.unbind(f.binding.channelId);
      successor = f.state.rebindOrdinaryClaude({
        channelId: f.binding.channelId, guildId: 'guild', provider: 'claude', nativeId: CLAUDE,
        workspace: f.dir, endpoint: f.socketPath
      }, { sessionId: CLAUDE, threadId: CLAUDE, harness: 'claude-code' });
    }
    return watermark;
  };
  const gateway = new DiscordGateway({
    state: f.state,
    client: { user: { id: 'bot' }, on() {}, off() {}, async destroy() {} },
    providers: { claude: { async dispatch() { throw new Error('must stay held'); } } }
  });
  const result = await gateway.recoverTransport('stale-terminal', 0);
  f.state.getIntakeWatermark = originalGetIntakeWatermark;
  assert.deepEqual(result, { ready: false, state: READINESS.UNAVAILABLE });
  assert.equal(successor.generation, 2);
  assert.equal(f.state.getBinding(f.binding.channelId).generation, 2);
  assert.equal(f.state.getBinding(f.binding.channelId).readiness, READINESS.PENDING);
  assert.equal(f.state.getIntakeWatermark(f.binding.channelId).state, READINESS.UNAVAILABLE);
  await gateway.stop();
});

test('ordinary Claude pre-write endpoint loss demotes only matching binding and holds later intake', async t => {
  const f = fixture(t);
  const channel = {
    id: f.binding.channelId,
    guildId: 'guild',
    permissionsFor: () => ({ has: () => true }),
    async send() { return { id: 'receipt' }; }
  };
  const gateway = new DiscordGateway({
    state: f.state,
    client: { user: { id: 'bot' }, channels: { fetch: async () => channel }, on() {}, off() {}, async destroy() {} },
    fetchHistory: async () => [],
    providers: { claude: new ClaudeProvider({ waitForReply: (id, options) => waitForReply(f.state, id, options) }) }
  });
  gateway.historyPermission = () => ({ known: true, allowed: true });
  const monitor = createClaudeMonitor({ state: f.state, nativeId: CLAUDE, socketPath: f.socketPath, stateDir: f.dir, dbPath: f.db });
  await monitor.start();
  const recovery = await gateway.recoverTransport('monitor-ready', 0);
  assert.equal(recovery.ready, true);
  assert.equal(f.state.getBinding(f.binding.channelId).readiness, READINESS.READY);
  await new Promise((resolve, reject) => monitor.server.close(error => error ? reject(error) : resolve()));
  try { fs.unlinkSync(f.socketPath); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const result = await gateway.consumer.handleMessage({
    id: 'endpoint-loss', guildId: 'guild', channelId: f.binding.channelId, content: 'lost endpoint',
    author: { id: 'operator', bot: false }, channel
  });
  assert.equal(result.status, 'not_submitted');
  assert.equal(f.state.getMessage('endpoint-loss').state, MESSAGE_STATES.ACCEPTED);
  await waitFor(() => f.state.getBinding(f.binding.channelId)?.readiness === READINESS.UNAVAILABLE);
  assert.equal(gateway.ready, false);
  const held = await gateway.consumer.intakeMessage({
    id: 'endpoint-loss-held', guildId: 'guild', channelId: f.binding.channelId, content: 'hold after loss',
    author: { id: 'operator', bot: false }, channel
  }, false, null, null, true);
  assert.equal(held.accepted, true);
  assert.equal(f.state.claimDispatch('endpoint-loss-held').reason, 'binding-not-ready');
  assert.equal(f.state.getMessage('endpoint-loss-held').state, MESSAGE_STATES.ACCEPTED);
  await gateway.stop();
  try { await monitor.stop(); } catch {}
});

test('ordinary Claude Monitor leaves readiness promotion to Gateway and revokes it on stop', async t => {
  const f = fixture(t);
  f.state.close();
  const child = spawn(process.execPath, [CLI_PATH, 'claude-monitor', '--state-dir', f.dir, '--db', f.db, '--native-id', CLAUDE, '--socket', f.socketPath], {
    stdio: ['ignore', 'pipe', 'pipe']
  });
  t.after(async () => {
    if (child.exitCode === null) child.kill('SIGTERM');
  });
  const observed = new SurfaceState(f.db);
  await waitFor(() => fs.existsSync(f.socketPath));
  assert.equal(observed.getBinding(f.binding.channelId).readiness, READINESS.PENDING);
  child.kill('SIGTERM');
  await new Promise((resolve, reject) => {
    child.once('close', resolve);
    child.once('error', reject);
  });
  await waitFor(() => observed.getBinding(f.binding.channelId)?.readiness === READINESS.UNAVAILABLE);
  assert.equal(fs.existsSync(f.socketPath), false);
  observed.close();
});

test('Claude Monitor releases settled dedupe after native reply becomes terminal', async t => {
  const f = fixture(t);
  const stdout = new EventEmitter();
  const events = [];
  let prune;
  const timer = { unref() {} };
  t.mock.method(global, 'setInterval', callback => {
    prune = callback;
    return timer;
  });
  t.mock.method(global, 'clearInterval', value => assert.equal(value, timer));
  stdout.write = (chunk, callback) => {
    events.push(JSON.parse(String(chunk)));
    callback?.();
    return true;
  };
  const monitor = createMonitorMcp({ state: f.state, stateDir: f.dir, dbPath: f.db, stdout });
  f.state.setBindingReadiness(f.binding.channelId, READINESS.READY, 'test Monitor ready', f.binding);
  const intake = f.state.acceptDiscordMessage({
    id: 'ordinary-claude-dedupe-release', guildId: 'guild', channelId: f.binding.channelId,
    authorId: 'operator', isBot: false, content: 'answer this'
  });
  assert.equal(f.state.claimDispatch(intake.message.id).claimed, true);
  f.state.markSubmitted(intake.message.id);
  const event = {
    method: 'notifications/claude/channel',
    params: { content: 'answer this', meta: { messageId: intake.message.id, nativeId: CLAUDE, generation: '1' } }
  };
  await monitor.notification(event);
  assert.equal(events.length, 1);
  f.state.recordNativeReply({ provider: 'claude', messageId: intake.message.id, nativeId: CLAUDE, generation: 1, text: 'done' });
  prune();
  await monitor.notification(event);
  assert.equal(events.length, 2);
  await monitor.close();
});

test('real ClaudeProvider and Claude Monitor path preserves exact reply custody', async t => {
  const f = fixture(t);
  const stdout = new EventEmitter();
  const events = [];
  stdout.write = (chunk, callback) => {
    events.push(JSON.parse(String(chunk)));
    callback?.();
    return true;
  };
  const monitor = createClaudeMonitor({ state: f.state, nativeId: CLAUDE, socketPath: f.socketPath, stateDir: f.dir, dbPath: f.db, stdout });
  await monitor.start();
  f.state.setBindingReadiness(f.binding.channelId, READINESS.READY, 'test Monitor ready', f.binding);
  const intake = f.state.acceptDiscordMessage({
    id: 'ordinary-claude-event', guildId: 'guild', channelId: f.binding.channelId,
    authorId: 'operator', isBot: false, content: 'answer this'
  });
  assert.equal(intake.accepted, true);
  const provider = new ClaudeProvider({ waitForReply: (id, options) => waitForReply(f.state, id, options) });
  const work = dispatchAndObserve(f.state, intake.message.id, { claude: provider }, { timeoutMs: 3000, pollMs: 5 });
  await waitFor(() => events.length === 1);
  const pointer = events[0];
  const payload = JSON.parse(fs.readFileSync(pointer.payloadPath, 'utf8'));
  assert.equal(payload.meta.nativeId, CLAUDE);
  assert.equal(payload.meta.messageId, intake.message.id);
  const duplicate = await postUnixJson(f.socketPath, { nativeId: CLAUDE, messageId: intake.message.id, generation: 1, content: 'duplicate' });
  assert.equal(duplicate.statusCode, 202);
  f.state.recordNativeReply({ provider: 'claude', messageId: intake.message.id, nativeId: CLAUDE, generation: 1, text: 'Claude answer' });
  const result = await work;
  assert.equal(result.message.state, MESSAGE_STATES.REPLY_READY);
  assert.equal(f.state.getMessage(intake.message.id).replyText, 'Claude answer');
  await monitor.stop();
});

test('Claude Monitor stdout failure stops transport and detaches listeners', async t => {
  const errorFixture = fixture(t);
  const closeFixture = fixture(t);
  const errorStdout = new EventEmitter();
  const closeStdout = new EventEmitter();
  errorStdout.write = (_chunk, callback) => { callback?.(); return true; };
  closeStdout.write = (_chunk, callback) => { callback?.(); return true; };
  let errorTransportCloses = 0;
  let closeTransportCloses = 0;
  const errorMonitor = createClaudeMonitor({
    state: errorFixture.state, nativeId: CLAUDE, socketPath: errorFixture.socketPath,
    stateDir: errorFixture.dir, dbPath: errorFixture.db, stdout: errorStdout,
    onTransportClose: () => { errorTransportCloses += 1; }
  });
  const closeMonitor = createClaudeMonitor({
    state: closeFixture.state, nativeId: CLAUDE, socketPath: closeFixture.socketPath,
    stateDir: closeFixture.dir, dbPath: closeFixture.db, stdout: closeStdout,
    onTransportClose: () => { closeTransportCloses += 1; }
  });
  t.after(async () => {
    await errorMonitor.stop().catch(() => {});
    await closeMonitor.stop().catch(() => {});
  });

  await Promise.all([errorMonitor.start(), closeMonitor.start()]);
  assert.equal(errorStdout.listenerCount('error'), 1);
  assert.equal(errorStdout.listenerCount('close'), 1);
  assert.equal(closeStdout.listenerCount('error'), 1);
  assert.equal(closeStdout.listenerCount('close'), 1);

  assert.doesNotThrow(() => errorStdout.emit('error', new Error('stdout failed')));
  assert.doesNotThrow(() => closeStdout.emit('close'));
  await waitFor(() => !errorMonitor.started && !closeMonitor.started);

  assert.equal(errorMonitor.ready, false);
  assert.equal(closeMonitor.ready, false);
  assert.equal(errorTransportCloses, 1);
  assert.equal(closeTransportCloses, 1);
  assert.equal(errorStdout.listenerCount('error'), 0);
  assert.equal(errorStdout.listenerCount('close'), 0);
  assert.equal(closeStdout.listenerCount('error'), 0);
  assert.equal(closeStdout.listenerCount('close'), 0);
  assert.equal(fs.existsSync(errorFixture.socketPath), false);
  assert.equal(fs.existsSync(closeFixture.socketPath), false);
});

test('ordinary Claude post preserves dedupe and stale generation custody', async t => {
  const f = fixture(t);
  const textFile = path.join(f.dir, 'milestone.txt');
  fs.writeFileSync(textFile, 'ordinary Claude milestone');
  let calls = 0;
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ id: `milestone-${++calls}` }) });
  const first = await runDirectPost({ state: f.state, token: 'fixture', nativeId: CLAUDE, generation: 1, channelId: f.binding.channelId,
    provider: 'claude', ordinary: true, textFile, dedupeKey: 'ordinary-claude-milestone', fetchImpl });
  const duplicate = await runDirectPost({ state: f.state, token: 'fixture', nativeId: CLAUDE, generation: 1, channelId: f.binding.channelId,
    provider: 'claude', ordinary: true, textFile, dedupeKey: 'ordinary-claude-milestone', fetchImpl });
  assert.equal(first.status, 'sent');
  assert.equal(duplicate.duplicate, true);
  assert.equal(calls, 1);
  f.state.unbind(f.binding.channelId);
  const rebound = f.state.rebindOrdinaryClaude({ channelId: f.binding.channelId, guildId: 'guild', provider: 'claude', nativeId: CLAUDE, workspace: f.dir, endpoint: f.socketPath },
    { sessionId: CLAUDE, threadId: CLAUDE, harness: 'claude-code' });
  assert.equal(rebound.generation, 2);
  await assert.rejects(() => runDirectPost({ state: f.state, token: 'fixture', nativeId: CLAUDE, generation: 1, channelId: f.binding.channelId,
    provider: 'claude', ordinary: true, textFile, dedupeKey: 'stale-claude', fetchImpl }), error => error instanceof StaleGenerationError);
});


test('Monitor construction failure releases allocated timers and listeners', t => {
  const timers = new Set();
  t.mock.method(global, 'setInterval', () => {
    const timer = { unref() {} };
    timers.add(timer);
    return timer;
  });
  t.mock.method(global, 'clearInterval', timer => timers.delete(timer));
  const stdout = new EventEmitter();
  stdout.write = () => true;
  assert.throws(() => createClaudeMonitor({
    state: { findNativeBinding: () => null },
    nativeId: CLAUDE,
    socketPath: '/tmp/monitor-construction-failure.sock',
    stateDir: '/tmp/monitor-construction-failure',
    stdout
  }), /pre-bound, opted-in/);
  assert.equal(timers.size, 0);
  assert.equal(stdout.listenerCount('error'), 0);
  assert.equal(stdout.listenerCount('close'), 0);
});


test('ordinary Claude preflight rereads Gateway after binding mutation', async t => {
  const f = fixture(t, { bind: false });
  const channel = { id: 'claude-channel', guildId: 'guild', name: 'dev', isTextBased: () => true };
  let reads = 0;
  const supportedCapabilities = [
    GATEWAY_CAPABILITIES.ordinaryBindWake,
    GATEWAY_CAPABILITIES.runtimeBindLock,
    GATEWAY_CAPABILITIES.ordinaryClaudeBind
  ];
  await assert.rejects(() => ordinaryClaudeBind({
    'state-dir': f.dir, channel: '#dev', transcript: f.session.file, socket: f.socketPath
  }, {
    resolveClaudeCaller: () => ({ sessionId: CLAUDE, harness: 'claude-code' }),
    requireInstalled: () => ({ Client: fakeClient(channel), GatewayIntentBits: { Guilds: 1 } }),
    readSecret: () => 'fixture-token',
    gatewayProcessStatus: () => (++reads < 3
      ? { state: 'running', pid: 4242, capabilities: supportedCapabilities }
      : { state: 'running', pid: 4243, capabilities: [GATEWAY_CAPABILITIES.ordinaryBindWake, GATEWAY_CAPABILITIES.runtimeBindLock] }),
    environment: { DISCORD_SURFACE_ORDINARY_CLAUDE_RUNTIME_PID: '4242' },
    killProcess: () => {},
    print: () => {}
  }), /running Gateway changed while binding ordinary Claude session/);
  const binding = f.state.getBinding(channel.id);
  assert.ok(binding);
  assert.equal(f.state.hasOrdinaryPreflight(binding), false);
});

test('ordinary Claude bind pins recovery wake to the selected Gateway', async t => {
  const f = fixture(t, { bind: false });
  const channel = { id: 'claude-channel', guildId: 'guild', name: 'dev', isTextBased: () => true };
  const selected = {
    state: 'running', pid: 4242,
    capabilities: [GATEWAY_CAPABILITIES.ordinaryBindWake, GATEWAY_CAPABILITIES.runtimeBindLock, GATEWAY_CAPABILITIES.ordinaryClaudeBind]
  };
  const replacement = { state: 'running', pid: 4243, capabilities: [] };
  let reads = 0;
  const wakeSignals = [];
  const result = await ordinaryClaudeBind({
    'state-dir': f.dir, channel: '#dev', transcript: f.session.file, socket: f.socketPath
  }, {
    resolveClaudeCaller: () => ({ sessionId: CLAUDE, harness: 'claude-code' }),
    requireInstalled: () => ({ Client: fakeClient(channel), GatewayIntentBits: { Guilds: 1 } }),
    readSecret: () => 'fixture-token',
    validateClaudeSessionIdentity: () => ({ file: f.session.file, sessionId: CLAUDE, threadId: CLAUDE, workspace: f.dir }),
    gatewayProcessStatus: () => (++reads < 4 ? selected : replacement),
    environment: { DISCORD_SURFACE_ORDINARY_CLAUDE_RUNTIME_PID: String(selected.pid) },
    killProcess: (pid, signal) => wakeSignals.push({ pid, signal }),
    print: () => {}
  });
  assert.deepEqual(result.gatewayWake, { requested: false, pid: replacement.pid, state: 'running', reason: 'gateway-changed' });
  assert.deepEqual(wakeSignals, []);
});

function spawnChannel(t, f) {
  const child = spawn(process.execPath, [CLI_PATH, 'claude-channel', '--state-dir', f.dir, '--db', f.db, '--native-id', CLAUDE, '--socket', f.socketPath], {
    stdio: ['pipe', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += chunk; });
  const deadline = setTimeout(() => child.kill('SIGKILL'), 20000);
  deadline.unref();
  const closed = new Promise((resolve, reject) => {
    child.once('close', resolve);
    child.once('error', reject);
  });
  t.after(async () => {
    clearTimeout(deadline);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await closed;
  });
  return {
    child,
    stdout: () => stdout,
    stderr: () => stderr,
    async terminate() {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      await closed;
    }
  };
}

async function expectWithin(predicate, label, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(10);
  }
  throw new Error(`${label} did not happen within ${timeoutMs}ms`);
}

function readinessReceipts(state, channelId) {
  return state.listReceipts()
    .filter(row => row.kind === 'binding-readiness')
    .map(row => JSON.parse(row.detail))
    .filter(detail => detail.channelId === channelId);
}

function spawnGateway(t, f, { messageId, content }) {
  const preloadPath = path.join(f.dir, 'gateway-preload.cjs');
  const archiveRoot = path.resolve(__dirname, '..');
  fs.writeFileSync(path.join(f.dir, 'discord.env'), 'DISCORD_TOKEN=fixture-token\n', { mode: 0o600 });
  const preloadSource = String.raw`
const { EventEmitter } = require('node:events');
const Module = require('node:module');
const path = require('node:path');
const archive = __ARCHIVE__;
const channelId = __CHANNEL__;
const heldMessageId = __MESSAGE_ID__;
const heldContent = __CONTENT__;
const channel = {
  id: channelId,
  guildId: 'guild',
  topic: '',
  isTextBased: () => true,
  isThread: () => false,
  permissionsFor: () => ({ has: () => true }),
  messages: {
    async fetch() {
      return [{ id: heldMessageId, guildId: 'guild', channelId, author: { id: 'operator', bot: false }, content: heldContent, attachments: [],
        async react() {} }];
    }
  },
  async send() { return { id: 'fixture-discord-message' }; }
};
class FixtureClient extends EventEmitter {
  constructor() {
    super();
    this.user = { id: 'fixture-bot' };
    this.channels = { fetch: async requested => requested === channelId ? channel : null };
    this.guilds = { fetch: async () => ({ channels: { fetch: async requested => requested ? channel : new Map([[channelId, channel]]) } }) };
  }
  async login() {}
  async destroy() {}
}
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'discord.js') return { Client: FixtureClient, GatewayIntentBits: { Guilds: 1, GuildMessages: 2, MessageContent: 4 }, PermissionFlagsBits: { ViewChannel: 'ViewChannel', ReadMessageHistory: 'ReadMessageHistory', SendMessages: 'SendMessages' } };
  return originalLoad.apply(this, arguments);
};
const nativePath = path.join(archive, 'src', 'native.js');
const native = require(nativePath);
class FixtureClaudeProvider {
  async dispatch(message) {
    const result = await native.postUnixJson(message.endpoint, {
      nativeId: message.nativeId, messageId: message.id, generation: message.generation, content: message.content
    });
    return result.statusCode === 202 ? { status: 'submitted' } : { status: 'not-submitted', error: new Error('Claude channel returned ' + result.statusCode) };
  }
  observe() { return { stopped: true }; }
}
require.cache[require.resolve(nativePath)].exports = { ...native, ClaudeProvider: FixtureClaudeProvider };
setInterval(() => {}, 1000);
`.replaceAll('__ARCHIVE__', JSON.stringify(archiveRoot))
    .replaceAll('__CHANNEL__', JSON.stringify(f.binding.channelId))
    .replaceAll('__MESSAGE_ID__', JSON.stringify(messageId))
    .replaceAll('__CONTENT__', JSON.stringify(content));
  fs.writeFileSync(preloadPath, preloadSource, { mode: 0o600 });
  const child = spawn(process.execPath, [CLI_PATH, 'run', '--state-dir', f.dir, '--db', f.db], {
    cwd: archiveRoot,
    env: { ...process.env, NODE_OPTIONS: `--require=${preloadPath}`, DISCORD_SURFACE_LOCK_HELD: '1' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += chunk; });
  const deadline = setTimeout(() => child.kill('SIGKILL'), 20000);
  deadline.unref();
  const closed = new Promise((resolve, reject) => {
    child.once('close', resolve);
    child.once('error', reject);
  });
  t.after(async () => {
    clearTimeout(deadline);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await closed;
  });
  return {
    child,
    stderr: () => stderr,
    async terminate() {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      await closed;
    }
  };
}

test('ordinary Claude channel startup reopens an endpoint-unavailable watermark, wakes the Gateway, and revokes readiness on stop', async t => {
  const f = fixture(t);
  f.state.markIntakeBoundary(f.binding.channelId, 'unavailable', 'Claude endpoint unavailable before event write: connect ENOENT', null, null, f.binding);
  f.state.close();
  const observed = new SurfaceState(f.db);
  t.after(() => { try { observed.close(); } catch {} });
  const listener = spawnChannel(t, f);
  await expectWithin(() => fs.existsSync(f.socketPath), 'Claude channel socket');
  await expectWithin(() => observed.getIntakeWatermark(f.binding.channelId)?.state === READINESS.PENDING,
    'Claude channel startup reconciling the endpoint-unavailable watermark');
  assert.equal(observed.getBinding(f.binding.channelId).readiness, READINESS.PENDING);
  await expectWithin(() => listener.stderr().includes('could not wake Gateway'),
    'Claude channel startup requesting a Gateway wake');
  assert.match(listener.stderr(), /discord-surface: Claude channel startup could not wake Gateway \(gateway-not-running\)/);

  await listener.terminate();
  assert.equal(observed.getBinding(f.binding.channelId).readiness, READINESS.UNAVAILABLE);
  assert.deepEqual(readinessReceipts(observed, f.binding.channelId).at(-1), {
    channelId: f.binding.channelId, conductorId: null, readiness: READINESS.UNAVAILABLE, detail: 'Claude channel unavailable',
    guildId: f.binding.guildId, provider: f.binding.provider, nativeId: f.binding.nativeId, generation: f.binding.generation
  });
});

test('ordinary Claude channel startup delivers held intake through successful Gateway recovery', async t => {
  const f = fixture(t);
  const messageId = 'claude-channel-held';
  const content = 'deliver through the Claude channel';
  const accepted = f.state.acceptDiscordMessage({
    id: messageId, guildId: 'guild', channelId: f.binding.channelId,
    authorId: 'operator', isBot: false, content, attachments: []
  }, { ready: false });
  assert.equal(accepted.accepted, true);
  assert.equal(f.state.claimDispatch(messageId).reason, 'binding-not-ready');
  f.state.close();

  const gateway = spawnGateway(t, f, { messageId, content });
  await expectWithin(() => fs.existsSync(path.join(f.dir, 'runtime.pid')), 'Gateway runtime pid');
  const listener = spawnChannel(t, f);
  await expectWithin(() => fs.existsSync(f.socketPath), 'Claude channel socket');
  await expectWithin(() => listener.stdout().includes(messageId) && listener.stdout().includes(content), 'held message delivery through Claude channel');
  assert.match(listener.stdout(), new RegExp(messageId));
  assert.match(listener.stdout(), new RegExp(content));
  const observed = new SurfaceState(f.db);
  t.after(() => { try { observed.close(); } catch {} });
  assert.equal(observed.getBinding(f.binding.channelId).readiness, READINESS.READY);
  await listener.terminate();
  await gateway.terminate();
});

test('ordinary Claude channel startup with no held intake still wakes the Gateway and revokes readiness on stop', async t => {
  const f = fixture(t);
  f.state.close();
  const observed = new SurfaceState(f.db);
  t.after(() => { try { observed.close(); } catch {} });
  const listener = spawnChannel(t, f);
  await expectWithin(() => fs.existsSync(f.socketPath), 'Claude channel socket');
  await expectWithin(() => listener.stderr().includes('could not wake Gateway'),
    'Claude channel startup requesting a Gateway wake');
  assert.match(listener.stderr(), /discord-surface: Claude channel startup could not wake Gateway \(gateway-not-running\)/);
  assert.equal(observed.getIntakeWatermark(f.binding.channelId), null);

  await listener.terminate();
  assert.equal(observed.getBinding(f.binding.channelId).readiness, READINESS.UNAVAILABLE);
  assert.equal(readinessReceipts(observed, f.binding.channelId).at(-1).detail, 'Claude channel unavailable');
});

test('Claude channel leaves a conductor binding untouched on start and stop', async t => {
  const f = fixture(t, { bind: false });
  const conductor = f.state.bind({
    channelId: 'claude-channel', guildId: 'guild', provider: 'claude', nativeId: CLAUDE,
    workspace: f.dir, endpoint: f.socketPath, conductorId: 'conductor-1', repoKey: 'repo-1'
  });
  assert.equal(f.state.isOrdinaryBinding(conductor), false);
  f.state.setBindingReadiness(conductor.channelId, READINESS.READY, 'conductor ready', conductor);
  f.state.close();
  const observed = new SurfaceState(f.db);
  t.after(() => { try { observed.close(); } catch {} });
  const before = readinessReceipts(observed, conductor.channelId).length;
  const listener = spawnChannel(t, f);
  await expectWithin(() => fs.existsSync(f.socketPath), 'Claude channel socket');
  await sleep(50);
  assert.equal(observed.getBinding(conductor.channelId).readiness, READINESS.READY);
  assert.equal(listener.stderr().includes('wake Gateway'), false);
  assert.equal(observed.getIntakeWatermark(conductor.channelId), null);

  await listener.terminate();
  assert.equal(observed.getBinding(conductor.channelId).readiness, READINESS.READY);
  assert.equal(readinessReceipts(observed, conductor.channelId).length, before);
});

test('an ordinary listener refuses to attach when its binding changed during startup', t => {
  const f = fixture(t);
  const identity = {
    channelId: f.binding.channelId, guildId: 'guild', provider: 'claude', nativeId: CLAUDE,
    workspace: f.dir, endpoint: f.socketPath, generation: f.binding.generation
  };
  const startupBinding = servedOrdinaryBinding(f.state, identity);
  assert.ok(startupBinding);
  f.state.unbind(f.binding.channelId);
  f.state.rebindOrdinaryClaude({
    channelId: f.binding.channelId, guildId: 'guild', provider: 'claude', nativeId: CLAUDE, workspace: f.dir, endpoint: f.socketPath
  }, { sessionId: CLAUDE, threadId: CLAUDE, harness: 'claude-code' });
  for (const label of ['Claude channel', 'Claude Monitor']) {
    assert.throws(() => attachOrdinaryListener({
      state: f.state, paths: { stateDir: f.dir, db: f.db }, startupBinding, identity, label,
      requestRecovery: () => { throw new Error('must not wake the Gateway for a changed binding'); },
      stderr: { write() { throw new Error('must not report a wake for a changed binding'); } }
    }), new RegExp(`^Error: ${label} binding changed during startup$`));
  }
  assert.equal(detachOrdinaryListener({ state: f.state, startupBinding, reason: 'Claude channel unavailable' }), false);
  assert.equal(f.state.getBinding(f.binding.channelId).readiness, READINESS.PENDING);
});

test('every CLI listener that serves a Claude binding routes through the ordinary lifecycle owner', () => {
  const source = fs.readFileSync(CLI_PATH, 'utf8');
  const commands = [...source.matchAll(/case '([a-z-]+)': return (\w+)\(args\)/g)].map(match => ({ command: match[1], fn: match[2] }));
  assert.ok(commands.length > 10, 'CLI command table must be readable');
  const constructions = /new ClaudeChannel\(|createClaudeMonitor\(/g;
  const listeners = [];
  let claimed = 0;
  for (const { command, fn } of commands) {
    const start = ['async function', 'function']
      .map(keyword => source.indexOf(`\n${keyword} ${fn}(args`))
      .find(index => index >= 0);
    if (start === undefined) continue;
    const body = source.slice(start, source.indexOf('\n}\n', start));
    const found = body.match(constructions)?.length || 0;
    if (!found) continue;
    claimed += found;
    listeners.push(command);
    assert.match(body, /attachOrdinaryListener\(/, `${command} must attach through the ordinary lifecycle owner`);
    assert.match(body, /detachOrdinaryListener\(/, `${command} must detach through the ordinary lifecycle owner`);
    if (command === 'claude-channel') assert.match(body, /beforeTransportClose: detach/, `${command} must revoke before transport close releases its socket`);
  }
  assert.deepEqual(listeners.sort(), ['claude-channel', 'claude-monitor']);
  // A listener built anywhere but a command function would escape the check above.
  assert.equal(claimed, source.match(constructions)?.length || 0, 'every listener must be built by a CLI command function');
});
