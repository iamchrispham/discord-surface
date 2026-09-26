const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const installed = path.resolve(__dirname, '..');
const test = require('node:test');
const { SurfaceState } = require(path.join(installed, 'src/state'));
const { DiscordGateway } = require(path.join(installed, 'src/discord'));
const { recordNativeAcknowledgment } = require(path.join(installed, 'src/acknowledgment'));
const { validateCodexSessionIdentityAsync } = require(path.join(installed, 'src/native'));
const { NATIVE_PROOF_PHASES, nativeProofDeadlineDetail } = require(path.join(installed, 'src/discord/native-proof-recovery'));

test('stopping before-binding recovery during shared deadline preserves custody across restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-proof-shared-interrupted-'));
  const root = path.join(dir, 'sessions');
  const db = path.join(dir, 'surface.sqlite');
  const ids = ['66666666-6666-4666-8666-666666666666', '77777777-7777-4777-8777-777777777777'];
  const channels = ['1000', '2000'];
  fs.mkdirSync(root);
  for (const id of ids) {
    fs.writeFileSync(path.join(root, `${id}.jsonl`), JSON.stringify({ type: 'session_meta', payload: { id, cwd: dir } }) + '\n');
  }
  let state = new SurfaceState(db);
  let gateway;
  const timers = new Set();
  const preflights = [];
  let slowFirstPreflight = true;
  let resolveOpenStarted;
  const openStarted = new Promise(resolve => { resolveOpenStarted = resolve; });
  let resolveBeforeBinding;
  const beforeBindingStarted = new Promise(resolve => { resolveBeforeBinding = resolve; });
  let releaseBeforeBinding;
  const beforeBindingGate = new Promise(resolve => { releaseBeforeBinding = resolve; });
  const makeGateway = () => new DiscordGateway({
    state,
    client: {
      user: { id: 'bot' },
      channels: { fetch: async id => ({ id, guildId: 'guild', topic: null, permissionsFor: () => ({ has: () => true }) }) },
      on() {}, off() {}, async destroy() {}
    },
    fetchHistory: async (channel, options) => {
      const id = channel.id === '1000' ? '101' : '102';
      return BigInt(options.after || '0') < BigInt(id)
        ? [{ id, channelId: channel.id, guildId: 'guild', content: 'retained instruction', author: { id: 'operator', bot: false }, channel }]
        : [];
    },
    providers: { codex: { async dispatch() { throw new Error('interrupted recovery must not dispatch'); } } },
    recoveryOptions: {
      timeoutMs: 1000,
      ordinaryNativePreflight: async (binding, options) => {
        preflights.push(binding.channelId);
        if (binding.channelId !== '1000' || !slowFirstPreflight) {
          return validateCodexSessionIdentityAsync(binding.nativeId, binding.workspace, root, options);
        }
        slowFirstPreflight = false;
        const originalOpen = fs.promises.open;
        fs.promises.open = async (...args) => {
          resolveOpenStarted();
          const opening = originalOpen(...args);
          await new Promise(resolve => {
            const timer = setTimeout(() => { timers.delete(timer); resolve(); }, 1100);
            timers.add(timer);
          });
          return opening;
        };
        try {
          return await validateCodexSessionIdentityAsync(binding.nativeId, binding.workspace, root, options);
        } finally {
          fs.promises.open = originalOpen;
        }
      }
    }
  });
  try {
    state.setConfig({ operatorId: 'operator', guildId: 'guild', secretFile: path.join(dir, 'unused') });
    for (let i = 0; i < channels.length; i++) {
      state.bindOrdinary({ channelId: channels[i], guildId: 'guild', provider: 'codex', nativeId: ids[i], workspace: dir },
        { sessionId: ids[i], threadId: ids[i] });
      state.setIntakeBaseline(channels[i], '100', 'fixture baseline');
      assert.equal(state.acceptDiscordMessage({ id: String(101 + i), channelId: channels[i], guildId: 'guild',
        authorId: 'operator', isBot: false, content: 'retained instruction' }, { ready: false }).accepted, true);
    }
    gateway = makeGateway();
    const originalRecordBoundary = gateway.recordBoundary.bind(gateway);
    gateway.recordBoundary = async (...args) => {
      const [binding, , boundaryState, detail] = args;
      const beforeBindingMarker = String(detail).startsWith('Native proof recovery v1:') &&
        String(detail).includes('"phase":"before-binding"');
      if (binding.channelId === '2000' && boundaryState === 'unavailable' && beforeBindingMarker) {
        resolveBeforeBinding();
        await beforeBindingGate;
      }
      return originalRecordBoundary(...args);
    };
    const recovery = gateway.recoverTransport('reconnect', gateway.lifecycleEpoch);
    await openStarted;
    await beforeBindingStarted;
    const stopping = gateway.stop();
    releaseBeforeBinding();
    await stopping;
    const stopped = await recovery;
    assert.equal(stopped.ready, false);
    assert.equal(stopped.state, 'stopped');
    assert.equal(state.getMessage('101').state, 'accepted');
    assert.equal(state.getMessage('102').state, 'accepted');
    state.close();
    state = new SurfaceState(db);
    gateway = makeGateway();
    const reopened = await gateway.recoverTransport('reconnect', gateway.lifecycleEpoch);
    assert.equal(reopened.ready, true);
    assert.equal(state.getIntakeWatermark('1000').state, 'ready');
    assert.equal(state.getIntakeWatermark('1000').recovered_through_id, '101');
    assert.equal(state.getIntakeWatermark('2000').state, 'ready');
    assert.equal(state.getIntakeWatermark('2000').recovered_through_id, '102');
    assert.equal(state.getMessage('101').state, 'accepted');
    assert.equal(state.getMessage('102').state, 'accepted');
    assert.deepEqual(preflights.slice(-2), channels);
  } finally {
    releaseBeforeBinding?.();
    if (gateway) await gateway.stop();
    for (const timer of timers) clearTimeout(timer);
    state.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('stopping native preflight deadline marker creation preserves custody across restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-proof-interrupted-retry-'));
  const root = path.join(dir, 'sessions');
  const db = path.join(dir, 'surface.sqlite');
  const secret = path.join(dir, 'discord.env');
  const nativeId = '33333333-3333-4333-8333-333333333333';
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, `${nativeId}.jsonl`), JSON.stringify({ type: 'session_meta', payload: { id: nativeId, cwd: dir } }) + '\n');
  fs.writeFileSync(secret, 'DISCORD_TOKEN=fixture-token\n', { mode: 0o600 });
  let state = new SurfaceState(db);
  let gateway;
  let forcePreflightDeadline = true;
  let resolveBoundaryStarted;
  let releaseBoundary;
  const boundaryStarted = new Promise(resolve => { resolveBoundaryStarted = resolve; });
  const boundaryGate = new Promise(resolve => { releaseBoundary = resolve; });
  let preflightDeadlineObserved = false;
  let dispatches = 0;
  const replies = [];
  const channel = { id: '1000', guildId: 'guild', topic: null, permissionsFor: () => ({ has: () => true }),
    messages: { async fetch() { return { async react() {} }; } },
    async send(body) { replies.push(body); return { id: 'reply-101' }; } };
  const makeGateway = () => new DiscordGateway({ state,
    client: {
      user: { id: 'bot' }, channels: { fetch: async () => channel },
      application: { commands: { async fetch() { return []; }, async create() {} } },
      async login() {}, on() {}, off() {}, async destroy() {}
    },
    fetchHistory: async (_channel, options) => BigInt(options.after || '0') < 101n
      ? [{ id: '101', channelId: '1000', guildId: 'guild', content: 'retained instruction', author: { id: 'operator', bot: false }, channel }]
      : [],
    providers: { codex: {
      async dispatch(message) {
        dispatches++;
        recordNativeAcknowledgment(state, { messageId: message.id, provider: 'codex', nativeId, generation: message.generation });
        return { status: 'submitted' };
      },
      async observe() { return { text: 'recovered answer' }; }
    } },
    recoveryOptions: { ordinaryNativePreflight: async (binding, options) => {
      if (forcePreflightDeadline) {
        try {
          return await validateCodexSessionIdentityAsync(binding.nativeId, binding.workspace, root,
            { ...options, deadline: Date.now() - 1 });
        } catch (error) {
          preflightDeadlineObserved = true;
          throw error;
        }
      }
      return validateCodexSessionIdentityAsync(binding.nativeId, binding.workspace, root, options);
    } }
  });
  try {
    state.setConfig({ operatorId: 'operator', guildId: 'guild', secretFile: secret });
    const binding = state.bindOrdinary({ channelId: '1000', guildId: 'guild', provider: 'codex', nativeId, workspace: dir },
      { sessionId: nativeId, threadId: nativeId });
    state.setIntakeBaseline('1000', '100', 'fixture baseline');
    assert.equal(state.acceptDiscordMessage({ id: '101', channelId: '1000', guildId: 'guild', authorId: 'operator', isBot: false,
      content: 'retained instruction' }, { ready: false }).accepted, true);
    gateway = makeGateway();
    const originalRecordBoundary = gateway.recordBoundary.bind(gateway);
    gateway.recordBoundary = async (...args) => {
      const [, , boundaryState, detail] = args;
      const preflightMarker = String(detail).startsWith('Native proof recovery v1:') &&
        String(detail).includes('"phase":"preflight"');
      if (forcePreflightDeadline && boundaryState === 'unavailable' && preflightMarker) {
        resolveBoundaryStarted();
        await boundaryGate;
      }
      return originalRecordBoundary(...args);
    };
    const recovery = gateway.recoverTransport('reconnect', gateway.lifecycleEpoch);
    await boundaryStarted;
    assert.equal(preflightDeadlineObserved, true);
    const stopping = gateway.stop();
    releaseBoundary();
    const stopped = await recovery;
    await stopping;
    assert.equal(stopped.ready, false);
    assert.equal(stopped.state, 'stopped');
    assert.equal(state.getMessage('101').state, 'accepted');

    state.close();
    state = new SurfaceState(db);
    forcePreflightDeadline = false;
    gateway = makeGateway();
    await gateway.start(secret);
    await gateway.reconcilePending();
    await gateway.consumer.waitForNativeWork();
    assert.equal(state.getIntakeWatermark('1000').state, 'ready');
    assert.equal(state.getIntakeWatermark('1000').recovered_through_id, '101');
    assert.equal(state.getMessage('101').state, 'replied');
    assert.equal(dispatches, 1);
    assert.equal(replies.filter(row => row.content === 'recovered answer').length, 1);
    assert.equal(state.getBinding('1000').generation, binding.generation);
  } finally {
    releaseBoundary?.();
    if (gateway) await gateway.stop();
    state.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
