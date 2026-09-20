const test = require('node:test');
const assert = require('node:assert/strict');
const { encodeAgentMessage, decodeAgentMessage, KINDS } = require('../src/agent-message');
const { ChannelType, Collection } = require('discord.js');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SurfaceState, READINESS } = require('../src/state');
const { THREAD_STATES } = require('../src/state/thread-enrollment');
const { messageRequest } = require('../src/native');
const { staticConductorMarker } = require('../src/topic');
const { createSurfaceConsumer, DiscordGateway, fetchAgentAttachment, waitForRecoveryOperation } = require('../src/discord');
const { recoverThread } = require('../src/discord/thread-enrollment');
const { attachmentUrlAllowed } = require('../src/agent-attachment');

const source = { guildId: '100', channelId: '101', provider: 'codex', nativeId: '11111111-1111-1111-1111-111111111111', generation: 1 };
const target = { guildId: '100', channelId: '102', provider: 'claude', nativeId: '22222222-2222-2222-2222-222222222222', generation: 2 };
const packet = { id: 'work-1', kind: KINDS.REQUEST, source, target, replyTo: null, text: 'Inspect the reported failure. Do not change ownership.' };
const token = 'isolated-test-credential';

// Parent recovery still handles results whose immutable custody predates child routing.
function encodeLegacyParentResult(state, value, credential) {
  const result = { ...value, kind: KINDS.RESULT, replyTo: `request-${value.id}`, routingVersion: 2 };
  state.receipt(null, 'direct-post-outcome', {
    outcome: 'sent', legacyAgentPacket: { ...result, routingVersion: undefined }, agentPacket: result
  });
  return encodeAgentMessage(result, credential);
}

async function waitForCondition(predicate, message, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await new Promise(resolve => setImmediate(resolve));
  assert.ok(predicate(), message);
}

function createTestGate(label, timeoutMs = 3000) {
  let settled = false;
  let timer;
  let resolveGate;
  let rejectGate;
  const settle = (callback, value) => {
    if (settled) return false;
    settled = true;
    clearTimeout(timer);
    callback(value);
    return true;
  };
  const promise = new Promise((resolve, reject) => {
    resolveGate = value => settle(resolve, value);
    rejectGate = error => settle(reject, error);
    timer = setTimeout(() => rejectGate(new Error(label + ' deadline exceeded')), timeoutMs);
  });
  promise.catch(() => {});
  return {
    promise,
    resolve: value => resolveGate(value),
    reject: error => rejectGate(error),
    isSettled: () => settled
  };
}

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
  assert.equal(gateway.pendingRecoveryChannels.size, 0);
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
