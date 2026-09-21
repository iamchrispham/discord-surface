const {
  test,
  assert,
  encodeAgentMessage,
  ChannelType,
  fs,
  os,
  path,
  SurfaceState,
  READINESS,
  THREAD_STATES,
  staticConductorMarker,
  createSurfaceConsumer,
  DiscordGateway,
  waitForRecoveryOperation,
  recoverThread,
  source,
  target,
  packet,
  token,
  encodeLegacyParentResult,
  waitForCondition
} = require('./agent-attachment-fixture');

test('child history attachment recovery honors cancellation while fetching fresh custody', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-attachment-child-history-cancel-'));
  const state = new SurfaceState(path.join(dir, 'surface.sqlite'));
  let gateway;
  t.after(async () => {
    try { gateway?.consumer.releaseIntake('103'); } catch {}
    try { await gateway?.stop(); } catch {}
    try { state.close(); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  });
  state.setConfig({ operatorId: '900', guildId: target.guildId, secretFile: path.join(dir, 'secret') });
  state.bind({ ...target, workspace: dir, endpoint: '/tmp/agent-child-history-cancel.sock', conductorId: 'destination-conductor', repoKey: 'repo:destination' });
  let binding = state.getBinding(target.channelId);
  binding = state.setBindingReadiness(target.channelId, READINESS.READY, 'fixture ready', binding);
  state.setIntakeBaseline(target.channelId, '6999', 'previous completed recovery', binding);
  state.markIntakeBoundary(target.channelId, 'ready', null, null, null, binding);
  state.enrollThread({ threadId: '103', parentChannelId: target.channelId, guildId: target.guildId }, binding);
  state.setThreadBaseline('103', '6999', binding);
  state.markThreadBoundary('103', THREAD_STATES.READY, 'fixture adoption', null, null, binding);
  const destination = { ...target, channelId: '103', generation: binding.generation };
  const wire = encodeAgentMessage({ ...packet, target: destination }, token);
  const message = {
    id: '7001', guildId: destination.guildId, channelId: destination.channelId,
    author: { id: '901', bot: true }, content: 'readable preview',
    attachments: [{ url: 'https://cdn.discordapp.com/attachments/100/103/agent-message.tether', filename: 'agent-message.tether',
      contentType: 'application/octet-stream', size: Buffer.byteLength(wire) }]
  };
  let fetchAttempts = 0;
  const childChannel = {
    id: destination.channelId, guildId: destination.guildId, parentId: target.channelId, type: ChannelType.PublicThread,
    locked: false, archived: false, isThread: () => true,
    permissionsFor: () => ({ has: () => true }), messages: { fetch: async () => [] }
  };
  gateway = new DiscordGateway({
    state,
    client: { user: { id: '901' }, channels: { fetch: async () => childChannel }, on() {}, off() {}, async destroy() {} },
    providers: {},
    fetchHistory: async (_channel, options) => options.after === '6999' ? [message] : [],
    recoveryOptions: {
      agentAttachmentFetch: async (_url, options) => {
        fetchAttempts += 1;
        if (fetchAttempts === 1) throw new Error('CDN unavailable');
        await new Promise((resolve, reject) => {
          const onAbort = () => {
            options.signal?.removeEventListener('abort', onAbort);
            reject(new Error('attachment fetch observed recovery cancellation'));
          };
          if (options.signal?.aborted) return onAbort();
          options.signal?.addEventListener('abort', onAbort, { once: true });
        });
        return new Response(Buffer.from(wire), { status: 200, headers: { 'content-length': String(Buffer.byteLength(wire)) } });
      }
    }
  });
  gateway.discordToken = token;
  await assert.rejects(gateway.consumer.intakeMessage(message, false, message.id, binding), /agent attachment fetch failed/);
  const controller = new AbortController();
  const recovery = recoverThread(gateway, state.getThreadEnrollment(destination.channelId), controller.signal,
    gateway.lifecycleEpoch, waitForRecoveryOperation, false, Date.now() + 800);
  await waitForCondition(() => fetchAttempts === 2, 'child history attachment fetch did not start', 800);
  controller.abort();
  assert.equal(await recovery, false);
  assert.equal(state.getMessage(message.id), null);
  assert.equal(state.getThreadEnrollment(destination.channelId).state, THREAD_STATES.PENDING);
});

test('live attachment failure fences later same-channel intake until recovery', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-attachment-fence-'));
  const state = new SurfaceState(path.join(dir, 'surface.sqlite'));
  t.after(() => { try { state.close(); } catch {} fs.rmSync(dir, { recursive: true, force: true }); });
  state.setConfig({ operatorId: '900', guildId: target.guildId, secretFile: path.join(dir, 'secret') });
  state.bind({ ...target, workspace: dir, endpoint: '/tmp/agent-fence.sock', conductorId: 'destination-conductor', repoKey: 'repo:destination' });
  const binding = state.getBinding(target.channelId);
  state.setIntakeBaseline(target.channelId, '6999', 'previous completed recovery', binding);
  state.markIntakeBoundary(target.channelId, 'ready', null, null, null, binding);
  const destination = { ...target, generation: binding.generation };
  const firstWire = encodeLegacyParentResult(state, { ...packet, target: destination }, token);
  const secondWire = encodeLegacyParentResult(state, { ...packet, id: 'work-2', target: destination }, token);
  const makeMessage = (id, url, size) => ({
    id, guildId: destination.guildId, channelId: destination.channelId,
    author: { id: '901', bot: true }, content: 'readable preview',
    attachments: [{ url, filename: 'agent-message.tether', contentType: 'application/octet-stream', size }]
  });
  const first = makeMessage('7000', 'https://cdn.discordapp.com/attachments/100/102/agent-message.tether', Buffer.byteLength(firstWire));
  const second = makeMessage('7001', 'https://cdn.discordapp.com/attachments/100/103/agent-message.tether', Buffer.byteLength(secondWire));
  let fetchAttempts = 0;
  const fetchAttachment = async url => {
    fetchAttempts += 1;
    if (fetchAttempts === 1) throw new Error('CDN unavailable');
    const wire = String(url).includes('/103/') ? secondWire : firstWire;
    return new Response(Buffer.from(wire), { status: 200, headers: { 'content-length': String(Buffer.byteLength(wire)) } });
  };
  const channel = {
    id: destination.channelId,
    guildId: destination.guildId,
    topic: staticConductorMarker({ provider: destination.provider, conductorId: binding.conductorId, repoKey: binding.repoKey }),
    permissionsFor: () => ({ has: () => true }),
    messages: { fetch: async () => [] }
  };
  const history = async (_channel, options) => {
    if (options.after === '6999') return [first, second];
    if (options.after === '7001') return [];
    throw new Error(`unexpected history cursor ${options.after}`);
  };
  const gateway = new DiscordGateway({
    state,
    client: { user: { id: '901' }, channels: { fetch: async () => channel }, on() {}, off() {}, async destroy() {} },
    providers: {},
    fetchHistory: history,
    recoveryOptions: { pageLimit: 2, agentAttachmentFetch: fetchAttachment }
  });
  gateway.discordToken = token;
  gateway.ready = true;
  gateway.boundMessage(first);
  gateway.boundMessage(second);
  const deadline = Date.now() + 4000;
  while ((!state.getMessage(first.id) || !state.getMessage(second.id)) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(state.getMessage(first.id));
  assert.ok(state.getMessage(second.id));
  assert.equal(fetchAttempts, 3);
  await gateway.stop();
});

test('foreign bot attachments do not trigger agent CDN fetches', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-attachment-foreign-bot-'));
  const state = new SurfaceState(path.join(dir, 'surface.sqlite'));
  t.after(() => { try { state.close(); } catch {} fs.rmSync(dir, { recursive: true, force: true }); });
  state.setConfig({ operatorId: '900', guildId: target.guildId, secretFile: path.join(dir, 'secret') });
  state.bind({ ...target, workspace: dir, endpoint: '/tmp/agent-foreign-bot.sock' });
  const binding = state.getBinding(target.channelId);
  state.setIntakeBaseline(target.channelId, '6999', 'previous completed recovery', binding);
  state.markIntakeBoundary(target.channelId, 'ready', null, null, null, binding);
  let fetchCalls = 0;
  const consumer = createSurfaceConsumer({
    state,
    providers: {},
    agentBotId: 'connected-bot',
    agentCredential: () => token,
    agentAttachmentFetch: async () => { fetchCalls += 1; throw new Error('foreign bot must not fetch'); }
  });
  const intake = await consumer.intakeMessage({
    id: '7000', guildId: target.guildId, channelId: target.channelId,
    author: { id: 'foreign-bot', bot: true }, content: 'unrelated bot message',
    attachments: [{ url: 'https://cdn.discordapp.com/attachments/100/102/agent-message.tether', filename: 'agent-message.tether', contentType: 'application/octet-stream', size: 1 }]
  }, true, null, binding);
  assert.equal(intake.reason, 'bot-source');
  assert.equal(fetchCalls, 0);
});

test('live attachment fetch failures leave a durable gap receipt', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-attachment-live-gap-'));
  const state = new SurfaceState(path.join(dir, 'surface.sqlite'));
  t.after(() => { try { state.close(); } catch {} fs.rmSync(dir, { recursive: true, force: true }); });
  state.setConfig({ operatorId: '900', guildId: target.guildId, secretFile: path.join(dir, 'secret') });
  state.bind({ ...target, workspace: dir, endpoint: '/tmp/agent-live-gap.sock' });
  const binding = state.getBinding(target.channelId);
  state.setIntakeBaseline(target.channelId, '6999', 'previous completed recovery', binding);
  state.markIntakeBoundary(target.channelId, 'ready', null, null, null, binding);
  const client = {
    user: { id: 'connected-bot' },
    channels: { fetch: async () => ({ id: target.channelId, guildId: target.guildId, permissionsFor: () => ({ has: () => true }), messages: { fetch: async () => [] } }) },
    on() {}, off() {}, async destroy() {}
  };
  const gateway = new DiscordGateway({
    state,
    client,
    providers: {},
    fetchHistory: async () => [],
    recoveryOptions: { agentAttachmentFetch: async () => { throw new Error('CDN unavailable'); } }
  });
  gateway.ready = true;
  gateway.boundMessage({
    id: '7000', guildId: target.guildId, channelId: target.channelId,
    author: { id: 'connected-bot', bot: true }, content: 'readable preview',
    attachments: [{ url: 'https://cdn.discordapp.com/attachments/100/102/agent-message.tether', filename: 'agent-message.tether', contentType: 'application/octet-stream', size: 1 }]
  });
  await Promise.all([...gateway.inFlight]);
  assert.equal(state.hasIntakeEvidence('7000'), false);
  assert.equal(state.listReceipts().some(row => row.kind === 'intake-boundary' && JSON.parse(row.detail).state === 'gap'), true);
  await gateway.stop();
});

test('live attachment normalization preserves channel order', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-attachment-order-'));
  const state = new SurfaceState(path.join(dir, 'surface.sqlite'));
  t.after(() => { try { state.close(); } catch {} fs.rmSync(dir, { recursive: true, force: true }); });
  state.setConfig({ operatorId: '900', guildId: target.guildId, secretFile: path.join(dir, 'secret') });
  state.bind({ ...target, workspace: dir, endpoint: '/tmp/agent-order.sock' });
  const binding = state.getBinding(target.channelId);
  state.setIntakeBaseline(target.channelId, '6999', 'previous completed recovery', binding);
  state.markIntakeBoundary(target.channelId, 'ready', null, null, null, binding);
  const destination = { ...target, generation: binding.generation };
  const wireOne = encodeLegacyParentResult(state, { ...packet, target: destination }, token);
  const wireTwo = encodeLegacyParentResult(state, { ...packet, id: 'work-2', target: destination }, token);
  let firstStarted;
  const firstStartedPromise = new Promise(resolve => { firstStarted = resolve; });
  let releaseFirst;
  const firstReleased = new Promise(resolve => { releaseFirst = resolve; });
  let fetchCalls = 0;
  const consumer = createSurfaceConsumer({
    state,
    providers: {},
    agentBotId: 'connected-bot',
    agentCredential: () => token,
    agentAttachmentFetch: async url => {
      fetchCalls += 1;
      if (fetchCalls === 1) {
        firstStarted();
        await firstReleased;
        return new Response(Buffer.from(wireOne), { status: 200, headers: { 'content-length': String(Buffer.byteLength(wireOne)) } });
      }
      return new Response(Buffer.from(wireTwo), { status: 200, headers: { 'content-length': String(Buffer.byteLength(wireTwo)) } });
    }
  });
  const makeMessage = (id, url) => ({ id, guildId: target.guildId, channelId: target.channelId, author: { id: 'connected-bot', bot: true }, content: 'preview', attachments: [{ url, filename: 'agent-message.tether', contentType: 'application/octet-stream', size: Buffer.byteLength(wireOne) }] });
  const first = consumer.intakeMessage(makeMessage('7000', 'https://cdn.discordapp.com/attachments/100/102/agent-message.tether'), true, null, binding);
  await firstStartedPromise;
  const second = consumer.intakeMessage(makeMessage('7001', 'https://cdn.discordapp.com/attachments/100/103/agent-message.tether'), true, null, binding);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fetchCalls, 1);
  releaseFirst();
  const [firstIntake, secondIntake] = await Promise.all([first, second]);
  assert.equal(firstIntake.accepted, true);
  assert.equal(secondIntake.accepted, true);
  assert.equal(state.getMessage('7000') !== null, true);
  assert.equal(state.getMessage('7001') !== null, true);
  assert.equal(state.getIntakeWatermark(target.channelId).last_accepted_id, '7001');
});
