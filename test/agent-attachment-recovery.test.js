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
  DiscordGateway,
  target,
  packet,
  token,
  encodeLegacyParentResult,
  waitForCondition
} = require('./agent-attachment-fixture');

test('live attachment failure with no cursor recovers the failed packet', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-attachment-no-cursor-'));
  const state = new SurfaceState(path.join(dir, 'surface.sqlite'));
  t.after(() => { try { state.close(); } catch {} fs.rmSync(dir, { recursive: true, force: true }); });
  state.setConfig({ operatorId: '900', guildId: target.guildId, secretFile: path.join(dir, 'secret') });
  state.bind({ ...target, workspace: dir, endpoint: '/tmp/agent-no-cursor.sock', conductorId: 'destination-conductor', repoKey: 'repo:destination' });
  const binding = state.getBinding(target.channelId);
  state.markIntakeBoundary(target.channelId, 'ready', null, null, null, binding);
  const destination = { ...target, generation: binding.generation };
  const wire = encodeLegacyParentResult(state, { ...packet, target: destination }, token);
  const message = {
    id: '7000', guildId: destination.guildId, channelId: destination.channelId,
    author: { id: '901', bot: true }, content: 'readable preview',
    attachments: [{ url: 'https://cdn.discordapp.com/attachments/100/102/agent-message.tether', filename: 'agent-message.tether', contentType: 'application/octet-stream', size: Buffer.byteLength(wire) }]
  };
  let fetchAttempts = 0;
  const fetchAttachment = async () => {
    fetchAttempts += 1;
    if (fetchAttempts === 1) throw new Error('CDN unavailable');
    return new Response(Buffer.from(wire), { status: 200, headers: { 'content-length': String(Buffer.byteLength(wire)) } });
  };
  const historyCursors = [];
  const channel = {
    id: destination.channelId,
    guildId: destination.guildId,
    topic: staticConductorMarker({ provider: destination.provider, conductorId: binding.conductorId, repoKey: binding.repoKey }),
    permissionsFor: () => ({ has: () => true }),
    send: async () => ({ id: 'native-recovery-reply' }),
    messages: { fetch: async () => [] }
  };
  const history = async (_channel, options) => {
    historyCursors.push(options.after || null);
    if (options.after === '0') return [message];
    if (options.after === message.id) return [];
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
  gateway.boundMessage(message);
  const deadline = Date.now() + 3000;
  while (!state.getMessage(message.id) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(state.getMessage(message.id));
  assert.ok(historyCursors.includes('0'));
  assert.equal(fetchAttempts, 2);
  await gateway.stop();
});

test('child attachment failure retries after child recovery without a new arrival', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-attachment-child-retry-'));
  const state = new SurfaceState(path.join(dir, 'surface.sqlite'));
  t.after(() => { try { state.close(); } catch {} fs.rmSync(dir, { recursive: true, force: true }); });
  state.setConfig({ operatorId: '900', guildId: target.guildId, secretFile: path.join(dir, 'secret') });
  state.bind({ ...target, workspace: dir, endpoint: '/tmp/agent-child-retry.sock', conductorId: 'destination-conductor', repoKey: 'repo:destination' });
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
    id: '7000', guildId: destination.guildId, channelId: destination.channelId,
    author: { id: '901', bot: true }, content: 'readable preview',
    attachments: [{ url: 'https://cdn.discordapp.com/attachments/100/103/agent-message.tether', filename: 'agent-message.tether',
      contentType: 'application/octet-stream', size: Buffer.byteLength(wire) }]
  };
  let fetchAttempts = 0;
  const fetchAttachment = async () => {
    fetchAttempts += 1;
    if (fetchAttempts === 1) throw new Error('CDN unavailable');
    return new Response(Buffer.from(wire), { status: 200, headers: { 'content-length': String(Buffer.byteLength(wire)) } });
  };
  const parentChannel = {
    id: target.channelId, guildId: target.guildId, type: ChannelType.GuildText,
    topic: staticConductorMarker({ provider: target.provider, conductorId: binding.conductorId, repoKey: binding.repoKey }),
    permissionsFor: () => ({ has: () => true }), messages: { fetch: async () => [] }
  };
  const childChannel = {
    id: destination.channelId, guildId: destination.guildId, parentId: target.channelId, type: ChannelType.PublicThread,
    locked: false, archived: false, isThread: () => true,
    permissionsFor: () => ({ has: () => true }), messages: { fetch: async () => [] }
  };
  const history = async (channel, options) => {
    if (options.after === '6999') return [];
    throw new Error(`unexpected ${channel.id} history cursor ${options.after}`);
  };
  const gateway = new DiscordGateway({
    state,
    client: { user: { id: '901' }, channels: { fetch: async id => id === target.channelId ? parentChannel : childChannel }, on() {}, off() {}, async destroy() {} },
    providers: {},
    fetchHistory: history,
    recoveryOptions: { pageLimit: 2, agentAttachmentFetch: fetchAttachment }
  });
  gateway.discordToken = token;
  gateway.ready = true;
  gateway.boundMessage({ ...message, channel: childChannel });
  await waitForCondition(() => state.getMessage(message.id), 'child attachment was not retried after recovery');
  assert.equal(fetchAttempts, 2);
  assert.equal(state.getMessage(message.id).channelId, target.channelId);
  assert.equal(state.getMessage(message.id).deliveryChannelId, destination.channelId);
  assert.equal(state.getThreadEnrollment(destination.channelId).state, THREAD_STATES.READY);
  assert.equal(state.getIntakeWatermark(target.channelId).recovered_through_id, '6999');
  assert.equal(gateway.attachmentIntakeRetryMessages.has(destination.channelId), false);
  assert.equal(gateway.attachmentIntakeBlockedChannels.has(destination.channelId), false);
  await gateway.stop();
});

test('child attachment recovery does not read or demote the healthy parent', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-attachment-child-parent-isolation-'));
  const state = new SurfaceState(path.join(dir, 'surface.sqlite'));
  let gateway;
  t.after(async () => { try { await gateway?.stop(); } catch {} try { state.close(); } catch {} fs.rmSync(dir, { recursive: true, force: true }); });
  state.setConfig({ operatorId: '900', guildId: target.guildId, secretFile: path.join(dir, 'secret') });
  state.bind({ ...target, workspace: dir, endpoint: '/tmp/agent-child-parent-isolation.sock', conductorId: 'destination-conductor', repoKey: 'repo:destination' });
  let binding = state.getBinding(target.channelId);
  binding = state.setBindingReadiness(target.channelId, READINESS.READY, 'fixture ready', binding);
  state.setIntakeBaseline(target.channelId, '6999', 'previous completed recovery', binding);
  state.markIntakeBoundary(target.channelId, 'ready', null, null, null, binding);
  state.enrollThread({ threadId: '103', parentChannelId: target.channelId, guildId: target.guildId }, binding);
  state.setThreadBaseline('103', '6999', binding);
  state.markThreadBoundary('103', THREAD_STATES.READY, 'fixture adoption', null, null, binding);
  const destination = { ...target, channelId: '103', generation: binding.generation };
  const wire = encodeAgentMessage({ ...packet, target: destination }, token);
  let fetchAttempts = 0;
  let parentFetches = 0;
  const message = {
    id: '7000', guildId: destination.guildId, channelId: destination.channelId,
    author: { id: '901', bot: true }, content: 'readable preview',
    attachments: [{ url: 'https://cdn.discordapp.com/attachments/100/103/agent-message.tether', filename: 'agent-message.tether',
      contentType: 'application/octet-stream', size: Buffer.byteLength(wire) }]
  };
  const parentChannel = {
    id: target.channelId, guildId: target.guildId, type: ChannelType.GuildText,
    topic: staticConductorMarker({ provider: target.provider, conductorId: binding.conductorId, repoKey: binding.repoKey }),
    permissionsFor: () => ({ has: () => true }), messages: { fetch: async () => [] }
  };
  const childChannel = {
    id: destination.channelId, guildId: destination.guildId, parentId: target.channelId, type: ChannelType.PublicThread,
    locked: false, archived: false, isThread: () => true,
    permissionsFor: () => ({ has: () => true }), messages: { fetch: async () => [] }
  };
  gateway = new DiscordGateway({
    state,
    client: {
      user: { id: '901' },
      channels: { fetch: async id => {
        if (id === target.channelId) {
          parentFetches += 1;
          throw new Error('parent history must not be read for child recovery');
        }
        return childChannel;
      } },
      on() {}, off() {}, async destroy() {}
    },
    providers: {},
    fetchHistory: async channel => {
      assert.equal(channel.id, destination.channelId);
      return [];
    },
    recoveryOptions: {
      agentAttachmentFetch: async () => {
        fetchAttempts += 1;
        if (fetchAttempts === 1) throw new Error('CDN unavailable');
        return new Response(Buffer.from(wire), { status: 200, headers: { 'content-length': String(Buffer.byteLength(wire)) } });
      }
    }
  });
  gateway.discordToken = token;
  gateway.ready = true;
  gateway.boundMessage({ ...message, channel: childChannel });
  await waitForCondition(() => state.getMessage(message.id), 'child attachment did not recover without parent history');
  assert.equal(fetchAttempts, 2);
  assert.equal(parentFetches, 0);
  assert.equal(state.getBinding(target.channelId).readiness, READINESS.READY);
  assert.equal(state.getThreadEnrollment(destination.channelId).state, THREAD_STATES.READY);
  await gateway.stop();
});

test('child recovery admits fresh history through its blocked attachment barrier', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-attachment-child-history-barrier-'));
  const state = new SurfaceState(path.join(dir, 'surface.sqlite'));
  let gateway;
  t.after(async () => {
    try { gateway?.consumer.releaseIntake('103'); } catch {}
    try { await gateway?.stop(); } catch {}
    try { state.close(); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  });
  state.setConfig({ operatorId: '900', guildId: target.guildId, secretFile: path.join(dir, 'secret') });
  state.bind({ ...target, workspace: dir, endpoint: '/tmp/agent-child-history-barrier.sock', conductorId: 'destination-conductor', repoKey: 'repo:destination' });
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
    id: '7000', guildId: destination.guildId, channelId: destination.channelId,
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
  const historyCursors = [];
  const history = async (channel, options) => {
    assert.equal(channel.id, destination.channelId);
    historyCursors.push(options.after || null);
    if (options.after === '6999') return [message];
    if (options.after === message.id) return [];
    throw new Error(`unexpected child history cursor ${options.after}`);
  };
  gateway = new DiscordGateway({
    state,
    client: { user: { id: '901' }, channels: { fetch: async () => childChannel }, on() {}, off() {}, async destroy() {} },
    providers: {},
    fetchHistory: history,
    recoveryOptions: {
      pageLimit: 2,
      agentAttachmentFetch: async () => {
        fetchAttempts += 1;
        if (fetchAttempts === 1) throw new Error('CDN unavailable');
        return new Response(Buffer.from(wire), { status: 200, headers: { 'content-length': String(Buffer.byteLength(wire)) } });
      }
    }
  });
  gateway.discordToken = token;
  gateway.ready = true;
  gateway.boundMessage({ ...message, channel: childChannel });
  await waitForCondition(() => state.getMessage(message.id), 'fresh child history remained behind its attachment barrier', 800);
  assert.equal(fetchAttempts, 2);
  assert.deepEqual(historyCursors, ['6999']);
  assert.equal(state.getMessage(message.id).channelId, target.channelId);
  assert.equal(state.getMessage(message.id).deliveryChannelId, destination.channelId);
  assert.equal(state.getThreadEnrollment(destination.channelId).state, THREAD_STATES.READY);
  assert.equal(gateway.attachmentIntakeBlockedChannels.has(destination.channelId), false);
});
