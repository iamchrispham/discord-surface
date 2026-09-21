const {
  test,
  assert,
  fs,
  os,
  path,
  createBindingWakeController,
  GATEWAY_CAPABILITIES,
  ordinaryBind,
  DiscordGateway,
  sessionRoot,
  validateCodexSessionIdentity,
  SurfaceState,
  PROVIDERS,
  READINESS,
  ordinaryBindModule,
  reconcileProofUnavailableIntake,
  CODEX,
  ORDINARY_NATIVE_PROOF_UNAVAILABLE_PREFIX,
  fixture,
  ordinary,
  transcript
} = require('./ordinary-codex-fixture');

test('ordinary bind preserves unrelated terminal intake after native proof recovers', async t => {
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
    assert.equal(state.getBinding('ordinary-recovery-channel').readiness, READINESS.UNAVAILABLE);
    assert.equal(state.getIntakeWatermark('ordinary-recovery-channel').state, READINESS.UNAVAILABLE);
  } finally { state.close(); }
});

test('ordinary bind reopens a proof-related intake gap after native proof recovers', t => {
  const f = fixture(t);
  const binding = ordinary(f);
  f.state.recordOrdinaryPreflight(binding, {
    file: path.join(f.dir, 'session.jsonl'), sessionId: CODEX, threadId: CODEX, workspace: f.dir
  });
  f.state.markIntakeBoundary(binding.channelId, READINESS.GAP,
    'Codex transcript proof unavailable before event write: transcript is unavailable');

  const reopened = reconcileProofUnavailableIntake(f.state, binding, {
    reused: true,
    nativeProofVerified: true,
    nativeProofDetail: { file: path.join(f.dir, 'session.jsonl') },
    nativeProofError: null
  });

  assert.equal(reopened.readiness, READINESS.PENDING);
  assert.equal(f.state.getIntakeWatermark(binding.channelId).state, READINESS.PENDING);
  assert.equal(f.state.listReceipts().filter(receipt => receipt.kind === 'intake-reconcile-requested').length, 1);

  f.state.markIntakeBoundary(binding.channelId, READINESS.GAP, 'unrelated history gap');
  const unchanged = reconcileProofUnavailableIntake(f.state, f.state.getBinding(binding.channelId), {
    reused: true, nativeProofVerified: true, nativeProofDetail: { file: path.join(f.dir, 'session.jsonl') }, nativeProofError: null
  });
  assert.equal(unchanged.readiness, READINESS.GAP);
  assert.equal(f.state.getIntakeWatermark(binding.channelId).state, READINESS.GAP);
});

test('ordinary bind public entrypoints recover only proof-related intake boundaries', async t => {
  for (const [label, bind] of [['cli', ordinaryBind], ['module', ordinaryBindModule]]) {
    await t.test(label, async t => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ordinary-bind-public-${label}-`));
      const db = path.join(dir, 'surface.sqlite');
      const session = transcript(t, dir);
      const setup = new SurfaceState(db);
      setup.setConfig({ operatorId: 'operator', guildId: 'guild', secretFile: path.join(dir, 'discord.env') });
      const binding = setup.bindOrdinary({
        channelId: 'ordinary-public-channel', guildId: 'guild', provider: PROVIDERS.CODEX,
        nativeId: CODEX, workspace: dir, sessionRoot: session.root
      }, { sessionId: CODEX, threadId: CODEX });
      setup.recordOrdinaryPreflight(binding, {
        file: session.file, sessionId: CODEX, threadId: CODEX, workspace: dir
      });
      assert.throws(() => setup.reconcileIntake(binding.channelId, binding), /intake boundary is unknown/);
      setup.close();
      t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

      const channel = {
        id: 'ordinary-public-channel', guildId: 'guild', name: 'dev', isTextBased: () => true
      };
      class FakeClient {
        constructor() {
          this.guilds = { fetch: async () => ({ channels: { fetch: async () => [channel] } }) };
        }
        async login() {}
        async destroy() {}
      }
      const dependencies = {
        environment: { CODEX_SESSION_ID: CODEX, CODEX_THREAD_ID: CODEX, PWD: dir },
        requireInstalled: () => ({ Client: FakeClient, GatewayIntentBits: { Guilds: 1 } }),
        readSecret: () => 'fixture-token',
        validateCodexSessionIdentity: () => ({
          file: session.file, sessionId: CODEX, threadId: CODEX, workspace: dir
        }),
        gatewayProcessStatus: () => ({ state: 'stopped' }),
        print: () => {}
      };
      const args = { 'state-dir': dir, channel: '#dev', workspace: dir, 'session-root': session.root };
      const bindResult = async () => bind(args, dependencies);
      const missing = await bindResult();
      assert.equal(missing.reused, true);
      assert.equal(missing.nativeProof.status, 'verified');
      assert.equal(missing.binding.nativeId, CODEX);
      assert.equal(missing.binding.generation, 1);

      const state = new SurfaceState(db);
      try {
        assert.equal(state.getIntakeWatermark(binding.channelId), null);
        state.markIntakeBoundary(binding.channelId, READINESS.GAP, 'unrelated history gap');
      } finally { state.close(); }
      const unrelated = await bindResult();
      assert.equal(unrelated.binding.readiness, READINESS.GAP);

      const proofUnavailable = new SurfaceState(db);
      try {
        proofUnavailable.markIntakeBoundary(binding.channelId, READINESS.UNAVAILABLE,
          `${ORDINARY_NATIVE_PROOF_UNAVAILABLE_PREFIX} transcript is unavailable`);
      } finally { proofUnavailable.close(); }
      const unavailable = await bindResult();
      assert.equal(unavailable.binding.readiness, READINESS.PENDING);

      const proofGap = new SurfaceState(db);
      try {
        proofGap.markIntakeBoundary(binding.channelId, READINESS.GAP,
          `${ORDINARY_NATIVE_PROOF_UNAVAILABLE_PREFIX} transcript is unavailable`);
      } finally { proofGap.close(); }
      const gap = await bindResult();
      assert.equal(gap.binding.readiness, READINESS.PENDING);

      const finalState = new SurfaceState(db);
      try {
        assert.equal(finalState.getBinding(binding.channelId).generation, 1);
        assert.equal(finalState.getIntakeWatermark(binding.channelId).state, READINESS.PENDING);
        assert.equal(finalState.listReceipts().filter(receipt => receipt.kind === 'intake-reconcile-requested').length, 2);
      } finally { finalState.close(); }
    });
  }
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
