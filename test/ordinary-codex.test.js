const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createOrdinaryCodexRequestFromEnvironment, ordinaryBindingDecision, resolveExistingChannel, resolveInvocationIdentity } = require('../src/ordinary-codex');
const { createBindingWakeController, GATEWAY_CAPABILITIES, handoffInternal, ordinaryBind } = require('../src/cli');
const { DiscordGateway } = require('../src/discord');
const { CodexProvider, sessionRoot, validateCodexSessionIdentity, validateCodexSessionIdentityAsync } = require('../src/native');
const { SurfaceState, READINESS, StaleGenerationError } = require('../src/state');
const { runDirectPost } = require('../src/direct-post');
const facade = require('../src/ordinary-codex');
const emitted = require('../dist/ordinary-codex');

const CODEX = '9caa5d21-2169-429d-918b-5f08651b5dbd';
const CODEX_V7 = '01a0701c-5714-7671-a455-db7d67f9fa78';
const OTHER = '79e3da8e-94b4-4aff-8f88-b45b3a451dd1';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinary-codex-'));
  const state = new SurfaceState(path.join(dir, 'surface.sqlite'));
  state.setConfig({ operatorId: 'operator', guildId: 'guild', secretFile: path.join(dir, 'discord.env') });
  const identity = { sessionId: CODEX, threadId: CODEX };
  t.after(() => {
    state.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, identity, state };
}

function ordinary(fixtureState, channelId = 'ordinary-channel', nativeId = CODEX) {
  return fixtureState.state.bindOrdinary({
    channelId, guildId: 'guild', provider: 'codex', nativeId, workspace: fixtureState.dir
  }, { sessionId: nativeId, threadId: nativeId });
}

function transcript(t, workspace, id = CODEX, overrides = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinary-transcript-'));
  const root = path.join(home, 'sessions');
  fs.mkdirSync(root);
  const file = path.join(root, `${id}.jsonl`);
  fs.writeFileSync(file, `${JSON.stringify({ type: 'session_meta', payload: {
    session_id: id, id, cwd: workspace, ...overrides
  } })}\n`);
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return { root, file };
}

test('typed ordinary request rejects missing or conflicting invocation identity', () => {
  assert.throws(() => resolveInvocationIdentity({ CODEX_SESSION_ID: CODEX, PWD: '/tmp/workspace' }), /CODEX_THREAD_ID/);
  assert.equal(resolveInvocationIdentity({ CODEX_THREAD_ID: CODEX, PWD: '/tmp/workspace' }).sessionId, CODEX);
  assert.throws(() => resolveInvocationIdentity({ CODEX_SESSION_ID: CODEX, CODEX_THREAD_ID: OTHER, PWD: '/tmp/workspace' }), /conflict/);
  assert.throws(() => createOrdinaryCodexRequestFromEnvironment({
    channelId: 'channel', guildId: 'guild', workspace: '/tmp/workspace', nativeId: OTHER,
    environment: { CODEX_SESSION_ID: CODEX, CODEX_THREAD_ID: CODEX, PWD: '/tmp/workspace' }
  }), /conflicts/);
  const request = createOrdinaryCodexRequestFromEnvironment({
    channelId: 'channel', guildId: 'guild', workspace: '/tmp/workspace',
    environment: { CODEX_SESSION_ID: CODEX, CODEX_THREAD_ID: CODEX, PWD: '/tmp/workspace' }
  });
  assert.deepEqual(request.identity, { sessionId: CODEX, threadId: CODEX });
  assert.equal(request.nativeId, CODEX);
  assert.equal(resolveInvocationIdentity({ CODEX_SESSION_ID: CODEX_V7, CODEX_THREAD_ID: CODEX_V7, PWD: '/tmp/workspace' }).sessionId, CODEX_V7);
  assert.equal(resolveInvocationIdentity({ CODEX_SESSION_ID: CODEX, CODEX_THREAD_ID: CODEX, PWD: '/checkout' }, '/session-workspace').workspace, '/session-workspace');
  assert.equal(resolveInvocationIdentity({ CODEX_SESSION_ID: CODEX, CODEX_THREAD_ID: CODEX, PWD: '/checkout' }).workspace, undefined);
  assert.throws(() => createOrdinaryCodexRequestFromEnvironment({
    channelId: 'channel', guildId: 'guild',
    environment: { CODEX_SESSION_ID: CODEX, CODEX_THREAD_ID: CODEX, PWD: '/checkout' }
  }), /workspace must come from exact Codex session metadata/);
});

test('ordinary CommonJS facade exposes emitted code and fails closed when output is absent', () => {
  assert.equal(facade.resolveExistingChannel, emitted.resolveExistingChannel);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinary-codex-missing-'));
  try {
    fs.mkdirSync(path.join(root, 'src'));
    fs.copyFileSync(path.resolve(__dirname, '../src/ordinary-codex.js'), path.join(root, 'src/ordinary-codex.js'));
    const result = spawnSync(process.execPath, ['-e', "require('./src/ordinary-codex')"], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /run npm run build before starting/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('channel resolution accepts exact ID, mention, and one name only in the configured guild', () => {
  const channels = [
    { id: '123', guildId: 'guild', name: 'ops', messageCapable: true },
    { id: '456', guildId: 'guild', name: 'dev', messageCapable: true },
    { id: '999', guildId: 'guild', name: 'ops', messageCapable: true },
    { id: '789', guildId: 'other-guild', name: 'ops', messageCapable: true }
  ];
  assert.equal(resolveExistingChannel('123', 'guild', channels).name, 'ops');
  assert.equal(resolveExistingChannel('<#456>', 'guild', channels).name, 'dev');
  assert.equal(resolveExistingChannel('dev', 'guild', channels).id, '456');
  assert.equal(resolveExistingChannel('#dev', 'guild', channels).id, '456');
  assert.throws(() => resolveExistingChannel('ops', 'guild', channels), /ambiguous/);
  assert.throws(() => resolveExistingChannel('<#789>', 'guild', channels), /outside/);
  assert.throws(() => resolveExistingChannel('missing', 'guild', channels), /unknown/);
  assert.throws(() => resolveExistingChannel('123', 'guild', [{ ...channels[0], messageCapable: false }]), /message-capable/);
  assert.throws(() => resolveExistingChannel('dev', 'guild', [{ ...channels[1], messageCapable: false }]), /message-capable/);
});

test('ordinary bind rejects ownership loss while recording native proof', async t => {
  const f = fixture(t);
  const channel = { id: 'ordinary-channel', guildId: 'guild', name: 'dev', isTextBased: () => true };
  let printed = false;
  class Client {
    constructor() { this.guilds = { fetch: async () => ({ channels: { fetch: async () => [channel] } }) }; }
    async login() {}
    async destroy() {}
  }
  t.mock.method(SurfaceState.prototype, 'recordOrdinaryPreflight', function(binding) {
    this.unbind(binding.channelId);
    return null;
  });
  await assert.rejects(() => ordinaryBind({ 'state-dir': f.dir, channel: '#dev', workspace: f.dir }, {
    environment: { CODEX_SESSION_ID: CODEX, CODEX_THREAD_ID: CODEX, PWD: f.dir },
    requireInstalled: () => ({ Client, GatewayIntentBits: { Guilds: 1 } }),
    readSecret: () => 'fixture-token',
    validateCodexSessionIdentity: () => ({ file: path.join(f.dir, 'session.jsonl'), sessionId: CODEX, threadId: CODEX, workspace: f.dir }),
    gatewayProcessStatus: () => ({ state: 'stopped' }),
    print: () => { printed = true; }
  }), /binding changed before native proof/);
  assert.equal(printed, false);
  assert.equal(f.state.getBinding(channel.id).active, false);
  assert.equal(f.state.listReceipts().some(row => row.kind === 'ordinary-native-preflight'), false);
});

test('ordinary bind reuses the exact owner and wakes an already-running Gateway', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinary-bind-cli-'));
  const db = path.join(dir, 'surface.sqlite');
  const setup = new SurfaceState(db);
  setup.setConfig({ operatorId: 'operator', guildId: 'guild', secretFile: path.join(dir, 'discord.env') });
  setup.close();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  let cutoffFetches = 0;
  const validationRoots = [];
  const channel = {
    id: 'ordinary-channel', guildId: 'guild', name: 'dev', isTextBased: () => true,
    messages: { fetch: async () => { cutoffFetches += 1; return new Map([['latest', { id: `latest-${cutoffFetches}` }]]); } }
  };
  const category = { id: 'category-channel', guildId: 'guild', name: 'category', isTextBased: () => false };
  const wakeSignals = [];
  class FakeClient {
    constructor() {
      this.guilds = { fetch: async () => ({ channels: {
        fetch: async selection => selection === category.id ? category : selection ? channel : new Map([[channel.id, channel], [category.id, category]])
      } }) };
    }
    async login() {}
    async destroy() {}
  }
  const dependencies = {
    environment: { CODEX_SESSION_ID: CODEX, CODEX_THREAD_ID: CODEX, PWD: dir },
    requireInstalled: () => ({ Client: FakeClient, GatewayIntentBits: { Guilds: 1 } }),
    readSecret: () => 'fixture-token',
    validateCodexSessionIdentity: (...args) => {
      validationRoots.push(args[2]);
      return { file: path.join(dir, 'session.jsonl'), sessionId: CODEX, threadId: CODEX, workspace: dir };
    },
    gatewayProcessStatus: () => ({ state: 'running', pid: 4242, capabilities: [GATEWAY_CAPABILITIES.ordinaryBindWake] }),
    killProcess: (pid, signal) => wakeSignals.push({ pid, signal }),
    print: () => {}
  };
  const args = { 'state-dir': dir, channel: '#dev', workspace: dir };
  const first = await ordinaryBind(args, dependencies);
  const second = await ordinaryBind(args, dependencies);
  assert.equal(first.reused, false);
  assert.equal(second.reused, true);
  assert.equal(first.binding.generation, 1);
  assert.equal(second.binding.generation, 1);
  assert.deepEqual(validationRoots, [undefined, sessionRoot({})]);
  assert.equal(second.binding.readiness, READINESS.PENDING);
  assert.equal(first.nativeProof.status, 'verified');
  assert.equal(second.nativeProof.status, 'verified');
  assert.deepEqual(wakeSignals, [{ pid: 4242, signal: 'SIGUSR2' }, { pid: 4242, signal: 'SIGUSR2' }]);

  const tombstone = new SurfaceState(db);
  try {
    assert.equal(tombstone.unbind(channel.id), true);
    assert.throws(() => tombstone.rebindOrdinary({
      channelId: channel.id, guildId: 'guild', provider: 'codex', nativeId: OTHER, workspace: dir
    }, { sessionId: OTHER, threadId: OTHER }), /owner changed/);
  } finally { tombstone.close(); }
  await assert.rejects(() => ordinaryBind({ ...args }, {
    ...dependencies,
    environment: { CODEX_SESSION_ID: OTHER, CODEX_THREAD_ID: OTHER, PWD: dir }
  }), /already bound to another owner/);
  const rebound = await ordinaryBind(args, dependencies);
  assert.equal(rebound.reused, false);
  assert.equal(rebound.binding.generation, 2);
  assert.equal(rebound.binding.readiness, READINESS.PENDING);
  assert.equal(rebound.nativeProof.status, 'verified');
  assert.equal(cutoffFetches, 2);

  const stateAfterRebind = new SurfaceState(db);
  try {
    assert.equal(stateAfterRebind.getIntakeWatermark(channel.id).last_seen_id, 'latest-2');
  } finally { stateAfterRebind.close(); }

  await assert.rejects(() => ordinaryBind({ ...args, channel: '#category' }, dependencies), /message-capable/);

  await assert.rejects(() => ordinaryBind(args, {
    ...dependencies,
    environment: { CODEX_SESSION_ID: OTHER, CODEX_THREAD_ID: OTHER, PWD: dir }
  }), /already bound to another owner/);

  const state = new SurfaceState(db);
  try {
    const receipts = state.listReceipts();
    assert.equal(receipts.filter(receipt => receipt.kind === 'ordinary-bound').length, 2);
    assert.equal(receipts.filter(receipt => receipt.kind === 'ordinary-native-preflight').length, 2);
  } finally { state.close(); }
});

test('ordinary bind refuses an incompatible running Gateway before mutation', async t => {
  const f = fixture(t);
  const channel = { id: 'ordinary-channel', guildId: 'guild', name: 'dev', isTextBased: () => true };
  let printed = false;
  class Client {
    constructor() {
      this.guilds = { fetch: async () => ({ channels: {
        fetch: async selection => selection ? channel : new Map([[channel.id, channel]])
      } }) };
    }
    async login() {}
    async destroy() {}
  }
  await assert.rejects(() => ordinaryBind({ 'state-dir': f.dir, channel: '#dev', workspace: f.dir }, {
    environment: { CODEX_SESSION_ID: CODEX, CODEX_THREAD_ID: CODEX, PWD: f.dir },
    requireInstalled: () => ({ Client, GatewayIntentBits: { Guilds: 1 } }),
    readSecret: () => 'fixture-token',
    validateCodexSessionIdentity: () => ({ file: path.join(f.dir, 'session.jsonl'), sessionId: CODEX, threadId: CODEX, workspace: f.dir }),
    gatewayProcessStatus: () => ({ state: 'running', pid: 4242, capabilities: [] }),
    print: () => { printed = true; }
  }), /does not support ordinary binding wake/);
  assert.equal(f.state.getBinding(channel.id), null);
  assert.equal(printed, false);
});

test('ordinary bind reopens terminal intake after native proof recovers', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinary-bind-recovery-'));
  const db = path.join(dir, 'surface.sqlite');
  const session = transcript(t, dir);
  const setup = new SurfaceState(db);
  setup.setConfig({ operatorId: 'operator', guildId: 'guild', secretFile: path.join(dir, 'discord.env') });
  setup.close();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const channel = { id: 'ordinary-recovery-channel', guildId: 'guild', name: 'dev', isTextBased: () => true };
  class FakeClient {
    constructor() {
      this.guilds = { fetch: async () => ({ channels: {
        fetch: async selection => selection ? channel : new Map([[channel.id, channel]])
      } }) };
    }
    async login() {}
    async destroy() {}
  }
  const dependencies = {
    environment: { CODEX_SESSION_ID: CODEX, CODEX_THREAD_ID: CODEX, PWD: dir },
    requireInstalled: () => ({ Client: FakeClient, GatewayIntentBits: { Guilds: 1 } }),
    readSecret: () => 'fixture-token',
    validateCodexSessionIdentity: () => { throw new Error('transcript is not available yet'); },
    gatewayProcessStatus: () => ({ state: 'stopped' }),
    print: () => {}
  };
  const args = { 'state-dir': dir, channel: '#dev', workspace: dir };
  const first = await ordinaryBind(args, dependencies);
  assert.equal(first.reused, false);
  assert.equal(first.nativeProof.status, 'pending');

  const unavailable = new SurfaceState(db);
  unavailable.markIntakeBoundary('ordinary-recovery-channel', READINESS.UNAVAILABLE, 'Gateway intake unavailable');
  unavailable.close();

  const recovered = await ordinaryBind(args, {
    ...dependencies,
    validateCodexSessionIdentity: () => ({ file: session.file, sessionId: CODEX, threadId: CODEX, workspace: dir })
  });
  assert.equal(recovered.reused, true);
  assert.equal(recovered.nativeProof.status, 'verified');

  const state = new SurfaceState(db);
  try {
    assert.equal(state.getBinding('ordinary-recovery-channel').readiness, READINESS.PENDING);
    assert.equal(state.getIntakeWatermark('ordinary-recovery-channel').state, READINESS.PENDING);
  } finally { state.close(); }
});

test('ordinary bind derives workspace from exact transcript metadata across checkouts', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinary-bind-workspace-'));
  const invocationWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinary-invocation-'));
  const sessionWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinary-session-workspace-'));
  const session = transcript(t, sessionWorkspace);
  const db = path.join(dir, 'surface.sqlite');
  const setup = new SurfaceState(db);
  setup.setConfig({ operatorId: 'operator', guildId: 'guild', secretFile: path.join(dir, 'discord.env') });
  setup.close();
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(invocationWorkspace, { recursive: true, force: true });
    fs.rmSync(sessionWorkspace, { recursive: true, force: true });
  });

  const channel = { id: 'workspace-channel', guildId: 'guild', name: 'dev', isTextBased: () => true };
  let logins = 0;
  class FakeClient {
    constructor() {
      this.guilds = { fetch: async () => ({ channels: {
        fetch: async selection => selection ? channel : new Map([[channel.id, channel]])
      } }) };
    }
    async login() { logins += 1; }
    async destroy() {}
  }
  const dependencies = {
    environment: { CODEX_SESSION_ID: CODEX, CODEX_THREAD_ID: CODEX, PWD: invocationWorkspace },
    requireInstalled: () => ({ Client: FakeClient, GatewayIntentBits: { Guilds: 1 } }),
    readSecret: () => 'fixture-token',
    validateCodexSessionIdentity,
    gatewayProcessStatus: () => ({ state: 'stopped' }),
    print: () => {}
  };
  const args = { 'state-dir': dir, channel: '#dev', 'session-root': session.root };
  const result = await ordinaryBind(args, dependencies);
  assert.equal(logins, 1);
  assert.equal(result.binding.workspace, sessionWorkspace);
  assert.equal(result.binding.sessionRoot, session.root);
  assert.equal(result.nativeProof.status, 'verified');
  await assert.rejects(() => ordinaryBind({ ...args, workspace: invocationWorkspace }, dependencies), /does not match the supplied workspace/);
  assert.equal(logins, 1);
});

test('ordinary bind after Gateway start wakes real recovery and dispatches held intake', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinary-gateway-bind-'));
  const db = path.join(dir, 'surface.sqlite');
  const secretFile = path.join(dir, 'discord.env');
  fs.writeFileSync(secretFile, 'DISCORD_TOKEN=fixture-token\n', { mode: 0o600 });
  fs.chmodSync(secretFile, 0o600);
  const session = transcript(t, dir);
  const state = new SurfaceState(db);
  state.setConfig({ operatorId: 'operator', guildId: 'guild', secretFile });
  let releaseHistory;
  const historyGate = new Promise(resolve => { releaseHistory = resolve; });
  let firstHistoryStarted;
  const firstHistory = new Promise(resolve => { firstHistoryStarted = resolve; });
  const channel = {
    id: 'gateway-channel',
    guildId: 'guild',
    name: 'gateway-channel',
    topic: null,
    isTextBased: () => true,
    permissionsFor: () => ({ has: () => true }),
    async send() { return { id: `reply-${Date.now()}` }; }
  };
  const client = {
    user: { id: 'bot' },
    channels: { fetch: async () => channel },
    on() {},
    off() {},
    async login() {},
    async destroy() {}
  };
  let historyCalls = 0;
  let dispatches = 0;
  let dispatchedSessionRoot;
  const gateway = new DiscordGateway({
    state,
    client,
    fetchHistory: async () => {
      historyCalls += 1;
      if (historyCalls === 1) {
        firstHistoryStarted();
        await historyGate;
      }
      return [];
    },
    providers: {
      codex: {
        async dispatch(message) { dispatches += 1; dispatchedSessionRoot = message.sessionRoot; return { status: 'submitted' }; },
        async observe() { return { text: 'answer' }; }
      }
    },
    recoveryOptions: {
      codexSessionRoot: session.root,
      ordinaryNativePreflight: current => validateCodexSessionIdentity(current.nativeId, current.workspace, session.root)
    }
  });
  gateway.historyPermission = () => ({ known: true, allowed: true });
  let stopping = false;
  const wakeErrors = [];
  const wake = createBindingWakeController({
    getGateway: () => gateway,
    isReady: () => gateway.ready,
    isStopping: () => stopping,
    logger: error => wakeErrors.push(error)
  });
  t.after(async () => {
    stopping = true;
    releaseHistory?.();
    await wake.wait();
    await gateway.stop();
    state.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await gateway.start(secretFile);
  assert.equal(gateway.ready, true);
  const bindClient = class {
    constructor() {
      this.guilds = { fetch: async () => ({ channels: {
        fetch: async selection => selection ? channel : new Map([[channel.id, channel]])
      } }) };
    }
    async login() {}
    async destroy() {}
  };
  const dependencies = {
    environment: { CODEX_SESSION_ID: CODEX, CODEX_THREAD_ID: CODEX, PWD: dir },
    requireInstalled: () => ({ Client: bindClient, GatewayIntentBits: { Guilds: 1 } }),
    readSecret: () => 'fixture-token',
    validateCodexSessionIdentity,
    gatewayProcessStatus: () => ({ state: 'running', pid: 4242, capabilities: [GATEWAY_CAPABILITIES.ordinaryBindWake] }),
    killProcess: () => wake.request(),
    print: () => {}
  };
  const args = { 'state-dir': dir, channel: '#gateway-channel', 'session-root': session.root };
  const first = await ordinaryBind(args, dependencies);
  await firstHistory;
  const accepted = state.acceptDiscordMessage({
    id: 'gateway-held-input', guildId: 'guild', channelId: channel.id,
    authorId: 'operator', isBot: false, content: 'held until Gateway recovery'
  }, { ready: false });
  assert.equal(accepted.accepted, true);
  const second = await ordinaryBind(args, dependencies);
  assert.equal(first.reused, false);
  assert.equal(second.reused, true);
  releaseHistory();
  await wake.wait();
  assert.deepEqual(wakeErrors, []);
  assert.ok(historyCalls >= 2);
  assert.equal(state.getBinding(channel.id).readiness, READINESS.READY);
  assert.equal(dispatches, 1);
  assert.equal(dispatchedSessionRoot, session.root);
  assert.equal(state.getMessage('gateway-held-input').state, 'replied');
});

test('ordinary bind uses the empty channel snowflake as its cutoff', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinary-bind-empty-cutoff-'));
  const db = path.join(dir, 'surface.sqlite');
  const setup = new SurfaceState(db);
  setup.setConfig({ operatorId: 'operator', guildId: 'guild', secretFile: path.join(dir, 'discord.env') });
  setup.close();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  let fetchStartedAt = 0;
  let fetchCompletedAt = 0;
  const channel = {
    id: '123456789012345678', guildId: 'guild', name: 'dev', isTextBased: () => true,
    messages: { fetch: async () => {
      fetchStartedAt = Date.now();
      await new Promise(resolve => setTimeout(resolve, 50));
      fetchCompletedAt = Date.now();
      return new Map();
    } }
  };
  class FakeClient {
    constructor() {
      this.guilds = { fetch: async () => ({ channels: {
        fetch: async selection => selection ? channel : new Map([[channel.id, channel]])
      } }) };
    }
    async login() {}
    async destroy() {}
  }
  await ordinaryBind({ 'state-dir': dir, channel: '#dev' }, {
    environment: { CODEX_SESSION_ID: CODEX, CODEX_THREAD_ID: CODEX, PWD: dir },
    requireInstalled: () => ({ Client: FakeClient, GatewayIntentBits: { Guilds: 1 } }),
    readSecret: () => 'fixture-token',
    validateCodexSessionIdentity: () => ({ file: path.join(dir, 'session.jsonl'), sessionId: CODEX, threadId: CODEX, workspace: dir }),
    gatewayProcessStatus: () => ({ state: 'stopped' }),
    print: () => {}
  });

  const state = new SurfaceState(db);
  try {
    const watermark = state.getIntakeWatermark(channel.id);
    assert.equal(watermark.last_seen_id, channel.id);
    assert.ok(fetchCompletedAt >= fetchStartedAt);
  } finally { state.close(); }
});

test('ordinary bind rejects an inactive different owner despite verified proof', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinary-successor-bind-'));
  const db = path.join(dir, 'surface.sqlite');
  const successorWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinary-successor-bind-workspace-'));
  const successorSession = transcript(t, successorWorkspace, OTHER);
  const setup = new SurfaceState(db);
  setup.setConfig({ operatorId: 'operator', guildId: 'guild', secretFile: path.join(dir, 'discord.env') });
  const original = setup.bindOrdinary({
    channelId: 'ordinary-successor-channel', guildId: 'guild', provider: 'codex', nativeId: CODEX,
    workspace: dir
  }, { sessionId: CODEX, threadId: CODEX });
  setup.unbind(original.channelId);
  setup.close();
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(successorWorkspace, { recursive: true, force: true });
  });

  const channel = {
    id: original.channelId, guildId: 'guild', name: 'dev', isTextBased: () => true,
    messages: { fetch: async () => new Map([['latest', { id: '200' }]]) }
  };
  class FakeClient {
    constructor() {
      this.guilds = { fetch: async () => ({ channels: {
        fetch: async selection => selection ? channel : new Map([[channel.id, channel]])
      } }) };
    }
    async login() {}
    async destroy() {}
  }
  await assert.rejects(() => ordinaryBind({ 'state-dir': dir, channel: '#dev', 'session-root': successorSession.root }, {
    environment: { CODEX_SESSION_ID: OTHER, CODEX_THREAD_ID: OTHER, PWD: successorWorkspace },
    requireInstalled: () => ({ Client: FakeClient, GatewayIntentBits: { Guilds: 1 } }),
    readSecret: () => 'fixture-token',
    validateCodexSessionIdentity,
    gatewayProcessStatus: () => ({ state: 'stopped' }),
    print: () => {}
  }), /already bound/);

  const state = new SurfaceState(db);
  try {
    const binding = state.getBinding(original.channelId);
    assert.equal(binding.nativeId, CODEX);
    assert.equal(binding.generation, 1);
    assert.equal(binding.active, false);
    assert.equal(state.listReceipts().filter(receipt => receipt.kind === 'ordinary-handoff').length, 0);
  } finally { state.close(); }
});

test('ordinary handoff clears an explicit default transcript root', t => {
  const f = fixture(t);
  const predecessorRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinary-null-predecessor-root-'));
  const successorRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinary-null-successor-root-'));
  const binding = f.state.bindOrdinary({
    channelId: 'ordinary-null-root-channel', guildId: 'guild', provider: 'codex', nativeId: CODEX,
    workspace: f.dir, sessionRoot: predecessorRoot
  }, f.identity);
  f.state.unbind(binding.channelId);
  const transcriptFile = path.join(successorRoot, OTHER + '.jsonl');
  fs.writeFileSync(transcriptFile, '');
  t.after(() => {
    fs.rmSync(predecessorRoot, { recursive: true, force: true });
    fs.rmSync(successorRoot, { recursive: true, force: true });
  });
  const rebound = f.state.handoffOrdinary({
    channelId: binding.channelId, provider: 'codex', fromNativeId: CODEX, fromGeneration: 1,
    nativeId: OTHER, workspace: f.dir, sessionRoot: null, handoffId: 'ordinary-null-root-handoff',
    identity: { sessionId: OTHER, threadId: OTHER },
    nativeProof: { file: transcriptFile, sessionId: OTHER, threadId: OTHER, workspace: f.dir, sessionRoot: null }
  });
  assert.equal(rebound.sessionRoot, null);
  assert.equal(rebound.nativeId, OTHER);
  assert.equal(rebound.generation, 2);
});

test('ordinary CLI handoff changes a custom root to its default root', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinary-default-root-cli-'));
  const db = path.join(dir, 'surface.sqlite');
  const successorWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinary-default-root-workspace-'));
  const predecessorRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinary-default-root-predecessor-'));
  const defaultRoot = path.join(dir, 'sessions');
  fs.mkdirSync(defaultRoot);
  const transcriptFile = path.join(defaultRoot, OTHER + '.jsonl');
  fs.writeFileSync(transcriptFile, `${JSON.stringify({ type: 'session_meta', payload: {
    session_id: OTHER, id: OTHER, cwd: successorWorkspace
  } })}\n`);
  const setup = new SurfaceState(db);
  setup.setConfig({ operatorId: 'operator', guildId: 'guild', secretFile: path.join(dir, 'discord.env') });
  const original = setup.bindOrdinary({
    channelId: '123456789012345679', guildId: 'guild', provider: 'codex', nativeId: CODEX,
    workspace: dir, sessionRoot: predecessorRoot
  }, { sessionId: CODEX, threadId: CODEX });
  setup.unbind(original.channelId);
  setup.close();
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(successorWorkspace, { recursive: true, force: true });
    fs.rmSync(predecessorRoot, { recursive: true, force: true });
    fs.rmSync(defaultRoot, { recursive: true, force: true });
  });

  const channel = {
    id: original.channelId, guildId: 'guild', name: 'ordinary', isTextBased: () => true,
    messages: { fetch: async () => new Map([['latest', { id: '200' }]]) }
  };
  class FakeClient {
    constructor() { this.guilds = { fetch: async () => ({ channels: { fetch: async () => channel } }) }; }
    async login() {}
    async destroy() {}
  }
  const result = await handoffInternal({
    ordinary: true, 'state-dir': dir, provider: 'codex', 'channel-id': original.channelId,
    'from-native-id': CODEX, 'from-generation': '1', 'native-id': OTHER,
    workspace: successorWorkspace, 'handoff-id': 'ordinary-default-root-cli-handoff'
  }, {
    codexSessionRoot: () => defaultRoot,
    environment: { CODEX_SESSION_ID: OTHER, CODEX_THREAD_ID: OTHER, PWD: successorWorkspace },
    requireInstalled: () => ({ Client: FakeClient, GatewayIntentBits: { Guilds: 1 } }),
    readSecret: () => 'fixture-token',
    validateCodexSessionIdentity,
    gatewayProcessStatus: () => ({ state: 'stopped' }),
    print: () => {}
  });
  assert.equal(result.binding.sessionRoot, defaultRoot);
  assert.equal(result.binding.generation, 2);
});

test('binding wake replays after joining an in-flight recovery', async () => {
  let releaseShared;
  const shared = new Promise(resolve => { releaseShared = resolve; });
  const calls = [];
  const gateway = {
    recoveryPromise: shared,
    async recoverTransport(reason) {
      calls.push(`recover:${reason}`);
      if (calls.length === 1) {
        this.recoveryPromise = null;
        return shared;
      }
      this.recoveryPromise = null;
      return { ready: true, state: 'ready' };
    },
    async reconcilePending() { calls.push('reconcile'); }
  };
  const wake = createBindingWakeController({
    getGateway: () => gateway,
    isReady: () => true,
    isStopping: () => false
  });
  wake.request();
  releaseShared({ ready: true, state: 'ready' });
  await wake.wait();
  assert.deepEqual(calls, ['recover:ordinary-bind', 'recover:ordinary-bind', 'reconcile']);
});

test('binding wake reconciles after a partial recovery leaves the Gateway ready', async () => {
  const calls = [];
  const gateway = {
    ready: true,
    async recoverTransport(reason) {
      calls.push(`recover:${reason}`);
      return { ready: false, state: 'unavailable' };
    },
    async reconcilePending() { calls.push('reconcile'); }
  };
  const wake = createBindingWakeController({
    getGateway: () => gateway,
    isReady: () => true,
    isStopping: () => false
  });
  wake.request();
  await wake.wait();
  assert.deepEqual(calls, ['recover:ordinary-bind', 'reconcile']);
});

test('ordinary binding decision refuses a non-ordinary or inactive existing owner', () => {
  const request = {
    provider: 'codex', channelId: 'channel', guildId: 'guild', nativeId: CODEX, workspace: '/tmp/workspace',
    identity: { sessionId: CODEX, threadId: CODEX }
  };
  assert.equal(ordinaryBindingDecision(null, request), 'bind');
  assert.equal(ordinaryBindingDecision({ ...request, active: true }, request, true), 'reuse');
  assert.equal(ordinaryBindingDecision({ ...request, active: false }, request, true), 'rebind');
  assert.throws(() => ordinaryBindingDecision({ ...request, active: true, conductorId: 'conductor' }, request, false), /already bound/);
});

test('ordinary bind starts pending with paired null conductor identity and holds intake', t => {
  const f = fixture(t);
  const binding = ordinary(f);
  assert.equal(binding.readiness, READINESS.PENDING);
  assert.equal(binding.conductorId, null);
  assert.equal(binding.repoKey, null);
  assert.equal(f.state.isOrdinaryBinding(binding), true);
  assert.throws(() => f.state.rebind({
    channelId: binding.channelId, guildId: 'guild', provider: 'codex', nativeId: OTHER, workspace: f.dir
  }), /matching invocation identity/);
  const accepted = f.state.acceptDiscordMessage({
    id: 'pending-input', guildId: 'guild', channelId: binding.channelId,
    authorId: 'operator', isBot: false, content: 'held'
  }, { ready: false });
  assert.equal(accepted.accepted, true);
  assert.equal(f.state.claimDispatch('pending-input').reason, 'binding-not-ready');
  assert.equal(f.state.getMessage('pending-input').state, 'accepted');
  assert.throws(() => f.state.bindOrdinary({
    channelId: 'second-channel', guildId: 'guild', provider: 'codex', nativeId: CODEX, workspace: f.dir
  }, f.identity), /already owned/);
  assert.throws(() => f.state.bindOrdinary({
    channelId: binding.channelId, guildId: 'guild', provider: 'codex', nativeId: OTHER, workspace: f.dir
  }, { sessionId: OTHER, threadId: OTHER }), /already bound/);
  assert.throws(() => f.state.bindOrdinary({
    channelId: 'identity-mismatch', guildId: 'guild', provider: 'codex', nativeId: CODEX, workspace: f.dir
  }, { sessionId: OTHER, threadId: OTHER }), /does not match the native session/);
});

test('ordinary binding permits a verified transcript-root relocation', t => {
  const f = fixture(t);
  const binding = ordinary(f);
  const sessionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinary-relocated-root-'));
  t.after(() => fs.rmSync(sessionRoot, { recursive: true, force: true }));
  const request = {
    provider: 'codex', channelId: binding.channelId, guildId: 'guild', nativeId: CODEX,
    workspace: f.dir, sessionRoot, identity: { sessionId: CODEX, threadId: CODEX }
  };
  const proof = {
    file: path.join(sessionRoot, `${CODEX}.jsonl`), sessionId: CODEX, threadId: CODEX,
    workspace: f.dir, sessionRoot
  };
  assert.throws(() => ordinaryBindingDecision(binding, request, true), /already bound/);
  assert.equal(ordinaryBindingDecision(binding, request, true, proof), 'rebind');
  const relocated = f.state.rebindOrdinary(request, request.identity, proof);
  assert.equal(relocated.sessionRoot, sessionRoot);
  assert.equal(relocated.generation, 2);
});

test('ordinary root relocation reopens a drained terminal intake watermark', t => {
  const f = fixture(t);
  const binding = ordinary(f);
  f.state.markIntakeBoundary(binding.channelId, 'gap', 'previous recovery gap', 'gap-from', 'gap-to');
  const sessionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinary-relocated-terminal-root-'));
  t.after(() => fs.rmSync(sessionRoot, { recursive: true, force: true }));
  const request = {
    provider: 'codex', channelId: binding.channelId, guildId: 'guild', nativeId: CODEX,
    workspace: f.dir, sessionRoot, identity: { sessionId: CODEX, threadId: CODEX }
  };
  const proof = {
    file: path.join(sessionRoot, `${CODEX}.jsonl`), sessionId: CODEX, threadId: CODEX,
    workspace: f.dir, sessionRoot
  };
  const relocated = f.state.rebindOrdinary(request, request.identity, proof);
  assert.equal(relocated.generation, 2);
  const watermark = f.state.getIntakeWatermark(binding.channelId);
  assert.equal(watermark.state, 'pending');
  assert.equal(watermark.gap_from, null);
  assert.equal(watermark.gap_to, null);
});

test('ordinary root relocation refuses an in-flight dispatch', t => {
  const f = fixture(t);
  const binding = ordinary(f);
  const sessionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinary-relocated-dispatch-root-'));
  t.after(() => fs.rmSync(sessionRoot, { recursive: true, force: true }));
  f.state.recordOrdinaryPreflight(binding, {
    file: path.join(f.dir, 'session.jsonl'), sessionId: CODEX, threadId: CODEX, workspace: f.dir
  });
  f.state.markIntakeBoundary(binding.channelId, 'ready', null, null, null, binding);
  const accepted = f.state.acceptDiscordMessage({
    id: 'dispatching-root-relocation', guildId: 'guild', channelId: binding.channelId,
    authorId: 'operator', isBot: false, content: 'dispatching'
  });
  assert.equal(accepted.accepted, true);
  f.state.claimDispatch(accepted.message.id);
  const request = {
    provider: 'codex', channelId: binding.channelId, guildId: 'guild', nativeId: CODEX,
    workspace: f.dir, sessionRoot, identity: { sessionId: CODEX, threadId: CODEX }
  };
  const proof = {
    file: path.join(sessionRoot, `${CODEX}.jsonl`), sessionId: CODEX, threadId: CODEX,
    workspace: f.dir, sessionRoot
  };
  assert.throws(() => f.state.rebindOrdinary(request, request.identity, proof), /work drains|dispatch/);
  assert.equal(f.state.getBinding(binding.channelId).sessionRoot, binding.sessionRoot);
});

test('ordinary root relocation refuses an uncertain dispatch', t => {
  const f = fixture(t);
  const binding = ordinary(f);
  const sessionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinary-relocated-uncertain-root-'));
  t.after(() => fs.rmSync(sessionRoot, { recursive: true, force: true }));
  f.state.recordOrdinaryPreflight(binding, {
    file: path.join(f.dir, 'session.jsonl'), sessionId: CODEX, threadId: CODEX, workspace: f.dir
  });
  f.state.markIntakeBoundary(binding.channelId, 'ready', null, null, null, binding);
  const accepted = f.state.acceptDiscordMessage({
    id: 'uncertain-root-relocation', guildId: 'guild', channelId: binding.channelId,
    authorId: 'operator', isBot: false, content: 'uncertain'
  });
  assert.equal(accepted.accepted, true);
  f.state.claimDispatch(accepted.message.id);
  f.state.markUncertain(accepted.message.id, new Error('dispatch outcome unknown'));
  const request = {
    provider: 'codex', channelId: binding.channelId, guildId: 'guild', nativeId: CODEX,
    workspace: f.dir, sessionRoot, identity: { sessionId: CODEX, threadId: CODEX }
  };
  const proof = {
    file: path.join(sessionRoot, `${CODEX}.jsonl`), sessionId: CODEX, threadId: CODEX,
    workspace: f.dir, sessionRoot
  };
  assert.throws(() => f.state.rebindOrdinary(request, request.identity, proof), /work drains|dispatch/);
  assert.equal(f.state.getBinding(binding.channelId).sessionRoot, binding.sessionRoot);
});

test('ordinary bind rejects a successor and explicit tombstone handoff transfers custody', t => {
  const f = fixture(t);
  const originalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinary-original-root-'));
  const binding = f.state.bindOrdinary({
    channelId: 'ordinary-channel', guildId: 'guild', provider: 'codex', nativeId: CODEX,
    workspace: f.dir, sessionRoot: originalRoot
  }, f.identity);
  f.state.setIntakeCutoff(binding.channelId, 'guild', '100', 'ordinary handoff baseline');
  f.state.unbind(binding.channelId);
  const successorWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinary-successor-workspace-'));
  const successorRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinary-successor-root-'));
  t.after(() => {
    fs.rmSync(originalRoot, { recursive: true, force: true });
    fs.rmSync(successorWorkspace, { recursive: true, force: true });
    fs.rmSync(successorRoot, { recursive: true, force: true });
  });
  const request = {
    provider: 'codex', channelId: binding.channelId, guildId: 'guild', nativeId: OTHER,
    workspace: successorWorkspace,
    identity: { sessionId: OTHER, threadId: OTHER }
  };
  const proof = {
    file: path.join(successorRoot, `${OTHER}.jsonl`), sessionId: OTHER, threadId: OTHER,
    workspace: successorWorkspace, sessionRoot: successorRoot
  };
  const tombstone = f.state.getBinding(binding.channelId);
  assert.throws(() => ordinaryBindingDecision(tombstone, request, true), /already bound/);
  assert.throws(() => ordinaryBindingDecision(tombstone, { ...request, sessionRoot: successorRoot }, true, proof), /already bound/);
  assert.throws(() => f.state.rebindOrdinary(request, request.identity, proof), /owner changed/);
  const rebound = f.state.handoffOrdinary({
    channelId: binding.channelId, provider: 'codex', fromNativeId: CODEX, fromGeneration: 1,
    nativeId: OTHER, workspace: successorWorkspace, sessionRoot: successorRoot,
    handoffId: 'ordinary-tombstone-handoff', identity: request.identity, nativeProof: proof
  });
  assert.equal(rebound.active, true);
  assert.equal(rebound.nativeId, OTHER);
  assert.equal(rebound.workspace, successorWorkspace);
  assert.equal(rebound.sessionRoot, successorRoot);
  assert.equal(rebound.generation, 2);
  assert.equal(rebound.readiness, READINESS.PENDING);
  assert.equal(rebound.conductorId, null);
  assert.equal(rebound.repoKey, null);
  assert.equal(f.state.getIntakeWatermark(binding.channelId).last_seen_id, '100');
  const retry = f.state.handoffOrdinary({
    channelId: binding.channelId, provider: 'codex', fromNativeId: CODEX, fromGeneration: 1,
    nativeId: OTHER, workspace: successorWorkspace, sessionRoot: successorRoot,
    handoffId: 'ordinary-tombstone-handoff', identity: request.identity, nativeProof: proof
  });
  assert.equal(retry.handoffReconciled, true);
  assert.equal(retry.generation, 2);
  assert.equal(f.state.listReceipts().filter(receipt => receipt.kind === 'ordinary-handoff').length, 1);
  assert.equal(f.state.listReceipts().filter(receipt => receipt.kind === 'ordinary-handoff-retry').length, 1);
});

test('ordinary handoff transfers an active drained source and holds stale, unresolved, and collision cases', t => {
  const f = fixture(t);
  const binding = ordinary(f);
  f.state.setIntakeCutoff(binding.channelId, 'guild', '100', 'ordinary active handoff baseline');
  f.state.markIntakeBoundary(binding.channelId, 'gap', 'ordinary active handoff previous gap', 'gap-from', 'gap-to');
  const successorWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinary-active-successor-workspace-'));
  const successorRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinary-active-successor-root-'));
  t.after(() => {
    fs.rmSync(successorWorkspace, { recursive: true, force: true });
    fs.rmSync(successorRoot, { recursive: true, force: true });
  });
  const proof = {
    file: path.join(successorRoot, `${OTHER}.jsonl`), sessionId: OTHER, threadId: OTHER,
    workspace: successorWorkspace, sessionRoot: successorRoot
  };
  assert.throws(() => f.state.handoffOrdinary({
    channelId: binding.channelId, provider: 'codex', fromNativeId: CODEX, fromGeneration: 2,
    nativeId: OTHER, workspace: successorWorkspace, sessionRoot: successorRoot,
    handoffId: 'ordinary-stale-handoff', identity: { sessionId: OTHER, threadId: OTHER }, nativeProof: proof
  }), /stale/);
  assert.equal(f.state.getBinding(binding.channelId).nativeId, CODEX);
  assert.throws(() => f.state.handoffOrdinary({
    channelId: binding.channelId, provider: 'codex', fromNativeId: CODEX, fromGeneration: 1,
    nativeId: OTHER, workspace: successorWorkspace, sessionRoot: successorRoot,
    handoffId: 'ordinary-proof-handoff', identity: { sessionId: OTHER, threadId: OTHER },
    nativeProof: { ...proof, workspace: f.dir }
  }), /transcript proof/);
  assert.equal(f.state.getBinding(binding.channelId).generation, 1);
  const transferred = f.state.handoffOrdinary({
    channelId: binding.channelId, provider: 'codex', fromNativeId: CODEX, fromGeneration: 1,
    nativeId: OTHER, workspace: successorWorkspace, sessionRoot: successorRoot,
    handoffId: 'ordinary-active-handoff', identity: { sessionId: OTHER, threadId: OTHER }, nativeProof: proof
  });
  assert.equal(transferred.active, true);
  assert.equal(transferred.nativeId, OTHER);
  assert.equal(transferred.generation, 2);
  assert.equal(transferred.readiness, READINESS.PENDING);
  assert.equal(f.state.getIntakeWatermark(binding.channelId).last_seen_id, '100');
  assert.equal(f.state.getIntakeWatermark(binding.channelId).state, 'pending');
  assert.equal(f.state.getIntakeWatermark(binding.channelId).gap_from, null);
  assert.equal(f.state.getIntakeWatermark(binding.channelId).gap_to, null);
  const retry = f.state.handoffOrdinary({
    channelId: binding.channelId, provider: 'codex', fromNativeId: CODEX, fromGeneration: 1,
    nativeId: OTHER, workspace: successorWorkspace, sessionRoot: successorRoot,
    handoffId: 'ordinary-active-handoff', identity: { sessionId: OTHER, threadId: OTHER }, nativeProof: proof
  });
  assert.equal(retry.handoffReconciled, true);
  assert.equal(retry.generation, 2);

  const unresolvedFixture = fixture(t);
  const unresolvedBinding = ordinary(unresolvedFixture, 'ordinary-unresolved-source');
  const accepted = unresolvedFixture.state.acceptDiscordMessage({
    id: 'ordinary-handoff-pending', guildId: 'guild', channelId: unresolvedBinding.channelId,
    authorId: 'operator', isBot: false, content: 'held'
  }, { ready: true });
  assert.equal(accepted.accepted, true);
  assert.throws(() => unresolvedFixture.state.handoffOrdinary({
    channelId: unresolvedBinding.channelId, provider: 'codex', fromNativeId: CODEX, fromGeneration: 1,
    nativeId: OTHER, workspace: successorWorkspace, sessionRoot: successorRoot,
    handoffId: 'ordinary-unresolved-handoff', identity: { sessionId: OTHER, threadId: OTHER }, nativeProof: proof
  }), /unresolved/);
  assert.equal(unresolvedFixture.state.getBinding(unresolvedBinding.channelId).nativeId, CODEX);
  const collisionFixture = fixture(t);
  const collisionBinding = ordinary(collisionFixture, 'ordinary-collision-source');
  const second = collisionFixture.state.bindOrdinary({
    channelId: 'ordinary-collision-channel', guildId: 'guild', provider: 'codex', nativeId: OTHER,
    workspace: successorWorkspace, sessionRoot: successorRoot
  }, { sessionId: OTHER, threadId: OTHER });
  assert.equal(second.active, true);
  assert.throws(() => collisionFixture.state.handoffOrdinary({
    channelId: collisionBinding.channelId, provider: 'codex', fromNativeId: CODEX, fromGeneration: 1,
    nativeId: OTHER, workspace: successorWorkspace, sessionRoot: successorRoot,
    handoffId: 'ordinary-collision-handoff', identity: { sessionId: OTHER, threadId: OTHER }, nativeProof: proof
  }), /already owned/);
  assert.equal(collisionFixture.state.getBinding(collisionBinding.channelId).generation, 1);

  const missingReceiptFixture = fixture(t);
  const missingReceiptBinding = ordinary(missingReceiptFixture, 'ordinary-missing-unbound');
  missingReceiptFixture.state.db.prepare('UPDATE bindings SET active=0 WHERE channel_id=?').run(missingReceiptBinding.channelId);
  assert.throws(() => missingReceiptFixture.state.handoffOrdinary({
    channelId: missingReceiptBinding.channelId, provider: 'codex', fromNativeId: CODEX, fromGeneration: 1,
    nativeId: OTHER, workspace: successorWorkspace, sessionRoot: successorRoot,
    handoffId: 'ordinary-missing-unbound-handoff', identity: { sessionId: OTHER, threadId: OTHER }, nativeProof: proof
  }), /no matching unbind receipt/);
  assert.equal(missingReceiptFixture.state.getBinding(missingReceiptBinding.channelId).active, false);
  assert.equal(missingReceiptFixture.state.listReceipts().filter(receipt => receipt.kind === 'ordinary-handoff').length, 0);
});

test('explicit ordinary handoff validates the CLI proof and wakes generation-specific Gateway recovery', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinary-handoff-cli-'));
  const db = path.join(dir, 'surface.sqlite');
  const successorWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinary-handoff-cli-workspace-'));
  const session = transcript(t, successorWorkspace, OTHER);
  const setup = new SurfaceState(db);
  setup.setConfig({ operatorId: 'operator', guildId: 'guild', secretFile: path.join(dir, 'discord.env') });
  const original = setup.bindOrdinary({
    channelId: '123456789012345678', guildId: 'guild', provider: 'codex', nativeId: CODEX,
    workspace: dir
  }, { sessionId: CODEX, threadId: CODEX });
  setup.setIntakeCutoff(original.channelId, 'guild', '100', 'ordinary CLI handoff baseline');
  setup.markIntakeBoundary(original.channelId, 'unavailable', 'ordinary CLI handoff previous terminal');
  setup.unbind(original.channelId);
  setup.close();
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(successorWorkspace, { recursive: true, force: true });
  });

  const channel = {
    id: original.channelId, guildId: 'guild', name: 'ordinary', isTextBased: () => true,
    messages: { fetch: async () => new Map([['latest', { id: '200' }]]) }
  };
  const wakeSignals = [];
  const output = [];
  let proofArguments;
  class FakeClient {
    constructor() {
      this.guilds = { fetch: async () => ({ channels: { fetch: async () => channel } }) };
    }
    async login() {}
    async destroy() {}
  }
  const result = await handoffInternal({
    ordinary: true, 'state-dir': dir, provider: 'codex', 'channel-id': original.channelId,
    'from-native-id': CODEX, 'from-generation': '1', 'native-id': OTHER,
    workspace: successorWorkspace, 'session-root': session.root, 'handoff-id': 'ordinary-cli-handoff'
  }, {
    environment: { CODEX_SESSION_ID: OTHER, CODEX_THREAD_ID: OTHER, PWD: successorWorkspace },
    requireInstalled: () => ({ Client: FakeClient, GatewayIntentBits: { Guilds: 1 } }),
    readSecret: () => 'fixture-token',
    validateCodexSessionIdentity: async (...args) => {
      proofArguments = args;
      return { file: session.file, sessionId: OTHER, threadId: OTHER, workspace: successorWorkspace };
    },
    requestGatewayRecovery: (_paths, options) => {
      const runtime = options.status(_paths);
      options.kill(runtime.pid, 'SIGUSR2');
      return { requested: true, pid: runtime.pid, signal: 'SIGUSR2' };
    },
    gatewayProcessStatus: () => ({ state: 'running', pid: 4242, capabilities: [GATEWAY_CAPABILITIES.ordinaryBindWake] }),
    killProcess: (pid, signal) => wakeSignals.push({ pid, signal }),
    print: value => output.push(value)
  });
  assert.equal(result.binding.generation, 2);
  assert.equal(result.binding.nativeId, OTHER);
  assert.equal(result.binding.readiness, READINESS.PENDING);
  assert.deepEqual(proofArguments, [OTHER, successorWorkspace, session.root]);
  assert.deepEqual(wakeSignals, [{ pid: 4242, signal: 'SIGUSR2' }]);
  assert.equal(output[0].ordinary, true);

  const recoveredState = new SurfaceState(db);
  const recoveredBinding = recoveredState.getBinding(original.channelId);
  assert.equal(recoveredBinding.generation, 2);
  assert.equal(recoveredState.getIntakeWatermark(original.channelId).last_seen_id, '200');
  assert.equal(recoveredState.getIntakeWatermark(original.channelId).recovered_through_id, '200');
  assert.equal(recoveredState.getIntakeWatermark(original.channelId).state, 'pending');
  assert.equal(recoveredState.getIntakeWatermark(original.channelId).gap_from, null);
  assert.equal(recoveredState.getIntakeWatermark(original.channelId).gap_to, null);
  let preflights = 0;
  const gatewayChannel = {
    id: original.channelId, guildId: 'guild', topic: null,
    permissionsFor: () => ({ has: () => true })
  };
  const gatewayClient = {
    user: { id: 'bot' },
    channels: { fetch: async () => gatewayChannel },
    on() {}, off() {}, async destroy() {}
  };
  const gateway = new DiscordGateway({
    state: recoveredState,
    client: gatewayClient,
    fetchHistory: async () => [],
    providers: { codex: { async dispatch() { return { status: 'submitted' }; } } },
    recoveryOptions: {
      codexSessionRoot: session.root,
      ordinaryNativePreflight: async current => {
        preflights += 1;
        assert.equal(current.generation, 2);
        return validateCodexSessionIdentity(current.nativeId, current.workspace, session.root);
      }
    }
  });
  const recovery = await gateway.recoverTransport('ordinary-handoff', 0);
  assert.equal(recovery.ready, true);
  assert.equal(preflights, 1);
  assert.equal(recoveredState.getBinding(original.channelId).readiness, READINESS.READY);
  assert.equal(recoveredState.getIntakeWatermark(original.channelId).state, 'ready');
  assert.equal(recoveredState.getIntakeWatermark(original.channelId).recovered_through_id, '200');
  await gateway.stop();
  recoveredState.close();
});

test('native preflight requires exact session metadata and workspace', t => {
  const f = fixture(t);
  const matching = transcript(t, f.dir);
  const proof = validateCodexSessionIdentity(CODEX, f.dir, matching.root);
  assert.equal(proof.file, matching.file);
  assert.equal(validateCodexSessionIdentity(CODEX, undefined, matching.root).workspace, f.dir);
  const wrongWorkspace = transcript(t, '/tmp/other-workspace');
  assert.throws(() => validateCodexSessionIdentity(CODEX, f.dir, wrongWorkspace.root), /workspace/);
  const wrongIdentity = transcript(t, f.dir, CODEX, { id: OTHER });
  assert.throws(() => validateCodexSessionIdentity(CODEX, f.dir, wrongIdentity.root), /identity/);
});

test('ordinary readiness requires the applicable Discord reply permission', t => {
  const f = fixture(t);
  const permissions = new Set();
  const client = { user: { id: 'bot' }, on() {}, off() {} };
  const gateway = new DiscordGateway({ state: f.state, client, providers: {} });
  const { PermissionFlagsBits } = require('discord.js');
  const channel = { permissionsFor: () => ({ has: permission => permissions.has(permission) }) };
  permissions.add(PermissionFlagsBits.ViewChannel);
  permissions.add(PermissionFlagsBits.ReadMessageHistory);
  assert.equal(gateway.historyPermission(channel, { requireSend: true }).allowed, false);
  permissions.add(PermissionFlagsBits.SendMessages);
  assert.equal(gateway.historyPermission(channel, { requireSend: true }).allowed, true);
  permissions.delete(PermissionFlagsBits.SendMessages);
  const thread = { isThread: () => true, permissionsFor: channel.permissionsFor };
  permissions.add(PermissionFlagsBits.SendMessagesInThreads);
  assert.equal(gateway.historyPermission(thread, { requireSend: true }).allowed, true);
  const archivedThread = { isThread: () => true, archived: true, locked: false, permissionsFor: channel.permissionsFor };
  assert.equal(gateway.historyPermission(archivedThread, { requireSend: true }).allowed, true);
  const lockedThread = { isThread: () => true, archived: true, locked: true, permissionsFor: channel.permissionsFor };
  assert.equal(gateway.historyPermission(lockedThread, { requireSend: true }).allowed, false);
});

test('ordinary readiness requires native proof before the intake boundary can become ready', t => {
  const f = fixture(t);
  const binding = ordinary(f);
  assert.throws(() => f.state.markIntakeBoundary(binding.channelId, 'ready', 'history complete', null, null, binding), /preflight/);
  assert.throws(() => f.state.recordOrdinaryPreflight(binding, { file: '/tmp/exact.jsonl', sessionId: OTHER, threadId: OTHER, workspace: f.dir }), /does not match/);
  f.state.recordOrdinaryPreflight(binding, { file: '/tmp/exact.jsonl', sessionId: CODEX, threadId: CODEX, workspace: f.dir });
  f.state.markIntakeBoundary(binding.channelId, 'ready', 'history complete', null, null, binding);
  assert.equal(f.state.getBinding(binding.channelId).readiness, READINESS.READY);
});

test('Gateway repeats ordinary native preflight on reconnect before promoting intake', async t => {
  const f = fixture(t);
  const session = transcript(t, f.dir);
  const binding = ordinary(f);
  const secretFile = path.join(f.dir, 'discord.env');
  fs.writeFileSync(secretFile, 'DISCORD_TOKEN=fixture-token\n', { mode: 0o600 });
  const held = f.state.acceptDiscordMessage({
    id: 'held-input', guildId: 'guild', channelId: binding.channelId,
    authorId: 'operator', isBot: false, content: 'held until native proof'
  }, { ready: false });
  assert.equal(held.accepted, true);
  let preflights = 0;
  let dispatches = 0;
  let replies = 0;
  const channel = {
    id: binding.channelId,
    guildId: 'guild',
    topic: null,
    permissionsFor: () => ({ has: () => true }),
    messages: { fetch: async () => ({ react: async () => {} }) },
    async send() { replies += 1; return { id: `reply-${replies}` }; }
  };
  const client = {
    user: { id: 'bot' },
    channels: { fetch: async () => channel },
    on() {}, off() {}, async login() {}, async destroy() {}
  };
  const gateway = new DiscordGateway({
    state: f.state,
    client,
    fetchHistory: async () => [],
    providers: { codex: {
      async dispatch() { dispatches += 1; return { status: 'submitted' }; },
      async observe() { return { text: 'answer' }; }
    } },
    recoveryOptions: {
      codexSessionRoot: session.root,
      ordinaryNativePreflight: async current => {
        preflights += 1;
        return validateCodexSessionIdentity(current.nativeId, current.workspace, session.root);
      }
    }
  });
  await gateway.start(secretFile);
  assert.equal(f.state.getBinding(binding.channelId).readiness, READINESS.READY);
  assert.equal(preflights, 1);
  await gateway.reconcilePending();
  await gateway.consumer.waitForNativeWork();
  assert.deepEqual(f.state.recoveryCandidates(), []);
  assert.equal(dispatches, 1);
  assert.ok(replies >= 1);
  assert.equal(f.state.getMessage('held-input').state, 'replied');
  gateway.pauseConnection('reconnect');
  assert.equal(f.state.getBinding(binding.channelId).readiness, READINESS.RECOVERING);
  const second = await gateway.recoverTransport('reconnect', gateway.lifecycleEpoch);
  assert.equal(second.ready, true);
  assert.equal(preflights, 2);
  assert.equal(f.state.getMessage('held-input').state, 'replied');
  await gateway.stop();
});

test('ordinary post uses explicit binding custody and suppresses duplicate and unknown resend', async t => {
  const f = fixture(t);
  const binding = ordinary(f);
  const textFile = path.join(f.dir, 'milestone.txt');
  fs.writeFileSync(textFile, 'ordinary milestone');
  let calls = 0;
  const unknownFetch = async () => {
    calls += 1;
    throw Object.assign(new Error('network uncertain'), { outcome: 'unknown' });
  };
  const first = await runDirectPost({ state: f.state, token: 'fixture', nativeId: CODEX, generation: binding.generation,
    channelId: binding.channelId, provider: 'codex', ordinary: true, textFile, dedupeKey: 'ordinary-unknown', fetchImpl: unknownFetch });
  assert.equal(first.status, 'unknown');
  const retry = await runDirectPost({ state: f.state, token: 'fixture', nativeId: CODEX, generation: binding.generation,
    channelId: binding.channelId, provider: 'codex', ordinary: true, textFile, dedupeKey: 'ordinary-unknown', fetchImpl: unknownFetch });
  assert.equal(retry.status, 'unknown');
  assert.equal(calls, 1);
  const sentFetch = async () => {
    calls += 1;
    return { ok: true, status: 200, json: async () => ({ id: `sent-${calls}` }) };
  };
  const sent = await runDirectPost({ state: f.state, token: 'fixture', nativeId: CODEX, generation: binding.generation,
    channelId: binding.channelId, provider: 'codex', ordinary: true, textFile, dedupeKey: 'ordinary-sent', fetchImpl: sentFetch });
  const duplicate = await runDirectPost({ state: f.state, token: 'fixture', nativeId: CODEX, generation: binding.generation,
    channelId: binding.channelId, provider: 'codex', ordinary: true, textFile, dedupeKey: 'ordinary-sent', fetchImpl: sentFetch });
  assert.equal(sent.status, 'sent');
  assert.equal(duplicate.duplicate, true);
  assert.equal(calls, 2);
  f.state.rebind({ channelId: binding.channelId, guildId: 'guild', provider: 'codex', nativeId: CODEX,
    workspace: f.dir, ordinaryIdentity: { sessionId: CODEX, threadId: CODEX } });
  await assert.rejects(() => runDirectPost({ state: f.state, token: 'fixture', nativeId: CODEX, generation: binding.generation,
    channelId: binding.channelId, provider: 'codex', ordinary: true, textFile, dedupeKey: 'ordinary-stale', fetchImpl: sentFetch }),
  error => error instanceof StaleGenerationError);
});

test('unsupported direct transcript store cannot validate or invoke queue', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinary-direct-store-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, `${CODEX}.jsonl`), `${JSON.stringify({ type: 'session_meta', payload: { id: CODEX, session_id: CODEX, cwd: root } })}\n`);
  assert.throws(() => validateCodexSessionIdentity(CODEX, root, root), /Unsupported Codex session root/);
  await assert.rejects(() => validateCodexSessionIdentityAsync(CODEX, root, root), /Unsupported Codex session root/);
  let calls = 0;
  const provider = new CodexProvider({ root, run: async () => { calls++; return { status: 'submitted' }; } });
  const result = await provider.dispatch({ nativeId: CODEX, workspace: root });
  assert.equal(result.status, 'not_submitted');
  assert.equal(calls, 0);
  assert.equal(fs.existsSync(path.join(root, `${CODEX}.jsonl`)), true);
  assert.equal(fs.existsSync(path.join(root, 'sessions')), false);
});

for (const action of ['rebind', 'handoff']) {
  for (const collision of [true, false]) {
    test(`inactive ${action} ${collision ? 'refusal preserves' : 'success commits'} intake custody`, async t => {
      const f = fixture(t);
      const channelId = '123456789012345678';
      const successor = action === 'handoff' ? OTHER : CODEX;
      const native = transcript(t, f.dir, successor);
      ordinary(f, channelId);
      f.state.setIntakeCutoff(channelId, 'guild', '100', 'seed');
      f.state.markIntakeBoundary(channelId, 'unavailable', 'seed gap', '100', '150');
      f.state.unbind(channelId);
      if (collision) ordinary(f, '223456789012345678', successor);
      const before = {
        binding: f.state.getBinding(channelId), watermark: f.state.getIntakeWatermark(channelId),
        receipts: f.state.listReceipts()
      };
      const channel = {
        id: channelId, guildId: 'guild', name: 'dev', isTextBased: () => true,
        messages: { fetch: async () => new Map([['latest', { id: '200' }]]) }
      };
      class FakeClient {
        constructor() { this.guilds = { fetch: async () => ({ channels: {
          fetch: async selection => selection ? channel : new Map([[channelId, channel]])
        } }) }; }
        async login() {}
        async destroy() {}
      }
      const dependencies = {
        environment: { CODEX_SESSION_ID: successor, CODEX_THREAD_ID: successor, PWD: f.dir },
        codexSessionRoot: () => native.root,
        requireInstalled: () => ({ Client: FakeClient, GatewayIntentBits: { Guilds: 1 } }),
        readSecret: () => 'fixture-token',
        validateCodexSessionIdentity: async () => ({ file: native.file, sessionId: successor, threadId: successor, workspace: f.dir }),
        gatewayProcessStatus: () => ({ state: 'stopped' }), print: () => {}
      };
      const invoke = () => action === 'rebind'
        ? ordinaryBind({ 'state-dir': f.dir, channel: '#dev', 'session-root': native.root }, dependencies)
        : handoffInternal({ ordinary: true, 'state-dir': f.dir, provider: 'codex',
          'channel-id': channelId, 'from-native-id': CODEX, 'from-generation': '1',
          'native-id': successor, workspace: f.dir, 'session-root': native.root,
          'handoff-id': 'cutoff-atomicity' }, dependencies);
      if (collision) {
        await assert.rejects(invoke, /already owned/);
        assert.deepEqual(f.state.getBinding(channelId), before.binding);
        assert.deepEqual(f.state.getIntakeWatermark(channelId), before.watermark);
        assert.deepEqual(f.state.listReceipts(), before.receipts);
      } else {
        await invoke();
        assert.equal(f.state.getBinding(channelId).generation, 2);
        assert.equal(f.state.getBinding(channelId).nativeId, successor);
        assert.equal(f.state.getIntakeWatermark(channelId).last_seen_id, '200');
      }
    });
  }
}
