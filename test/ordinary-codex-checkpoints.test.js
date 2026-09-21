const {
  test,
  assert,
  path,
  DiscordGateway,
  sessionRoot,
  PROVIDERS,
  READINESS,
  CODEX,
  OTHER,
  fixture,
  ordinary,
  transcript
} = require('./ordinary-codex-fixture');

test('healthy intake checkpoint requires durable history and honors cancellation', async t => {
  for (const mode of ['covered', 'missing', 'unrelated-receipt', 'cutoff-rejection', 'cancelled']) {
    await t.test(mode, async t => {
      const f = fixture(t);
      const binding = ordinary(f);
      f.state.recordOrdinaryPreflight(binding, { file: path.join(f.dir, 'session.jsonl'), sessionId: CODEX, threadId: CODEX, workspace: f.dir });
      f.state.setIntakeCutoff(binding.channelId, 'guild', '100', 'checkpoint baseline');
      f.state.markIntakeBoundary(binding.channelId, READINESS.READY, 'fixture ready');
      const event = { id: '101', guildId: 'guild', channelId: binding.channelId, authorId: 'bot', isBot: true, content: 'notice' };
      if (mode === 'covered' || mode === 'cancelled') {
        assert.equal(f.state.acceptDiscordMessage(event).reason, 'bot-source');
      } else if (mode === 'unrelated-receipt') {
        f.state.receipt(null, 'test-note', { discordId: '101' });
      } else if (mode === 'cutoff-rejection') {
        f.state.receipt(null, 'intake-rejected', { discordId: '101', reason: 'before-intake-cutoff' });
      }
      const controller = new AbortController();
      const channel = {
        id: binding.channelId, guildId: 'guild', permissionsFor: () => ({ has: () => true }),
        messages: { fetch: async () => new Map([['101', event]]) }
      };
      const gateway = new DiscordGateway({
        state: f.state,
        client: { user: { id: 'bot' }, on() {}, off() {}, channels: { fetch: async () => channel } },
        fetchHistory: async () => {
          if (mode === 'cancelled') {
            controller.abort();
            await new Promise(resolve => setImmediate(resolve));
          }
          return [event];
        }
      });
      const work = gateway.checkpointHealthyIntake(controller.signal, gateway.lifecycleEpoch);
      if (mode === 'cancelled') await assert.rejects(work, error => error.recoveryKind === 'stopped');
      else await work;
      assert.equal(f.state.getIntakeWatermark(binding.channelId).recovered_through_id, mode === 'covered' ? '101' : '100');
    });
  }
});

test('live intake checkpoints keep sequential traffic within recovery bounds', async t => {
  const f = fixture(t);
  const binding = ordinary(f);
  f.state.recordOrdinaryPreflight(binding, { file: path.join(f.dir, 'session.jsonl'), sessionId: CODEX, threadId: CODEX, workspace: f.dir });
  f.state.setIntakeCutoff(binding.channelId, 'guild', '100', 'checkpoint baseline');
  f.state.markIntakeBoundary(binding.channelId, READINESS.READY, 'fixture ready');
  const history = [];
  const channel = {
    id: binding.channelId, guildId: 'guild', permissionsFor: () => ({ has: () => true }),
    messages: { fetch: async () => new Map(history.slice(-1).map(message => [message.id, message])) }
  };
  const gateway = new DiscordGateway({
    state: f.state,
    client: { user: { id: 'bot' }, on() {}, off() {}, channels: { fetch: async () => channel } },
    fetchHistory: async (_channel, options) => history.filter(message => BigInt(message.id) > BigInt(options.after)).slice(0, options.limit),
    recoveryOptions: { maxMessages: 4 }
  });
  gateway.ready = true;
  for (let id = 101; id <= 106; id += 1) {
    const message = { id: String(id), guildId: 'guild', channelId: binding.channelId, author: { id: 'bot', bot: true }, content: 'notice' };
    history.push(message);
    gateway.boundMessage(message);
    await Promise.all([...gateway.inFlight]);
    await gateway.liveCheckpointPromise;
  }
  assert.equal(f.state.getIntakeWatermark(binding.channelId).recovered_through_id, '106');
  assert.equal(f.state.listMessages().length, 0);
  assert.equal(history.length > gateway.historyMaxMessages, true);
});

test('live intake checkpoints skip unrelated ready bindings when a channel triggers the pass', async t => {
  const f = fixture(t);
  const blocked = ordinary(f, '0-blocked-channel', OTHER);
  const triggered = ordinary(f, '1-triggered-channel', CODEX);
  for (const binding of [blocked, triggered]) {
    f.state.recordOrdinaryPreflight(binding, {
      file: path.join(f.dir, `${binding.channelId}.jsonl`),
      sessionId: binding.nativeId,
      threadId: binding.nativeId,
      workspace: f.dir
    });
    f.state.setIntakeCutoff(binding.channelId, 'guild', '100', 'checkpoint baseline');
    f.state.markIntakeBoundary(binding.channelId, READINESS.READY, 'fixture ready');
  }
  const event = {
    id: '101',
    guildId: 'guild',
    channelId: triggered.channelId,
    authorId: 'bot',
    isBot: true,
    content: 'triggering notice',
    attachments: []
  };
  assert.equal(f.state.acceptDiscordMessage(event).reason, 'bot-source');
  const channels = new Map([blocked, triggered].map(binding => [binding.channelId, {
    id: binding.channelId,
    guildId: 'guild',
    permissionsFor: () => ({ has: () => true }),
    messages: { fetch: async () => new Map([['101', event]]) }
  }]));
  let blockedFetches = 0;
  let gateway;
  gateway = new DiscordGateway({
    state: f.state,
    client: {
      user: { id: 'bot' },
      on() {},
      off() {},
      channels: {
        fetch: async channelId => {
          if (channelId === blocked.channelId) {
            blockedFetches += 1;
            gateway.liveCheckpointController?.abort();
            await new Promise(resolve => setImmediate(resolve));
          }
          return channels.get(channelId);
        }
      }
    },
    fetchHistory: async channel => channel.id === triggered.channelId ? [event] : [],
    recoveryOptions: { maxMessages: 2 }
  });
  gateway.ready = true;
  gateway.noteLiveIntake(event);
  await gateway.liveCheckpointPromise;

  assert.equal(blockedFetches, 0);
  assert.equal(f.state.getIntakeWatermark(triggered.channelId).recovered_through_id, '101');
  assert.equal(f.state.getIntakeWatermark(blocked.channelId).recovered_through_id, '100');
});

test('live intake checkpoints reschedule traffic received during an in-flight checkpoint', async t => {
  const f = fixture(t);
  const binding = ordinary(f);
  f.state.recordOrdinaryPreflight(binding, { file: path.join(f.dir, 'session.jsonl'), sessionId: CODEX, threadId: CODEX, workspace: f.dir });
  f.state.setIntakeCutoff(binding.channelId, 'guild', '100', 'checkpoint baseline');
  f.state.markIntakeBoundary(binding.channelId, READINESS.READY, 'fixture ready');
  const history = [];
  let historyFetches = 0;
  let releaseFirstHistory;
  const firstHistoryReleased = new Promise(resolve => { releaseFirstHistory = resolve; });
  let firstHistoryStarted;
  const firstHistoryStartedPromise = new Promise(resolve => { firstHistoryStarted = resolve; });
  const channel = {
    id: binding.channelId, guildId: 'guild', permissionsFor: () => ({ has: () => true }),
    messages: { fetch: async () => new Map(history.slice(-1).map(message => [message.id, message])) }
  };
  const gateway = new DiscordGateway({
    state: f.state,
    client: { user: { id: 'bot' }, on() {}, off() {}, channels: { fetch: async () => channel } },
    fetchHistory: async (_channel, options) => {
      const page = history.filter(message => BigInt(message.id) > BigInt(options.after)).slice(0, options.limit);
      historyFetches += 1;
      if (historyFetches === 1) {
        firstHistoryStarted();
        await firstHistoryReleased;
      }
      return page;
    },
    recoveryOptions: { maxMessages: 4 }
  });
  gateway.ready = true;
  const send = async id => {
    const message = { id: String(id), guildId: 'guild', channelId: binding.channelId, author: { id: 'bot', bot: true }, content: 'notice' };
    history.push(message);
    gateway.boundMessage(message);
    await Promise.all([...gateway.inFlight]);
  };

  await send(101);
  await send(102);
  const firstCheckpoint = gateway.liveCheckpointPromise;
  assert.ok(firstCheckpoint);
  await firstHistoryStartedPromise;
  await send(103);
  await send(104);
  releaseFirstHistory();
  await firstCheckpoint;
  assert.ok(gateway.liveCheckpointPromise);
  await gateway.liveCheckpointPromise;

  assert.equal(historyFetches >= 2, true);
  assert.equal(f.state.getIntakeWatermark(binding.channelId).recovered_through_id, '104');
});

test('live intake checkpoints retain demand after a failed pass', async t => {
  const f = fixture(t);
  const binding = ordinary(f);
  f.state.recordOrdinaryPreflight(binding, { file: path.join(f.dir, 'session.jsonl'), sessionId: CODEX, threadId: CODEX, workspace: f.dir });
  f.state.setIntakeCutoff(binding.channelId, 'guild', '100', 'checkpoint baseline');
  f.state.markIntakeBoundary(binding.channelId, READINESS.READY, 'fixture ready');
  const history = [];
  let historyFetches = 0;
  const channel = {
    id: binding.channelId, guildId: 'guild', permissionsFor: () => ({ has: () => true }),
    messages: { fetch: async () => new Map(history.slice(-1).map(message => [message.id, message])) }
  };
  const gateway = new DiscordGateway({
    state: f.state,
    client: { user: { id: 'bot' }, on() {}, off() {}, channels: { fetch: async () => channel } },
    fetchHistory: async (_channel, options) => {
      historyFetches += 1;
      if (historyFetches === 1) throw new Error('temporary history failure');
      return history.filter(message => BigInt(message.id) > BigInt(options.after)).slice(0, options.limit);
    },
    recoveryOptions: { maxMessages: 4 }
  });
  gateway.ready = true;
  const send = async id => {
    const message = { id: String(id), guildId: 'guild', channelId: binding.channelId, author: { id: 'bot', bot: true }, content: 'notice' };
    history.push(message);
    gateway.boundMessage(message);
    await Promise.all([...gateway.inFlight]);
  };

  await send(101);
  await send(102);
  const firstCheckpoint = gateway.liveCheckpointPromise;
  assert.ok(firstCheckpoint);
  await firstCheckpoint;
  assert.equal(gateway.liveCheckpointPromise, null);
  assert.equal(gateway.liveIntakeCounts.get(binding.channelId), gateway.liveCheckpointThreshold);

  const fetchesBeforeBackoffArrival = historyFetches;
  await send(103);
  assert.equal(gateway.liveCheckpointPromise, null);
  assert.equal(historyFetches, fetchesBeforeBackoffArrival);
  assert.equal(gateway.liveIntakeCounts.get(binding.channelId), gateway.liveCheckpointThreshold + 1);

  await new Promise(resolve => setTimeout(resolve, 1100));
  if (gateway.liveCheckpointPromise) await gateway.liveCheckpointPromise;

  assert.equal(historyFetches >= 2, true);
  assert.equal(f.state.getIntakeWatermark(binding.channelId).recovered_through_id, '103');
});

test('Gateway observes a committed pending ordinary generation without a wake signal', async t => {
  const f = fixture(t);
  const binding = ordinary(f);
  const session = transcript(t, f.dir, OTHER);
  f.state.recordOrdinaryPreflight(binding, {
    file: path.join(f.dir, 'source-session.jsonl'), sessionId: CODEX, threadId: CODEX, workspace: f.dir
  });
  f.state.setIntakeCutoff(binding.channelId, 'guild', '100', 'ordinary handoff baseline');
  f.state.markIntakeBoundary(binding.channelId, READINESS.READY, 'ordinary handoff drained', null, null, binding);
  let preflights = 0;
  const channel = {
    id: binding.channelId, guildId: 'guild', topic: null,
    permissionsFor: () => ({ has: () => true })
  };
  const gateway = new DiscordGateway({
    state: f.state,
    client: { user: { id: 'bot' }, channels: { fetch: async () => channel }, on() {}, off() {}, async destroy() {} },
    fetchHistory: async () => [],
    providers: { codex: { async dispatch() { return { status: 'submitted' }; } } },
    recoveryOptions: {
      ordinaryNativePreflight: async current => {
        preflights += 1;
        return { file: session.file, sessionId: current.nativeId, threadId: current.nativeId, workspace: f.dir };
      }
    }
  });
  gateway.ready = true;
  gateway.started = true;
  gateway.transportReady = true;
  gateway.schedulePendingHandoffRecoveryPoll();

  f.state.pauseOrdinaryHandoffIntake(binding.channelId, binding);

  f.state.handoffOrdinary({
    channelId: binding.channelId, provider: PROVIDERS.CODEX, fromNativeId: CODEX, fromGeneration: 1,
    nativeId: OTHER, workspace: f.dir, sessionRoot: null, handoffId: 'poll-handoff',
    intakeCutoff: '100', identity: { sessionId: OTHER, threadId: OTHER },
    nativeProof: { file: session.file, sessionId: OTHER, threadId: OTHER, workspace: f.dir }
  });

  assert.deepEqual(f.state.listPendingOrdinaryHandoffChannels(), [binding.channelId]);
  await new Promise(resolve => setTimeout(resolve, 350));
  assert.equal(preflights, 1);
  assert.equal(f.state.getBinding(binding.channelId).readiness, READINESS.READY);
  await gateway.stop();
});

test('Gateway recovers a channel queued by both ordinary handoff recovery paths', async t => {
  const f = fixture(t);
  const binding = ordinary(f);
  const session = transcript(t, f.dir);
  let preflights = 0;
  const channel = {
    id: binding.channelId, guildId: 'guild', topic: null,
    permissionsFor: () => ({ has: () => true })
  };
  const gateway = new DiscordGateway({
    state: f.state,
    client: { user: { id: 'bot' }, channels: { fetch: async () => channel }, on() {}, off() {}, async destroy() {} },
    fetchHistory: async () => [],
    providers: { codex: { async dispatch() { return { status: 'submitted' }; } } },
    recoveryOptions: {
      ordinaryNativePreflight: async current => {
        preflights += 1;
        return { file: session.file, sessionId: current.nativeId, threadId: current.nativeId, workspace: f.dir };
      }
    }
  });
  gateway.ready = true;
  gateway.started = true;
  gateway.transportReady = true;
  gateway.deferredHandoffRecoveryChannels.add(binding.channelId);
  gateway.pendingHandoffRecoveryChannels.add(binding.channelId);
  gateway.scheduleDeferredHandoffRecovery(binding.channelId);

  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(preflights, 1);
  assert.equal(f.state.getBinding(binding.channelId).readiness, READINESS.READY);
  await gateway.stop();
});

test('Gateway recovers an orphaned recovering ordinary binding', async t => {
  const f = fixture(t);
  const binding = ordinary(f);
  const session = transcript(t, f.dir);
  f.state.setBindingReadiness(binding.channelId, READINESS.RECOVERING, 'handoff intake race', binding);
  let preflights = 0;
  const channel = {
    id: binding.channelId, guildId: 'guild', topic: null,
    permissionsFor: () => ({ has: () => true })
  };
  const gateway = new DiscordGateway({
    state: f.state,
    client: { user: { id: 'bot' }, channels: { fetch: async () => channel }, on() {}, off() {}, async destroy() {} },
    fetchHistory: async () => [],
    providers: { codex: { async dispatch() { return { status: 'submitted' }; } } },
    recoveryOptions: {
      ordinaryNativePreflight: async current => {
        preflights += 1;
        return { file: session.file, sessionId: current.nativeId, threadId: current.nativeId, workspace: f.dir };
      }
    }
  });
  gateway.ready = true;
  gateway.started = true;
  gateway.transportReady = true;
  gateway.scheduleDeferredHandoffRecovery(binding.channelId);

  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(preflights, 1);
  assert.equal(f.state.getBinding(binding.channelId).readiness, READINESS.READY);
  await gateway.stop();
});
