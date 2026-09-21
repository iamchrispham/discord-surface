const {
  test,
  assert,
  fs,
  os,
  path,
  GATEWAY_CAPABILITIES,
  requestGatewayRecovery,
  unbind,
  sessionRoot,
  SurfaceState,
  PROVIDERS,
  READINESS,
  CODEX,
  OTHER,
  fixture,
  ordinary
} = require('./ordinary-codex-fixture');

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
