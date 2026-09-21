const {
  test,
  assert,
  encodeAgentMessage,
  ChannelType,
  Collection,
  fs,
  os,
  path,
  SurfaceState,
  READINESS,
  THREAD_STATES,
  staticConductorMarker,
  createSurfaceConsumer,
  DiscordGateway,
  fetchAgentAttachment,
  source,
  target,
  packet,
  token,
  encodeLegacyParentResult
} = require('./agent-attachment-fixture');

test('malformed reserved attachment follows ordinary bot coverage without waking native work', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-attachment-metadata-'));
  const db = path.join(dir, 'surface.sqlite');
  const state = new SurfaceState(db);
  t.after(() => { try { state.close(); } catch {} fs.rmSync(dir, { recursive: true, force: true }); });
  state.setConfig({ operatorId: '900', guildId: target.guildId, secretFile: path.join(dir, 'secret') });
  state.bind({ ...target, workspace: dir, endpoint: '/tmp/agent-attachment-metadata.sock', conductorId: 'destination-conductor', repoKey: 'repo:destination' });
  const binding = state.getBinding(target.channelId);
  state.setIntakeBaseline(target.channelId, '6999', 'previous completed recovery', binding);
  state.markIntakeBoundary(target.channelId, 'ready', null, null, null, binding);
  let fetchCalls = 0;
  const consumer = createSurfaceConsumer({
    state,
    providers: {},
    agentCredential: () => { throw new Error('malformed metadata must not request credentials'); },
    agentBotId: '901',
    agentAttachmentFetch: async () => { fetchCalls += 1; throw new Error('malformed metadata must not fetch'); }
  });
  const malformed = await consumer.intakeMessage({
    id: '7000', guildId: target.guildId, channelId: target.channelId,
    author: { id: '901', bot: true }, content: 'Agent request from codex to claude: readable preview',
    attachments: [{ url: 'https://cdn.discordapp.com/attachments/100/102/agent-message.tether', filename: 'agent-message.tether', contentType: 'text/plain', size: 12 }]
  }, true, null, binding);
  assert.equal(malformed.accepted, false);
  assert.equal(malformed.reason, 'bot-source');
  assert.equal(state.hasIntakeEvidence('7000'), true);
  assert.equal(state.getIntakeWatermark(target.channelId).last_seen_id, '7000');
  assert.equal(fetchCalls, 0);
  const ordinary = await consumer.intakeMessage({
    id: '7001', guildId: target.guildId, channelId: target.channelId,
    author: { id: '900', bot: false }, content: 'healthy ordinary event'
  }, true, null, binding);
  assert.equal(ordinary.accepted, true);
  assert.equal(state.getIntakeWatermark(target.channelId).last_seen_id, '7001');
});

test('Discord omitted attachment MIME reaches signed packet intake', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-attachment-null-mime-'));
  const state = new SurfaceState(path.join(dir, 'surface.sqlite'));
  t.after(() => { try { state.close(); } catch {} fs.rmSync(dir, { recursive: true, force: true }); });
  state.setConfig({ operatorId: '900', guildId: target.guildId, secretFile: path.join(dir, 'secret') });
  state.bind({ ...target, workspace: dir, endpoint: '/tmp/agent-null-mime.sock', conductorId: 'destination-conductor', repoKey: 'repo:destination' });
  const binding = state.getBinding(target.channelId);
  state.markIntakeBoundary(target.channelId, 'ready', null, null, null, binding);
  const destination = { ...target, generation: binding.generation };
  const wire = encodeLegacyParentResult(state, { ...packet, target: destination }, token);
  let fetchCalls = 0;
  let credentialCalls = 0;
  const consumer = createSurfaceConsumer({
    state,
    providers: {},
    agentCredential: () => { credentialCalls += 1; return token; },
    agentBotId: '901',
    agentAttachmentFetch: async () => {
      fetchCalls += 1;
      return new Response(Buffer.from(wire), {
        status: 200,
        headers: { 'content-length': String(Buffer.byteLength(wire)) }
      });
    }
  });
  const message = {
    id: '7002', guildId: destination.guildId, channelId: destination.channelId,
    author: { id: '901', bot: true }, content: 'readable preview',
    attachments: [{ url: 'https://cdn.discordapp.com/attachments/100/102/agent-message.tether', filename: 'agent-message.tether', size: Buffer.byteLength(wire) }]
  };
  const intake = await consumer.intakeMessage(message, true, null, binding);
  const stored = state.getMessage(message.id);
  assert.equal(intake.accepted, true);
  assert.equal(fetchCalls, 1);
  assert.equal(credentialCalls, 1);
  assert.ok(stored);
  assert.equal(stored.content, wire);
  assert.deepEqual(stored.attachments, []);
  assert.equal(stored.agentMessage.id, packet.id);
});

test('enrolled child attachment reaches authenticated child custody', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-attachment-child-'));
  const state = new SurfaceState(path.join(dir, 'surface.sqlite'));
  t.after(() => { try { state.close(); } catch {} fs.rmSync(dir, { recursive: true, force: true }); });
  state.setConfig({ operatorId: '900', guildId: target.guildId, secretFile: path.join(dir, 'secret') });
  state.bind({ ...target, workspace: dir, endpoint: path.join(dir, 'child.sock'), conductorId: 'destination-conductor', repoKey: 'repo:destination' });
  let binding = state.getBinding(target.channelId);
  binding = state.setBindingReadiness(target.channelId, READINESS.READY, 'fixture ready', binding);
  state.enrollThread({ threadId: '103', parentChannelId: target.channelId, guildId: target.guildId }, binding);
  state.setThreadBaseline('103', '7000', binding);
  state.markThreadBoundary('103', THREAD_STATES.READY, 'fixture adoption', null, null, binding);
  const destination = { ...target, channelId: '103', generation: binding.generation };
  const wire = encodeAgentMessage({ ...packet, target: destination }, token);
  let fetchCalls = 0;
  const consumer = createSurfaceConsumer({
    state,
    providers: {},
    agentBotId: '901',
    agentCredential: () => token,
    agentAttachmentFetch: async () => {
      fetchCalls += 1;
      return new Response(Buffer.from(wire), { status: 200, headers: { 'content-length': String(Buffer.byteLength(wire)) } });
    }
  });
  const intake = await consumer.intakeMessage({
    id: '7001', guildId: destination.guildId, channelId: destination.channelId,
    author: { id: '901', bot: true }, content: 'readable child preview',
    attachments: [{ url: 'https://cdn.discordapp.com/attachments/100/103/agent-message.tether', filename: 'agent-message.tether',
      contentType: 'application/octet-stream', size: Buffer.byteLength(wire) }]
  }, true, null, binding);
  assert.equal(intake.accepted, true);
  assert.equal(fetchCalls, 1);
  assert.equal(intake.message.channelId, target.channelId);
  assert.equal(intake.message.deliveryChannelId, destination.channelId);
  assert.deepEqual(intake.message.agentMessage, { ...packet, target: destination });
  assert.equal(state.getIntakeWatermark(target.channelId), null);
  assert.equal(state.getThreadEnrollment(destination.channelId).lastAcceptedId, '7001');
});

test('live child intake normalizes a Discord.js attachment collection before bot rejection', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-attachment-child-collection-'));
  const state = new SurfaceState(path.join(dir, 'surface.sqlite'));
  let gateway;
  t.after(async () => { try { await gateway?.stop(); } catch {} try { state.close(); } catch {} fs.rmSync(dir, { recursive: true, force: true }); });
  state.setConfig({ operatorId: '900', guildId: target.guildId, secretFile: path.join(dir, 'secret') });
  state.bind({ ...target, workspace: dir, endpoint: '/tmp/ac.sock', conductorId: 'destination-conductor', repoKey: 'repo:destination' });
  let binding = state.getBinding(target.channelId);
  binding = state.setBindingReadiness(target.channelId, READINESS.READY, 'fixture ready', binding);
  state.setIntakeBaseline(target.channelId, '6999', 'previous completed recovery', binding);
  state.markIntakeBoundary(target.channelId, 'ready', null, null, null, binding);
  state.enrollThread({ threadId: '103', parentChannelId: target.channelId, guildId: target.guildId }, binding);
  state.setThreadBaseline('103', '6999', binding);
  state.markThreadBoundary('103', THREAD_STATES.READY, 'fixture adoption', null, null, binding);
  const destination = { ...target, channelId: '103', generation: binding.generation };
  const wire = encodeAgentMessage({ ...packet, target: destination }, token);
  let fetchCalls = 0;
  const parentChannel = {
    id: target.channelId, guildId: target.guildId, type: ChannelType.GuildText,
    topic: staticConductorMarker({ provider: target.provider, conductorId: binding.conductorId, repoKey: binding.repoKey }),
    permissionsFor: () => ({ has: () => true }), messages: { fetch: async () => [] },
    send: async () => ({ id: 'parent-receipt' })
  };
  const childChannel = {
    id: destination.channelId, guildId: destination.guildId, parentId: target.channelId, type: ChannelType.PublicThread,
    locked: false, archived: false, isThread: () => true,
    permissionsFor: () => ({ has: () => true }), messages: { fetch: async () => [] },
    send: async () => ({ id: 'child-receipt' })
  };
  gateway = new DiscordGateway({
    state,
    client: { user: { id: '901' }, channels: { fetch: async id => id === target.channelId ? parentChannel : childChannel }, on() {}, off() {}, async destroy() {} },
    providers: {},
    fetchHistory: async () => [],
    recoveryOptions: {
      agentAttachmentFetch: async () => {
        fetchCalls += 1;
        return new Response(Buffer.from(wire), { status: 200, headers: { 'content-length': String(Buffer.byteLength(wire)) } });
      }
    }
  });
  gateway.discordToken = token;
  gateway.ready = false;
  const attachment = { url: 'https://cdn.discordapp.com/attachments/100/103/agent-message.tether', filename: 'agent-message.tether',
    contentType: 'application/octet-stream', size: Buffer.byteLength(wire) };
  const message = {
    id: '7002', guildId: destination.guildId, channelId: destination.channelId, channel: childChannel,
    author: { id: '901', bot: true }, content: 'readable child preview',
    attachments: new Collection([[attachment.filename, attachment]])
  };
  gateway.boundMessage(message);
  await Promise.all([...gateway.inFlight]);
  await gateway.consumer.waitForReceipts();
  const stored = state.getMessage(message.id);
  assert.ok(stored);
  assert.equal(fetchCalls, 1);
  assert.equal(stored.channelId, target.channelId);
  assert.equal(stored.deliveryChannelId, destination.channelId);
  assert.deepEqual(stored.agentMessage, { ...packet, target: destination });
});

test('declared attachment size mismatch is a retryable intake failure', async () => {
  const url = 'https://cdn.discordapp.com/attachments/100/102/agent-message.tether';
  const body = Buffer.from('short body', 'utf8');
  let released = false;
  const error = await assert.rejects(
    fetchAgentAttachment({ url, size: body.length + 4 }, {
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        url,
        headers: { get: () => null },
        body: {
          getReader: () => ({
            read: async () => {
              if (released) return { done: true };
              released = true;
              return { done: false, value: body };
            },
            cancel: async () => {},
            releaseLock: () => {}
          })
        }
      })
    }),
    failure => {
      assert.equal(failure.recoveryKind, 'agent-attachment');
      assert.match(failure.message, /body size 10 does not match declared size 14/);
      return true;
    }
  );
  assert.equal(error, undefined);
});
