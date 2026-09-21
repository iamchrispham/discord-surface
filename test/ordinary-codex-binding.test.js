const {
  test,
  assert,
  fs,
  os,
  path,
  GATEWAY_CAPABILITIES,
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
  ordinary
} = require('./ordinary-codex-fixture');

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

test('ordinary bind does not wake a replacement Gateway after commit', async t => {
  const f = fixture(t);
  const channel = { id: 'ordinary-channel', guildId: 'guild', name: 'dev', isTextBased: () => true };
  const wakeSignals = [];
  let reads = 0;
  class Client {
    constructor() {
      this.guilds = { fetch: async () => ({ channels: {
        fetch: async selection => selection ? channel : new Map([[channel.id, channel]])
      } }) };
    }
    async login() {}
    async destroy() {}
  }
  const selected = { state: 'running', pid: 4242, capabilities: [GATEWAY_CAPABILITIES.ordinaryBindWake, GATEWAY_CAPABILITIES.runtimeBindLock] };
  const replacement = { state: 'running', pid: 4243, capabilities: [] };
  const result = await ordinaryBind({ 'state-dir': f.dir, channel: '#dev', workspace: f.dir }, {
    environment: {
      CODEX_SESSION_ID: CODEX, CODEX_THREAD_ID: CODEX, PWD: f.dir,
      DISCORD_SURFACE_ORDINARY_CODEX_RUNTIME_PID: String(selected.pid)
    },
    requireInstalled: () => ({ Client, GatewayIntentBits: { Guilds: 1 } }),
    readSecret: () => 'fixture-token',
    validateCodexSessionIdentity: () => ({ file: path.join(f.dir, 'session.jsonl'), sessionId: CODEX, threadId: CODEX, workspace: f.dir }),
    gatewayProcessStatus: () => (++reads < 3 ? selected : replacement),
    killProcess: (pid, signal) => wakeSignals.push({ pid, signal }),
    print: () => {}
  });
  assert.deepEqual(result.gatewayWake, { requested: false, pid: replacement.pid, state: 'running', reason: 'gateway-changed' });
  assert.deepEqual(wakeSignals, []);
  assert.equal(f.state.getBinding(channel.id).readiness, READINESS.PENDING);
});

test('ordinary bind rolls back when Gateway becomes incompatible after history fetch', async t => {
  const f = fixture(t);
  const channel = { id: 'ordinary-channel', guildId: 'guild', name: 'dev', isTextBased: () => true };
  let printed = false;
  let historyFetched = false;
  channel.messages = { fetch: async () => { historyFetched = true; return new Map([['100', { id: '100' }]]); } };
  const beforeReceipts = f.state.listReceipts();
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
    gatewayProcessStatus: () => historyFetched
      ? { state: 'running', pid: 4242, capabilities: [] }
      : { state: 'stopped' },
    print: () => { printed = true; }
  }), /does not support ordinary binding wake/);
  assert.equal(f.state.getBinding(channel.id), null);
  assert.equal(printed, false);
  assert.equal(historyFetched, true);
  assert.equal(f.state.getIntakeWatermark(channel.id), null);
  assert.deepEqual(f.state.listReceipts(), beforeReceipts);
});
