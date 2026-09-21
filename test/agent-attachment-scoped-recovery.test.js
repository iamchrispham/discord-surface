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

test('stop clears queued recovery channels and preserves healthy sibling custody', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-attachment-stop-recovery-'));
  const state = new SurfaceState(path.join(dir, 'surface.sqlite'));
  t.after(() => { try { state.close(); } catch {} fs.rmSync(dir, { recursive: true, force: true }); });
  state.setConfig({ operatorId: '900', guildId: target.guildId, secretFile: path.join(dir, 'secret') });
  const channelA = '201';
  const channelB = '202';
  state.bind({ ...target, channelId: channelA, nativeId: '33333333-3333-3333-3333-333333333333', workspace: dir, endpoint: '/tmp/agent-stop-a.sock', conductorId: 'conductor-a', repoKey: 'repo:a' });
  state.bind({ ...target, channelId: channelB, nativeId: '44444444-4444-4444-4444-444444444444', workspace: dir, endpoint: '/tmp/agent-stop-b.sock', conductorId: 'conductor-b', repoKey: 'repo:b' });
  const bindingA = state.getBinding(channelA);
  const bindingB = state.getBinding(channelB);
  state.setIntakeBaseline(channelA, '6999', 'previous completed recovery', bindingA);
  state.markIntakeBoundary(channelA, 'gap', 'attachment failure', '6999', '7000', bindingA);
  state.setIntakeBaseline(channelB, '7999', 'healthy sibling baseline', bindingB);
  state.markIntakeBoundary(channelB, 'ready', null, null, null, bindingB);
  const gateway = new DiscordGateway({
    state,
    client: { channels: { fetch: async () => null }, on() {}, off() {}, async destroy() {} },
    providers: {},
    fetchHistory: async () => []
  });
  const recoveryCalls = [];
  let releaseFirst;
  const firstStarted = new Promise(resolve => { releaseFirst = resolve; });
  gateway.recoverInbound = async (_signal, _reason, _epoch, channelIds) => {
    recoveryCalls.push({ selected: channelIds ? [...channelIds] : null, active: state.listBindings().filter(binding => binding.active).map(binding => binding.channelId) });
    if (recoveryCalls.length === 1) await firstStarted;
    return { ready: true, state: 'ready' };
  };
  const first = gateway.recoverTransport('first', gateway.lifecycleEpoch, [channelA]);
  const firstRecoveryDeadline = Date.now() + 3000;
  while (recoveryCalls.length < 1 && Date.now() < firstRecoveryDeadline) {
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(recoveryCalls.length, 1, 'timed out waiting for first recovery to start');
  const second = gateway.recoverTransport('second', gateway.lifecycleEpoch, [channelB]);
  const stopping = gateway.stop();
  releaseFirst();
  await Promise.allSettled([first, second, stopping]);
  assert.equal(gateway.pendingRecoveryRequests.length, 0);
  assert.equal(state.getIntakeWatermark(channelA).gap_to, '7000');
  assert.equal(state.getBinding(channelB).readiness, 'ready');

  const restarted = await gateway.recoverTransport('restart', gateway.lifecycleEpoch);
  assert.equal(restarted.ready, true);
  assert.deepEqual(recoveryCalls, [
    { selected: [channelA], active: [channelA, channelB] },
    { selected: null, active: [channelA, channelB] }
  ]);
  await gateway.stop();
});

test('concurrent attachment recovery retains channels for a follow-up pass', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-attachment-recovery-queue-'));
  const state = new SurfaceState(path.join(dir, 'surface.sqlite'));
  t.after(() => { try { state.close(); } catch {} fs.rmSync(dir, { recursive: true, force: true }); });
  const gateway = new DiscordGateway({
    state,
    client: { channels: { fetch: async () => null }, on() {}, off() {}, async destroy() {} },
    providers: {},
    fetchHistory: async () => []
  });
  const started = [];
  let releaseFirst;
  const firstStarted = new Promise(resolve => { releaseFirst = resolve; });
  gateway.recoverInbound = async (_signal, _reason, _epoch, channelIds) => {
    started.push([...channelIds]);
    if (started.length === 1) await firstStarted;
    return { ready: true, state: 'ready' };
  };
  const first = gateway.recoverTransport('first', gateway.lifecycleEpoch, ['channel-a']);
  const firstRecoveryDeadline = Date.now() + 3000;
  while (started.length < 1 && Date.now() < firstRecoveryDeadline) {
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(started.length, 1, 'timed out waiting for first recovery to start');
  const second = gateway.recoverTransport('second', gateway.lifecycleEpoch, ['channel-b']);
  releaseFirst();
  await second;
  await first;
  assert.deepEqual(started, [['channel-a'], ['channel-b']]);
  await gateway.stop();
});

test('unscoped recovery survives a scoped follow-up', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-attachment-recovery-full-'));
  const state = new SurfaceState(path.join(dir, 'surface.sqlite'));
  t.after(() => { try { state.close(); } catch {} fs.rmSync(dir, { recursive: true, force: true }); });
  const gateway = new DiscordGateway({
    state,
    client: { channels: { fetch: async () => null }, on() {}, off() {}, async destroy() {} },
    providers: {},
    fetchHistory: async () => []
  });
  const started = [];
  const firstGate = createTestGate('first recovery');
  const secondGate = createTestGate('second recovery');
  gateway.recoverInbound = async (_signal, _reason, _epoch, channelIds) => {
    started.push(channelIds ? [...channelIds] : null);
    if (started.length === 1) await firstGate.promise;
    if (started.length === 2) await secondGate.promise;
    return { ready: true, state: 'ready' };
  };
  const first = gateway.recoverTransport('first', gateway.lifecycleEpoch, ['channel-a']);
  await waitForCondition(() => started.length === 1, 'timed out waiting for first recovery to start');
  const second = gateway.recoverTransport('second', gateway.lifecycleEpoch, ['channel-b']);
  firstGate.resolve();
  await waitForCondition(() => started.length === 2, 'timed out waiting for scoped follow-up to start');
  const reconnect = gateway.recoverTransport('reconnect', gateway.lifecycleEpoch);
  secondGate.resolve();
  await Promise.all([first, second, reconnect]);
  assert.deepEqual(started, [['channel-a'], ['channel-b'], null]);
  await gateway.stop();
});

test('live stale attachment failure releases obsolete generation barrier before successor intake', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsa-sg-'));
  const state = new SurfaceState(path.join(dir, 'surface.sqlite'));
  let gateway = null;
  let fetchStarted = false;
  const fetchGate = createTestGate('stale-generation attachment fetch');
  let fetchReleased = false;
  const releaseFetch = () => {
    if (fetchReleased) return;
    fetchReleased = true;
    fetchGate.reject(new Error('CDN unavailable'));
  };
  t.after(async () => {
    releaseFetch();
    let cleanupError = null;
    try { await gateway?.stop(); } catch (error) { cleanupError = error; }
    try { state.close(); } catch (error) { cleanupError ||= error; }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (error) { cleanupError ||= error; }
    if (cleanupError) throw cleanupError;
  });

  state.setConfig({ operatorId: '900', guildId: target.guildId, secretFile: path.join(dir, 'secret') });
  state.bind({
    ...target,
    workspace: dir,
    endpoint: path.join(dir, 'g1.sock'),
    conductorId: 'destination-conductor',
    repoKey: 'repo:destination'
  });
  const binding = state.getBinding(target.channelId);
  state.setIntakeBaseline(target.channelId, '6999', 'previous completed recovery', binding);
  state.markIntakeBoundary(target.channelId, 'ready', null, null, null, binding);
  const firstTarget = { ...target, nativeId: binding.nativeId, generation: binding.generation };
  const successorNativeId = '33333333-3333-3333-3333-333333333333';
  const firstWire = encodeLegacyParentResult(state, { ...packet, target: firstTarget }, token);
  let fetchAttempts = 0;
  const fetchUrls = [];
  let successorWire;
  const firstMessage = {
    id: '7000',
    guildId: binding.guildId,
    channelId: binding.channelId,
    author: { id: '901', bot: true },
    content: 'readable preview',
    attachments: [{
      url: 'https://cdn.discordapp.com/attachments/100/102/agent-message.tether',
      filename: 'agent-message.tether',
      contentType: 'application/octet-stream',
      size: Buffer.byteLength(firstWire)
    }]
  };
  const fetchAttachment = async url => {
    fetchAttempts += 1;
    fetchUrls.push(String(url));
    if (fetchAttempts > 1) {
      return new Response(Buffer.from(successorWire), {
        status: 200,
        headers: { 'content-length': String(Buffer.byteLength(successorWire)) }
      });
    }
    fetchStarted = true;
    await fetchGate.promise;
    throw new Error('CDN unavailable');
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
          return { status: 'not_submitted', error: new Error('bounded test provider') };
        }
      }
    },
    fetchHistory: async () => [],
    recoveryOptions: { agentAttachmentFetch: fetchAttachment }
  });
  gateway.sendReply = async () => ({ id: 'reply' });
  gateway.sendTransportReceipt = async () => ({ id: 'receipt' });
  gateway.discordToken = token;
  gateway.ready = true;
  gateway.boundMessage(firstMessage);
  await waitForCondition(() => fetchStarted, 'stale-generation fetch did not start');

  const successor = state.rebind({ ...binding, nativeId: successorNativeId });
  state.markIntakeBoundary(successor.channelId, 'ready', null, null, null, successor);
  const successorTarget = { ...target, nativeId: successor.nativeId, generation: successor.generation };
  successorWire = encodeLegacyParentResult(state, { ...packet, id: 'work-2', target: successorTarget }, token);
  const successorMessage = {
    id: '7001',
    guildId: successor.guildId,
    channelId: successor.channelId,
    author: { id: '901', bot: true },
    content: 'readable successor preview',
    attachments: [{
      url: 'https://cdn.discordapp.com/attachments/100/103/agent-message.tether',
      filename: 'agent-message.tether',
      contentType: 'application/octet-stream',
      size: Buffer.byteLength(successorWire)
    }]
  };
  gateway.boundMessage(successorMessage);
  releaseFetch();
  await waitForCondition(() => state.getMessage(successorMessage.id)?.generation === successor.generation,
    'generation-2 packet was not accepted after stale barrier release');
  await waitForCondition(() => nativeDispatches.length === 1,
    'generation-2 packet did not reach injected native provider');

  const stored = state.getMessage(successorMessage.id);
  assert.equal(stored.nativeId, successorNativeId);
  assert.equal(stored.generation, successor.generation);
  assert.equal(stored.state, 'accepted');
  assert.deepEqual(nativeDispatches, [{
    id: successorMessage.id,
    nativeId: successorNativeId,
    generation: successor.generation
  }]);
  assert.equal(fetchAttempts, 2);
  assert.deepEqual(fetchUrls, [
    'https://cdn.discordapp.com/attachments/100/102/agent-message.tether',
    'https://cdn.discordapp.com/attachments/100/103/agent-message.tether'
  ]);
  assert.equal(fetchGate.isSettled(), true);
  assert.equal(state.getIntakeWatermark(successor.channelId).state, 'ready');
  await gateway.stop();
});

test('targeted attachment recovery preserves one ready sibling native dispatch', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsa-rs-'));
  const state = new SurfaceState(path.join(dir, 'surface.sqlite'));
  let gateway = null;
  const recoveryGate = createTestGate('ready-sibling recovery');
  let recoveryReleased = false;
  const releaseRecovery = () => {
    if (recoveryReleased) return;
    recoveryReleased = true;
    recoveryGate.resolve();
  };
  t.after(async () => {
    releaseRecovery();
    let cleanupError = null;
    try { await gateway?.stop(); } catch (error) { cleanupError = error; }
    try { state.close(); } catch (error) { cleanupError ||= error; }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (error) { cleanupError ||= error; }
    if (cleanupError) throw cleanupError;
  });

  state.setConfig({ operatorId: '900', guildId: target.guildId, secretFile: path.join(dir, 'secret') });
  const channelA = '201';
  const channelB = '202';
  const nativeA = '33333333-3333-4333-8333-333333333333';
  const nativeB = '44444444-4444-4444-8444-444444444444';
  state.bind({
    ...target,
    channelId: channelA,
    nativeId: nativeA,
    workspace: dir,
    endpoint: path.join(dir, 'a.sock'),
    conductorId: 'conductor-a',
    repoKey: 'repo:a'
  });
  state.bind({
    ...target,
    channelId: channelB,
    nativeId: nativeB,
    workspace: dir,
    endpoint: path.join(dir, 'b.sock'),
    conductorId: 'conductor-b',
    repoKey: 'repo:b'
  });
  const bindingA = state.getBinding(channelA);
  const bindingB = state.getBinding(channelB);
  state.setIntakeBaseline(channelA, '6999', 'previous completed recovery', bindingA);
  state.markIntakeBoundary(channelA, 'ready', null, null, null, bindingA);
  state.setIntakeBaseline(channelB, '7999', 'healthy sibling baseline', bindingB);
  state.markIntakeBoundary(channelB, 'ready', null, null, null, bindingB);

  const channel = channelId => ({
    id: channelId,
    guildId: target.guildId,
    topic: staticConductorMarker({
      provider: 'claude',
      conductorId: channelId === channelA ? 'conductor-a' : 'conductor-b',
      repoKey: channelId === channelA ? 'repo:a' : 'repo:b'
    }),
    permissionsFor: () => ({ has: () => true }),
    messages: { fetch: async () => [] }
  });
  let historyStarted = false;
  const fetchHistory = async (_channel, options) => {
    historyStarted = true;
    assert.equal(options.after, '6999');
    await recoveryGate.promise;
    return [];
  };
  const nativeDispatches = [];
  gateway = new DiscordGateway({
    state,
    client: {
      user: { id: '901' },
      channels: { fetch: async channelId => channel(channelId) },
      on() {},
      off() {},
      async destroy() {}
    },
    providers: {
      claude: {
        async dispatch(message) {
          nativeDispatches.push({ id: message.id, nativeId: message.nativeId, generation: message.generation });
          return { status: 'not_submitted', error: new Error('bounded test provider') };
        }
      }
    },
    fetchHistory,
    recoveryOptions: { pageLimit: 2 }
  });
  gateway.sendReply = async () => ({ id: 'reply' });
  gateway.sendTransportReceipt = async () => ({ id: 'receipt' });
  gateway.discordToken = token;
  gateway.ready = false;

  const boundary = await gateway.recordLiveAttachmentGap(
    { id: '7000', channelId: channelA },
    bindingA,
    Object.assign(new Error('attachment gap'), { recoveryKind: 'agent-attachment' })
  );
  assert.equal(boundary.watermark.state, 'gap');
  await waitForCondition(() => historyStarted, 'channel-A recovery did not reach injected history');
  assert.equal(gateway.ready, false);
  assert.equal(state.getBinding(channelA).readiness, 'recovering');
  assert.equal(state.getBinding(channelB).readiness, 'ready');

  const siblingMessage = {
    id: '8000',
    guildId: target.guildId,
    channelId: channelB,
    author: { id: '900', bot: false },
    content: 'ready sibling request'
  };
  gateway.boundMessage(siblingMessage);
  await waitForCondition(() => state.getMessage(siblingMessage.id)?.state === 'accepted',
    'ready sibling was not durably accepted while gateway recovery was held');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(nativeDispatches, []);
  releaseRecovery();
  await waitForCondition(() => nativeDispatches.length === 1,
    'ready sibling did not dispatch after channel-A recovery completed');
  assert.deepEqual(nativeDispatches, [{
    id: siblingMessage.id,
    nativeId: nativeB,
    generation: bindingB.generation
  }]);
  assert.equal(state.getMessage(siblingMessage.id).state, 'accepted');
  assert.equal(state.getBinding(channelA).readiness, 'ready');
  assert.equal(nativeDispatches.some(dispatch => dispatch.nativeId === nativeA), false);
  assert.equal(recoveryGate.isSettled(), true);
  await gateway.stop();
});
