const {
  test,
  assert,
  fs,
  os,
  path,
  ordinaryBindingDecision,
  GATEWAY_CAPABILITIES,
  handoffInternal,
  requestGatewayRecovery,
  unbind,
  DiscordGateway,
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
  assert.equal(f.state.hasIntakeEvidence('sent-message'), true);
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
  let wakeExpectedPid;
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
      wakeExpectedPid = options.expectedPid;
      const runtime = options.status(_paths);
      options.kill(runtime.pid, 'SIGUSR2');
      return { requested: true, pid: runtime.pid, signal: 'SIGUSR2' };
    },
    gatewayProcessStatus: () => ({ state: 'running', pid: 4242, capabilities: [GATEWAY_CAPABILITIES.ordinaryBindWake, GATEWAY_CAPABILITIES.runtimeBindLock] }),
    killProcess: (pid, signal) => wakeSignals.push({ pid, signal }),
    print: value => output.push(value)
  });
  assert.equal(result.binding.generation, 2);
  assert.equal(result.binding.nativeId, OTHER);
  assert.equal(result.binding.readiness, READINESS.PENDING);
  assert.deepEqual(proofArguments, [OTHER, successorWorkspace, session.root]);
  assert.deepEqual(wakeSignals, [{ pid: 4242, signal: 'SIGUSR2' }]);
  assert.equal(wakeExpectedPid, 4242);
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
