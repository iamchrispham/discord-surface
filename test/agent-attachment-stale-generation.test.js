const {
  test,
  assert,
  fs,
  os,
  path,
  SurfaceState,
  staticConductorMarker,
  DiscordGateway,
  target,
  packet,
  token,
  encodeLegacyParentResult,
  waitForCondition,
  createTestGate
} = require('./agent-attachment-fixture');

async function createStaleBarrierScenario({ holdBoundary = false, holdRecovery = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-attachment-stale-barrier-'));
  const state = new SurfaceState(path.join(dir, 'surface.sqlite'));
  const fetchGate = createTestGate('initial attachment fetch');
  const boundaryGate = createTestGate('first boundary');
  const recoveryGate = createTestGate('scoped recovery');
  let gateway = null;
  let fetchStarted = false;
  let boundaryRecorded = false;
  let boundaryCalls = 0;
  let recoveryStarted = false;
  let fetchReleased = false;
  let successorWire;
  const releaseFetch = () => {
    if (fetchReleased) return;
    fetchReleased = true;
    fetchGate.reject(new Error('CDN unavailable'));
  };
  state.setConfig({ operatorId: '900', guildId: target.guildId, secretFile: path.join(dir, 'secret') });
  state.bind({
    ...target,
    workspace: dir,
    endpoint: '/tmp/agent-stale-barrier.sock',
    conductorId: 'destination-conductor',
    repoKey: 'repo:destination'
  });
  const binding = state.getBinding(target.channelId);
  state.setIntakeBaseline(target.channelId, '6999', 'previous completed recovery', binding);
  state.markIntakeBoundary(target.channelId, 'ready', null, null, null, binding);
  const firstWire = encodeLegacyParentResult(state, { ...packet, target: { ...target, nativeId: binding.nativeId, generation: binding.generation } }, token);
  const firstMessage = {
    id: '7000',
    guildId: binding.guildId,
    channelId: binding.channelId,
    author: { id: '901', bot: true },
    content: 'old generation preview',
    attachments: [{
      url: 'https://cdn.discordapp.com/attachments/100/102/old.tether',
      filename: 'agent-message.tether',
      contentType: 'application/octet-stream',
      size: Buffer.byteLength(firstWire)
    }]
  };
  let fetchAttempts = 0;
  const fetchAttachment = async () => {
    fetchAttempts += 1;
    if (fetchAttempts === 1) {
      fetchStarted = true;
      await fetchGate.promise;
      throw new Error('CDN unavailable');
    }
    return new Response(Buffer.from(successorWire), {
      status: 200,
      headers: { 'content-length': String(Buffer.byteLength(successorWire)) }
    });
  };
  const nativeDispatches = [];
  const channel = {
    id: binding.channelId,
    guildId: binding.guildId,
    topic: staticConductorMarker({ provider: binding.provider, conductorId: binding.conductorId, repoKey: binding.repoKey }),
    permissionsFor: () => ({ has: () => true }),
    messages: { fetch: async () => [] }
  };
  gateway = new DiscordGateway({
    state,
    client: {
      user: { id: '901' },
      channels: { fetch: async () => channel },
      on() {},
      off() {},
      async destroy() {}
    },
    providers: {
      claude: {
        async dispatch(message) {
          nativeDispatches.push({ id: message.id, nativeId: message.nativeId, generation: message.generation });
          return { status: 'not_submitted', error: new Error('bounded provider') };
        },
        async observe() { return { text: 'bounded observation' }; }
      }
    },
    fetchHistory: async () => [],
    recoveryOptions: { agentAttachmentFetch: fetchAttachment }
  });
  const originalRecordBoundary = gateway.recordBoundary.bind(gateway);
  gateway.recordBoundary = async (...args) => {
    boundaryCalls += 1;
    const result = await originalRecordBoundary(...args);
    if (holdBoundary && boundaryCalls === 1) {
      boundaryRecorded = true;
      await boundaryGate.promise;
    }
    return result;
  };
  gateway.recoverInbound = async () => {
    recoveryStarted = true;
    if (holdRecovery) await recoveryGate.promise;
    return { ready: true, state: 'ready' };
  };
  gateway.sendReply = async () => ({ id: 'reply' });
  gateway.sendTransportReceipt = async () => ({ id: 'receipt' });
  gateway.discordToken = token;
  gateway.ready = true;

  const makeSuccessor = (ready = true) => {
    const successor = state.rebind({ ...binding, nativeId: '33333333-3333-3333-3333-333333333333' });
    if (ready) state.markIntakeBoundary(successor.channelId, 'ready', null, null, null, successor);
    const successorTarget = { ...target, nativeId: successor.nativeId, generation: successor.generation };
    successorWire = encodeLegacyParentResult(state, { ...packet, id: 'work-2', target: successorTarget }, token);
    return {
      successor,
      message: {
        id: '7001',
        guildId: successor.guildId,
        channelId: successor.channelId,
        author: { id: '901', bot: true },
        content: 'successor generation preview',
        attachments: [{
          url: 'https://cdn.discordapp.com/attachments/100/103/successor.tether',
          filename: 'agent-message.tether',
          contentType: 'application/octet-stream',
          size: Buffer.byteLength(successorWire)
        }]
      }
    };
  };
  const cleanup = async () => {
    releaseFetch();
    boundaryGate.resolve();
    recoveryGate.resolve();
    try { await gateway?.stop(); } catch {}
    try { state.close(); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return {
    state,
    gateway,
    firstMessage,
    fetchStarted: () => fetchStarted,
    boundaryRecorded: () => boundaryRecorded,
    recoveryStarted: () => recoveryStarted,
    releaseFetch,
    boundaryGate,
    recoveryGate,
    makeSuccessor,
    cleanup,
    nativeDispatches
  };
}

test('pre-timer stale rebind releases old barrier', async t => {
  const scenario = await createStaleBarrierScenario({ holdBoundary: true });
  t.after(scenario.cleanup);
  scenario.gateway.boundMessage(scenario.firstMessage);
  await waitForCondition(scenario.fetchStarted, 'pre-timer fetch did not start');
  scenario.releaseFetch();
  await waitForCondition(scenario.boundaryRecorded, 'pre-timer gap boundary did not record');
  const { successor, message } = scenario.makeSuccessor(true);
  scenario.gateway.boundMessage(message);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(scenario.state.getMessage(message.id), null, 'successor bypassed the pre-timer barrier');
  scenario.boundaryGate.resolve();
  await waitForCondition(() => scenario.state.getMessage(message.id)?.generation === successor.generation,
    'successor was not admitted after pre-timer stale cleanup');
  await waitForCondition(() => scenario.nativeDispatches.length === 1,
    'successor did not dispatch after pre-timer cleanup');
  assert.deepEqual(scenario.nativeDispatches, [{ id: message.id, nativeId: successor.nativeId, generation: successor.generation }]);
  assert.equal(scenario.gateway.attachmentIntakeRetryMessages.has(successor.channelId), false);
  assert.equal(scenario.gateway.attachmentIntakeBlockedChannels.has(successor.channelId), false);
});

test('during-recovery stale rebind releases old barrier', async t => {
  const scenario = await createStaleBarrierScenario({ holdRecovery: true });
  t.after(scenario.cleanup);
  scenario.gateway.boundMessage(scenario.firstMessage);
  await waitForCondition(scenario.fetchStarted, 'during-recovery fetch did not start');
  scenario.releaseFetch();
  await waitForCondition(scenario.recoveryStarted, 'during-recovery recovery did not start');
  const { successor, message } = scenario.makeSuccessor(true);
  scenario.gateway.boundMessage(message);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(scenario.state.getMessage(message.id), null, 'successor bypassed the during-recovery barrier');
  scenario.recoveryGate.resolve();
  await waitForCondition(() => scenario.state.getMessage(message.id)?.generation === successor.generation,
    'successor was not admitted after during-recovery stale cleanup');
  await waitForCondition(() => scenario.nativeDispatches.length === 1,
    'successor did not dispatch after during-recovery cleanup');
  assert.deepEqual(scenario.nativeDispatches, [{ id: message.id, nativeId: successor.nativeId, generation: successor.generation }]);
  assert.equal(scenario.gateway.attachmentIntakeRetryMessages.has(successor.channelId), false);
  assert.equal(scenario.gateway.attachmentIntakeBlockedChannels.has(successor.channelId), false);
});

test('pre-timer stale callback preserves newer pending ownership', async t => {
  const scenario = await createStaleBarrierScenario({ holdBoundary: true, holdRecovery: true });
  t.after(scenario.cleanup);
  scenario.gateway.boundMessage(scenario.firstMessage);
  await waitForCondition(scenario.fetchStarted, 'pre-timer preservation fetch did not start');
  scenario.releaseFetch();
  await waitForCondition(scenario.boundaryRecorded, 'pre-timer preservation boundary did not record');
  const { successor } = scenario.makeSuccessor(false);
  scenario.boundaryGate.resolve();
  await scenario.gateway.recordLiveAttachmentGap(
    { id: '7002', channelId: successor.channelId },
    successor,
    Object.assign(new Error('successor attachment gap'), { recoveryKind: 'agent-attachment' })
  );
  await new Promise(resolve => setImmediate(resolve));
  const pending = scenario.gateway.attachmentIntakeRetryMessages.get(successor.channelId);
  assert.equal(pending?.binding.generation, successor.generation);
  assert.equal(scenario.gateway.attachmentIntakeRetryPendingChannels.has(successor.channelId), true);
  assert.equal(scenario.gateway.attachmentIntakeBlockedChannels.has(successor.channelId), true);
});

test('during-recovery stale callback preserves newer pending ownership', async t => {
  const scenario = await createStaleBarrierScenario({ holdRecovery: true });
  t.after(scenario.cleanup);
  scenario.gateway.boundMessage(scenario.firstMessage);
  await waitForCondition(scenario.fetchStarted, 'during-recovery preservation fetch did not start');
  scenario.releaseFetch();
  await waitForCondition(scenario.recoveryStarted, 'during-recovery preservation recovery did not start');
  const { successor } = scenario.makeSuccessor(false);
  await scenario.gateway.recordLiveAttachmentGap(
    { id: '7002', channelId: successor.channelId },
    successor,
    Object.assign(new Error('successor attachment gap'), { recoveryKind: 'agent-attachment' })
  );
  scenario.recoveryGate.resolve();
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  const pending = scenario.gateway.attachmentIntakeRetryMessages.get(successor.channelId);
  assert.equal(pending?.binding.generation, successor.generation);
  assert.equal(scenario.gateway.attachmentIntakeRetryPendingChannels.has(successor.channelId), true);
  assert.equal(scenario.gateway.attachmentIntakeBlockedChannels.has(successor.channelId), true);
});
