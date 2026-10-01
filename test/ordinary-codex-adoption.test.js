const {
  test,
  assert,
  fs,
  os,
  path,
  createBindingWakeController,
  handoffInternal,
  ordinaryBind,
  unbind,
  sessionRoot,
  validateCodexSessionIdentity,
  SurfaceState,
  PROVIDERS,
  READINESS,
  CODEX,
  OTHER,
  fixture,
  ordinary,
  transcript
} = require('./ordinary-codex-fixture');
const { fixture: recoveryFixture } = require('./helpers/intake-recovery-fixture');

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
  }, { sessionId: CODEX, threadId: CODEX }, '100');
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
  }, f.identity, '100');
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
  }, { sessionId: CODEX, threadId: CODEX }, '100');
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
    codexSessionRoot: () => path.join(dir, 'sessions'),
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

test('ready completion wake does not demote an unrelated healthy route', { timeout: 5000, todo: 'issue #195: completion wake demotes a healthy route' }, async t => {
  const f = recoveryFixture(t);
  f.gateway.ready = true;
  f.gateway.transportReady = true;
  const changes = [];
  const original = f.state.setBindingReadiness.bind(f.state);
  t.mock.method(f.state, 'setBindingReadiness', (...args) => {
    changes.push({ channelId: args[0], readiness: args[1] });
    return original(...args);
  });
  const wake = createBindingWakeController({
    getGateway: () => f.gateway,
    isReady: () => f.gateway.ready,
    isTransportReady: () => f.gateway.transportReady,
    isStopping: () => f.gateway.stopping
  });
  wake.request();
  await wake.wait();
  assert.equal(f.state.getBinding('1000').readiness, 'ready');
  assert.equal(f.boundary('2000').state, 'ready');
  assert.equal(changes.some(change => change.channelId === '1000' && change.readiness === 'recovering'), false,
    'completion-only wake must not temporarily hold a healthy route');
});

test('a pending route is still recovered by the public binding wake', { timeout: 5000 }, async t => {
  const f = recoveryFixture(t);
  f.gateway.ready = true;
  f.gateway.transportReady = true;
  f.state.setBindingReadiness('1000', 'pending', 'fixture pending', f.state.getBinding('1000'));
  const wake = createBindingWakeController({
    getGateway: () => f.gateway,
    isReady: () => f.gateway.ready,
    isTransportReady: () => f.gateway.transportReady,
    isStopping: () => f.gateway.stopping
  });
  wake.request();
  await wake.wait();
  assert.equal(f.state.getBinding('1000').readiness, 'ready');
  assert.equal(f.boundary('2000').state, 'ready');
  assert.ok(f.calls.some(call => call.id === '1000' && call.kind === 'history'));
});
