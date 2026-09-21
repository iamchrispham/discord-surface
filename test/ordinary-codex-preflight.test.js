const {
  test,
  assert,
  fs,
  path,
  DiscordGateway,
  sessionRoot,
  validateCodexSessionIdentity,
  PROVIDERS,
  READINESS,
  CODEX,
  CODEX_V7,
  OTHER,
  fixture,
  ordinary,
  transcript
} = require('./ordinary-codex-fixture');

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
  permissions.add(PermissionFlagsBits.ManageThreads);
  assert.equal(gateway.historyPermission(lockedThread, { requireSend: true }).allowed, true);
  permissions.delete(PermissionFlagsBits.ManageThreads);
  permissions.add(PermissionFlagsBits.Administrator);
  assert.equal(gateway.historyPermission(lockedThread, { requireSend: true }).allowed, true);
  permissions.delete(PermissionFlagsBits.Administrator);
});

test('ordinary readiness requires native proof before the intake boundary can become ready', t => {
  const f = fixture(t);
  const binding = ordinary(f);
  assert.throws(() => f.state.markIntakeBoundary(binding.channelId, READINESS.READY, 'history complete', null, null, binding), /preflight/);
  assert.throws(() => f.state.recordOrdinaryPreflight(binding, { file: '/tmp/exact.jsonl', sessionId: OTHER, threadId: OTHER, workspace: f.dir }), /ordinary codex native preflight proof does not match the binding/);
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

test('ordinary Codex bind-time proof failure keeps a reopenable transcript watermark', async t => {
  const f = fixture(t);
  const binding = ordinary(f);
  const channel = { id: binding.channelId, guildId: 'guild' };
  const gateway = new DiscordGateway({
    state: f.state,
    client: { user: { id: 'bot' }, channels: { fetch: async () => channel }, on() {}, off() {}, async destroy() {} },
    providers: { codex: { async dispatch() { throw new Error('must stay held'); } } },
    recoveryOptions: { ordinaryNativePreflight: async () => { throw new Error('transcript unreadable'); } }
  });
  const result = await gateway.recoverTransport('ordinary-bind', 0);
  assert.equal(result.ready, false);
  assert.equal(result.state, READINESS.UNAVAILABLE);
  assert.equal(f.state.getBinding(binding.channelId).readiness, READINESS.UNAVAILABLE);
  assert.match(f.state.getIntakeWatermark(binding.channelId).detail, /^Codex transcript proof unavailable before event write: transcript unreadable/);
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

test('Gateway polls a live handoff owner without recovering unrelated bindings', async t => {
  const f = fixture(t);
  const deferredBinding = ordinary(f, 'ordinary-deferred');
  const healthyBinding = ordinary(f, 'ordinary-healthy', CODEX_V7);
  const healthySession = transcript(t, f.dir, CODEX_V7);
  assert.ok(f.state.pauseOrdinaryHandoffIntake(deferredBinding.channelId, deferredBinding));
  f.state.ordinaryHandoffPauses.clear();
  f.state.ordinaryHandoffPauseSnapshots.clear();
  const secretFile = path.join(f.dir, 'discord.env');
  fs.writeFileSync(secretFile, 'DISCORD_TOKEN=fixture-token\n', { mode: 0o600 });
  const channels = new Map([deferredBinding, healthyBinding].map(binding => [binding.channelId, {
    id: binding.channelId,
    guildId: 'guild',
    topic: null,
    permissionsFor: () => ({ has: () => true })
  }]));
  let historyFetches = 0;
  let preflights = 0;
  const client = {
    user: { id: 'bot' },
    channels: { fetch: async channelId => channels.get(channelId) },
    on() {}, off() {}, async login() {}, async destroy() {}
  };
  const gateway = new DiscordGateway({
    state: f.state,
    client,
    fetchHistory: async () => { historyFetches += 1; return []; },
    providers: { codex: {
      async dispatch() { return { status: 'submitted' }; },
      async observe() { return { text: 'answer' }; }
    } },
    recoveryOptions: {
      ordinaryNativePreflight: async binding => {
        preflights += 1;
        return { file: healthySession.file, sessionId: binding.nativeId, threadId: binding.nativeId, workspace: f.dir };
      }
    }
  });

  await gateway.start(secretFile);
  const startupHistoryFetches = historyFetches;
  const startupPreflights = preflights;
  await new Promise(resolve => setTimeout(resolve, 250));

  assert.equal(historyFetches, startupHistoryFetches);
  assert.equal(preflights, startupPreflights);
  assert.equal(f.state.getIntakeWatermark(deferredBinding.channelId).state, READINESS.PENDING);
  assert.ok(gateway.deferredHandoffRecoveryDelayMs > 100);
  await gateway.stop();
});
