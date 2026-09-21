const {
  test,
  assert,
  Module,
  fs,
  os,
  path,
  GATEWAY_CAPABILITIES,
  handoffInternal,
  requestGatewayRecovery,
  validateCodexSessionIdentity,
  SurfaceState,
  PROVIDERS,
  READINESS,
  THREAD_STATES,
  staticConductorMarker,
  CODEX,
  OTHER,
  fixture,
  ordinary,
  transcript
} = require('./ordinary-codex-fixture');

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

test('public conductor handoff refuses an enrolled child history gap before ownership transfer', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conductor-child-gap-'));
  const db = path.join(dir, 'surface.sqlite');
  const secretFile = path.join(dir, 'discord.secret');
  fs.writeFileSync(secretFile, 'DISCORD_TOKEN=fixture-token\n', { mode: 0o600 });
  const setup = new SurfaceState(db);
  setup.setConfig({ operatorId: 'operator', guildId: 'guild', secretFile, codexCategoryId: 'codex-category' });
  const original = setup.bind({
    channelId: 'conductor-channel', guildId: 'guild', provider: PROVIDERS.CODEX, nativeId: CODEX,
    workspace: dir, categoryId: 'codex-category', conductorId: 'conductor', repoKey: 'repo'
  });
  setup.enrollThread({ threadId: 'child', parentChannelId: original.channelId, guildId: original.guildId }, original);
  setup.setThreadBaseline('child', '100', original);
  setup.markThreadBoundary('child', THREAD_STATES.READY, 'fixture adoption', null, null, original);
  setup.setIntakeCutoff(original.channelId, 'guild', '100', 'fixture parent coverage');
  setup.markIntakeBoundary(original.channelId, READINESS.READY, 'fixture parent ready', null, null, original);
  setup.close();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const parent = {
    id: original.channelId,
    parentId: 'codex-category',
    topic: staticConductorMarker({ provider: PROVIDERS.CODEX, conductorId: 'conductor', repoKey: 'repo' }),
    messages: { fetch: async () => new Map([['fence', { id: '150' }]]) },
    send: async () => ({ id: '150', async delete() {} })
  };
  const child = {
    id: 'child',
    messages: { fetch: async () => new Map([['missing', { id: '120' }]]) }
  };
  const discord = {
    GatewayIntentBits: { Guilds: 1 },
    Client: class {
      constructor() {
        this.guilds = { fetch: async () => ({ channels: { fetch: async () => parent } }) };
        this.channels = { fetch: async id => id === child.id ? child : parent };
      }
      async login() {}
      async destroy() {}
    }
  };
  const originalLoad = Module._load;
  t.mock.method(Module, '_load', function(request, parentModule, isMain) {
    if (request === 'discord.js') return discord;
    return originalLoad.call(this, request, parentModule, isMain);
  });

  await assert.rejects(() => handoffInternal({
    'state-dir': dir, provider: PROVIDERS.CODEX, 'channel-id': original.channelId,
    'conductor-id': 'conductor', 'repo-key': 'repo', 'from-native-id': CODEX,
    'from-generation': '1', 'native-id': OTHER, workspace: dir, 'handoff-id': 'conductor-child-gap'
  }), /durably drained/);

  const recovered = new SurfaceState(db);
  try {
    const binding = recovered.getBinding(original.channelId);
    assert.equal(binding.nativeId, CODEX);
    assert.equal(binding.generation, 1);
    assert.equal(recovered.getThreadEnrollment(child.id).active, true);
    assert.equal(recovered.getThreadEnrollment(child.id).recoveredThroughId, '100');
  } finally {
    recovered.close();
  }
});

test('public conductor handoff rejects enrollment added between proof and commit', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conductor-enrollment-race-'));
  const db = path.join(dir, 'surface.sqlite');
  const secretFile = path.join(dir, 'discord.secret');
  fs.writeFileSync(secretFile, 'DISCORD_TOKEN=fixture-token\n', { mode: 0o600 });
  const setup = new SurfaceState(db);
  setup.setConfig({ operatorId: 'operator', guildId: 'guild', secretFile, codexCategoryId: 'codex-category' });
  const original = setup.bind({
    channelId: 'conductor-race-channel', guildId: 'guild', provider: PROVIDERS.CODEX, nativeId: CODEX,
    workspace: dir, categoryId: 'codex-category', conductorId: 'conductor', repoKey: 'repo'
  });
  setup.enrollThread({ threadId: 'child-a', parentChannelId: original.channelId, guildId: original.guildId }, original);
  setup.setThreadBaseline('child-a', '100', original);
  setup.markThreadBoundary('child-a', THREAD_STATES.READY, 'fixture adoption', null, null, original);
  setup.setIntakeCutoff(original.channelId, 'guild', '100', 'fixture parent coverage');
  setup.markIntakeBoundary(original.channelId, READINESS.READY, 'fixture parent ready', null, null, original);
  setup.close();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const parent = {
    id: original.channelId,
    parentId: 'codex-category',
    topic: staticConductorMarker({ provider: PROVIDERS.CODEX, conductorId: 'conductor', repoKey: 'repo' }),
    messages: { fetch: async () => new Map([['fence', { id: '150' }]]) },
    send: async () => ({ id: '150', async delete() {} })
  };
  const child = {
    id: 'child-a',
    messages: { fetch: async () => new Map([['fence', { id: '150' }]]) }
  };
  const discord = {
    GatewayIntentBits: { Guilds: 1 },
    Client: class {
      constructor() {
        this.guilds = { fetch: async () => ({ channels: { fetch: async () => parent } }) };
        this.channels = { fetch: async id => id === child.id ? child : parent };
      }
      async login() {}
      async destroy() {}
    }
  };
  const originalLoad = Module._load;
  t.mock.method(Module, '_load', function(request, parentModule, isMain) {
    if (request === 'discord.js') return discord;
    return originalLoad.call(this, request, parentModule, isMain);
  });

  const originalHandoffConductor = SurfaceState.prototype.handoffConductor;
  let inserted = false;
  t.mock.method(SurfaceState.prototype, 'handoffConductor', function(input) {
    if (!inserted) {
      inserted = true;
      const raceState = new SurfaceState(db);
      try {
        const binding = raceState.getBinding(input.channelId);
        raceState.enrollThread({ threadId: 'child-b', parentChannelId: input.channelId, guildId: 'guild' }, binding);
      } finally {
        raceState.close();
      }
    }
    return originalHandoffConductor.call(this, input);
  });

  await assert.rejects(() => handoffInternal({
    'state-dir': dir, provider: PROVIDERS.CODEX, 'channel-id': original.channelId,
    'conductor-id': 'conductor', 'repo-key': 'repo', 'from-native-id': CODEX,
    'from-generation': '1', 'native-id': OTHER, workspace: dir, 'handoff-id': 'conductor-enrollment-race'
  }), /active thread enrollments changed during handoff proof/);

  const recovered = new SurfaceState(db);
  try {
    const binding = recovered.getBinding(original.channelId);
    assert.equal(binding.nativeId, CODEX);
    assert.equal(binding.generation, 1);
    assert.equal(recovered.getThreadEnrollment('child-a').recoveredThroughId, '100');
    assert.equal(recovered.getThreadEnrollment('child-b').active, true);
    assert.equal(recovered.getThreadEnrollment('child-b').recoveredThroughId, null);
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
