const {
  test,
  assert,
  decodeAgentMessage,
  fs,
  os,
  path,
  SurfaceState,
  messageRequest,
  staticConductorMarker,
  createSurfaceConsumer,
  DiscordGateway,
  fetchAgentAttachment,
  attachmentUrlAllowed,
  source,
  target,
  packet,
  token,
  encodeLegacyParentResult
} = require('./agent-attachment-fixture');

test('attachment fetch bounds pre-abort, cleanup, deadline, and URL path', async () => {
  const attachment = {
    url: 'https://cdn.discordapp.com/attachments/100/102/agent-message.tether',
    filename: 'agent-message.tether', contentType: 'application/octet-stream', size: 1
  };
  assert.equal(attachmentUrlAllowed(attachment.url), true);
  assert.equal(attachmentUrlAllowed('https://cdn.discordapp.com/not-an-attachment'), false);
  const preAborted = new AbortController();
  preAborted.abort();
  let fetchCalls = 0;
  await assert.rejects(
    fetchAgentAttachment(attachment, { signal: preAborted.signal, fetchImpl: async () => { fetchCalls += 1; throw new Error('must not fetch'); } }),
    error => error.recoveryKind === 'stopped'
  );
  assert.equal(fetchCalls, 0);

  let cancelCalls = 0;
  let releaseCalls = 0;
  const hangingReader = {
    read: () => new Promise(() => {}),
    cancel: () => { cancelCalls += 1; return new Promise(() => {}); },
    releaseLock: () => { releaseCalls += 1; }
  };
  const timedOut = fetchAgentAttachment(attachment, {
    timeoutMs: 10,
    fetchImpl: async () => ({ ok: true, status: 200, url: attachment.url, headers: { get: () => null }, body: { getReader: () => hangingReader } })
  });
  const timeoutError = await Promise.race([
    timedOut.then(() => null, error => error),
    new Promise(resolve => setTimeout(() => resolve(new Error('cleanup exceeded test bound')), 200))
  ]);
  assert.equal(timeoutError?.recoveryKind, 'deadline');
  assert.equal(cancelCalls, 1);
  assert.equal(releaseCalls, 1);

  const deadline = Date.now() + 10;
  const deadlineError = await assert.rejects(
    fetchAgentAttachment(attachment, {
      deadline,
      fetchImpl: async () => {
        await new Promise(resolve => setTimeout(resolve, 40));
        return { ok: true, status: 200, url: attachment.url, headers: { get: () => null }, body: { getReader: () => ({ read: async () => ({ done: true }), cancel() {} }) } };
      }
    }),
    error => error.recoveryKind === 'deadline'
  );
  assert.equal(deadlineError, undefined);
});

test('accepted attachment duplicate skips CDN fetch and advances intake coverage', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-attachment-duplicate-'));
  const db = path.join(dir, 'surface.sqlite');
  const state = new SurfaceState(db);
  t.after(() => { try { state.close(); } catch {} fs.rmSync(dir, { recursive: true, force: true }); });
  state.setConfig({ operatorId: '900', guildId: target.guildId, secretFile: path.join(dir, 'secret') });
  state.bind({ ...target, workspace: dir, endpoint: '/tmp/agent-attachment-duplicate.sock', conductorId: 'destination-conductor', repoKey: 'repo:destination' });
  const binding = state.getBinding(target.channelId);
  const destination = { ...target, generation: binding.generation };
  state.setIntakeBaseline(destination.channelId, '6999', 'previous completed recovery', binding);
  state.markIntakeBoundary(destination.channelId, 'ready', null, null, null, binding);
  const wire = encodeLegacyParentResult(state, { ...packet, target: destination }, token);
  const message = {
    id: '7000', guildId: destination.guildId, channelId: destination.channelId,
    author: { id: '901', bot: true }, content: 'Agent request from codex to claude: Inspect the reported failure.',
    attachments: [{
      url: 'https://cdn.discordapp.com/attachments/100/102/agent-message.tether',
      filename: 'agent-message.tether', contentType: 'application/octet-stream', size: Buffer.byteLength(wire)
    }]
  };
  let fetchCalls = 0;
  const consumer = createSurfaceConsumer({
    state,
    providers: {},
    agentCredential: () => token,
    agentBotId: '901',
    agentAttachmentFetch: async () => {
      fetchCalls += 1;
      if (fetchCalls > 1) throw new Error('duplicate must not fetch the CDN');
      return new Response(Buffer.from(wire), { status: 200, headers: { 'content-length': String(Buffer.byteLength(wire)) } });
    }
  });
  const first = await consumer.intakeMessage(message, true, null, binding);
  assert.equal(first.accepted, true);
  const duplicate = await consumer.intakeMessage(message, true, null, binding);
  assert.equal(duplicate.duplicate, true);
  assert.equal(fetchCalls, 1);
  assert.equal(state.getIntakeWatermark(destination.channelId).last_seen_id, message.id);
});

test('attachment intake stays outside coverage until refreshed recovery, then native restart needs no CDN', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-attachment-recovery-'));
  const db = path.join(dir, 'surface.sqlite');
  let state = new SurfaceState(db);
  t.after(() => { try { state.close(); } catch {} fs.rmSync(dir, { recursive: true, force: true }); });
  state.setConfig({ operatorId: '900', guildId: target.guildId, secretFile: path.join(dir, 'secret') });
  state.bind({ ...target, workspace: dir, endpoint: '/tmp/agent-attachment-recovery.sock', conductorId: 'destination-conductor', repoKey: 'repo:destination' });
  const binding = state.getBinding(target.channelId);
  const destination = { ...target, generation: binding.generation };
  state.setIntakeBaseline(destination.channelId, '6999', 'previous completed recovery', binding);
  state.markIntakeBoundary(destination.channelId, 'ready', null, null, null, binding);
  const wire = encodeLegacyParentResult(state, { ...packet, target: destination }, token);
  const attachment = {
    url: 'https://cdn.discordapp.com/attachments/100/102/agent-message.tether',
    filename: 'agent-message.tether',
    contentType: 'application/octet-stream',
    size: Buffer.byteLength(wire)
  };
  const agentMessage = {
    id: '7000', guildId: destination.guildId, channelId: destination.channelId,
    author: { id: '901', bot: true }, content: 'Agent request from codex to claude: Inspect the reported failure.',
    attachments: [attachment]
  };
  const ordinaryMessage = {
    id: '7001', guildId: destination.guildId, channelId: destination.channelId,
    author: { id: '901', bot: true }, content: 'ordinary event'
  };
  let fetchAttempts = 0;
  let attachmentAvailable = false;
  const fetchAttachment = async (_url, options) => {
    fetchAttempts += 1;
    assert.equal(options.headers, undefined);
    if (!attachmentAvailable) throw new Error('CDN unavailable');
    return new Response(Buffer.from(wire), {
      status: 200,
      headers: { 'content-length': String(Buffer.byteLength(wire)) }
    });
  };
  const consumer = createSurfaceConsumer({ state, providers: {}, agentCredential: () => token, agentBotId: '901', agentAttachmentFetch: fetchAttachment });
  await assert.rejects(
    consumer.intakeMessage(agentMessage, false, agentMessage.id, binding, false, new AbortController().signal, null, true),
    /agent attachment fetch failed/
  );
  assert.equal(state.getMessage(agentMessage.id), null);
  assert.equal(state.getIntakeWatermark(destination.channelId).recovered_through_id, '6999');
  assert.equal(state.hasIntakeEvidence(agentMessage.id), false);

  const ordinary = await consumer.intakeMessage(ordinaryMessage, true, null, binding);
  assert.equal(ordinary.accepted, false);
  assert.equal(ordinary.reason, 'bot-source');
  assert.equal(state.getIntakeWatermark(destination.channelId).last_seen_id, ordinaryMessage.id);

  const channel = {
    id: destination.channelId,
    guildId: destination.guildId,
    topic: staticConductorMarker({ provider: destination.provider, conductorId: binding.conductorId, repoKey: binding.repoKey }),
    permissionsFor: () => ({ has: () => true }),
    messages: { fetch: async () => [] }
  };
  const history = async (_channel, options) => {
    if (options.after === '6999') return [agentMessage, ordinaryMessage];
    if (options.after === '7001') return [];
    throw new Error(`unexpected history cursor ${options.after}`);
  };
  const client = {
    user: { id: '901' },
    channels: { fetch: async () => channel },
    on() {}, off() {}, async destroy() {}
  };
  const gateway = new DiscordGateway({
    state,
    client,
    providers: {},
    fetchHistory: history,
    recoveryOptions: { pageLimit: 2, agentAttachmentFetch: fetchAttachment }
  });
  gateway.discordToken = token;
  const checkpoint = await gateway.checkpointHealthyIntake(new AbortController().signal, gateway.lifecycleEpoch, new Map([[destination.channelId, 1]]));
  assert.equal(checkpoint.size, 0);
  assert.equal(state.getIntakeWatermark(destination.channelId).recovered_through_id, '6999');

  attachmentAvailable = true;
  state.reconcileIntake(destination.channelId, binding);
  const recovered = await gateway.recoverTransport('explicit-reconcile');
  assert.equal(recovered.ready, true);
  assert.equal(fetchAttempts, 2);
  assert.equal(state.getMessage(agentMessage.id).content, wire);
  assert.deepEqual(state.getMessage(agentMessage.id).attachments, []);
  assert.deepEqual(state.getMessage(agentMessage.id).agentMessage, decodeAgentMessage(wire, token, destination));
  assert.equal(state.listReceipts().filter(row => row.kind === 'agent-message').length, 1);
  assert.ok(messageRequest(state.getMessage(agentMessage.id)).includes(packet.text));

  const fetchAttemptsAfterAcceptance = fetchAttempts;
  attachmentAvailable = false;
  const duplicate = await consumer.intakeMessage(agentMessage, true, null, binding);
  assert.equal(duplicate.duplicate, true);
  assert.equal(fetchAttempts, fetchAttemptsAfterAcceptance);

  await gateway.stop();
  state.close();
  state = new SurfaceState(db);
  const nativePrompts = [];
  const restartedConsumer = createSurfaceConsumer({
    state,
    agentAttachmentFetch: async () => { throw new Error('CDN must not be used after acceptance'); },
    providers: {
      claude: {
        async dispatch(message) {
          nativePrompts.push(messageRequest(message));
          return { status: 'submitted' };
        },
        async observe() { return { text: 'native recovery reply' }; }
      }
    },
    sendReply: async () => ({ id: 'native-recovery-reply' }),
    sendTransportReceipt: async () => ({ id: 'transport-receipt' })
  });
  const native = await restartedConsumer.handleStoredMessage(state.getMessage(agentMessage.id), new AbortController().signal);
  assert.equal(native.message.state, 'replied');
  assert.equal(nativePrompts.length, 1);
  assert.ok(nativePrompts[0].includes(packet.text));
  assert.equal(state.listReceipts().filter(row => row.kind === 'agent-message').length, 1);
});
