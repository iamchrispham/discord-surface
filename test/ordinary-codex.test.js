const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ORDINARY_BINDING_DECISIONS, createOrdinaryCodexRequestFromEnvironment, ordinaryBindingDecision, resolveExistingChannel, resolveInvocationIdentity } = require('../src/ordinary-codex');
const { createBindingWakeController, GATEWAY_CAPABILITIES, handoffInternal, ordinaryBind, requestGatewayRecovery, unbind } = require('../src/cli');
const { DiscordGateway } = require('../src/discord');
const { CodexProvider, readCodexSessionIdentityAsync, validateCodexSessionIdentity, validateCodexSessionIdentityAsync } = require('../src/native');
const { SurfaceState, PROVIDERS, READINESS, StaleGenerationError } = require('../src/state');
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
    channelId, guildId: 'guild', provider: PROVIDERS.CODEX, nativeId, workspace: fixtureState.dir
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
  const upperRequest = createOrdinaryCodexRequestFromEnvironment({
    channelId: 'channel', guildId: 'guild', nativeId: CODEX.toUpperCase(), workspace: '/tmp/workspace',
    environment: { CODEX_SESSION_ID: CODEX.toUpperCase(), CODEX_THREAD_ID: CODEX.toUpperCase() }
  });
  assert.equal(upperRequest.nativeId, CODEX);
  assert.deepEqual(upperRequest.identity, { sessionId: CODEX, threadId: CODEX });
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

test('ordinary bind reuses the exact owner and wakes an already-running Gateway', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinary-bind-cli-'));
  const db = path.join(dir, 'surface.sqlite');
  const defaultRoot = path.join(dir, 'default-sessions');
  const setup = new SurfaceState(db);
  setup.setConfig({ operatorId: 'operator', guildId: 'guild', secretFile: path.join(dir, 'discord.env') });
  setup.close();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const fences = [];
  const validationRoots = [];
  const channel = {
    id: 'ordinary-channel', guildId: 'guild', name: 'dev', isTextBased: () => true,
    async send() {
      const id = `adoption-fence-${fences.length + 1}`;
      const message = { id, async delete() { fences.find(fence => fence.id === id).deleted = true; } };
      fences.push({ id, deleted: false });
      return message;
    }
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
    codexSessionRoot: () => defaultRoot,
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
  assert.deepEqual(validationRoots, [defaultRoot, defaultRoot]);
  assert.equal(first.binding.sessionRoot, defaultRoot);
  assert.equal(second.binding.readiness, READINESS.PENDING);
  assert.equal(first.nativeProof.status, 'verified');
  assert.equal(second.nativeProof.status, 'verified');
  assert.deepEqual(wakeSignals, [{ pid: 4242, signal: 'SIGUSR2' }, { pid: 4242, signal: 'SIGUSR2' }]);

  const tombstone = new SurfaceState(db);
  try {
    assert.equal(tombstone.unbind(channel.id), true);
    assert.throws(() => tombstone.rebindOrdinary({
      channelId: channel.id, guildId: 'guild', provider: PROVIDERS.CODEX, nativeId: OTHER, workspace: dir
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
  assert.deepEqual(fences, [
    { id: 'adoption-fence-1', deleted: true },
    { id: 'adoption-fence-2', deleted: true }
  ]);

  const stateAfterRebind = new SurfaceState(db);
  try {
    assert.equal(stateAfterRebind.getIntakeWatermark(channel.id).last_seen_id, 'adoption-fence-2');
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

test('ordinary bind reopens terminal intake after native proof recovers', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinary-bind-recovery-'));
  const db = path.join(dir, 'surface.sqlite');
  const session = transcript(t, dir);
  const setup = new SurfaceState(db);
  setup.setConfig({ operatorId: 'operator', guildId: 'guild', secretFile: path.join(dir, 'discord.env') });
  setup.close();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const channel = {
    id: 'ordinary-recovery-channel', guildId: 'guild', name: 'dev', isTextBased: () => true,
    async send() { return { id: 'adoption-fence-recovery', async delete() {} }; }
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

  const channel = {
    id: 'workspace-channel', guildId: 'guild', name: 'dev', isTextBased: () => true,
    async send() { return { id: 'adoption-fence-workspace', async delete() {} }; }
  };
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
    async send() { return { id: '100' }; }
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
      return historyCalls === 1
        ? [{ id: '200', guildId: 'guild', channelId: 'gateway-channel', author: { id: 'operator', bot: false }, content: 'held until Gateway recovery', attachments: [] }]
        : [];
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
    id: '200', guildId: 'guild', channelId: channel.id,
    authorId: 'operator', isBot: false, content: 'held until Gateway recovery'
  }, { ready: false });
  assert.equal(accepted.accepted, true);
  const second = await ordinaryBind(args, dependencies);
  assert.equal(first.reused, false);
  assert.equal(second.reused, true);
  releaseHistory();
  await wake.wait();
  assert.deepEqual(wakeErrors, []);
  assert.ok(historyCalls >= 1);
  assert.equal(state.getBinding(channel.id).readiness, READINESS.READY);
  assert.equal(dispatches, 1);
  assert.equal(dispatchedSessionRoot, session.root);
  assert.equal(state.getMessage('200').state, 'replied');
});

test('ordinary bind uses the server fence as its adoption cutoff', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinary-bind-empty-cutoff-'));
  const db = path.join(dir, 'surface.sqlite');
  const setup = new SurfaceState(db);
  setup.setConfig({ operatorId: 'operator', guildId: 'guild', secretFile: path.join(dir, 'discord.env') });
  setup.close();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  let sendStartedAt = 0;
  let sendCompletedAt = 0;
  const channel = {
    id: '123456789012345678', guildId: 'guild', name: 'dev', isTextBased: () => true,
    send: async () => {
      sendStartedAt = Date.now();
      await new Promise(resolve => setTimeout(resolve, 50));
      sendCompletedAt = Date.now();
      return { id: '123456789012345679', async delete() {} };
    }
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
    assert.equal(watermark.last_seen_id, '123456789012345679');
    assert.ok(sendCompletedAt >= sendStartedAt);
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
    channelId: 'ordinary-successor-channel', guildId: 'guild', provider: PROVIDERS.CODEX, nativeId: CODEX,
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
    messages: { fetch: async () => new Map([['latest', { id: '200' }]]) },
    send: async () => ({ id: '201', async delete() {} })
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
    channelId: 'ordinary-null-root-channel', guildId: 'guild', provider: PROVIDERS.CODEX, nativeId: CODEX,
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
    channelId: binding.channelId, provider: PROVIDERS.CODEX, fromNativeId: CODEX, fromGeneration: 1,
    nativeId: OTHER, workspace: f.dir, sessionRoot: null, handoffId: 'ordinary-null-root-handoff',
    identity: { sessionId: OTHER, threadId: OTHER },
    nativeProof: { file: transcriptFile, sessionId: OTHER, threadId: OTHER, workspace: f.dir, sessionRoot: null }
  });
  assert.equal(rebound.sessionRoot, null);
  assert.equal(rebound.nativeId, OTHER);
  assert.equal(rebound.generation, 2);
});

test('ordinary CLI handoff preserves a custom transcript root when omitted', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinary-default-root-cli-'));
  const db = path.join(dir, 'surface.sqlite');
  const successorWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinary-default-root-workspace-'));
  const predecessorHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinary-default-root-predecessor-'));
  const predecessorRoot = path.join(predecessorHome, 'sessions');
  fs.mkdirSync(predecessorRoot);
  const defaultRoot = path.join(dir, 'sessions');
  fs.mkdirSync(defaultRoot);
  const transcriptFile = path.join(predecessorRoot, OTHER + '.jsonl');
  fs.writeFileSync(transcriptFile, `${JSON.stringify({ type: 'session_meta', payload: {
    session_id: OTHER, id: OTHER, cwd: successorWorkspace
  } })}\n`);
  const setup = new SurfaceState(db);
  setup.setConfig({ operatorId: 'operator', guildId: 'guild', secretFile: path.join(dir, 'discord.env') });
  const original = setup.bindOrdinary({
    channelId: '123456789012345679', guildId: 'guild', provider: PROVIDERS.CODEX, nativeId: CODEX,
    workspace: dir, sessionRoot: predecessorRoot
  }, { sessionId: CODEX, threadId: CODEX });
  setup.unbind(original.channelId);
  setup.close();
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(successorWorkspace, { recursive: true, force: true });
    fs.rmSync(predecessorHome, { recursive: true, force: true });
    fs.rmSync(defaultRoot, { recursive: true, force: true });
  });

  const channel = {
    id: original.channelId, guildId: 'guild', name: 'ordinary', isTextBased: () => true,
    messages: { fetch: async () => new Map([['latest', { id: '200' }]]) },
    send: async () => ({ id: '201', async delete() {} })
  };
  class FakeClient {
    constructor() { this.guilds = { fetch: async () => ({ channels: { fetch: async () => channel } }) }; }
    async login() {}
    async destroy() {}
  }
  const result = await handoffInternal({
    ordinary: true, 'state-dir': dir, provider: PROVIDERS.CODEX, 'channel-id': original.channelId,
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
  assert.equal(result.binding.sessionRoot, predecessorRoot);
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
      return { ready: true, state: READINESS.READY };
    },
    async reconcilePending() { calls.push('reconcile'); }
  };
  const wake = createBindingWakeController({
    getGateway: () => gateway,
    isReady: () => true,
    isStopping: () => false
  });
  wake.request();
  releaseShared({ ready: true, state: READINESS.READY });
  await wake.wait();
  assert.deepEqual(calls, ['recover:ordinary-bind', 'recover:ordinary-bind', 'reconcile']);
});

test('binding wake reconciles recovered owners after a partial recovery pauses live dispatch', async () => {
  const calls = [];
  const gateway = {
    ready: true,
    pauseLiveDispatch() { this.ready = false; },
    async recoverTransport(reason) {
      calls.push(`recover:${reason}`);
      return { ready: false, state: READINESS.UNAVAILABLE };
    },
    async reconcilePending(_before, options) { calls.push({ phase: 'reconcile', options }); }
  };
  const wake = createBindingWakeController({
    getGateway: () => gateway,
    isReady: () => gateway.ready,
    isStopping: () => false
  });
  wake.request();
  await wake.wait();
  assert.deepEqual(calls, [
    'recover:ordinary-bind',
    { phase: 'reconcile', options: { allowPaused: true, readyOnly: true } }
  ]);
});

test('binding wake remains queued while the Gateway is disconnected', async () => {
  const calls = [];
  const gateway = {
    ready: false,
    recoveryPromise: null,
    async recoverTransport(reason) {
      calls.push(`recover:${reason}`);
      return { ready: true, state: READINESS.READY };
    },
    async reconcilePending() { calls.push('reconcile'); }
  };
  const wake = createBindingWakeController({
    getGateway: () => gateway,
    isReady: () => gateway.ready,
    isStopping: () => false
  });
  wake.request();
  await wake.wait();
  assert.deepEqual(calls, []);
  gateway.ready = true;
  wake.start();
  await wake.wait();
  assert.deepEqual(calls, ['recover:ordinary-bind', 'reconcile']);
});

test('binding wake starts when reconnect transport is ready after partial recovery', async () => {
  const calls = [];
  const gateway = {
    ready: false,
    transportReady: true,
    recoveryPromise: null,
    async recoverTransport(reason) {
      calls.push(`recover:${reason}`);
      this.ready = true;
      return { ready: true, state: READINESS.READY };
    },
    async reconcilePending() { calls.push('reconcile'); }
  };
  const wake = createBindingWakeController({
    getGateway: () => gateway,
    isReady: () => gateway.ready,
    isTransportReady: () => gateway.transportReady,
    isStopping: () => false
  });
  wake.request();
  await wake.wait();
  assert.deepEqual(calls, ['recover:ordinary-bind', 'reconcile']);
});

test('ordinary binding decision refuses a non-ordinary or inactive existing owner', () => {
  const request = {
    provider: PROVIDERS.CODEX, channelId: 'channel', guildId: 'guild', nativeId: CODEX, workspace: '/tmp/workspace',
    identity: { sessionId: CODEX, threadId: CODEX }
  };
  assert.equal(ordinaryBindingDecision(null, request), ORDINARY_BINDING_DECISIONS.BIND);
  assert.equal(ordinaryBindingDecision({ ...request, active: true }, request, true), ORDINARY_BINDING_DECISIONS.REUSE);
  assert.equal(ordinaryBindingDecision({ ...request, active: false }, request, true), ORDINARY_BINDING_DECISIONS.REBIND);
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
    channelId: binding.channelId, guildId: 'guild', provider: PROVIDERS.CODEX, nativeId: OTHER, workspace: f.dir
  }), /matching invocation identity/);
  const accepted = f.state.acceptDiscordMessage({
    id: 'pending-input', guildId: 'guild', channelId: binding.channelId,
    authorId: 'operator', isBot: false, content: 'held'
  }, { ready: false });
  assert.equal(accepted.accepted, true);
  assert.equal(f.state.claimDispatch('pending-input').reason, 'binding-not-ready');
  assert.equal(f.state.getMessage('pending-input').state, 'accepted');
  assert.throws(() => f.state.bindOrdinary({
    channelId: 'second-channel', guildId: 'guild', provider: PROVIDERS.CODEX, nativeId: CODEX, workspace: f.dir
  }, f.identity), /already owned/);
  assert.throws(() => f.state.bindOrdinary({
    channelId: binding.channelId, guildId: 'guild', provider: PROVIDERS.CODEX, nativeId: OTHER, workspace: f.dir
  }, { sessionId: OTHER, threadId: OTHER }), /already bound/);
  assert.throws(() => f.state.bindOrdinary({
    channelId: 'identity-mismatch', guildId: 'guild', provider: PROVIDERS.CODEX, nativeId: CODEX, workspace: f.dir
  }, { sessionId: OTHER, threadId: OTHER }), /does not match the native session/);
});

test('ordinary binding permits a verified transcript-root relocation', t => {
  const f = fixture(t);
  const binding = ordinary(f);
  const sessionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinary-relocated-root-'));
  t.after(() => fs.rmSync(sessionRoot, { recursive: true, force: true }));
  const request = {
    provider: PROVIDERS.CODEX, channelId: binding.channelId, guildId: 'guild', nativeId: CODEX,
    workspace: f.dir, sessionRoot, identity: { sessionId: CODEX, threadId: CODEX }
  };
  const proof = {
    file: path.join(sessionRoot, `${CODEX}.jsonl`), sessionId: CODEX, threadId: CODEX,
    workspace: f.dir, sessionRoot
  };
  assert.throws(() => ordinaryBindingDecision(binding, request, true), /already bound/);
  assert.equal(ordinaryBindingDecision(binding, request, true, proof), ORDINARY_BINDING_DECISIONS.REBIND);
  const relocated = f.state.rebindOrdinary(request, request.identity, proof);
  assert.equal(relocated.sessionRoot, sessionRoot);
  assert.equal(relocated.generation, 2);
});

test('ordinary root relocation reopens a drained terminal intake watermark', t => {
  const f = fixture(t);
  const binding = ordinary(f);
  f.state.markIntakeBoundary(binding.channelId, READINESS.GAP, 'previous recovery gap', 'gap-from', 'gap-to');
  const sessionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinary-relocated-terminal-root-'));
  t.after(() => fs.rmSync(sessionRoot, { recursive: true, force: true }));
  const request = {
    provider: PROVIDERS.CODEX, channelId: binding.channelId, guildId: 'guild', nativeId: CODEX,
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

test('ordinary root relocation refuses an active dispatch', t => {
  const f = fixture(t);
  const binding = ordinary(f);
  const sessionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinary-relocated-dispatch-root-'));
  const proof = {
    file: path.join(sessionRoot, `${CODEX}.jsonl`), sessionId: CODEX, threadId: CODEX,
    workspace: f.dir, sessionRoot
  };
  t.after(() => fs.rmSync(sessionRoot, { recursive: true, force: true }));
  f.state.recordOrdinaryPreflight(binding, {
    file: path.join(f.dir, 'session.jsonl'), sessionId: CODEX, threadId: CODEX, workspace: f.dir
  });
  const ready = f.state.setBindingReadiness(binding.channelId, READINESS.READY, 'test', binding);
  f.state.acceptDiscordMessage({
    id: 'ordinary-relocation-dispatch', guildId: 'guild', channelId: binding.channelId,
    authorId: 'operator', isBot: false, content: 'dispatch'
  }, { expectedBinding: ready });
  assert.equal(f.state.claimDispatch('ordinary-relocation-dispatch').claimed, true);
  const request = {
    provider: PROVIDERS.CODEX, channelId: binding.channelId, guildId: 'guild', nativeId: CODEX,
    workspace: f.dir, sessionRoot, identity: { sessionId: CODEX, threadId: CODEX }
  };
  assert.throws(() => f.state.rebindOrdinary(request, request.identity, proof), /dispatch is in flight/);
  f.state.markUncertain('ordinary-relocation-dispatch', 'network outcome is uncertain');
  assert.throws(() => f.state.rebindOrdinary(request, request.identity, proof), /dispatch is in flight/);
  const unchanged = f.state.getBinding(binding.channelId);
  assert.equal(unchanged.sessionRoot, null);
  assert.equal(unchanged.generation, binding.generation);
});

test('ordinary handoff refuses unmatched and active direct-post custody', t => {
  const f = fixture(t);
  const binding = ordinary(f);
  const successorWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinary-post-handoff-workspace-'));
  const successorRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinary-post-handoff-root-'));
  t.after(() => {
    fs.rmSync(successorWorkspace, { recursive: true, force: true });
    fs.rmSync(successorRoot, { recursive: true, force: true });
  });
  const proof = {
    file: path.join(successorRoot, `${OTHER}.jsonl`), sessionId: OTHER, threadId: OTHER,
    workspace: successorWorkspace, sessionRoot: successorRoot
  };
  f.state.directPostOwnerAlive = () => true;
  const attempt = {
    journal: 'direct-post-v1', requestId: 'ordinary-post-handoff', attemptId: 'ordinary-post-attempt',
    ownerPid: 1, sourcePath: path.join(f.dir, 'milestone.txt'), textHash: 'text-hash', operatorId: 'operator',
    partHash: 'part-hash', channelId: binding.channelId, guildId: 'guild', provider: PROVIDERS.CODEX,
    nativeId: CODEX, generation: binding.generation, conductorId: null, repoKey: null,
    partIndex: 0, partCount: 2, nonce: 'ordinary-post-nonce', status: 'attempted'
  };
  f.state.receipt(null, 'direct-post-attempt', attempt);
  const handoff = {
    channelId: binding.channelId, provider: PROVIDERS.CODEX, fromNativeId: CODEX, fromGeneration: binding.generation,
    nativeId: OTHER, workspace: successorWorkspace, sessionRoot: successorRoot,
    handoffId: 'ordinary-post-handoff-id', identity: { sessionId: OTHER, threadId: OTHER }, nativeProof: proof
  };
  const relocation = { ...binding, sessionRoot: successorRoot };
  const relocationProof = { ...proof, sessionId: CODEX, threadId: CODEX, workspace: binding.workspace };
  const assertRelocationHeld = () => {
    const before = f.state.getBinding(binding.channelId);
    assert.throws(() => f.state.rebindOrdinary(relocation, f.identity, relocationProof), /unresolved.*post/);
    assert.deepEqual(f.state.getBinding(binding.channelId), before);
  };
  assertRelocationHeld();
  assert.throws(() => f.state.handoffOrdinary(handoff), /unresolved/);
  f.state.receipt(null, 'direct-post-outcome', { ...attempt, outcome: 'sent', messageId: 'sent-message' });
  assertRelocationHeld();
  assert.throws(() => f.state.handoffOrdinary(handoff), /unresolved/);
  const finalAttempt = { ...attempt, attemptId: 'ordinary-post-final-attempt', partIndex: 1 };
  f.state.receipt(null, 'direct-post-attempt', finalAttempt);
  f.state.receipt(null, 'direct-post-outcome', { ...finalAttempt, outcome: 'sent', messageId: 'final-message' });
  const transferred = f.state.handoffOrdinary({ ...handoff, handoffId: 'ordinary-post-complete-id' });
  assert.equal(transferred.nativeId, OTHER);
  assert.equal(f.state.getBinding(binding.channelId).nativeId, OTHER);
});

test('ordinary bind rejects a successor and explicit tombstone handoff transfers custody', t => {
  const f = fixture(t);
  const originalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinary-original-root-'));
  const binding = f.state.bindOrdinary({
    channelId: 'ordinary-channel', guildId: 'guild', provider: PROVIDERS.CODEX, nativeId: CODEX,
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
    provider: PROVIDERS.CODEX, channelId: binding.channelId, guildId: 'guild', nativeId: OTHER,
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
    channelId: binding.channelId, provider: PROVIDERS.CODEX, fromNativeId: CODEX, fromGeneration: 1,
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
    channelId: binding.channelId, provider: PROVIDERS.CODEX, fromNativeId: CODEX, fromGeneration: 1,
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
  f.state.markIntakeBoundary(binding.channelId, READINESS.GAP, 'ordinary active handoff previous gap', 'gap-from', 'gap-to');
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
    channelId: binding.channelId, provider: PROVIDERS.CODEX, fromNativeId: CODEX, fromGeneration: 2,
    nativeId: OTHER, workspace: successorWorkspace, sessionRoot: successorRoot,
    handoffId: 'ordinary-stale-handoff', identity: { sessionId: OTHER, threadId: OTHER }, nativeProof: proof
  }), /stale/);
  assert.equal(f.state.getBinding(binding.channelId).nativeId, CODEX);
  assert.throws(() => f.state.handoffOrdinary({
    channelId: binding.channelId, provider: PROVIDERS.CODEX, fromNativeId: CODEX, fromGeneration: 1,
    nativeId: OTHER, workspace: successorWorkspace, sessionRoot: successorRoot,
    handoffId: 'ordinary-proof-handoff', identity: { sessionId: OTHER, threadId: OTHER },
    nativeProof: { ...proof, workspace: f.dir }
  }), /transcript proof/);
  assert.equal(f.state.getBinding(binding.channelId).generation, 1);
  const transferred = f.state.handoffOrdinary({
    channelId: binding.channelId, provider: PROVIDERS.CODEX, fromNativeId: CODEX, fromGeneration: 1,
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
    channelId: binding.channelId, provider: PROVIDERS.CODEX, fromNativeId: CODEX, fromGeneration: 1,
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
    channelId: unresolvedBinding.channelId, provider: PROVIDERS.CODEX, fromNativeId: CODEX, fromGeneration: 1,
    nativeId: OTHER, workspace: successorWorkspace, sessionRoot: successorRoot,
    handoffId: 'ordinary-unresolved-handoff', identity: { sessionId: OTHER, threadId: OTHER }, nativeProof: proof
  }), /unresolved/);
  assert.equal(unresolvedFixture.state.getBinding(unresolvedBinding.channelId).nativeId, CODEX);
  const collisionFixture = fixture(t);
  const collisionBinding = ordinary(collisionFixture, 'ordinary-collision-source');
  const second = collisionFixture.state.bindOrdinary({
    channelId: 'ordinary-collision-channel', guildId: 'guild', provider: PROVIDERS.CODEX, nativeId: OTHER,
    workspace: successorWorkspace, sessionRoot: successorRoot
  }, { sessionId: OTHER, threadId: OTHER });
  assert.equal(second.active, true);
  assert.throws(() => collisionFixture.state.handoffOrdinary({
    channelId: collisionBinding.channelId, provider: PROVIDERS.CODEX, fromNativeId: CODEX, fromGeneration: 1,
    nativeId: OTHER, workspace: successorWorkspace, sessionRoot: successorRoot,
    handoffId: 'ordinary-collision-handoff', identity: { sessionId: OTHER, threadId: OTHER }, nativeProof: proof
  }), /already owned/);
  assert.equal(collisionFixture.state.getBinding(collisionBinding.channelId).generation, 1);

  const missingReceiptFixture = fixture(t);
  const missingReceiptBinding = ordinary(missingReceiptFixture, 'ordinary-missing-unbound');
  missingReceiptFixture.state.db.prepare('UPDATE bindings SET active=0 WHERE channel_id=?').run(missingReceiptBinding.channelId);
  assert.throws(() => missingReceiptFixture.state.handoffOrdinary({
    channelId: missingReceiptBinding.channelId, provider: PROVIDERS.CODEX, fromNativeId: CODEX, fromGeneration: 1,
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
    channelId: '123456789012345678', guildId: 'guild', provider: PROVIDERS.CODEX, nativeId: CODEX,
    workspace: dir
  }, { sessionId: CODEX, threadId: CODEX });
  setup.setIntakeCutoff(original.channelId, 'guild', '100', 'ordinary CLI handoff baseline');
  setup.markIntakeBoundary(original.channelId, READINESS.UNAVAILABLE, 'ordinary CLI handoff previous terminal');
  setup.unbind(original.channelId);
  setup.close();
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(successorWorkspace, { recursive: true, force: true });
  });

  const channel = {
    id: original.channelId, guildId: 'guild', name: 'ordinary', isTextBased: () => true,
    messages: { fetch: async () => new Map([['latest', { id: '200' }]]) },
    send: async () => ({ id: '201', async delete() {} })
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
    ordinary: true, 'state-dir': dir, provider: PROVIDERS.CODEX, 'channel-id': original.channelId,
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
  assert.equal(recoveredState.getIntakeWatermark(original.channelId).last_seen_id, '201');
  assert.equal(recoveredState.getIntakeWatermark(original.channelId).recovered_through_id, '201');
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
  assert.equal(recoveredState.getIntakeWatermark(original.channelId).state, READINESS.READY);
  assert.equal(recoveredState.getIntakeWatermark(original.channelId).recovered_through_id, '201');
  await gateway.stop();
  recoveredState.close();
});

test('explicit ordinary handoff refuses an active remote intake gap', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinary-active-handoff-cli-'));
  const db = path.join(dir, 'surface.sqlite');
  const successorWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinary-active-handoff-workspace-'));
  const successorRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinary-active-handoff-root-'));
  const setup = new SurfaceState(db);
  setup.setConfig({ operatorId: 'operator', guildId: 'guild', secretFile: path.join(dir, 'discord.env') });
  const original = setup.bindOrdinary({
    channelId: '123456789012345678', guildId: 'guild', provider: PROVIDERS.CODEX, nativeId: CODEX,
    workspace: dir
  }, { sessionId: CODEX, threadId: CODEX });
  setup.recordOrdinaryPreflight(original, {
    file: path.join(dir, 'session.jsonl'), sessionId: CODEX, threadId: CODEX, workspace: dir
  });
  setup.setIntakeCutoff(original.channelId, 'guild', '100', 'ordinary active handoff baseline');
  setup.markIntakeBoundary(original.channelId, READINESS.READY, 'ordinary active handoff drained', null, null, original);
  setup.close();
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(successorWorkspace, { recursive: true, force: true });
    fs.rmSync(successorRoot, { recursive: true, force: true });
  });

  const channel = {
    id: original.channelId, guildId: 'guild', name: 'ordinary', isTextBased: () => true,
    messages: { fetch: async () => new Map([['latest', { id: '200' }]]) }
  };
  class FakeClient {
    constructor() {
      this.guilds = { fetch: async () => ({ channels: { fetch: async () => channel } }) };
    }
    async login() {}
    async destroy() {}
  }
  await assert.rejects(() => handoffInternal({
    ordinary: true, 'state-dir': dir, provider: PROVIDERS.CODEX, 'channel-id': original.channelId,
    'from-native-id': CODEX, 'from-generation': '1', 'native-id': OTHER,
    workspace: successorWorkspace, 'session-root': successorRoot, 'handoff-id': 'ordinary-active-gap'
  }, {
    environment: { CODEX_SESSION_ID: OTHER, CODEX_THREAD_ID: OTHER, PWD: successorWorkspace },
    requireInstalled: () => ({ Client: FakeClient, GatewayIntentBits: { Guilds: 1 } }),
    readSecret: () => 'fixture-token',
    validateCodexSessionIdentity: async () => ({
      file: path.join(successorRoot, `${OTHER}.jsonl`), sessionId: OTHER, threadId: OTHER,
      workspace: successorWorkspace
    })
  }), /durably drained/);

  const recovered = new SurfaceState(db);
  try {
    assert.equal(recovered.getBinding(original.channelId).nativeId, CODEX);
    assert.equal(recovered.getBinding(original.channelId).generation, 1);
  } finally {
    recovered.close();
  }
});

test('explicit ordinary handoff fences remote messages through its ownership commit', async t => {
  async function invokeCase(preFenceId) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinary-handoff-fence-'));
    const db = path.join(dir, 'surface.sqlite');
    const successorWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinary-handoff-fence-workspace-'));
    const session = transcript(t, successorWorkspace, OTHER);
    const setup = new SurfaceState(db);
    setup.setConfig({ operatorId: 'operator', guildId: 'guild', secretFile: path.join(dir, 'discord.env') });
    const original = setup.bindOrdinary({
      channelId: '123456789012345678', guildId: 'guild', provider: PROVIDERS.CODEX, nativeId: CODEX,
      workspace: dir
    }, { sessionId: CODEX, threadId: CODEX });
    setup.recordOrdinaryPreflight(original, {
      file: path.join(dir, 'session.jsonl'), sessionId: CODEX, threadId: CODEX, workspace: dir
    });
    setup.setIntakeCutoff(original.channelId, 'guild', '100', 'ordinary active handoff baseline');
    setup.markIntakeBoundary(original.channelId, READINESS.READY, 'ordinary active handoff drained', null, null, original);
    setup.close();
    t.after(() => {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(successorWorkspace, { recursive: true, force: true });
    });

    let beforeFenceFetches = 0;
    let deleted = false;
    let lateIntake;
    const wakeSignals = [];
    const channel = {
      id: original.channelId, guildId: 'guild', name: 'ordinary', isTextBased: () => true,
      messages: { fetch: async options => {
        if (options?.after === '100') {
          assert.equal(options.before, undefined);
          beforeFenceFetches += 1;
          return new Map([['latest', { id: preFenceId }]]);
        }
        return new Map([['latest', { id: '100' }]]);
      } },
      send: async () => {
        const duringFence = new SurfaceState(db);
        try {
          const bindingDuringFence = duringFence.getBinding(original.channelId);
          assert.equal(bindingDuringFence.readiness, READINESS.PENDING);
          lateIntake = duringFence.acceptDiscordMessage({
            id: '151', guildId: 'guild', channelId: original.channelId,
            authorId: 'operator', content: 'message after handoff fence'
          }, { ready: bindingDuringFence.readiness === READINESS.READY });
        } finally {
          duringFence.close();
        }
        return { id: '150', delete: async () => { deleted = true; } };
      }
    };
    class FakeClient {
      constructor() { this.guilds = { fetch: async () => ({ channels: { fetch: async () => channel } }) }; }
      async login() {}
      async destroy() {}
    }
    const dependencies = {
      environment: { CODEX_SESSION_ID: OTHER, CODEX_THREAD_ID: OTHER, PWD: successorWorkspace },
      requireInstalled: () => ({ Client: FakeClient, GatewayIntentBits: { Guilds: 1 } }),
      readSecret: () => 'fixture-token',
      validateCodexSessionIdentity: async () => ({ file: session.file, sessionId: OTHER, threadId: OTHER, workspace: successorWorkspace }),
      requestGatewayRecovery: (_paths, options) => {
        const runtime = options.status(_paths);
        options.kill(runtime.pid, 'SIGUSR2');
        return { requested: true, pid: runtime.pid, signal: 'SIGUSR2' };
      },
      gatewayProcessStatus: () => ({ state: 'running', pid: 4242, capabilities: [GATEWAY_CAPABILITIES.ordinaryBindWake] }),
      killProcess: (pid, signal) => wakeSignals.push({ pid, signal }),
      print: () => {}
    };
    const args = {
      ordinary: true, 'state-dir': dir, provider: PROVIDERS.CODEX, 'channel-id': original.channelId,
      'from-native-id': CODEX, 'from-generation': '1', 'native-id': OTHER,
      workspace: successorWorkspace, 'session-root': session.root, 'handoff-id': `ordinary-fence-${preFenceId}`
    };
    let result;
    let error;
    try {
      result = await handoffInternal(args, dependencies);
    } catch (caught) {
      error = caught;
    }
    const recovered = new SurfaceState(db);
    const snapshot = {
      binding: recovered.getBinding(original.channelId),
      watermark: recovered.getIntakeWatermark(original.channelId),
      retainedEvidence: recovered.hasIntakeEvidence('151')
    };
    const postAbortIntake = recovered.acceptDiscordMessage({
      id: '160', guildId: 'guild', channelId: original.channelId, authorId: 'operator', content: 'message after aborted handoff'
    }, { ready: snapshot.binding.readiness === READINESS.READY });
    recovered.close();
    return { result, error, snapshot, lateIntake, postAbortIntake, beforeFenceFetches, wakeSignals, wasDeleted: () => deleted };
  }

  const accepted = await invokeCase('100');
  assert.equal(accepted.error, undefined);
  assert.equal(accepted.result.binding.generation, 2);
  assert.equal(accepted.snapshot.watermark.last_seen_id, '151');
  assert.equal(accepted.snapshot.watermark.recovered_through_id, '150');
  assert.equal(accepted.snapshot.retainedEvidence, false);
  assert.equal(accepted.lateIntake.accepted, false);
  assert.equal(accepted.lateIntake.reason, 'handoff-intake-paused');
  assert.equal(accepted.beforeFenceFetches, 1);
  assert.deepEqual(accepted.wakeSignals, [{ pid: 4242, signal: 'SIGUSR2' }]);
  assert.equal(accepted.wasDeleted(), true);

  const rejected = await invokeCase('140');
  assert.match(rejected.error?.message || '', /durably drained/);
  assert.equal(rejected.snapshot.binding.generation, 1);
  assert.equal(rejected.snapshot.binding.nativeId, CODEX);
  assert.equal(rejected.snapshot.watermark.last_seen_id, '151');
  assert.equal(rejected.snapshot.retainedEvidence, false);
  assert.equal(rejected.lateIntake.accepted, false);
  assert.equal(rejected.lateIntake.reason, 'handoff-intake-paused');
  assert.equal(rejected.postAbortIntake.accepted, true);
  assert.deepEqual(rejected.wakeSignals, [{ pid: 4242, signal: 'SIGUSR2' }]);
  assert.equal(rejected.wasDeleted(), true);
});

test('aborted ordinary handoff preserves a newer unavailable readiness result', t => {
  const f = fixture(t);
  const binding = ordinary(f);
  f.state.recordOrdinaryPreflight(binding, {
    file: path.join(f.dir, 'session.jsonl'), sessionId: CODEX, threadId: CODEX, workspace: f.dir
  });
  f.state.markIntakeBoundary(binding.channelId, READINESS.READY, 'ordinary handoff drained', null, null, binding);
  f.state.pauseOrdinaryHandoffIntake(binding.channelId, binding);
  f.state.setBindingReadiness(binding.channelId, READINESS.UNAVAILABLE, 'native proof failed', binding);

  const restored = f.state.restoreOrdinaryHandoffIntake(binding.channelId, binding);

  assert.equal(restored, null);
  assert.equal(f.state.getBinding(binding.channelId).readiness, READINESS.UNAVAILABLE);
  assert.equal(f.state.getIntakeWatermark(binding.channelId).state, READINESS.PENDING);
  assert.equal(f.state.ordinaryHandoffPauses.has(binding.channelId), true);
});

test('interrupted ordinary handoff preserves a newer unavailable readiness result', t => {
  const f = fixture(t);
  const binding = ordinary(f);
  f.state.recordOrdinaryPreflight(binding, {
    file: path.join(f.dir, 'session.jsonl'), sessionId: CODEX, threadId: CODEX, workspace: f.dir
  });
  f.state.markIntakeBoundary(binding.channelId, READINESS.READY, 'ordinary handoff drained', null, null, binding);
  f.state.pauseOrdinaryHandoffIntake(binding.channelId, binding);
  f.state.setBindingReadiness(binding.channelId, READINESS.UNAVAILABLE, 'native proof failed', binding);
  const pausedReceipt = f.state.listReceipts().find(receipt => receipt.kind === 'ordinary-handoff-intake-paused');
  const pausedDetail = JSON.parse(pausedReceipt.detail);
  pausedDetail.ownerPid = 999999;
  f.state.db.prepare('UPDATE receipts SET detail=? WHERE id=?').run(JSON.stringify(pausedDetail), pausedReceipt.id);
  f.state.ordinaryHandoffPauses.clear();
  f.state.ordinaryHandoffPauseSnapshots.clear();
  f.state.close();

  const recovered = new SurfaceState(path.join(f.dir, 'surface.sqlite'));
  t.after(() => recovered.close());
  const restored = recovered.recoverInterruptedOrdinaryHandoffIntake(binding.channelId, binding);

  assert.equal(restored.state, READINESS.PENDING);
  assert.equal(recovered.getBinding(binding.channelId).readiness, READINESS.UNAVAILABLE);
  assert.equal(recovered.getIntakeWatermark(binding.channelId).state, READINESS.PENDING);
  assert.equal(recovered.listReceipts().some(receipt => receipt.kind === 'ordinary-handoff-intake-recovered'), true);
  const superseded = recovered.listReceipts().find(receipt => receipt.kind === 'ordinary-handoff-intake-pause-superseded');
  assert.equal(JSON.parse(superseded.detail).channelId, binding.channelId);
  const reconciled = recovered.reconcileIntake(binding.channelId, binding);
  assert.equal(reconciled.state, READINESS.PENDING);
  const reopened = recovered.markIntakeBoundary(binding.channelId, READINESS.READY, 'native proof recovered', null, null, binding);
  assert.equal(reopened.state, READINESS.READY);
  const intake = recovered.acceptDiscordMessage({
    id: '200', guildId: 'guild', channelId: binding.channelId, authorId: 'operator', content: 'after recovery'
  });
  assert.equal(intake.accepted, true);
});

test('interrupted ordinary handoff pause restores readiness from durable ownership state', t => {
  const f = fixture(t);
  const binding = ordinary(f);
  f.state.recordOrdinaryPreflight(binding, {
    file: path.join(f.dir, 'session.jsonl'), sessionId: CODEX, threadId: CODEX, workspace: f.dir
  });
  f.state.setIntakeCutoff(binding.channelId, 'guild', '100', 'ordinary handoff baseline');
  f.state.markIntakeBoundary(binding.channelId, READINESS.READY, 'ordinary handoff drained', null, null, binding);
  f.state.pauseOrdinaryHandoffIntake(binding.channelId, binding);
  f.state.setBindingReadiness(binding.channelId, READINESS.RECOVERING, 'Discord shard reconnecting', binding);
  const pausedReceipt = f.state.listReceipts().find(receipt => receipt.kind === 'ordinary-handoff-intake-paused');
  const pausedDetail = JSON.parse(pausedReceipt.detail);
  pausedDetail.ownerPid = 999999;
  f.state.db.prepare('UPDATE receipts SET detail=? WHERE id=?').run(JSON.stringify(pausedDetail), pausedReceipt.id);
  f.state.ordinaryHandoffPauses.clear();
  f.state.ordinaryHandoffPauseSnapshots.clear();
  f.state.close();

  const recovered = new SurfaceState(path.join(f.dir, 'surface.sqlite'));
  t.after(() => recovered.close());
  assert.equal(recovered.getIntakeWatermark(binding.channelId).state, READINESS.PENDING);
  const restored = recovered.recoverInterruptedOrdinaryHandoffIntake(binding.channelId, binding);
  assert.equal(restored.state, READINESS.READY);
  assert.equal(recovered.getBinding(binding.channelId).readiness, READINESS.READY);
  const intake = recovered.acceptDiscordMessage({
    id: '200', guildId: 'guild', channelId: binding.channelId, authorId: 'operator', content: 'after recovery'
  });
  assert.equal(intake.accepted, true);
});

test('ordinary unbind fences remote intake before revoking custody', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinary-unbind-fence-'));
  const db = path.join(dir, 'surface.sqlite');
  const setup = new SurfaceState(db);
  setup.setConfig({ operatorId: 'operator', guildId: 'guild', secretFile: path.join(dir, 'discord.env') });
  const binding = setup.bindOrdinary({
    channelId: '123456789012345680', guildId: 'guild', provider: PROVIDERS.CODEX, nativeId: CODEX,
    workspace: dir
  }, { sessionId: CODEX, threadId: CODEX });
  setup.recordOrdinaryPreflight(binding, {
    file: path.join(dir, 'session.jsonl'), sessionId: CODEX, threadId: CODEX, workspace: dir
  });
  setup.setIntakeCutoff(binding.channelId, 'guild', '100', 'ordinary unbind baseline');
  setup.markIntakeBoundary(binding.channelId, READINESS.READY, 'ordinary unbind drained', null, null, binding);
  setup.acceptDiscordMessage({
    id: '140', guildId: 'guild', channelId: binding.channelId, authorId: 'bot', isBot: true, content: 'receipt'
  }, { ready: true });
  setup.close();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  let deleted = false;
  const channel = {
    id: binding.channelId, guildId: 'guild', name: 'ordinary', isTextBased: () => true,
    lastMessageId: '140',
    messages: { fetch: async options => {
      if (options?.after === '100') { assert.equal(options.before, undefined); return new Map(); }
      return new Map([['latest', { id: '140' }]]);
    } },
    send: async () => {
      channel.lastMessageId = '150';
      return { id: '150', delete: async () => { deleted = true; } };
    }
  };
  class FakeClient {
    constructor() { this.guilds = { fetch: async () => ({ channels: { fetch: async () => channel } }) }; }
    async login() {}
    async destroy() {}
  }

  const result = await unbind({ 'state-dir': dir, 'channel-id': binding.channelId }, {
    requireInstalled: () => ({ Client: FakeClient, GatewayIntentBits: { Guilds: 1 } }),
    readSecret: () => 'fixture-token', print: () => {}
  });
  assert.equal(result.unbound, true);
  assert.equal(deleted, true);

  const recovered = new SurfaceState(db);
  try {
    assert.equal(recovered.getBinding(binding.channelId).active, false);
    const watermark = recovered.getIntakeWatermark(binding.channelId);
    assert.equal(watermark.last_seen_id, '150');
    assert.equal(watermark.recovered_through_id, '150');
    assert.equal(watermark.state, READINESS.READY);
    assert.equal(recovered.getReadiness().limits.connectionBackfill, 'bounded-by-discord-watermark');
  } finally { recovered.close(); }
});

test('aborted ordinary unbind restores intake and wakes the Gateway', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinary-unbind-abort-'));
  const db = path.join(dir, 'surface.sqlite');
  const setup = new SurfaceState(db);
  setup.setConfig({ operatorId: 'operator', guildId: 'guild', secretFile: path.join(dir, 'discord.env') });
  const binding = setup.bindOrdinary({
    channelId: '123456789012345680', guildId: 'guild', provider: PROVIDERS.CODEX, nativeId: CODEX,
    workspace: dir
  }, { sessionId: CODEX, threadId: CODEX });
  setup.recordOrdinaryPreflight(binding, {
    file: path.join(dir, 'session.jsonl'), sessionId: CODEX, threadId: CODEX, workspace: dir
  });
  setup.setIntakeCutoff(binding.channelId, 'guild', '100', 'ordinary unbind baseline');
  setup.markIntakeBoundary(binding.channelId, READINESS.READY, 'ordinary unbind drained', null, null, binding);
  setup.close();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const wakeSignals = [];
  const channel = {
    id: binding.channelId, guildId: 'guild', name: 'ordinary', isTextBased: () => true,
    messages: { fetch: async options => options?.after === '100'
      ? new Map([['latest', { id: '140' }]])
      : new Map([['latest', { id: '100' }]]) },
    send: async () => ({ id: '150', async delete() {} })
  };
  class FakeClient {
    constructor() { this.guilds = { fetch: async () => ({ channels: { fetch: async () => channel } }) }; }
    async login() {}
    async destroy() {}
  }

  await assert.rejects(() => unbind({ 'state-dir': dir, 'channel-id': binding.channelId }, {
    requireInstalled: () => ({ Client: FakeClient, GatewayIntentBits: { Guilds: 1 } }),
    readSecret: () => 'fixture-token',
    requestGatewayRecovery: (_paths, options) => {
      const runtime = options.status(_paths);
      options.kill(runtime.pid, 'SIGUSR2');
      return { requested: true, pid: runtime.pid, signal: 'SIGUSR2' };
    },
    gatewayProcessStatus: () => ({ state: 'running', pid: 4242, capabilities: [GATEWAY_CAPABILITIES.ordinaryBindWake] }),
    killProcess: (pid, signal) => wakeSignals.push({ pid, signal }),
    print: () => {}
  }), /durably drained/);

  const recovered = new SurfaceState(db);
  try {
    assert.equal(recovered.getBinding(binding.channelId).readiness, READINESS.READY);
    assert.equal(recovered.getIntakeWatermark(binding.channelId).state, READINESS.READY);
    assert.deepEqual(wakeSignals, [{ pid: 4242, signal: 'SIGUSR2' }]);
    assert.equal(recovered.acceptDiscordMessage({
      id: '160', guildId: 'guild', channelId: binding.channelId, authorId: 'operator', content: 'after aborted unbind'
    }).accepted, true);
  } finally { recovered.close(); }
});

test('ordinary ready intake records live observation without moving the recovery cutoff', t => {
  const f = fixture(t);
  const binding = ordinary(f);
  f.state.setIntakeCutoff(binding.channelId, 'guild', '100', 'ordinary live coverage baseline');
  f.state.recordOrdinaryPreflight(binding, {
    file: path.join(f.dir, 'session.jsonl'), sessionId: CODEX, threadId: CODEX, workspace: f.dir
  });
  f.state.markIntakeBoundary(binding.channelId, READINESS.READY, 'ordinary live coverage drained', null, null, binding);

  const intake = f.state.acceptDiscordMessage({
    id: '150', guildId: 'guild', channelId: binding.channelId, authorId: 'bot', isBot: true, content: 'receipt'
  }, { ready: true });
  assert.equal(intake.accepted, false);
  assert.equal(intake.reason, 'bot-source');
  const delayed = f.state.acceptDiscordMessage({
    id: '140', guildId: 'guild', channelId: binding.channelId, authorId: 'operator', isBot: false, content: 'delayed operator input'
  }, { ready: true });
  assert.equal(delayed.accepted, true);
  const watermark = f.state.getIntakeWatermark(binding.channelId);
  assert.equal(watermark.last_seen_id, '150');
  assert.equal(watermark.recovered_through_id, '100');
});

test('ordinary paused intake rejects messages at or before the persisted cutoff', t => {
  const f = fixture(t);
  const binding = ordinary(f);
  f.state.setIntakeCutoff(binding.channelId, 'guild', '100', 'ordinary paused intake cutoff');

  const stale = f.state.acceptDiscordMessage({
    id: '100', guildId: 'guild', channelId: binding.channelId, authorId: 'operator', isBot: false, content: 'stale'
  }, { ready: false });
  assert.equal(stale.accepted, false);
  assert.equal(stale.reason, 'before-intake-cutoff');
  assert.equal(f.state.getMessage('100'), null);

  const fresh = f.state.acceptDiscordMessage({
    id: '101', guildId: 'guild', channelId: binding.channelId, authorId: 'operator', isBot: false, content: 'fresh'
  }, { ready: false });
  assert.equal(fresh.accepted, true);
  assert.equal(fresh.message.generation, binding.generation);
});

test('ordinary unbind keeps a reactivated successor when its observed tombstone is stale', t => {
  const f = fixture(t);
  const binding = ordinary(f);
  f.state.unbind(binding.channelId);
  const tombstone = f.state.getBinding(binding.channelId);
  const successorWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinary-stale-unbind-workspace-'));
  const successorRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinary-stale-unbind-root-'));
  t.after(() => {
    fs.rmSync(successorWorkspace, { recursive: true, force: true });
    fs.rmSync(successorRoot, { recursive: true, force: true });
  });
  const proof = {
    file: path.join(successorRoot, `${OTHER}.jsonl`), sessionId: OTHER, threadId: OTHER,
    workspace: successorWorkspace, sessionRoot: successorRoot
  };
  const successor = f.state.handoffOrdinary({
    channelId: binding.channelId, provider: PROVIDERS.CODEX, fromNativeId: CODEX, fromGeneration: binding.generation,
    nativeId: OTHER, workspace: successorWorkspace, sessionRoot: successorRoot,
    handoffId: 'ordinary-stale-unbind-successor', identity: { sessionId: OTHER, threadId: OTHER }, nativeProof: proof
  });
  assert.equal(successor.active, true);
  assert.throws(() => f.state.unbind(binding.channelId, { expectedBinding: tombstone }), /stale/);
  assert.equal(f.state.getBinding(binding.channelId).nativeId, OTHER);
  assert.equal(f.state.getBinding(binding.channelId).active, true);
});

test('native preflight requires exact session metadata and workspace', async t => {
  const f = fixture(t);
  const matching = transcript(t, f.dir);
  const proof = validateCodexSessionIdentity(CODEX, f.dir, matching.root);
  assert.equal(proof.file, matching.file);
  const singleField = transcript(t, f.dir, CODEX, { id: undefined });
  const singleFieldProof = validateCodexSessionIdentity(CODEX, f.dir, singleField.root);
  assert.deepEqual({ sessionId: singleFieldProof.sessionId, threadId: singleFieldProof.threadId }, { sessionId: CODEX, threadId: CODEX });
  const asyncSingleFieldProof = await readCodexSessionIdentityAsync(CODEX, singleField.root);
  assert.deepEqual({ sessionId: asyncSingleFieldProof.sessionId, threadId: asyncSingleFieldProof.threadId }, { sessionId: CODEX, threadId: CODEX });
  const otherSingleField = transcript(t, f.dir, CODEX, { session_id: undefined });
  const otherSingleFieldProof = validateCodexSessionIdentity(CODEX, f.dir, otherSingleField.root);
  assert.deepEqual({ sessionId: otherSingleFieldProof.sessionId, threadId: otherSingleFieldProof.threadId }, { sessionId: CODEX, threadId: CODEX });
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
  assert.throws(() => f.state.markIntakeBoundary(binding.channelId, READINESS.READY, 'history complete', null, null, binding), /preflight/);
  assert.throws(() => f.state.recordOrdinaryPreflight(binding, { file: '/tmp/exact.jsonl', sessionId: OTHER, threadId: OTHER, workspace: f.dir }), /does not match/);
  f.state.recordOrdinaryPreflight(binding, { file: '/tmp/exact.jsonl', sessionId: CODEX, threadId: CODEX, workspace: f.dir });
  f.state.markIntakeBoundary(binding.channelId, READINESS.READY, 'history complete', null, null, binding);
  assert.equal(f.state.getBinding(binding.channelId).readiness, READINESS.READY);
});

test('ordinary preflight evidence is scoped to the active transcript root', t => {
  const f = fixture(t);
  const original = transcript(t, f.dir);
  const successor = transcript(t, f.dir);
  const binding = f.state.bindOrdinary({
    channelId: 'ordinary-root-scope', guildId: 'guild', provider: PROVIDERS.CODEX, nativeId: CODEX,
    workspace: f.dir, sessionRoot: original.root
  }, { sessionId: CODEX, threadId: CODEX });
  f.state.recordOrdinaryPreflight(binding, {
    file: original.file, sessionId: CODEX, threadId: CODEX, workspace: f.dir
  });
  assert.equal(f.state.hasOrdinaryPreflight(binding), true);
  f.state.acceptDiscordMessage({
    id: 'root-relocation-held', guildId: 'guild', channelId: binding.channelId,
    authorId: 'operator', isBot: false, content: 'held during root relocation'
  }, { ready: false });

  const relocated = f.state.rebindOrdinary({ ...binding, sessionRoot: successor.root }, {
    sessionId: CODEX, threadId: CODEX
  }, {
    file: successor.file, sessionId: CODEX, threadId: CODEX, workspace: f.dir, sessionRoot: successor.root
  });
  assert.equal(relocated.generation, binding.generation);
  assert.equal(relocated.sessionRoot, successor.root);
  assert.equal(f.state.hasOrdinaryPreflight(relocated), false);
  assert.throws(() => f.state.markIntakeBoundary(relocated.channelId, READINESS.READY, 'history complete', null, null, relocated), /preflight/);
});

test('Gateway repeats ordinary native preflight on reconnect before promoting intake', async t => {
  const f = fixture(t);
  const session = transcript(t, f.dir);
  const binding = ordinary(f);
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
    async send() { replies += 1; return { id: `reply-${replies}` }; }
  };
  const client = {
    user: { id: 'bot' },
    channels: { fetch: async () => channel },
    on() {}, off() {}, async destroy() {}
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
  const first = await gateway.recoverTransport('startup', 0);
  assert.equal(first.ready, true);
  assert.equal(f.state.getBinding(binding.channelId).readiness, READINESS.READY);
  assert.equal(preflights, 1);
  const reconciled = await gateway.reconcilePending();
  assert.deepEqual(reconciled, []);
  assert.equal(dispatches, 1);
  assert.ok(replies >= 1);
  assert.equal(f.state.getMessage('held-input').state, 'replied');
  gateway.pauseConnection('reconnect');
  assert.equal(f.state.getBinding(binding.channelId).readiness, READINESS.RECOVERING);
  const second = await gateway.recoverTransport('reconnect', 0);
  assert.equal(second.ready, true);
  assert.equal(preflights, 2);
  assert.equal(f.state.getMessage('held-input').state, 'replied');
  await gateway.stop();
});

test('Gateway defers startup recovery while an ordinary handoff owner is live', async t => {
  const f = fixture(t);
  const binding = ordinary(f);
  assert.ok(f.state.pauseOrdinaryHandoffIntake(binding.channelId, binding));
  f.state.ordinaryHandoffPauses.clear();
  f.state.ordinaryHandoffPauseSnapshots.clear();
  const secretFile = path.join(f.dir, 'discord.env');
  fs.writeFileSync(secretFile, 'DISCORD_TOKEN=fixture-token\n', { mode: 0o600 });
  let fetches = 0;
  const client = {
    user: { id: 'bot' },
    channels: { fetch: async () => { fetches += 1; throw new Error('startup recovery must be deferred'); } },
    on() {}, off() {}, async login() {}, async destroy() {}
  };
  const gateway = new DiscordGateway({ state: f.state, client, providers: {} });

  await gateway.start(secretFile);

  assert.equal(gateway.ready, true);
  assert.equal(fetches, 0);
  assert.equal(f.state.getBinding(binding.channelId).readiness, READINESS.PENDING);
  await gateway.stop();
});

test('Gateway retries deferred startup recovery after an ordinary handoff aborts', async t => {
  const f = fixture(t);
  const session = transcript(t, f.dir);
  const binding = ordinary(f);
  f.state.recordOrdinaryPreflight(binding, {
    file: session.file, sessionId: CODEX, threadId: CODEX, workspace: f.dir
  });
  f.state.setIntakeCutoff(binding.channelId, 'guild', '100', 'ordinary handoff baseline');
  f.state.markIntakeBoundary(binding.channelId, READINESS.READY, 'ordinary handoff drained', null, null, binding);
  const held = f.state.acceptDiscordMessage({
    id: '101', guildId: 'guild', channelId: binding.channelId, authorId: 'operator', content: 'held during handoff'
  }, { ready: true });
  assert.equal(held.accepted, true);
  assert.ok(f.state.pauseOrdinaryHandoffIntake(binding.channelId, binding));
  f.state.ordinaryHandoffPauses.clear();
  f.state.ordinaryHandoffPauseSnapshots.clear();
  const pausedReceipt = f.state.listReceipts().find(receipt => receipt.kind === 'ordinary-handoff-intake-paused');
  const pausedDetail = JSON.parse(pausedReceipt.detail);
  const secretFile = path.join(f.dir, 'discord.env');
  fs.writeFileSync(secretFile, 'DISCORD_TOKEN=fixture-token\n', { mode: 0o600 });
  let dispatches = 0;
  let replies = 0;
  const channel = {
    id: binding.channelId,
    guildId: 'guild',
    topic: null,
    permissionsFor: () => ({ has: () => true }),
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
    fetchHistory: async () => [{
      id: '101', guildId: 'guild', channelId: binding.channelId,
      author: { id: 'operator', bot: false }, content: 'held during handoff', attachments: []
    }],
    providers: { codex: {
      async dispatch() { dispatches += 1; return { status: 'submitted' }; },
      async observe() { return { text: 'answer' }; }
    } },
    recoveryOptions: {
      ordinaryNativePreflight: async () => ({
        file: session.file, sessionId: CODEX, threadId: CODEX, workspace: f.dir
      })
    }
  });

  await gateway.start(secretFile);
  gateway.transportReady = true;
  pausedDetail.ownerPid = 999999;
  f.state.db.prepare('UPDATE receipts SET detail=? WHERE id=?').run(JSON.stringify(pausedDetail), pausedReceipt.id);
  const restored = f.state.recoverInterruptedOrdinaryHandoffIntake(binding.channelId, binding);
  assert.equal(restored.state, READINESS.READY);

  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(dispatches, 1);
  assert.equal(f.state.getMessage('101').state, 'replied');
  await gateway.stop();
});

test('Gateway preserves recovered readiness while another binding wake fails', async t => {
  const f = fixture(t);
  const first = ordinary(f, 'ordinary-A', CODEX);
  const second = ordinary(f, 'ordinary-B', CODEX_V7);
  const dispatches = [];
  let replies = 0;
  const channelA = {
    id: first.channelId,
    guildId: 'guild',
    topic: null,
    permissionsFor: () => ({ has: () => true }),
    async send() {
      replies += 1;
      return { id: `reply-${replies}` };
    }
  };
  const client = new EventEmitter();
  client.user = { id: 'bot' };
  client.channels = {
    fetch: async channelId => {
      if (channelId === second.channelId) {
        client.emit('messageCreate', {
          id: 'live-A',
          guildId: 'guild',
          channelId: first.channelId,
          content: 'held while the second binding recovers',
          author: { id: 'operator', bot: false },
          channel: channelA
        });
        throw new Error('second binding unavailable');
      }
      return channelA;
    }
  };
  client.destroy = async () => {};
  const gateway = new DiscordGateway({
    state: f.state,
    client,
    fetchHistory: async () => [],
    providers: {
      codex: {
        async dispatch(message) {
          dispatches.push(message.id);
          return { status: 'submitted' };
        },
        async observe() { return { text: 'answer after paused intake' }; }
      }
    },
    recoveryOptions: {
      ordinaryNativePreflight: async current => ({
        file: path.join(f.dir, `${current.channelId}.jsonl`),
        sessionId: current.nativeId,
        threadId: current.nativeId,
        workspace: current.workspace
      })
    }
  });

  const result = await gateway.beginReconnectRecovery('resume');
  assert.equal(result.ready, false);
  assert.equal(result.state, READINESS.UNAVAILABLE);
  assert.ok(result.error);
  assert.equal(gateway.ready, true);
  assert.equal(f.state.getBinding(first.channelId).readiness, READINESS.READY);
  assert.equal(f.state.getIntakeWatermark(first.channelId).state, READINESS.READY);
  assert.equal(f.state.getBinding(second.channelId).readiness, READINESS.UNAVAILABLE);
  assert.deepEqual(dispatches, ['live-A']);
  assert.equal(f.state.getMessage('live-A').state, 'replied');
  await gateway.stop();
});

test('Gateway reconnect replays binding wakes after reconciliation', async t => {
  const f = fixture(t);
  const calls = [];
  const client = { on() {}, off() {}, async destroy() {} };
  const gateway = new DiscordGateway({
    state: f.state,
    client,
    providers: {},
    onReady: () => calls.push('ready')
  });
  gateway.started = true;
  gateway.recoverTransport = async () => ({ ready: true, state: READINESS.READY });
  gateway.reconcilePending = async () => calls.push('reconcile');
  const result = await gateway.beginReconnectRecovery('shard-ready');
  assert.equal(result.ready, true);
  assert.deepEqual(calls, ['reconcile', 'ready']);
  await gateway.stop();
});

test('Gateway reconnect notifies binding wakes after partial recovery', async t => {
  const f = fixture(t);
  const calls = [];
  const client = { on() {}, off() {}, async destroy() {} };
  const gateway = new DiscordGateway({
    state: f.state,
    client,
    providers: {},
    onReady: () => calls.push('ready')
  });
  gateway.started = true;
  gateway.recoverTransport = async () => ({ ready: false, state: READINESS.UNAVAILABLE });
  gateway.reconcilePending = async () => calls.push('reconcile');
  const result = await gateway.beginReconnectRecovery('shard-ready');
  assert.equal(result.ready, false);
  assert.equal(gateway.transportReady, true);
  assert.deepEqual(calls, ['ready']);
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
    channelId: binding.channelId, provider: PROVIDERS.CODEX, ordinary: true, textFile, dedupeKey: 'ordinary-unknown', fetchImpl: unknownFetch });
  assert.equal(first.status, 'unknown');
  const retry = await runDirectPost({ state: f.state, token: 'fixture', nativeId: CODEX, generation: binding.generation,
    channelId: binding.channelId, provider: PROVIDERS.CODEX, ordinary: true, textFile, dedupeKey: 'ordinary-unknown', fetchImpl: unknownFetch });
  assert.equal(retry.status, 'unknown');
  assert.equal(calls, 1);
  const sentFetch = async () => {
    calls += 1;
    return { ok: true, status: 200, json: async () => ({ id: `sent-${calls}` }) };
  };
  const sent = await runDirectPost({ state: f.state, token: 'fixture', nativeId: CODEX, generation: binding.generation,
    channelId: binding.channelId, provider: PROVIDERS.CODEX, ordinary: true, textFile, dedupeKey: 'ordinary-sent', fetchImpl: sentFetch });
  const duplicate = await runDirectPost({ state: f.state, token: 'fixture', nativeId: CODEX, generation: binding.generation,
    channelId: binding.channelId, provider: PROVIDERS.CODEX, ordinary: true, textFile, dedupeKey: 'ordinary-sent', fetchImpl: sentFetch });
  assert.equal(sent.status, 'sent');
  assert.equal(duplicate.duplicate, true);
  assert.equal(calls, 2);
  f.state.rebind({ channelId: binding.channelId, guildId: 'guild', provider: PROVIDERS.CODEX, nativeId: CODEX,
    workspace: f.dir, ordinaryIdentity: { sessionId: CODEX, threadId: CODEX } });
  await assert.rejects(() => runDirectPost({ state: f.state, token: 'fixture', nativeId: CODEX, generation: binding.generation,
    channelId: binding.channelId, provider: PROVIDERS.CODEX, ordinary: true, textFile, dedupeKey: 'ordinary-stale', fetchImpl: sentFetch }),
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
      f.state.markIntakeBoundary(channelId, READINESS.UNAVAILABLE, 'seed gap', '100', '150');
      f.state.unbind(channelId);
      if (collision) ordinary(f, '223456789012345678', successor);
      const before = {
        binding: f.state.getBinding(channelId), watermark: f.state.getIntakeWatermark(channelId),
        receipts: f.state.listReceipts()
      };
      const channel = {
        id: channelId, guildId: 'guild', name: 'dev', isTextBased: () => true,
        messages: { fetch: async () => new Map([['latest', { id: '200' }]]) },
        async send() { return { id: '200', async delete() {} }; }
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
        : handoffInternal({ ordinary: true, 'state-dir': f.dir, provider: PROVIDERS.CODEX,
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

test('simulated: ordinary binding wake honors the Gateway capability', () => {
  const paths = { stateDir: '/tmp/ordinary-wake', pid: '/tmp/ordinary-wake.pid' };
  const wakeSignals = [];
  const running = { state: 'running', pid: 4242, capabilities: [GATEWAY_CAPABILITIES.ordinaryBindWake] };
  assert.deepEqual(requestGatewayRecovery(paths, {
    status: () => running,
    kill: (pid, signal) => wakeSignals.push({ pid, signal })
  }), { requested: true, pid: 4242, signal: 'SIGUSR2' });
  assert.deepEqual(requestGatewayRecovery(paths, {
    status: () => ({ ...running, capabilities: [] }),
    kill: () => {}
  }), {
    requested: false,
    pid: 4242,
    state: 'running',
    reason: 'gateway-wake-unsupported',
    capability: GATEWAY_CAPABILITIES.ordinaryBindWake
  });
  assert.deepEqual(requestGatewayRecovery(paths, {
    status: () => ({ state: 'stopped' }),
    kill: () => {}
  }), { requested: false, state: 'stopped', reason: 'gateway-not-running' });
  assert.deepEqual(wakeSignals, [{ pid: 4242, signal: 'SIGUSR2' }]);
});

test('healthy intake checkpoint requires durable history and honors cancellation', async t => {
  for (const mode of ['covered', 'missing', 'unrelated-receipt', 'cutoff-rejection', 'cancelled']) {
    await t.test(mode, async t => {
      const f = fixture(t);
      const binding = ordinary(f);
      f.state.recordOrdinaryPreflight(binding, { file: path.join(f.dir, 'session.jsonl'), sessionId: CODEX, threadId: CODEX, workspace: f.dir });
      f.state.setIntakeCutoff(binding.channelId, 'guild', '100', 'checkpoint baseline');
      f.state.markIntakeBoundary(binding.channelId, READINESS.READY, 'fixture ready');
      const event = { id: '101', guildId: 'guild', channelId: binding.channelId, authorId: 'bot', isBot: true, content: 'notice' };
      if (mode === 'covered' || mode === 'cancelled') {
        assert.equal(f.state.acceptDiscordMessage(event).reason, 'bot-source');
      } else if (mode === 'unrelated-receipt') {
        f.state.receipt(null, 'test-note', { discordId: '101' });
      } else if (mode === 'cutoff-rejection') {
        f.state.receipt(null, 'intake-rejected', { discordId: '101', reason: 'before-intake-cutoff' });
      }
      const controller = new AbortController();
      const channel = {
        id: binding.channelId, guildId: 'guild', permissionsFor: () => ({ has: () => true }),
        messages: { fetch: async () => new Map([['101', event]]) }
      };
      const gateway = new DiscordGateway({
        state: f.state,
        client: { user: { id: 'bot' }, on() {}, off() {}, channels: { fetch: async () => channel } },
        fetchHistory: async () => {
          if (mode === 'cancelled') {
            controller.abort();
            await new Promise(resolve => setImmediate(resolve));
          }
          return [event];
        }
      });
      const work = gateway.checkpointHealthyIntake(controller.signal, gateway.lifecycleEpoch);
      if (mode === 'cancelled') await assert.rejects(work, error => error.recoveryKind === 'stopped');
      else await work;
      assert.equal(f.state.getIntakeWatermark(binding.channelId).recovered_through_id, mode === 'covered' ? '101' : '100');
    });
  }
});

test('live intake checkpoints keep sequential traffic within recovery bounds', async t => {
  const f = fixture(t);
  const binding = ordinary(f);
  f.state.recordOrdinaryPreflight(binding, { file: path.join(f.dir, 'session.jsonl'), sessionId: CODEX, threadId: CODEX, workspace: f.dir });
  f.state.setIntakeCutoff(binding.channelId, 'guild', '100', 'checkpoint baseline');
  f.state.markIntakeBoundary(binding.channelId, READINESS.READY, 'fixture ready');
  const history = [];
  const channel = {
    id: binding.channelId, guildId: 'guild', permissionsFor: () => ({ has: () => true }),
    messages: { fetch: async () => new Map(history.slice(-1).map(message => [message.id, message])) }
  };
  const gateway = new DiscordGateway({
    state: f.state,
    client: { user: { id: 'bot' }, on() {}, off() {}, channels: { fetch: async () => channel } },
    fetchHistory: async (_channel, options) => history.filter(message => BigInt(message.id) > BigInt(options.after)).slice(0, options.limit),
    recoveryOptions: { maxMessages: 4 }
  });
  gateway.ready = true;
  for (let id = 101; id <= 106; id += 1) {
    const message = { id: String(id), guildId: 'guild', channelId: binding.channelId, author: { id: 'bot', bot: true }, content: 'notice' };
    history.push(message);
    gateway.boundMessage(message);
    await Promise.all([...gateway.inFlight]);
    await gateway.liveCheckpointPromise;
  }
  assert.equal(f.state.getIntakeWatermark(binding.channelId).recovered_through_id, '106');
  assert.equal(f.state.listMessages().length, 0);
  assert.equal(history.length > gateway.historyMaxMessages, true);
});

test('live intake checkpoints skip unrelated ready bindings when a channel triggers the pass', async t => {
  const f = fixture(t);
  const blocked = ordinary(f, '0-blocked-channel', OTHER);
  const triggered = ordinary(f, '1-triggered-channel', CODEX);
  for (const binding of [blocked, triggered]) {
    f.state.recordOrdinaryPreflight(binding, {
      file: path.join(f.dir, `${binding.channelId}.jsonl`),
      sessionId: binding.nativeId,
      threadId: binding.nativeId,
      workspace: f.dir
    });
    f.state.setIntakeCutoff(binding.channelId, 'guild', '100', 'checkpoint baseline');
    f.state.markIntakeBoundary(binding.channelId, READINESS.READY, 'fixture ready');
  }
  const event = {
    id: '101',
    guildId: 'guild',
    channelId: triggered.channelId,
    authorId: 'bot',
    isBot: true,
    content: 'triggering notice',
    attachments: []
  };
  assert.equal(f.state.acceptDiscordMessage(event).reason, 'bot-source');
  const channels = new Map([blocked, triggered].map(binding => [binding.channelId, {
    id: binding.channelId,
    guildId: 'guild',
    permissionsFor: () => ({ has: () => true }),
    messages: { fetch: async () => new Map([['101', event]]) }
  }]));
  let blockedFetches = 0;
  let gateway;
  gateway = new DiscordGateway({
    state: f.state,
    client: {
      user: { id: 'bot' },
      on() {},
      off() {},
      channels: {
        fetch: async channelId => {
          if (channelId === blocked.channelId) {
            blockedFetches += 1;
            gateway.liveCheckpointController?.abort();
            await new Promise(resolve => setImmediate(resolve));
          }
          return channels.get(channelId);
        }
      }
    },
    fetchHistory: async channel => channel.id === triggered.channelId ? [event] : [],
    recoveryOptions: { maxMessages: 2 }
  });
  gateway.ready = true;
  gateway.noteLiveIntake(event);
  await gateway.liveCheckpointPromise;

  assert.equal(blockedFetches, 0);
  assert.equal(f.state.getIntakeWatermark(triggered.channelId).recovered_through_id, '101');
  assert.equal(f.state.getIntakeWatermark(blocked.channelId).recovered_through_id, '100');
});

test('live intake checkpoints reschedule traffic received during an in-flight checkpoint', async t => {
  const f = fixture(t);
  const binding = ordinary(f);
  f.state.recordOrdinaryPreflight(binding, { file: path.join(f.dir, 'session.jsonl'), sessionId: CODEX, threadId: CODEX, workspace: f.dir });
  f.state.setIntakeCutoff(binding.channelId, 'guild', '100', 'checkpoint baseline');
  f.state.markIntakeBoundary(binding.channelId, READINESS.READY, 'fixture ready');
  const history = [];
  let historyFetches = 0;
  let releaseFirstHistory;
  const firstHistoryReleased = new Promise(resolve => { releaseFirstHistory = resolve; });
  let firstHistoryStarted;
  const firstHistoryStartedPromise = new Promise(resolve => { firstHistoryStarted = resolve; });
  const channel = {
    id: binding.channelId, guildId: 'guild', permissionsFor: () => ({ has: () => true }),
    messages: { fetch: async () => new Map(history.slice(-1).map(message => [message.id, message])) }
  };
  const gateway = new DiscordGateway({
    state: f.state,
    client: { user: { id: 'bot' }, on() {}, off() {}, channels: { fetch: async () => channel } },
    fetchHistory: async (_channel, options) => {
      const page = history.filter(message => BigInt(message.id) > BigInt(options.after)).slice(0, options.limit);
      historyFetches += 1;
      if (historyFetches === 1) {
        firstHistoryStarted();
        await firstHistoryReleased;
      }
      return page;
    },
    recoveryOptions: { maxMessages: 4 }
  });
  gateway.ready = true;
  const send = async id => {
    const message = { id: String(id), guildId: 'guild', channelId: binding.channelId, author: { id: 'bot', bot: true }, content: 'notice' };
    history.push(message);
    gateway.boundMessage(message);
    await Promise.all([...gateway.inFlight]);
  };

  await send(101);
  await send(102);
  const firstCheckpoint = gateway.liveCheckpointPromise;
  assert.ok(firstCheckpoint);
  await firstHistoryStartedPromise;
  await send(103);
  await send(104);
  releaseFirstHistory();
  await firstCheckpoint;
  assert.ok(gateway.liveCheckpointPromise);
  await gateway.liveCheckpointPromise;

  assert.equal(historyFetches >= 2, true);
  assert.equal(f.state.getIntakeWatermark(binding.channelId).recovered_through_id, '104');
});

test('live intake checkpoints retain demand after a failed pass', async t => {
  const f = fixture(t);
  const binding = ordinary(f);
  f.state.recordOrdinaryPreflight(binding, { file: path.join(f.dir, 'session.jsonl'), sessionId: CODEX, threadId: CODEX, workspace: f.dir });
  f.state.setIntakeCutoff(binding.channelId, 'guild', '100', 'checkpoint baseline');
  f.state.markIntakeBoundary(binding.channelId, READINESS.READY, 'fixture ready');
  const history = [];
  let historyFetches = 0;
  const channel = {
    id: binding.channelId, guildId: 'guild', permissionsFor: () => ({ has: () => true }),
    messages: { fetch: async () => new Map(history.slice(-1).map(message => [message.id, message])) }
  };
  const gateway = new DiscordGateway({
    state: f.state,
    client: { user: { id: 'bot' }, on() {}, off() {}, channels: { fetch: async () => channel } },
    fetchHistory: async (_channel, options) => {
      historyFetches += 1;
      if (historyFetches === 1) throw new Error('temporary history failure');
      return history.filter(message => BigInt(message.id) > BigInt(options.after)).slice(0, options.limit);
    },
    recoveryOptions: { maxMessages: 4 }
  });
  gateway.ready = true;
  const send = async id => {
    const message = { id: String(id), guildId: 'guild', channelId: binding.channelId, author: { id: 'bot', bot: true }, content: 'notice' };
    history.push(message);
    gateway.boundMessage(message);
    await Promise.all([...gateway.inFlight]);
  };

  await send(101);
  await send(102);
  const firstCheckpoint = gateway.liveCheckpointPromise;
  assert.ok(firstCheckpoint);
  await firstCheckpoint;
  assert.equal(gateway.liveCheckpointPromise, null);
  assert.equal(gateway.liveIntakeCounts.get(binding.channelId), gateway.liveCheckpointThreshold);

  await send(103);
  const retryCheckpoint = gateway.liveCheckpointPromise;
  assert.ok(retryCheckpoint);
  await retryCheckpoint;

  assert.equal(historyFetches >= 2, true);
  assert.equal(f.state.getIntakeWatermark(binding.channelId).recovered_through_id, '103');
});
