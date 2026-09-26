const {
  test,
  assert,
  EventEmitter,
  fs,
  os,
  path,
  GATEWAY_CAPABILITIES,
  handoffInternal,
  ordinaryBind,
  requestGatewayRecovery,
  unbind,
  DiscordGateway,
  CodexProvider,
  validateCodexSessionIdentity,
  validateCodexSessionIdentityAsync,
  PROVIDERS,
  READINESS,
  StaleGenerationError,
  runDirectPost,
  CODEX,
  CODEX_V7,
  OTHER,
  fixture,
  ordinary,
  transcript
} = require('./ordinary-codex-fixture');

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
    messages: { fetch: async () => ({ react: async () => {} }) },
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
  await gateway.consumer.waitForNativeWork();
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
  const beforeRebind = f.state.getBinding(binding.channelId);
  assert.throws(() => f.state.rebind({ channelId: binding.channelId, guildId: 'guild', provider: PROVIDERS.CODEX, nativeId: CODEX, workspace: f.dir, ordinaryIdentity: { sessionId: CODEX, threadId: CODEX } }), /publication is unresolved/, 'an unknown outcome still holds binding retirement');
  const afterRebind = f.state.getBinding(binding.channelId);
  assert.deepEqual(afterRebind, beforeRebind, 'refused rebind must leave binding state untouched');
  const heldAttempt = f.state.directPostRows('ordinary-unknown').find(row => row.kind === 'direct-post-attempt');
  f.state.reconcileDirectPostOutcome('ordinary-unknown', heldAttempt.detail.attemptId, 'not_sent', { reason: 'fixture reconciliation' });
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

test('async identity discovery rejects an unreadable matching sibling', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinary-incomplete-'));
  const root = path.join(dir, 'sessions');
  fs.mkdirSync(root);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, `valid-${CODEX}.jsonl`), JSON.stringify({
    type: 'session_meta', payload: { session_id: CODEX, id: CODEX, cwd: root }
  }) + '\n');
  const broken = path.join(root, `unreadable-${CODEX}.jsonl`);
  fs.writeFileSync(broken, '{}\n');
  const open = fs.promises.open;
  t.mock.method(fs.promises, 'open', async (file, ...args) => {
    if (String(file) === broken) throw Object.assign(new Error('fixture unreadable'), { code: 'EACCES' });
    return open.call(fs.promises, file, ...args);
  });
  await assert.rejects(
    () => validateCodexSessionIdentityAsync(CODEX, undefined, root),
    /Codex transcript identity is unavailable/
  );
});

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
