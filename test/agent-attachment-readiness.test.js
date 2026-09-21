const {
  test,
  assert,
  fs,
  os,
  path,
  SurfaceState,
  messageRequest,
  staticConductorMarker,
  DiscordGateway,
  target,
  packet,
  token,
  encodeLegacyParentResult,
  waitForCondition,
  createTestGate
} = require('./agent-attachment-fixture');

test('live attachment recovery reconciles accepted packet to native provider', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-attachment-native-recovery-'));
  const state = new SurfaceState(path.join(dir, 'surface.sqlite'));
  t.after(() => { try { state.close(); } catch {} fs.rmSync(dir, { recursive: true, force: true }); });
  state.setConfig({ operatorId: '900', guildId: target.guildId, secretFile: path.join(dir, 'secret') });
  state.bind({ ...target, workspace: dir, endpoint: '/tmp/agent-native-recovery.sock', conductorId: 'destination-conductor', repoKey: 'repo:destination' });
  const binding = state.getBinding(target.channelId);
  const destination = { ...target, generation: binding.generation };
  state.setIntakeBaseline(destination.channelId, '6999', 'previous completed recovery', binding);
  state.markIntakeBoundary(destination.channelId, 'ready', null, null, null, binding);
  const wire = encodeLegacyParentResult(state, { ...packet, target: destination }, token);
  const message = {
    id: '7000', guildId: destination.guildId, channelId: destination.channelId,
    author: { id: '901', bot: true }, content: 'readable preview',
    attachments: [{
      url: 'https://cdn.discordapp.com/attachments/100/102/agent-message.tether',
      filename: 'agent-message.tether', contentType: 'application/octet-stream', size: Buffer.byteLength(wire)
    }]
  };
  const laterMessage = {
    id: '7001', guildId: destination.guildId, channelId: destination.channelId,
    author: { id: '900', bot: false }, content: 'later same-channel request'
  };
  let fetchAttempts = 0;
  const nativePrompts = [];
  const nativeDispatches = [];
  const fetchAttachment = async () => {
    fetchAttempts += 1;
    if (fetchAttempts === 1) throw new Error('CDN unavailable');
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
    if (options.after === '6999') return [message];
    if (options.after === message.id) return [];
    throw new Error(`unexpected history cursor ${options.after}`);
  };
  const gateway = new DiscordGateway({
    state,
    client: { user: { id: '901' }, channels: { fetch: async () => channel }, on() {}, off() {}, async destroy() {} },
    providers: {
      claude: {
        async dispatch(storedMessage) {
          nativeDispatches.push(storedMessage.id);
          nativePrompts.push(messageRequest(storedMessage));
          return { status: 'submitted' };
        },
        async observe() { return { text: 'recovered response' }; }
      }
    },
    fetchHistory: history,
    sendReply: async () => ({ id: 'native-recovery-reply' }),
    sendTransportReceipt: async () => ({ id: 'transport-receipt' }),
    recoveryOptions: { pageLimit: 2, agentAttachmentFetch: fetchAttachment }
  });
  const originalReconcilePending = gateway.reconcilePending.bind(gateway);
  let reconciliationStarted = false;
  let releaseReconciliation;
  const reconciliationGate = new Promise(resolve => { releaseReconciliation = resolve; });
  let holdReconciliation = true;
  gateway.reconcilePending = async (...args) => {
    if (holdReconciliation) {
      holdReconciliation = false;
      reconciliationStarted = true;
      await reconciliationGate;
    }
    return originalReconcilePending(...args);
  };
  t.after(() => releaseReconciliation?.());
  gateway.discordToken = token;
  gateway.ready = true;
  gateway.boundMessage(message);
  const reconciliationDeadline = Date.now() + 3000;
  while (!reconciliationStarted && Date.now() < reconciliationDeadline) await new Promise(resolve => setImmediate(resolve));
  assert.equal(reconciliationStarted, true, 'timed out waiting for recovered reconciliation to pause');
  gateway.boundMessage(laterMessage);
  const laterAdmissionDeadline = Date.now() + 3000;
  while (!state.getMessage(laterMessage.id) && Date.now() < laterAdmissionDeadline) {
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.ok(state.getMessage(laterMessage.id), 'timed out waiting for later same-channel admission');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(nativeDispatches, [], 'later intake dispatched while recovered reconciliation was held');
  releaseReconciliation();
  const firstDispatchDeadline = Date.now() + 3000;
  while (nativeDispatches.length < 1 && Date.now() < firstDispatchDeadline) {
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(nativeDispatches[0], message.id, 'recovered packet did not own the first native dispatch');
  const allDispatchesDeadline = Date.now() + 3000;
  while (nativeDispatches.length < 2 && Date.now() < allDispatchesDeadline) {
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.deepEqual(nativeDispatches.slice(0, 2), [message.id, laterMessage.id]);
  assert.equal(fetchAttempts, 2);
  assert.equal(nativePrompts.length, 2);
  assert.ok(nativePrompts[0].includes(packet.text));
  assert.ok(nativePrompts[1].includes(laterMessage.content));
  await gateway.stop();
});

test('held-ready attachment recovery fences later same-channel admission until history custody exists', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-attachment-held-ready-order-'));
  const state = new SurfaceState(path.join(dir, 'surface.sqlite'));
  let gateway = null;
  const recoveryGate = createTestGate('held-ready attachment recovery', 10000);
  t.after(async () => {
    recoveryGate.resolve();
    try { await gateway?.stop(); } catch {}
    try { state.close(); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  });
  state.setConfig({ operatorId: '900', guildId: target.guildId, secretFile: path.join(dir, 'secret') });
  state.bind({ ...target, workspace: dir, endpoint: '/tmp/agent-held-ready-order.sock', conductorId: 'destination-conductor', repoKey: 'repo:destination' });
  const binding = state.getBinding(target.channelId);
  const destination = { ...target, generation: binding.generation };
  state.setIntakeBaseline(destination.channelId, '6999', 'previous completed recovery', binding);
  state.markIntakeBoundary(destination.channelId, 'ready', null, null, null, binding);
  const wire = encodeLegacyParentResult(state, { ...packet, target: destination }, token);
  const message = {
    id: '7000', guildId: destination.guildId, channelId: destination.channelId,
    author: { id: '901', bot: true }, content: 'readable preview',
    attachments: [{
      url: 'https://cdn.discordapp.com/attachments/100/102/agent-message.tether',
      filename: 'agent-message.tether', contentType: 'application/octet-stream', size: Buffer.byteLength(wire)
    }]
  };
  const laterMessage = {
    id: '7001', guildId: destination.guildId, channelId: destination.channelId,
    author: { id: '900', bot: false }, content: 'later same-channel request'
  };
  let fetchAttempts = 0;
  const nativePrompts = [];
  const nativeDispatches = [];
  const fetchAttachment = async () => {
    fetchAttempts += 1;
    if (fetchAttempts === 1) throw new Error('CDN unavailable');
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
    if (options.after === '6999') return [message, laterMessage];
    if (options.after === laterMessage.id) return [];
    throw new Error(`unexpected history cursor ${options.after}`);
  };
  gateway = new DiscordGateway({
    state,
    client: { user: { id: '901' }, channels: { fetch: async () => channel }, on() {}, off() {}, async destroy() {} },
    providers: {
      claude: {
        async dispatch(storedMessage) {
          nativeDispatches.push(storedMessage.id);
          nativePrompts.push(messageRequest(storedMessage));
          return { status: 'submitted' };
        },
        async observe() { return { text: 'recovered response' }; }
      }
    },
    fetchHistory: history,
    sendReply: async () => ({ id: 'native-recovery-reply' }),
    sendTransportReceipt: async () => ({ id: 'transport-receipt' }),
    recoveryOptions: { pageLimit: 2, agentAttachmentFetch: fetchAttachment }
  });
  let recoveryStarted = false;
  const originalRecoverTransport = gateway.recoverTransport.bind(gateway);
  gateway.recoverTransport = async (...args) => {
    recoveryStarted = true;
    await recoveryGate.promise;
    return originalRecoverTransport(...args);
  };
  gateway.discordToken = token;
  gateway.ready = false;
  gateway.boundMessage(message);
  await waitForCondition(() => recoveryStarted, 'timed out waiting for held-ready attachment recovery to pause');
  assert.equal(fetchAttempts, 1);
  gateway.boundMessage(laterMessage);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(state.getMessage(laterMessage.id), null, 'later same-channel intake bypassed attachment recovery barrier');
  assert.deepEqual(nativeDispatches, [], 'later intake dispatched while attachment recovery was held');
  recoveryGate.resolve();
  await waitForCondition(() => nativeDispatches.length >= 1, 'recovered packet did not dispatch after attachment recovery');
  await waitForCondition(() => nativeDispatches.length >= 2, 'later same-channel packet did not dispatch after recovery');
  assert.deepEqual(nativeDispatches.slice(0, 2), [message.id, laterMessage.id]);
  assert.equal(fetchAttempts, 2);
  assert.equal(nativePrompts.length, 2);
  assert.ok(nativePrompts[0].includes(packet.text));
  assert.ok(nativePrompts[1].includes(laterMessage.content));
  await gateway.stop();
});


test('live attachment readiness drop during download holds durable intake and skips native dispatch', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-attachment-readiness-drop-'));
  const state = new SurfaceState(path.join(dir, 'surface.sqlite'));
  let gateway = null;
  let releaseFetch = () => {};
  let fetchReleased = false;
  const release = () => {
    if (fetchReleased) return;
    fetchReleased = true;
    releaseFetch();
  };
  t.after(async () => {
    release();
    await gateway?.stop();
    try { state.close(); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  });
  state.setConfig({ operatorId: '900', guildId: target.guildId, secretFile: path.join(dir, 'secret') });
  state.bind({ ...target, workspace: dir, endpoint: '/tmp/agent-readiness-drop.sock', conductorId: 'destination-conductor', repoKey: 'repo:destination' });
  const binding = state.getBinding(target.channelId);
  const destination = { ...target, generation: binding.generation };
  state.setIntakeBaseline(destination.channelId, '6999', 'previous completed recovery', binding);
  state.markIntakeBoundary(destination.channelId, 'ready', null, null, null, binding);
  const wire = encodeLegacyParentResult(state, { ...packet, target: destination }, token);
  const message = {
    id: '7000', guildId: destination.guildId, channelId: destination.channelId,
    author: { id: '901', bot: true }, content: 'readable preview',
    attachments: [{
      url: 'https://cdn.discordapp.com/attachments/100/102/agent-message.tether',
      filename: 'agent-message.tether', contentType: 'application/octet-stream', size: Buffer.byteLength(wire)
    }]
  };
  let fetchStarted = false;
  let resolveFetch;
  const fetchGate = new Promise(resolve => { resolveFetch = resolve; });
  releaseFetch = () => resolveFetch();
  const fetchAttachment = async () => {
    fetchStarted = true;
    await fetchGate;
    return new Response(Buffer.from(wire), { status: 200, headers: { 'content-length': String(Buffer.byteLength(wire)) } });
  };
  const nativeDispatches = [];
  const channel = { id: destination.channelId, guildId: destination.guildId, send: async () => ({ id: 'native-reply' }) };
  gateway = new DiscordGateway({
    state,
    client: { user: { id: '901' }, channels: { fetch: async () => channel }, on() {}, off() {}, async destroy() {} },
    providers: {
      claude: {
        async dispatch(storedMessage) {
          nativeDispatches.push(storedMessage.id);
          return { status: 'submitted' };
        },
        async observe() { return { text: 'unexpected native response' }; }
      }
    },
    sendReply: async () => ({ id: 'native-reply' }),
    sendTransportReceipt: async () => ({ id: 'transport-receipt' }),
    recoveryOptions: { agentAttachmentFetch: fetchAttachment }
  });
  gateway.discordToken = token;
  gateway.ready = true;
  gateway.boundMessage(message);
  const work = [...gateway.inFlight];
  assert.equal(work.length, 1);
  let workSettled = false;
  const completed = Promise.allSettled(work).then(results => {
    workSettled = true;
    return results;
  });
  const fetchDeadline = Date.now() + 3000;
  while (!fetchStarted && Date.now() < fetchDeadline) await new Promise(resolve => setImmediate(resolve));
  assert.equal(fetchStarted, true, 'timed out waiting for attachment fetch to pause');
  gateway.ready = false;
  release();
  const intakeDeadline = Date.now() + 3000;
  while (!state.getMessage(message.id) && Date.now() < intakeDeadline) await new Promise(resolve => setImmediate(resolve));

  const stored = state.getMessage(message.id);
  assert.ok(stored, 'attachment did not reach durable intake');
  assert.equal(stored.state, 'accepted');
  assert.equal(state.getIntakeWatermark(destination.channelId).last_accepted_id, message.id);
  assert.equal(state.listReceipts().some(row => row.discord_id === message.id && row.kind === 'intake-held-not-ready'), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(nativeDispatches, []);
  const completionDeadline = Date.now() + 3000;
  while (!workSettled && Date.now() < completionDeadline) await new Promise(resolve => setImmediate(resolve));
  assert.equal(workSettled, true, 'timed out waiting for held attachment intake to settle');
  await completed;
});
