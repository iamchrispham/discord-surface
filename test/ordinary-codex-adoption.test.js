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
const { ChannelType } = require('discord.js');

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

test('ready completion wake does not demote an unrelated healthy route', { timeout: 5000 }, async t => {
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

function observeReadiness(f, t) {
  const changes = [];
  const original = f.state.setBindingReadiness.bind(f.state);
  t.mock.method(f.state, 'setBindingReadiness', (...args) => {
    changes.push({ channelId: args[0], readiness: args[1] });
    return original(...args);
  });
  return changes;
}

function completionWake(f) {
  return createBindingWakeController({
    getGateway: () => f.gateway,
    isReady: () => f.gateway.ready,
    isTransportReady: () => f.gateway.transportReady,
    isStopping: () => f.gateway.stopping
  });
}

test('ordinary-bind wake recovers a pending child without touching its ready parent', { timeout: 5000 }, async t => {
  const f = recoveryFixture(t);
  f.gateway.ready = true;
  f.gateway.transportReady = true;
  f.state.markThreadBoundary('2000', 'pending', 'fixture pending child');
  const changes = observeReadiness(f, t);
  const wake = completionWake(f);
  wake.request();
  await wake.wait();
  assert.equal(f.state.getThreadEnrollment('2000').state, 'ready');
  assert.ok(f.calls.some(call => call.id === '2000' && call.kind === 'history'),
    'the pending child must be recovered');
  assert.equal(f.calls.some(call => call.id === '1000'), false,
    'the ready parent must not be re-fetched by a completion wake');
  assert.equal(changes.some(change => change.channelId === '1000'), false,
    'the ready parent must not be demoted by a completion wake');
  assert.equal(f.state.getBinding('1000').readiness, 'ready');
});

test('ordinary-bind wake recovers only a pending second parent beside ready parent and child', { timeout: 5000 }, async t => {
  const f = recoveryFixture(t);
  f.gateway.ready = true;
  f.gateway.transportReady = true;
  const secondParent = {
    id: '3000', guildId: 'guild', type: ChannelType.GuildText, parentId: null, isThread: () => false,
    permissionsFor: () => ({ has: () => true }),
    async send() { return { id: 'reply-3000' }; },
    messages: { async fetch() { return { async react() {} }; } }
  };
  f.channels.set('3000', secondParent);
  f.history.set('3000', []);
  f.state.bind({
    channelId: '3000', guildId: 'guild', provider: PROVIDERS.CODEX,
    nativeId: '22222222-2222-2222-2222-222222222222', workspace: f.state.getBinding('1000').workspace,
    readiness: 'pending'
  }, { intakeCutoff: '100' });
  f.state.setIntakeBaseline('3000', '100', 'fixture second parent');
  const changes = observeReadiness(f, t);
  const wake = completionWake(f);
  wake.request();
  await wake.wait();
  assert.equal(f.state.getBinding('3000').readiness, 'ready');
  assert.equal(f.state.getIntakeWatermark('3000').state, 'ready');
  assert.ok(f.calls.some(call => call.id === '3000' && call.kind === 'history'),
    'the pending second parent must be recovered');
  assert.equal(f.calls.some(call => call.id === '1000'), false,
    'the ready first parent must not be re-fetched');
  assert.equal(f.calls.some(call => call.id === '2000'), false,
    'the ready enrolled child must not be re-fetched');
  assert.deepEqual(changes, [{ channelId: '3000', readiness: 'recovering' }]);
});

test('startup recovery still performs a full fresh pass over ready routes', { timeout: 5000 }, async t => {
  const f = recoveryFixture(t);
  f.gateway.ready = true;
  f.gateway.transportReady = true;
  const wake = completionWake(f);
  wake.request();
  await wake.wait();
  assert.deepEqual(f.calls, [], 'a completion wake must not re-fetch already-ready routes');
  const result = await f.gateway.recoverTransport('startup');
  assert.equal(result.ready, true);
  assert.ok(f.calls.some(call => call.id === '1000' && call.kind === 'history'),
    'startup must refresh the ready parent');
  assert.ok(f.calls.some(call => call.id === '2000' && call.kind === 'history'),
    'startup must refresh the ready enrolled child');
});

test('reconnect recovery still performs a full fresh pass over ready routes', { timeout: 5000 }, async t => {
  const f = recoveryFixture(t);
  f.gateway.ready = true;
  f.gateway.transportReady = true;
  await f.reopen();
  const result = await f.gateway.recoverTransport('reconnect');
  assert.equal(result.ready, true);
  assert.ok(f.calls.some(call => call.id === '1000' && call.kind === 'history'),
    'reconnect must refresh the ready parent');
  assert.ok(f.calls.some(call => call.id === '2000' && call.kind === 'history'),
    'reconnect must refresh the ready enrolled child');
  assert.equal(f.state.getBinding('1000').readiness, 'ready');
  assert.equal(f.state.getThreadEnrollment('2000').state, 'ready');
});

test('explicit ordinary-bind scope still recovers an already-ready parent', { timeout: 5000 }, async t => {
  const f = recoveryFixture(t);
  f.gateway.ready = true;
  f.gateway.transportReady = true;
  const changes = observeReadiness(f, t);
  const result = await f.gateway.recoverTransport('ordinary-bind', f.gateway.lifecycleEpoch, new Set(['1000']));
  assert.equal(result.ready, true);
  assert.ok(f.calls.some(call => call.id === '1000' && call.kind === 'history'),
    'an explicit scope must still recover the ready parent');
  assert.ok(changes.some(change => change.channelId === '1000' && change.readiness === 'recovering'),
    'an explicit scope must re-run the readiness transition');
  assert.equal(f.state.getBinding('1000').readiness, 'ready');
});

test('ordinary-bind wake recovers a ready parent whose watermark is unknown', { timeout: 5000 }, async t => {
  const f = recoveryFixture(t);
  f.gateway.ready = true;
  f.gateway.transportReady = true;
  f.state.db.prepare('DELETE FROM intake_watermarks WHERE channel_id=?').run('1000');
  assert.equal(f.state.getIntakeWatermark('1000'), null);
  const changes = observeReadiness(f, t);
  const wake = completionWake(f);
  wake.request();
  await wake.wait();
  assert.ok(f.calls.some(call => call.id === '1000' && call.kind === 'channel'),
    'an unknown watermark must still be selected for recovery');
  assert.ok(changes.some(change => change.channelId === '1000' && change.readiness === 'recovering'),
    'an unknown watermark must re-run the readiness transition');
  assert.equal(f.state.getIntakeWatermark('1000').state, 'pending',
    'an unknown watermark without a qualified cursor must be held pending, not silently ready');
  assert.equal(f.calls.some(call => call.id === '2000'), false,
    'the ready enrolled child must not be re-fetched once its parent is held');
});
