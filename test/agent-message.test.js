const test = require('node:test');
const assert = require('node:assert/strict');
const { AGENT_MESSAGE_MAX_ENCODED_LENGTH, PREFIX, issueAgentAddress, encodeAgentMessage, decodeAgentMessage, verifyAgentAddress, verifyLegacyAgentAddress, KINDS } = require('../src/agent-message');

const source = { guildId: '100', channelId: '101', provider: 'codex', nativeId: '11111111-1111-1111-1111-111111111111', generation: 1 };
const target = { guildId: '100', channelId: '102', provider: 'claude', nativeId: '22222222-2222-2222-2222-222222222222', generation: 2 };
const packet = { id: 'work-1', kind: KINDS.REQUEST, source, target, replyTo: null, text: 'Inspect the reported failure. Do not change ownership.' };
const token = 'isolated-test-credential';

test('agent packet retains source, destination and task across authenticated encoding', () => {
  const wire = encodeAgentMessage(packet, token);
  assert.deepEqual(decodeAgentMessage(wire, token, target), packet);
  const result = { ...packet, id: 'result-1', kind: KINDS.RESULT, source: target, target: source, replyTo: packet.id, text: 'Found the cause.' };
  assert.deepEqual(decodeAgentMessage(encodeAgentMessage(result, token), token, source), result);
  assert.equal(decodeAgentMessage('Milestone landed. work-1', token, target), null);
});

test('address exports require the current signed envelope version', () => {
  const current = issueAgentAddress(target, token);
  assert.equal(current.version, 2);
  assert.deepEqual(verifyAgentAddress(current, token), target);
  const signingKey = crypto.createHmac('sha256', token).update('discord-tether/agent-message/v1').digest();
  const legacyProof = crypto.createHmac('sha256', signingKey)
    .update(`address/v1\0${JSON.stringify(target)}`).digest('base64url');
  assert.deepEqual(verifyLegacyAgentAddress({ address: target, proof: legacyProof }, token), target);
  assert.throws(() => verifyAgentAddress({ address: target, proof: legacyProof }, token), /complete binding address/);
  assert.throws(() => verifyAgentAddress({ version: 2, address: target, proof: legacyProof }, token), /invalid agent address signature/);
});

test('forged contents, credentials and stale destination cannot authenticate', () => {
  const wire = encodeAgentMessage(packet, token);
  assert.throws(() => decodeAgentMessage(wire, 'different-credential', target), /signature/);
  const [prefixAndBody, mac] = wire.split('.');
  const bodyStart = prefixAndBody.lastIndexOf(':') + 1;
  const forged = prefixAndBody.slice(0, bodyStart) + Buffer.from(JSON.stringify({ ...packet, text: 'Forged instruction' })).toString('base64url') + '.' + mac;
  assert.throws(() => decodeAgentMessage(forged, token, target), /signature/);
  for (const change of [{ generation: 3 }, { channelId: '103' }, { nativeId: source.nativeId }, { provider: 'codex' }, { guildId: '200' }]) {
    assert.throws(() => decodeAgentMessage(wire, token, { ...target, ...change }), /target/);
  }
});

test('packet grammar prevents self-targeting, uncorrelated results and oversized input', () => {
  for (const change of [{ target: source }, { kind: KINDS.RESULT }, { replyTo: 'unexpected' }, { text: ' ' }, { authority: 'operator' }, { source: { ...source, generation: 0 } }]) {
    assert.throws(() => encodeAgentMessage({ ...packet, ...change }, token), /invalid/);
  }
  assert.throws(() => encodeAgentMessage({ ...packet, text: 'x'.repeat(2000) }, token), /encoded size \d+ characters, maximum 2000 characters/);
  const oversizedWire = PREFIX + 'x'.repeat(AGENT_MESSAGE_MAX_ENCODED_LENGTH - PREFIX.length + 1);
  assert.throws(() => decodeAgentMessage(oversizedWire, token, target), /encoded size 2001 characters, maximum 2000 characters/);
});

test('agent packet reports the measured encoded size and accepts the exact boundary', () => {
  let low = 1;
  let high = AGENT_MESSAGE_MAX_ENCODED_LENGTH;
  let boundary = null;
  while (low <= high) {
    const textLength = Math.floor((low + high) / 2);
    const candidate = { ...packet, text: 'x'.repeat(textLength) };
    try {
      boundary = { packet: candidate, wire: encodeAgentMessage(candidate, token) };
      low = textLength + 1;
    } catch (error) {
      assert.match(error.message, /encoded size \d+ characters, maximum 2000 characters/);
      high = textLength - 1;
    }
  }
  assert.ok(boundary);
  assert.equal(boundary.wire.length, AGENT_MESSAGE_MAX_ENCODED_LENGTH);
  assert.deepEqual(decodeAgentMessage(boundary.wire, token, target), boundary.packet);

  const oversizedPacket = { ...packet, text: `${boundary.packet.text}x` };
  const oversizedBody = Buffer.from(JSON.stringify(oversizedPacket)).toString('base64url');
  const signatureLength = boundary.wire.slice(boundary.wire.lastIndexOf('.') + 1).length;
  const expectedLength = PREFIX.length + oversizedBody.length + 1 + signatureLength;
  assert.ok(expectedLength > AGENT_MESSAGE_MAX_ENCODED_LENGTH);
  assert.throws(() => encodeAgentMessage(oversizedPacket, token), error => {
    assert.equal(error.message,
      `agent message exceeds Discord message limit: encoded size ${expectedLength} characters, maximum ${AGENT_MESSAGE_MAX_ENCODED_LENGTH} characters`);
    return true;
  });
});

test('agent-send help explains encoded size and variable text budget', () => {
  const cli = path.resolve(__dirname, '../src/cli.js');
  const result = require('node:child_process').spawnSync(process.execPath, [cli, 'agent-send', '--help'], {
    encoding: 'utf8', timeout: 5000
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /2000 encoded characters/);
  assert.match(result.stdout, /UTF-8 width/);
  assert.match(result.stdout, /JSON escaping/);
});

const fs = require('node:fs');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { SurfaceState, MESSAGE_STATES, READINESS } = require('../src/state');
const { recordNativeAcknowledgment } = require('../src/acknowledgment');
const { THREAD_STATES } = require('../src/state/thread-enrollment');
const { agentCompletionCommand, codexPrompt, claudeEvent, messageRequest } = require('../src/native');
const { staticConductorMarker } = require('../src/topic');
const { createMonitorMcp, monitorEvent } = require('../src/claude-monitor');

function enrollChild(state, parent, threadId, baseline = '7000') {
  let binding = state.getBinding(parent.channelId);
  binding = state.setBindingReadiness(parent.channelId, READINESS.READY, 'fixture ready', binding);
  state.enrollThread({ threadId, parentChannelId: parent.channelId, guildId: parent.guildId }, binding);
  if (baseline !== null) state.setThreadBaseline(threadId, baseline, binding);
  state.markThreadBoundary(threadId, THREAD_STATES.READY, 'fixture adoption', null, null, binding);
  return { ...parent, channelId: threadId, generation: binding.generation };
}

test('durable agent intake survives reopen, preserves provenance and deduplicates replay', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-packet-'));
  const db = path.join(dir, 'surface.sqlite');
  let state = new SurfaceState(db);
  try {
    state.setConfig({ operatorId: '900', guildId: target.guildId, secretFile: path.join(dir, 'secret') });
    state.bind({ ...target, workspace: dir, endpoint: path.join(dir, 'claude.sock') });
    const destination = enrollChild(state, target, '103', null);
    const addressed = { ...packet, target: destination };
    const event = { id: '1001', guildId: destination.guildId, channelId: destination.channelId, authorId: '901', isBot: true, attachments: [], content: encodeAgentMessage(addressed, token) };
    assert.equal(state.acceptDiscordMessage(event, { agentToken: 'wrong' }).accepted, false);
    const intake = state.acceptDiscordMessage(event, { agentToken: token });
    assert.equal(intake.accepted, true);
    assert.equal(intake.message.authorId, '901');
    assert.equal(state.currentMessageBinding(intake.message).current, true);
    assert.equal(state.acceptDiscordMessage({ ...event, id: '1002' }, { agentToken: token }).accepted, false);
    assert.equal(state.listMessages().length, 1);
    state.close();
    state = new SurfaceState(db);
    const restored = state.getMessage(event.id);
    assert.deepEqual(restored.agentMessage, addressed);
    assert.equal(state.currentMessageBinding(restored).current, true);
    assert.match(codexPrompt(restored), /not as the operator/);
    assert.match(claudeEvent(restored).content, /not as the operator/);
    assert.ok(codexPrompt(restored).includes(packet.text));
    assert.equal(state.acceptDiscordMessage({ ...event, id: '1003', content: 'Ordinary bot milestone' }, { agentToken: token }).accepted, false);
  } finally { state.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('agent packet dedupe compares the full source and target route', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-packet-route-dedupe-'));
  const state = new SurfaceState(path.join(dir, 'surface.sqlite'));
  try {
    state.setConfig({ operatorId: '900', guildId: target.guildId, secretFile: path.join(dir, 'secret') });
    state.bind({ ...target, workspace: dir, endpoint: '/tmp/agent-route-dedupe.sock' });
    const binding = state.getBinding(target.channelId);
    for (const threadId of ['103', '104']) {
      state.enrollThread({ threadId, parentChannelId: target.channelId, guildId: target.guildId }, binding);
      state.setThreadBaseline(threadId, '8000', binding);
      state.markThreadBoundary(threadId, THREAD_STATES.READY, 'fixture adoption', null, null, binding);
    }
    const sourceChild = { ...source, channelId: '201' };
    const otherSourceChild = { ...source, channelId: '202' };
    const targetChild = { ...target, channelId: '103', generation: binding.generation };
    const otherTargetChild = { ...target, channelId: '104', generation: binding.generation };
    const packetFor = (packetSource, packetTarget) => encodeAgentMessage({ ...packet, source: packetSource, target: packetTarget }, token);
    const first = { id: '8001', guildId: target.guildId, channelId: targetChild.channelId, authorId: '901', isBot: true, attachments: [],
      content: packetFor(sourceChild, targetChild) };
    const duplicate = { ...first, id: '8002' };
    const otherTarget = { ...first, id: '8003', channelId: otherTargetChild.channelId, content: packetFor(sourceChild, otherTargetChild) };
    const otherSource = { ...first, id: '8004', content: packetFor(otherSourceChild, targetChild) };
    assert.equal(state.acceptDiscordMessage(first, { agentToken: token }).accepted, true);
    assert.equal(state.acceptDiscordMessage(duplicate, { agentToken: token }).reason, 'agent-message-duplicate');
    assert.equal(state.acceptDiscordMessage(otherTarget, { agentToken: token }).accepted, true);
    assert.equal(state.acceptDiscordMessage(otherSource, { agentToken: token }).accepted, true);
    assert.equal(state.listMessages().length, 3);
    assert.deepEqual(state.listMessages().map(message => [message.channelId, message.deliveryChannelId]), [
      [target.channelId, targetChild.channelId], [target.channelId, otherTargetChild.channelId], [target.channelId, targetChild.channelId]
    ]);
  } finally { state.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Claude Monitor persists authenticated agent context and preserves human content', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-monitor-'));
  const db = path.join(dir, 'surface.sqlite');
  const state = new SurfaceState(db);
  const stdout = new EventEmitter();
  const events = [];
  stdout.write = (chunk, callback) => {
    events.push(JSON.parse(String(chunk)));
    callback?.();
    return true;
  };
  try {
    state.setConfig({ operatorId: '900', guildId: target.guildId, secretFile: path.join(dir, 'secret') });
    state.bind({ ...target, workspace: dir, endpoint: path.join(dir, 'claude.sock') });
    const destination = enrollChild(state, target, '103', null);
    const resultPacket = {
      ...packet,
      id: 'result-1',
      kind: KINDS.RESULT,
      target: destination,
      replyTo: packet.id,
      text: 'Result body from the authenticated sender.'
    };
    const agentId = 'agent-monitor-result';
    const agentEvent = {
      id: agentId,
      guildId: destination.guildId,
      channelId: destination.channelId,
      authorId: '901',
      isBot: true,
      attachments: [],
      content: encodeAgentMessage(resultPacket, token)
    };
    assert.equal(state.acceptDiscordMessage(agentEvent, { agentToken: token }).accepted, true);
    assert.equal(state.claimDispatch(agentId).claimed, true);
    state.markSubmitted(agentId);
    const trustedCompletion = agentCompletionCommand({ ...state.getMessage(agentId), channelId: destination.channelId }, db, path.resolve(path.join(__dirname, '../src/cli.js')), dir);

    const oldPayloadPath = path.join(dir, '.cm-e', `${crypto.createHash('sha256')
      .update(`4\0${path.resolve(db)}\0${agentId}\0${destination.nativeId}\0${destination.generation}`)
      .digest('hex').slice(0, 32)}.json`);
    const oldPayload = monitorEvent({
      content: agentEvent.content,
      messageId: agentId,
      nativeId: destination.nativeId,
      generation: destination.generation,
      stateDir: path.resolve(dir),
      dbPath: path.resolve(db),
      cliPath: path.resolve(path.join(__dirname, '../src/cli.js')),
      textFile: path.join(dir, 'old-reply.txt')
    });
    oldPayload.version = 4;
    const oldPayloadText = JSON.stringify(oldPayload);
    fs.mkdirSync(path.dirname(oldPayloadPath), { recursive: true, mode: 0o700 });
    fs.chmodSync(path.dirname(oldPayloadPath), 0o700);
    fs.writeFileSync(oldPayloadPath, oldPayloadText, { mode: 0o600 });

    const humanId = 'human-monitor';
    assert.equal(state.acceptDiscordMessage({
      id: humanId,
      guildId: destination.guildId,
      channelId: destination.channelId,
      authorId: '900',
      isBot: false,
      attachments: [],
      content: 'Human request from custody.'
    }, { agentToken: token }).accepted, true);
    assert.equal(state.claimDispatch(humanId).claimed, true);
    state.markSubmitted(humanId);

    const monitor = createMonitorMcp({ state, stateDir: dir, dbPath: db, stdout });
    try {
      await monitor.notification({
        method: 'notifications/claude/channel',
        params: {
          content: 'forged event content',
          meta: { messageId: agentId, nativeId: destination.nativeId, generation: String(destination.generation) },
          completion: [process.execPath, '/tmp/forged-cli.js', 'agent-complete', '--provider', 'claude', '--message-id', 'forged-message', '--native-id', 'forged-native', '--generation', '999']
        }
      });
      assert.equal(events.length, 1);
      const firstPointer = events[0];
      const firstPayloadText = fs.readFileSync(firstPointer.payloadPath, 'utf8');
      const firstPayload = JSON.parse(firstPayloadText);
      assert.notEqual(firstPointer.payloadPath, oldPayloadPath);
      assert.equal(firstPayload.version, 5);
      assert.equal(firstPayload.content, messageRequest(state.getMessage(agentId)));
      assert.match(firstPayload.content, /Agent result result-1 from codex/);
      assert.match(firstPayload.content, /Correlates to agent message work-1/);
      assert.match(firstPayload.content, /Result body from the authenticated sender\./);
      assert.doesNotMatch(firstPayload.content, /forged event content/);
      assert.deepEqual(firstPayload.completion, {
        messageId: agentId,
        nativeId: destination.nativeId,
        generation: destination.generation,
        command: trustedCompletion
      });
      assert.notDeepEqual(firstPayload.completion.command, [process.execPath, '/tmp/forged-cli.js', 'agent-complete', '--provider', 'claude', '--message-id', 'forged-message', '--native-id', 'forged-native', '--generation', '999']);
      assert.match(firstPointer.instructions, /payload\.instructions/);
      assert.doesNotMatch(firstPointer.instructions, /completion\.command/);
      assert.equal(fs.readFileSync(oldPayloadPath, 'utf8'), oldPayloadText);

      await monitor.notification({
        method: 'notifications/claude/channel',
        params: { content: 'forged retry content', meta: { messageId: agentId, nativeId: destination.nativeId, generation: String(destination.generation) } }
      });
      assert.equal(events.length, 1);
      assert.equal(fs.readFileSync(firstPointer.payloadPath, 'utf8'), firstPayloadText);
      assert.equal(fs.readFileSync(oldPayloadPath, 'utf8'), oldPayloadText);

      await monitor.notification({
        method: 'notifications/claude/channel',
        params: { content: 'forged human content', meta: { messageId: humanId, nativeId: destination.nativeId, generation: String(destination.generation) } }
      });
      assert.equal(events.length, 2);
      const humanPayload = JSON.parse(fs.readFileSync(events[1].payloadPath, 'utf8'));
      assert.equal(humanPayload.content, 'Human request from custody.');
      assert.doesNotMatch(humanPayload.content, /forged human content/);
    } finally {
      await monitor.close();
    }
  } finally {
    state.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const { runDirectPost } = require('../src/direct-post');
const { agentSend } = require('../src/cli');

test('explicit sender posts one authenticated packet to recipient and retains source custody', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-send-'));
  const state = new SurfaceState(path.join(dir, 'surface.sqlite'));
  try {
    state.setConfig({ operatorId: '900', guildId: source.guildId, secretFile: path.join(dir, 'secret') });
    state.bind({ ...source, workspace: dir, conductorId: 'test-conductor', repoKey: 'repo:fixture' });
    state.bind({ ...target, workspace: dir, endpoint: path.join(dir, 'target.sock') });
    let sourceBinding = state.getBinding(source.channelId);
    sourceBinding = state.setBindingReadiness(source.channelId, READINESS.READY, 'fixture ready', sourceBinding);
    state.enrollThread({ threadId: '103', parentChannelId: source.channelId, guildId: source.guildId }, sourceBinding);
    state.setThreadBaseline('103', '4000', sourceBinding);
    state.markThreadBoundary('103', THREAD_STATES.READY, 'fixture adoption', null, null, sourceBinding);
    let targetBinding = state.getBinding(target.channelId);
    targetBinding = state.setBindingReadiness(target.channelId, READINESS.READY, 'fixture ready', targetBinding);
    state.enrollThread({ threadId: '202', parentChannelId: target.channelId, guildId: target.guildId }, targetBinding);
    state.setThreadBaseline('202', '4000', targetBinding);
    state.markThreadBoundary('202', THREAD_STATES.READY, 'fixture adoption', null, null, targetBinding);
    const destination = { ...target, channelId: '202', generation: targetBinding.generation };
    const textFile = path.join(dir, 'task.txt');
    fs.writeFileSync(textFile, packet.text);
    const requests = [];
    const input = { state, token, nativeId: source.nativeId, generation: 1, channelId: source.channelId, provider: source.provider,
      agentThreadId: '103', textFile, dedupeKey: 'send-1', agentTarget: issueAgentAddress(destination, token),
      fetchImpl: async (url, options) => {
        requests.push({ url, body: options.method === 'GET' ? null : JSON.parse(options.body) });
        return { ok: true, status: 200, json: async () => options.method === 'GET'
          ? { id: destination.channelId, guild_id: destination.guildId }
          : { id: '5000' } };
      } };
    const sent = await runDirectPost(input);
    assert.equal(sent.status, 'sent');
    assert.equal(sent.channelId, destination.channelId);
    assert.equal(requests.length, 2);
    assert.ok(requests[0].url.endsWith(`/channels/${destination.channelId}`));
    assert.ok(requests[1].url.endsWith(`/channels/${destination.channelId}/messages`));
    const decoded = decodeAgentMessage(requests[1].body.content, token, destination);
    assert.equal(decoded.source.nativeId, source.nativeId);
    assert.equal(decoded.source.channelId, '103');
    assert.equal(decoded.text, packet.text);
    assert.equal(state.hasIntakeEvidence('5000'), false);
    const inbound = { id: '5000', guildId: destination.guildId, channelId: destination.channelId,
      authorId: '901', isBot: true, content: requests[1].body.content, attachments: [] };
    assert.equal(state.acceptDiscordMessage(inbound, { agentToken: token }).accepted, true);
    assert.equal(state.getMessage('5000').nativeId, target.nativeId);
    assert.equal(state.getMessage('5000').channelId, target.channelId);
    assert.equal(state.getMessage('5000').deliveryChannelId, destination.channelId);
    assert.equal(state.acceptDiscordMessage({ ...inbound, id: '5001' }, { agentToken: token }).accepted, false);

    assert.equal((await runDirectPost(input)).duplicate, true);
    assert.equal((await runDirectPost({ ...input, token: 'rotated-test-credential', agentTarget: issueAgentAddress(destination, 'rotated-test-credential') })).duplicate, true);
    assert.equal((await runDirectPost({ ...input, agentTarget: issueAgentAddress(Object.fromEntries(Object.entries(destination).reverse()), token) })).duplicate, true);
    assert.equal(requests.length, 2);
    assert.equal(state.directPostRows('send-1')[0].detail.channelId, source.channelId);
    await assert.rejects(runDirectPost({ ...input, agentTarget: issueAgentAddress({ ...target, generation: 3 }, token) }), /identity conflicts/);
    assert.equal(requests.length, 2);
  } finally { state.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('explicit sender uses an enrolled child as its signed source address', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-send-child-'));
  const state = new SurfaceState(path.join(dir, 'surface.sqlite'));
  try {
    state.setConfig({ operatorId: '900', guildId: source.guildId, secretFile: path.join(dir, 'secret') });
    state.bind({ ...source, workspace: dir, conductorId: 'source-conductor', repoKey: 'repo:fixture' });
    let parent = state.getBinding(source.channelId);
    parent = state.setBindingReadiness(source.channelId, READINESS.READY, 'fixture ready', parent);
    state.enrollThread({ threadId: '103', parentChannelId: source.channelId, guildId: source.guildId }, parent);
    state.setThreadBaseline('103', '7000', parent);
    state.markThreadBoundary('103', THREAD_STATES.READY, 'fixture adoption', null, null, parent);
    state.enrollThread({ threadId: '104', parentChannelId: source.channelId, guildId: source.guildId }, parent);
    state.setThreadBaseline('104', '7000', parent);
    state.markThreadBoundary('104', THREAD_STATES.READY, 'fixture adoption', null, null, parent);
    const textFile = path.join(dir, 'task.txt');
    fs.writeFileSync(textFile, packet.text);
    let wire;
    let calls = 0;
    const input = { state, token, nativeId: source.nativeId, generation: 1, channelId: source.channelId,
      provider: source.provider, agentThreadId: '103', textFile, dedupeKey: 'send-child', agentTarget: issueAgentAddress(target, token),
      fetchImpl: async (url, options) => {
        calls += 1;
        if (options.method === 'POST') wire = JSON.parse(options.body).content;
        return { ok: true, status: 200, json: async () => options.method === 'GET'
          ? { id: target.channelId, guild_id: target.guildId } : { id: '5200' } };
      } };
    const result = await runDirectPost(input);
    assert.equal(result.status, 'sent');
    const decoded = decodeAgentMessage(wire, token, target);
    assert.equal(decoded.source.channelId, '103');
    assert.equal(decoded.target.channelId, target.channelId);
    assert.equal(state.directPostRows('send-child')[0].detail.channelId, source.channelId);
    assert.equal(state.directPostRows('send-child')[0].detail.deliveryChannelId, target.channelId);
    const attempt = state.directPostRows('send-child').find(row => row.kind === 'direct-post-attempt').detail;
    assert.equal((await runDirectPost(input)).duplicate, true);
    assert.equal(calls, 2);
    assert.equal(state.directPostRows('send-child').filter(row => row.kind === 'direct-post-attempt').length, 1);
    assert.equal(state.directPostRows('send-child').find(row => row.kind === 'direct-post-attempt').detail.nonce, attempt.nonce);
    await assert.rejects(runDirectPost({ ...input, agentThreadId: '104' }), /identity conflicts/);
    await assert.rejects(runDirectPost({ ...input, agentTarget: issueAgentAddress({ ...target, channelId: '202' }, token) }), /identity conflicts/);
    assert.equal(calls, 2);
  } finally { state.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('child outbound unknown stays child-specific across SQLite reopen', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-send-child-unknown-'));
  const db = path.join(dir, 'surface.sqlite');
  let state = new SurfaceState(db);
  try {
    state.setConfig({ operatorId: '900', guildId: source.guildId, secretFile: path.join(dir, 'secret') });
    state.bind({ ...source, workspace: dir, conductorId: 'source-conductor', repoKey: 'repo:fixture' });
    let parent = state.getBinding(source.channelId);
    parent = state.setBindingReadiness(source.channelId, READINESS.READY, 'fixture ready', parent);
    state.enrollThread({ threadId: '103', parentChannelId: source.channelId, guildId: source.guildId }, parent);
    state.setThreadBaseline('103', '7000', parent);
    state.markThreadBoundary('103', THREAD_STATES.READY, 'fixture adoption', null, null, parent);
    const childTarget = { ...target, channelId: '202' };
    const textFile = path.join(dir, 'task.txt');
    fs.writeFileSync(textFile, packet.text);
    const calls = [];
    const fetchImpl = async (url, options) => {
      calls.push({ url, method: options.method });
      if (options.method === 'GET') {
        return { ok: true, status: 200, json: async () => ({ id: childTarget.channelId, guild_id: childTarget.guildId }) };
      }
      return { ok: false, status: 500, json: async () => ({}) };
    };
    const input = { state, token, nativeId: source.nativeId, generation: source.generation,
      channelId: source.channelId, provider: source.provider, agentThreadId: '103', textFile,
      dedupeKey: 'child-unknown-reopen', agentTarget: issueAgentAddress(childTarget, token), fetchImpl };
    const first = await runDirectPost(input);
    assert.equal(first.status, 'unknown');
    assert.equal(calls.length, 2);
    assert.equal(calls[1].url.endsWith(`/channels/${childTarget.channelId}/messages`), true);
    const firstAttempt = state.directPostRows('child-unknown-reopen').find(row => row.kind === 'direct-post-attempt').detail;
    assert.equal(firstAttempt.channelId, source.channelId);
    assert.equal(firstAttempt.deliveryChannelId, childTarget.channelId);
    state.close();
    state = new SurfaceState(db);
    const second = await runDirectPost({ ...input, state });
    assert.equal(second.status, 'unknown');
    assert.equal(second.duplicate, false);
    assert.equal(calls.length, 2);
    const rows = state.directPostRows('child-unknown-reopen');
    assert.equal(rows.filter(row => row.kind === 'direct-post-attempt').length, 1);
    assert.equal(rows.filter(row => row.kind === 'direct-post-outcome').length, 1);
    assert.equal(rows.find(row => row.kind === 'direct-post-attempt').detail.nonce, firstAttempt.nonce);
    assert.equal(rows.find(row => row.kind === 'direct-post-attempt').detail.channelId, source.channelId);
    assert.equal(rows.find(row => row.kind === 'direct-post-attempt').detail.deliveryChannelId, childTarget.channelId);
  } finally {
    try { state.close(); } catch {}
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  }
});

test('public destination export routes across separate installation databases', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-remote-target-'));
  const state = new SurfaceState(path.join(dir, 'sender.sqlite'));
  const receiver = new SurfaceState(path.join(dir, 'receiver.sqlite'));
  try {
    const secretFile = path.join(dir, 'secret');
    fs.writeFileSync(secretFile, `DISCORD_TOKEN=${token}\n`, { mode: 0o600 });
    for (const store of [state, receiver]) store.setConfig({ operatorId: '900', guildId: source.guildId, secretFile });
    state.bind({ ...source, workspace: dir, conductorId: 'source-conductor', repoKey: 'repo:fixture' });
    receiver.bind({ ...target, workspace: dir, endpoint: path.join(dir, 'target.sock'), conductorId: 'target-conductor', repoKey: 'repo:target' });
    const sourceChild = enrollChild(state, source, '103');
    const targetChild = enrollChild(receiver, target, '203', '5000');
    const binding = receiver.getBinding(target.channelId);
    const cli = path.resolve(__dirname, '../src/cli.js');
    const args = [cli, 'agent-address', '--db', path.join(dir, 'receiver.sqlite'), '--provider', target.provider,
      '--channel-id', target.channelId, '--agent-thread-id', targetChild.channelId,
      '--native-id', target.nativeId, '--generation', String(binding.generation)];
    const exported = require('node:child_process').spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 5000 });
    assert.equal(exported.status, 0, exported.stderr);
    const envelope = JSON.parse(exported.stdout);
    assert.equal(state.getBinding(target.channelId), null);
    const refused = require('node:child_process').spawnSync(process.execPath, [...args.slice(0, -1), '999'], { encoding: 'utf8', timeout: 5000 });
    assert.equal(refused.status, 1);
    const textFile = path.join(dir, 'task.txt');
    fs.writeFileSync(textFile, packet.text);
    let wire;
    const result = await runDirectPost({ state, token, nativeId: source.nativeId, generation: source.generation,
      channelId: source.channelId, provider: source.provider, agentThreadId: sourceChild.channelId,
      textFile, dedupeKey: 'remote-target', agentTarget: envelope,
      fetchImpl: async (_url, options) => {
        if (options.method === 'POST') wire = JSON.parse(options.body).content;
        return { ok: true, status: 200, json: async () => options.method === 'GET'
          ? { id: targetChild.channelId, guild_id: target.guildId } : { id: '5100' } };
      } });
    assert.equal(result.status, 'sent');
    const event = { id: '5100', guildId: target.guildId, channelId: targetChild.channelId, authorId: '901', isBot: true, content: wire, attachments: [] };
    assert.equal(receiver.acceptDiscordMessage(event, { agentToken: token }).accepted, true);
    assert.equal(receiver.acceptDiscordMessage({ ...event, id: '5101' }, { agentToken: token }).accepted, false);
    assert.equal(receiver.listMessages().length, 1);
  } finally { state.close(); receiver.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('public child destination export preserves parent authority across installations', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-remote-child-target-'));
  const state = new SurfaceState(path.join(dir, 'sender.sqlite'));
  const receiver = new SurfaceState(path.join(dir, 'receiver.sqlite'));
  try {
    const secretFile = path.join(dir, 'secret');
    fs.writeFileSync(secretFile, `DISCORD_TOKEN=${token}\n`, { mode: 0o600 });
    for (const store of [state, receiver]) store.setConfig({ operatorId: '900', guildId: source.guildId, secretFile });
    state.bind({ ...source, workspace: dir, conductorId: 'source-conductor', repoKey: 'repo:fixture' });
    receiver.bind({ ...target, workspace: dir, endpoint: '/tmp/agent-child-target.sock', conductorId: 'target-conductor', repoKey: 'repo:target' });
    const sourceChild = enrollChild(state, source, '105');
    const binding = receiver.getBinding(target.channelId);
    receiver.enrollThread({ threadId: '103', parentChannelId: target.channelId, guildId: target.guildId }, binding);
    receiver.setThreadBaseline('103', '5000', binding);
    receiver.markThreadBoundary('103', THREAD_STATES.READY, 'fixture adoption', null, null, binding);
    const cli = path.resolve(__dirname, '../src/cli.js');
    const args = [cli, 'agent-address', '--db', path.join(dir, 'receiver.sqlite'), '--provider', target.provider,
      '--channel-id', target.channelId, '--agent-thread-id', '103', '--native-id', target.nativeId, '--generation', String(binding.generation)];
    const exported = require('node:child_process').spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 5000 });
    assert.equal(exported.status, 0, exported.stderr);
    const envelope = JSON.parse(exported.stdout);
    assert.equal(envelope.address.channelId, '103');
    assert.equal(state.getBinding(target.channelId), null);
    const refused = require('node:child_process').spawnSync(process.execPath, [...args.slice(0, -1), '999'], { encoding: 'utf8', timeout: 5000 });
    assert.equal(refused.status, 1);
    const textFile = path.join(dir, 'task.txt');
    fs.writeFileSync(textFile, packet.text);
    let wire;
    const result = await runDirectPost({ state, token, nativeId: source.nativeId, generation: source.generation,
      channelId: source.channelId, provider: source.provider, agentThreadId: sourceChild.channelId,
      textFile, dedupeKey: 'remote-child-target', agentTarget: envelope,
      fetchImpl: async (_url, options) => {
        if (options.method === 'POST') wire = JSON.parse(options.body).content;
        return { ok: true, status: 200, json: async () => options.method === 'GET'
          ? { id: envelope.address.channelId, guild_id: target.guildId } : { id: '5100' } };
      } });
    assert.equal(result.status, 'sent');
    const event = { id: '5100', guildId: target.guildId, channelId: envelope.address.channelId, authorId: '901', isBot: true, content: wire, attachments: [] };
    assert.equal(receiver.acceptDiscordMessage(event, { agentToken: token }).accepted, true);
    assert.equal(receiver.acceptDiscordMessage({ ...event, id: '5101' }, { agentToken: token }).accepted, false);
    assert.equal(receiver.listMessages().length, 1);
    assert.equal(receiver.getMessage('5100').channelId, target.channelId);
    assert.equal(receiver.getMessage('5100').deliveryChannelId, envelope.address.channelId);
  } finally { state.close(); receiver.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('agent sender rejects a channel outside the declared destination guild before posting', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-channel-check-'));
  const state = new SurfaceState(path.join(dir, 'surface.sqlite'));
  try {
    state.setConfig({ operatorId: '900', guildId: source.guildId, secretFile: path.join(dir, 'secret') });
    state.bind({ ...source, workspace: dir, conductorId: 'test-conductor', repoKey: 'repo:fixture' });
    state.bind({ ...target, workspace: dir, endpoint: path.join(dir, 'target.sock') });
    const sourceChild = enrollChild(state, source, '103');
    const textFile = path.join(dir, 'task.txt');
    fs.writeFileSync(textFile, packet.text);
    const calls = [];
    const result = await runDirectPost({ state, token, nativeId: source.nativeId, generation: 1, channelId: source.channelId,
      provider: source.provider, agentThreadId: sourceChild.channelId, textFile, dedupeKey: 'guild-check', agentTarget: issueAgentAddress(target, token),
      fetchImpl: async (url, options) => {
        calls.push({ url, method: options.method });
        return { ok: true, status: 200, json: async () => ({ id: target.channelId, guild_id: '999' }) };
      } });
    assert.equal(result.status, 'not_sent');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'GET');
  } finally { state.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('agent sender retries after a destination lookup failure classified as unsent', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-lookup-retry-'));
  const state = new SurfaceState(path.join(dir, 'surface.sqlite'));
  try {
    state.setConfig({ operatorId: '900', guildId: source.guildId, secretFile: path.join(dir, 'secret') });
    state.bind({ ...source, workspace: dir, conductorId: 'test-conductor', repoKey: 'repo:fixture' });
    const sourceChild = enrollChild(state, source, '103');
    const textFile = path.join(dir, 'task.txt');
    fs.writeFileSync(textFile, packet.text);
    const input = { state, token, nativeId: source.nativeId, generation: source.generation, channelId: source.channelId,
      provider: source.provider, agentThreadId: sourceChild.channelId, textFile, dedupeKey: 'lookup-retry', agentTarget: issueAgentAddress(target, token) };
    let attemptsDuringLookup = null;
    const first = await runDirectPost({ ...input, fetchImpl: async (_url, options) => {
      if (options.method === 'GET') attemptsDuringLookup = state.directPostRows('lookup-retry').filter(row => row.kind === 'direct-post-attempt').length;
      throw new Error('temporary lookup outage');
    } });
    assert.equal(first.status, 'not_sent');
    assert.equal(attemptsDuringLookup, 0);
    const firstRows = state.directPostRows('lookup-retry');
    assert.equal(firstRows.filter(row => row.kind === 'direct-post-attempt').length, 0);
    assert.equal(firstRows.find(row => row.kind === 'direct-post-outcome').detail.outcome, 'not_sent');
    const second = await runDirectPost({ ...input, fetchImpl: async (url, options) => ({ ok: true, status: 200, json: async () => options.method === 'GET'
      ? { id: target.channelId, guild_id: target.guildId } : { id: '5200' } }) });
    assert.equal(second.status, 'sent');
  } finally { state.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

const { createSurfaceConsumer } = require('../src/discord');

test('agent nonces include source and destination identity', async () => {
  const nonces = [];
  const cases = [
    { source, target: { ...target, channelId: '102' } },
    { source, target: { ...target, channelId: '103' } },
    { source: { ...source, channelId: '104' }, target: { ...target, channelId: '102' } }
  ];
  for (const [index, testCase] of cases.entries()) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-nonce-'));
    const state = new SurfaceState(path.join(dir, 'surface.sqlite'));
    try {
      state.setConfig({ operatorId: '900', guildId: testCase.source.guildId, secretFile: path.join(dir, 'secret') });
      state.bind({ ...testCase.source, workspace: dir, conductorId: 'fixture', repoKey: 'repo:fixture' });
      state.bind({ ...testCase.target, workspace: dir, endpoint: path.join(dir, 'target.sock') });
      const sourceChild = enrollChild(state, testCase.source, String(201 + index));
      const destination = { ...testCase.target, generation: state.getBinding(testCase.target.channelId).generation };
      const textFile = path.join(dir, 'task.txt');
      fs.writeFileSync(textFile, packet.text);
      const result = await runDirectPost({ state, token, nativeId: testCase.source.nativeId, generation: testCase.source.generation,
        channelId: testCase.source.channelId, provider: testCase.source.provider, agentThreadId: sourceChild.channelId, textFile, dedupeKey: 'same-key',
        agentTarget: issueAgentAddress(destination, token), fetchImpl: async (url, options) => {
          if (options.method === 'GET') return { ok: true, status: 200, json: async () => ({ id: destination.channelId, guild_id: destination.guildId }) };
          nonces.push(JSON.parse(options.body).nonce);
          return { ok: true, status: 200, json: async () => ({ id: '5000' }) };
        } });
      assert.equal(result.status, 'sent');
    } finally { state.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  }
  assert.equal(nonces.length, cases.length);
  assert.equal(new Set(nonces).size, cases.length);
});

test('history consumer verifies credential before durable intake', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-history-'));
  const state = new SurfaceState(path.join(dir, 'surface.sqlite'));
  try {
    state.setConfig({ operatorId: '900', guildId: target.guildId, secretFile: path.join(dir, 'secret') });
    state.bind({ ...target, workspace: dir, endpoint: path.join(dir, 'claude.sock') });
    const destination = enrollChild(state, target, '103', null);
    const consumer = createSurfaceConsumer({ state, providers: {}, agentCredential: () => token });
    const content = encodeAgentMessage({ ...packet, target: destination }, token);
    const incoming = { id: '7000', guildId: target.guildId, channelId: destination.channelId, author: { id: '901', bot: true }, content };
    const accepted = await consumer.intakeMessage(incoming, false);
    assert.equal(accepted.accepted, true);
    assert.deepEqual(accepted.message.agentMessage.source, source);
    assert.equal((await consumer.intakeMessage({ ...incoming, id: '7001' }, false)).accepted, false);
    assert.equal(state.listMessages().length, 1);
  } finally { state.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('public agent-send command reaches authenticated outbound transport', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-cli-'));
  const db = path.join(dir, 'surface.sqlite');
  const state = new SurfaceState(db);
  try {
    const secret = path.join(dir, 'secret');
    fs.writeFileSync(secret, `DISCORD_TOKEN=${token}\n`, { mode: 0o600 });
    state.setConfig({ operatorId: '900', guildId: source.guildId, secretFile: secret });
    state.bind({ ...source, workspace: dir, conductorId: 'test-conductor', repoKey: 'repo:fixture' });
    state.bind({ ...target, workspace: dir, endpoint: path.join(dir, 'target.sock') });
    let sourceBinding = state.getBinding(source.channelId);
    sourceBinding = state.setBindingReadiness(source.channelId, READINESS.READY, 'fixture ready', sourceBinding);
    state.enrollThread({ threadId: '103', parentChannelId: source.channelId, guildId: source.guildId }, sourceBinding);
    state.setThreadBaseline('103', '7000', sourceBinding);
    state.markThreadBoundary('103', THREAD_STATES.READY, 'fixture adoption', null, null, sourceBinding);
    let targetBinding = state.getBinding(target.channelId);
    targetBinding = state.setBindingReadiness(target.channelId, READINESS.READY, 'fixture ready', targetBinding);
    state.enrollThread({ threadId: '202', parentChannelId: target.channelId, guildId: target.guildId }, targetBinding);
    state.setThreadBaseline('202', '7000', targetBinding);
    state.markThreadBoundary('202', THREAD_STATES.READY, 'fixture adoption', null, null, targetBinding);
    const destination = path.join(dir, 'destination.json');
    const textFile = path.join(dir, 'text.txt');
    fs.writeFileSync(destination, JSON.stringify(issueAgentAddress({ ...target, channelId: '202' }, token)));
    fs.writeFileSync(textFile, 'CLI task');
    const cli = path.resolve(__dirname, '../src/cli.js');
    const argv = [process.execPath, cli, 'agent-send', '--db', db, '--provider', source.provider,
      '--channel-id', source.channelId, '--native-id', source.nativeId, '--generation', '1',
      '--agent-thread-id', '103',
      '--target-file', destination, '--text-file', textFile, '--dedupe-key', 'cli-1'];
    const script = `process.argv=${JSON.stringify(argv)};
      globalThis.fetch=async(url,options)=>{
        if (options.method === 'GET') {
          if (!String(url).endsWith('/channels/202')) throw new Error('wrong destination');
          return {ok:true,status:200,json:async()=>({id:'202',guild_id:'100'})};
        }
        if (!String(url).endsWith('/channels/202/messages')) throw new Error('wrong destination');
        if (!JSON.parse(options.body).content.startsWith('discord-tether:agent:v1:')) throw new Error('unsigned payload');
        return {ok:true,status:200,json:async()=>({id:'8000'})};
      };
      require(${JSON.stringify(cli)}).main().catch(e=>{console.error(e);process.exitCode=1});`;
    const noChildArgv = argv.filter((value, index) => value !== '--agent-thread-id' && argv[index - 1] !== '--agent-thread-id')
      .map(value => value === 'cli-1' ? 'cli-no-child' : value);
    const noChildScript = script.replace(JSON.stringify(argv), JSON.stringify(noChildArgv));
    const noChild = require('node:child_process').spawnSync(process.execPath, ['-e', noChildScript], { encoding: 'utf8', timeout: 5000 });
    assert.equal(noChild.status, 1);
    assert.match(noChild.stderr, /agent messages require --agent-thread-id/);
    assert.equal(state.directPostRows('cli-no-child').length, 0);
    for (const invalid of [null, false, '', {}, { ...target, generation: 0 }]) {
      fs.writeFileSync(destination, JSON.stringify(invalid));
      const refused = require('node:child_process').spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 5000 });
      assert.equal(refused.status, 1);
      assert.equal(state.directPostRows('cli-1').length, 0);
      assert.match(refused.stderr, /complete binding address/);
    }
    fs.writeFileSync(destination, JSON.stringify(issueAgentAddress({ ...target, channelId: '202' }, token)));
    const child = require('node:child_process').spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 5000 });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(JSON.parse(child.stdout).status, 'sent');
    assert.equal(state.directPostRows('cli-1').at(-1).detail.messageId, '8000');

    const request = { ...packet, id: 'cli-request', source: { ...target, channelId: '202' }, target: { ...source, channelId: '103' } };
    assert.equal(state.acceptDiscordMessage({ id: '8050', guildId: source.guildId, channelId: '103',
      authorId: '901', isBot: true, attachments: [], content: encodeAgentMessage(request, token) }, { agentToken: token }).accepted, true);
    const replyText = path.join(dir, 'reply.txt');
    fs.writeFileSync(replyText, 'CLI result');
    const replyArgv = [process.execPath, cli, 'agent-send', '--db', db, '--provider', source.provider,
      '--channel-id', source.channelId, '--native-id', source.nativeId, '--generation', '1',
      '--agent-thread-id', '103',
      '--text-file', replyText, '--dedupe-key', 'cli-result', '--agent-reply-to', request.id];
    const replyScript = script.replace(JSON.stringify(argv), JSON.stringify(replyArgv));
    const reply = require('node:child_process').spawnSync(process.execPath, ['-e', replyScript], { encoding: 'utf8', timeout: 5000 });
    assert.equal(reply.status, 0, reply.stderr);
    assert.equal(JSON.parse(reply.stdout).status, 'sent');
    assert.equal(state.directPostRows('cli-result').at(-1).detail.messageId, '8000');

    const emptyReplyArgv = [...argv.map(value => value === 'cli-1' ? 'cli-empty-reply' : value), '--agent-reply-to='];
    const emptyReplyScript = script.replace(JSON.stringify(argv), JSON.stringify(emptyReplyArgv));
    const emptyReply = require('node:child_process').spawnSync(process.execPath, ['-e', emptyReplyScript], { encoding: 'utf8', timeout: 5000 });
    assert.equal(emptyReply.status, 1);
    assert.match(emptyReply.stderr, /agent reply correlation must not be empty/);

    fs.writeFileSync(destination, 'x'.repeat(2049));
    const oversizedTarget = require('node:child_process').spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 5000 });
    assert.equal(oversizedTarget.status, 1);
    assert.match(oversizedTarget.stderr, /agent target file is too large/);

    const targetDirectory = path.join(dir, 'target-directory');
    fs.mkdirSync(targetDirectory);
    const directoryArgv = argv.map(value => value === destination ? targetDirectory : value);
    const directoryScript = script.replace(JSON.stringify(argv), JSON.stringify(directoryArgv));
    const directoryTarget = require('node:child_process').spawnSync(process.execPath, ['-e', directoryScript], { encoding: 'utf8', timeout: 5000 });
    assert.equal(directoryTarget.status, 1);
    assert.match(directoryTarget.stderr, /agent target file must be a regular file/);
  } finally { state.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('agent routes refuse the parent channel before custody or network access', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-parent-fallback-'));
  const state = new SurfaceState(path.join(dir, 'surface.sqlite'));
  try {
    const secretFile = path.join(dir, 'secret');
    fs.writeFileSync(secretFile, `DISCORD_TOKEN=${token}\n`, { mode: 0o600 });
    state.setConfig({ operatorId: '900', guildId: source.guildId, secretFile: secretFile });
    state.bind({ ...source, workspace: dir, conductorId: 'source-conductor', repoKey: 'repo:source' });
    state.bind({ ...target, workspace: dir, endpoint: path.join(dir, 'target.sock'), conductorId: 'target-conductor', repoKey: 'repo:target' });
    const textFile = path.join(dir, 'task.txt');
    fs.writeFileSync(textFile, packet.text);
    let fetches = 0;
    await assert.rejects(runDirectPost({
      state,
      token,
      nativeId: source.nativeId,
      generation: source.generation,
      channelId: source.channelId,
      provider: source.provider,
      textFile,
      dedupeKey: 'parent-fallback',
      agentTarget: issueAgentAddress(target, token),
      fetchImpl: async () => {
        fetches += 1;
        throw new Error('network must not be reached');
      }
    }), /agent messages require --agent-thread-id for an actively enrolled child route/);
    assert.equal(fetches, 0);
    assert.equal(state.directPostRows('parent-fallback').length, 0);
    const cli = path.resolve(__dirname, '../src/cli.js');
    const address = require('node:child_process').spawnSync(process.execPath, [cli, 'agent-address', '--db', path.join(dir, 'surface.sqlite'),
      '--provider', target.provider, '--channel-id', target.channelId, '--native-id', target.nativeId, '--generation', String(target.generation)], {
      encoding: 'utf8', timeout: 5000
    });
    assert.equal(address.status, 1);
    assert.match(address.stderr, /agent messages require --agent-thread-id/);
  } finally { state.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('retries return pre-upgrade parent-sourced outcomes without child migration or resend', async () => {
  for (const outcome of ['sent', 'unknown']) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `agent-legacy-retry-${outcome}-`));
    const state = new SurfaceState(path.join(dir, 'surface.sqlite'));
    try {
      state.setConfig({ operatorId: '900', guildId: source.guildId, secretFile: path.join(dir, 'secret') });
      state.bind({ ...source, workspace: dir, conductorId: 'fixture', repoKey: 'repo:fixture' });
      const requestId = `legacy-${outcome}`;
      const legacyPacket = { ...packet, id: requestId, source, target };
      const attempt = {
        journal: 'direct-post-v1', requestId, attemptId: `${requestId}-attempt`, sourcePath: path.join(dir, 'missing.txt'),
        textHash: crypto.createHash('sha256').update(JSON.stringify(legacyPacket)).digest('hex'), operatorId: '900',
        partHash: 'legacy-part-hash', channelId: source.channelId, guildId: source.guildId, provider: source.provider,
        nativeId: source.nativeId, generation: source.generation, conductorId: 'fixture', repoKey: 'repo:fixture',
        partIndex: 0, partCount: 1, nonce: `${requestId}-nonce`, deliveryChannelId: target.channelId,
        presentation: 'legacy', agentPacket: legacyPacket, status: 'attempted'
      };
      state.receipt(null, 'direct-post-attempt', attempt);
      state.receipt(null, 'direct-post-outcome', { ...attempt, outcome, ...(outcome === 'sent' ? { messageId: `${requestId}-message` } : {}) });
      const legacyEnvelope = { address: target, proof: 'A'.repeat(43) };
      let networkCalls = 0;
      const result = await runDirectPost({ state, token, nativeId: source.nativeId, generation: source.generation,
        channelId: source.channelId, provider: source.provider, requestId,
        textFile: path.relative(process.cwd(), path.join(dir, 'missing.txt')),
        agentTarget: legacyEnvelope, fetchImpl: async () => { networkCalls += 1; throw new Error('legacy retry must not send'); } });
      assert.equal(result.status, outcome);
      assert.equal(result.duplicate, outcome === 'sent');
      assert.deepEqual(result.messageIds, outcome === 'sent' ? [`${requestId}-message`] : []);
      assert.equal(networkCalls, 0);
      assert.equal(state.listReceipts().filter(row => row.kind === 'direct-post-attempt' || row.kind === 'direct-post-outcome').length, 2);
    } finally { state.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  }
});

test('retryable pre-upgrade custody requires a child route before resend', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-legacy-retryable-'));
  const state = new SurfaceState(path.join(dir, 'surface.sqlite'));
  try {
    state.setConfig({ operatorId: '900', guildId: source.guildId, secretFile: path.join(dir, 'secret') });
    state.bind({ ...source, workspace: dir, conductorId: 'fixture', repoKey: 'repo:fixture' });
    const requestId = 'legacy-not-sent';
    const legacyPacket = { ...packet, id: requestId, source, target };
    const attempt = {
      journal: 'direct-post-v1', requestId, attemptId: `${requestId}-attempt`, sourcePath: path.join(dir, 'missing.txt'),
      textHash: crypto.createHash('sha256').update(JSON.stringify(legacyPacket)).digest('hex'), operatorId: '900',
      partHash: 'legacy-part-hash', channelId: source.channelId, guildId: source.guildId, provider: source.provider,
      nativeId: source.nativeId, generation: source.generation, conductorId: 'fixture', repoKey: 'repo:fixture',
      partIndex: 0, partCount: 1, nonce: `${requestId}-nonce`, deliveryChannelId: target.channelId,
      presentation: 'legacy', agentPacket: legacyPacket, status: 'attempted'
    };
    state.receipt(null, 'direct-post-attempt', attempt);
    state.receipt(null, 'direct-post-outcome', { ...attempt, outcome: 'not_sent' });
    let networkCalls = 0;
    await assert.rejects(runDirectPost({ state, token, nativeId: source.nativeId, generation: source.generation,
      channelId: source.channelId, provider: source.provider, requestId, textFile: path.join(dir, 'missing.txt'),
      agentTarget: { address: target, proof: crypto.createHmac('sha256', crypto.createHmac('sha256', token)
        .update('discord-tether/agent-message/v1').digest()).update(`address/v1\0${JSON.stringify(target)}`).digest('base64url') },
      fetchImpl: async () => { networkCalls += 1; throw new Error('legacy retry must not reach network'); } }),
    /agent messages require --agent-thread-id/);
    assert.equal(networkCalls, 0);
  } finally { state.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});


test('invalid destination proof refuses before custody and source revocation during lookup prevents POST', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-proof-'));
  const state = new SurfaceState(path.join(dir, 'surface.sqlite'));
  try {
    state.setConfig({ operatorId: '900', guildId: source.guildId, secretFile: path.join(dir, 'secret') });
    state.bind({ ...source, workspace: dir, conductorId: 'fixture', repoKey: 'repo:fixture' });
    const sourceChild = enrollChild(state, source, '103');
    const textFile = path.join(dir, 'task.txt');
    fs.writeFileSync(textFile, packet.text);
    let posts = 0;
    const input = { state, token, nativeId: source.nativeId, generation: 1, channelId: source.channelId,
      provider: source.provider, agentThreadId: sourceChild.channelId, textFile, dedupeKey: 'proof-check', agentTarget: issueAgentAddress(target, token),
      fetchImpl: async (_url, options) => {
        if (options.method === 'POST') posts++;
        state.unbind(source.channelId);
        return { ok: true, status: 200, json: async () => ({ id: target.channelId, guild_id: target.guildId }) };
      } };
    for (const change of [{ guildId: '200' }, { channelId: '103' }, { provider: 'codex' }, { nativeId: source.nativeId }, { generation: 3 }]) {
      await assert.rejects(runDirectPost({ ...input, agentTarget: { ...input.agentTarget, address: { ...target, ...change } } }), /signature/);
    }
    await assert.rejects(runDirectPost({ ...input, agentTarget: target }), /proof/);
    assert.equal(state.directPostRows('proof-check').length, 0);
    const result = await runDirectPost(input);
    assert.equal(result.status, 'stale');
    assert.equal(posts, 0);
    assert.equal(state.directPostRows('proof-check').at(-1).detail.outcome, 'stale');
  } finally { state.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('source child revocation after destination lookup refuses before custody or POST', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-child-proof-'));
  const state = new SurfaceState(path.join(dir, 'surface.sqlite'));
  try {
    state.setConfig({ operatorId: '900', guildId: source.guildId, secretFile: path.join(dir, 'secret') });
    state.bind({ ...source, workspace: dir, conductorId: 'fixture', repoKey: 'repo:fixture' });
    let binding = state.getBinding(source.channelId);
    binding = state.setBindingReadiness(source.channelId, READINESS.READY, 'fixture ready', binding);
    state.enrollThread({ threadId: '103', parentChannelId: source.channelId, guildId: source.guildId }, binding);
    state.setThreadBaseline('103', '7000', binding);
    state.markThreadBoundary('103', THREAD_STATES.READY, 'fixture adoption', null, null, binding);
    const textFile = path.join(dir, 'task.txt');
    fs.writeFileSync(textFile, packet.text);
    let posts = 0;
    const result = await runDirectPost({ state, token, nativeId: source.nativeId, generation: 1, channelId: source.channelId,
      provider: source.provider, agentThreadId: '103', textFile, dedupeKey: 'child-proof', agentTarget: issueAgentAddress(target, token),
      fetchImpl: async (_url, options) => {
        if (options.method === 'POST') posts += 1;
        else state.markThreadBoundary('103', THREAD_STATES.UNAVAILABLE, 'child revoked during destination lookup', null, null, binding);
        return { ok: true, status: 200, json: async () => ({ id: target.channelId, guild_id: target.guildId }) };
      } });
    assert.equal(result.status, 'stale');
    assert.equal(posts, 0);
    assert.equal(state.directPostRows('child-proof').filter(row => row.kind === 'direct-post-attempt').length, 0);
    assert.equal(state.directPostRows('child-proof').find(row => row.kind === 'direct-post-outcome').detail.outcome, 'stale');
  } finally { state.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('source child revocation after rejected destination lookup records stale custody', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-child-rejected-lookup-'));
  const state = new SurfaceState(path.join(dir, 'surface.sqlite'));
  try {
    state.setConfig({ operatorId: '900', guildId: source.guildId, secretFile: path.join(dir, 'secret') });
    state.bind({ ...source, workspace: dir, conductorId: 'fixture', repoKey: 'repo:fixture' });
    let binding = state.getBinding(source.channelId);
    binding = state.setBindingReadiness(source.channelId, READINESS.READY, 'fixture ready', binding);
    state.enrollThread({ threadId: '103', parentChannelId: source.channelId, guildId: source.guildId }, binding);
    state.setThreadBaseline('103', '7000', binding);
    state.markThreadBoundary('103', THREAD_STATES.READY, 'fixture adoption', null, null, binding);
    const textFile = path.join(dir, 'task.txt');
    fs.writeFileSync(textFile, packet.text);
    let posts = 0;
    const result = await runDirectPost({ state, token, nativeId: source.nativeId, generation: 1, channelId: source.channelId,
      provider: source.provider, agentThreadId: '103', textFile, dedupeKey: 'child-rejected-lookup', agentTarget: issueAgentAddress(target, token),
      fetchImpl: async (_url, options) => {
        if (options.method === 'POST') posts += 1;
        else {
          state.markThreadBoundary('103', THREAD_STATES.UNAVAILABLE, 'child revoked during rejected destination lookup', null, null, binding);
          throw Object.assign(new Error('destination lookup rejected after source revocation'), { outcome: 'not_sent', status: 404 });
        }
        return { ok: true, status: 200, json: async () => ({ id: target.channelId, guild_id: target.guildId }) };
      } });
    assert.equal(result.status, 'stale');
    assert.equal(posts, 0);
    assert.equal(state.directPostRows('child-rejected-lookup').filter(row => row.kind === 'direct-post-attempt').length, 0);
    assert.equal(state.directPostRows('child-rejected-lookup').find(row => row.kind === 'direct-post-outcome').detail.outcome, 'stale');
  } finally { state.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('results reverse an accepted request and reject unrelated or unknown correlation before custody', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-result-'));
  const state = new SurfaceState(path.join(dir, 'surface.sqlite'));
  try {
    state.setConfig({ operatorId: '900', guildId: source.guildId, secretFile: path.join(dir, 'secret') });
    state.bind({ ...source, workspace: dir, conductorId: 'fixture', repoKey: 'repo:fixture' });
    const sourceChild = enrollChild(state, source, '103');
    const request = { ...packet, source: target, target: sourceChild };
    const intake = state.acceptDiscordMessage({ id: '8100', guildId: source.guildId, channelId: sourceChild.channelId,
      authorId: '901', isBot: true, attachments: [], content: encodeAgentMessage(request, token) }, { agentToken: token });
    assert.equal(intake.accepted, true);
    const textFile = path.join(dir, 'result.txt');
    fs.writeFileSync(textFile, 'Useful result');
    let calls = 0;
    const input = { state, token, nativeId: source.nativeId, generation: 1, channelId: source.channelId,
      provider: source.provider, agentThreadId: sourceChild.channelId, textFile, dedupeKey: 'result-check', agentTarget: request.source,
      agentKind: KINDS.RESULT, agentReplyTo: request.id,
      fetchImpl: async (_url, options) => {
        calls++;
        return { ok: true, status: 200, json: async () => options.method === 'GET'
          ? { id: target.channelId, guild_id: target.guildId } : { id: '8200' } };
      } };
    await assert.rejects(runDirectPost({ ...input, agentTarget: issueAgentAddress({ ...target, channelId: '103' }, token) }), /does not match/);
    await assert.rejects(runDirectPost({ ...input, agentReplyTo: 'missing' }), /unknown/);
    assert.equal(calls, 0);
    assert.equal(state.directPostRows('result-check').length, 0);
    assert.equal((await runDirectPost(input)).status, 'sent');
    const resultRows = state.directPostRows('result-check');
    const resultPacket = { id: 'result-check', kind: KINDS.RESULT, source: sourceChild, target, replyTo: request.id, text: 'Useful result', routingVersion: 2, sourceParentChannelId: source.channelId };
    assert.deepEqual(resultRows.find(row => row.kind === 'direct-post-attempt').detail.agentPacket, resultPacket);
    assert.deepEqual(resultRows.find(row => row.kind === 'direct-post-outcome').detail.agentPacket, resultPacket);
    assert.equal((await runDirectPost(input)).duplicate, true);
    assert.equal((await runDirectPost({ ...input, dedupeKey: 'result-no-target', agentTarget: null })).status, 'sent');
    assert.equal(calls, 4);
  } finally { state.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('results can answer a parent-targeted request accepted before child routing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-result-legacy-parent-'));
  const state = new SurfaceState(path.join(dir, 'surface.sqlite'));
  try {
    state.setConfig({ operatorId: '900', guildId: source.guildId, secretFile: path.join(dir, 'secret') });
    state.bind({ ...source, workspace: dir, conductorId: 'fixture', repoKey: 'repo:fixture' });
    const request = { ...packet, id: 'legacy-parent-request', source: target, target: source };
    const binding = state.getBinding(source.channelId);
    const content = encodeAgentMessage(request, token);
    const timestamp = new Date().toISOString();
    state.db.prepare(`INSERT INTO messages(discord_id, guild_id, channel_id, delivery_channel_id, author_id, content, attachments, provider, native_id, workspace, endpoint, conductor_id, repo_key, generation, state, created_at, updated_at)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      '8102', request.target.guildId, source.channelId, source.channelId, '901', content, '[]', binding.provider, binding.nativeId,
      binding.workspace, binding.endpoint, binding.conductorId, binding.repoKey, binding.generation, MESSAGE_STATES.ACCEPTED, timestamp, timestamp
    );
    state.receipt('8102', 'agent-message', { packet: request, authorId: '901' });
    state.receipt('8102', 'accepted', { channelId: source.channelId, conductorId: binding.conductorId, generation: binding.generation, readiness: 'ready' });
    const sourceChild = enrollChild(state, source, '103');
    const textFile = path.join(dir, 'result.txt');
    fs.writeFileSync(textFile, 'Legacy result');
    const calls = [];
    let wire;
    const result = await runDirectPost({ state, token, nativeId: source.nativeId, generation: 1,
      channelId: source.channelId, provider: source.provider, agentThreadId: sourceChild.channelId, textFile,
      dedupeKey: 'legacy-parent-result', agentKind: KINDS.RESULT, agentReplyTo: request.id,
      fetchImpl: async (url, options) => {
        calls.push({ url, method: options.method });
        if (options.method === 'POST') wire = JSON.parse(options.body).content;
        return { ok: true, status: 200, json: async () => options.method === 'GET'
          ? { id: target.channelId, guild_id: target.guildId } : { id: '8202' } };
      } });
    assert.equal(result.status, 'sent');
    assert.equal(calls.length, 2);
    assert.ok(calls[0].url.endsWith(`/channels/${target.channelId}`));
    assert.ok(calls[1].url.endsWith(`/channels/${target.channelId}/messages`));
    assert.deepEqual(decodeAgentMessage(wire, token, target), {
      id: 'legacy-parent-result', kind: KINDS.RESULT, source: sourceChild, target,
      replyTo: request.id, text: 'Legacy result', routingVersion: 2, sourceParentChannelId: source.channelId
    });
    const postUpgradeRequest = { ...packet, id: 'post-upgrade-parent-request', source: target, target: source };
    assert.equal(state.acceptDiscordMessage({ id: '8103', guildId: source.guildId, channelId: source.channelId,
      authorId: '901', isBot: true, attachments: [], content: encodeAgentMessage(postUpgradeRequest, token) }, { agentToken: token }).accepted, false);
    await assert.rejects(runDirectPost({ state, token, nativeId: source.nativeId, generation: 1,
      channelId: source.channelId, provider: source.provider, agentThreadId: sourceChild.channelId, textFile,
      dedupeKey: 'post-upgrade-parent-result', agentKind: KINDS.RESULT, agentReplyTo: postUpgradeRequest.id,
      fetchImpl: async () => { throw new Error('post-upgrade parent request must not send'); } }), /unknown or does not match/);
  } finally { state.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('child result correlation returns to the peer child address', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-result-child-'));
  const state = new SurfaceState(path.join(dir, 'surface.sqlite'));
  const receiver = new SurfaceState(path.join(dir, 'peer.sqlite'));
  try {
    state.setConfig({ operatorId: '900', guildId: source.guildId, secretFile: path.join(dir, 'secret') });
    state.bind({ ...source, workspace: dir, conductorId: 'fixture', repoKey: 'repo:fixture' });
    let binding = state.getBinding(source.channelId);
    binding = state.setBindingReadiness(source.channelId, READINESS.READY, 'fixture ready', binding);
    state.enrollThread({ threadId: '103', parentChannelId: source.channelId, guildId: source.guildId }, binding);
    state.setThreadBaseline('103', '8000', binding);
    state.markThreadBoundary('103', THREAD_STATES.READY, 'fixture adoption', null, null, binding);
    const localChild = { ...source, channelId: '103', generation: binding.generation };
    const peerChild = { ...target, channelId: '202' };
    receiver.setConfig({ operatorId: '900', guildId: peerChild.guildId, secretFile: path.join(dir, 'secret') });
    receiver.bind({ ...target, workspace: dir, endpoint: '/tmp/agent-result-peer.sock', conductorId: 'peer', repoKey: 'repo:peer' });
    const peerBinding = receiver.getBinding(target.channelId);
    receiver.enrollThread({ threadId: peerChild.channelId, parentChannelId: target.channelId, guildId: peerChild.guildId }, peerBinding);
    receiver.setThreadBaseline(peerChild.channelId, '8000', peerBinding);
    receiver.markThreadBoundary(peerChild.channelId, THREAD_STATES.READY, 'fixture adoption', null, null, peerBinding);
    const request = { ...packet, source: peerChild, target: localChild };
    const intake = state.acceptDiscordMessage({ id: '8101', guildId: source.guildId, channelId: localChild.channelId,
      authorId: '901', isBot: true, attachments: [], content: encodeAgentMessage(request, token) }, { agentToken: token });
    assert.equal(intake.accepted, true);
    const textFile = path.join(dir, 'result.txt');
    fs.writeFileSync(textFile, 'Useful child result');
    let wire;
    const result = await runDirectPost({ state, token, nativeId: source.nativeId, generation: 1,
      channelId: source.channelId, provider: source.provider, agentThreadId: localChild.channelId, textFile,
      dedupeKey: 'result-child', agentTarget: issueAgentAddress(peerChild, token), agentKind: KINDS.RESULT,
      agentReplyTo: request.id, fetchImpl: async (_url, options) => {
        if (options.method === 'POST') wire = JSON.parse(options.body).content;
        return { ok: true, status: 200, json: async () => options.method === 'GET'
          ? { id: peerChild.channelId, guild_id: peerChild.guildId } : { id: '8201' } };
      } });
    assert.equal(result.status, 'sent');
    assert.deepEqual(decodeAgentMessage(wire, token, peerChild), {
      id: 'result-child', kind: KINDS.RESULT, source: localChild, target: peerChild,
      replyTo: request.id, text: 'Useful child result', routingVersion: 2, sourceParentChannelId: source.channelId
    });
    const resultIntake = receiver.acceptDiscordMessage({ id: '8201', guildId: peerChild.guildId, channelId: peerChild.channelId,
      authorId: '901', isBot: true, attachments: [], content: wire }, { agentToken: token });
    assert.equal(resultIntake.accepted, true);
    assert.equal(receiver.getMessage('8201').channelId, target.channelId);
    assert.equal(receiver.getMessage('8201').deliveryChannelId, peerChild.channelId);
  } finally { state.close(); receiver.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('CLI lets a receipt-bound v1 retry reach legacy custody before v2 validation', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-cli-legacy-retry-'));
  const db = path.join(dir, 'surface.sqlite');
  const secret = path.join(dir, 'secret');
  const textFile = path.join(dir, 'gone.txt');
  const destination = path.join(dir, 'destination.json');
  const state = new SurfaceState(db);
  try {
    fs.writeFileSync(secret, `DISCORD_TOKEN=${token}\n`, { mode: 0o600 });
    state.setConfig({ operatorId: '900', guildId: source.guildId, secretFile: secret });
    state.bind({ ...source, workspace: dir, conductorId: 'fixture', repoKey: 'repo:fixture' });
    const requestId = 'cli-legacy-retry';
    const legacyPacket = { ...packet, id: requestId, source, target };
    const attempt = {
      journal: 'direct-post-v1', requestId, attemptId: `${requestId}-attempt`, sourcePath: textFile,
      textHash: crypto.createHash('sha256').update(JSON.stringify(legacyPacket)).digest('hex'), operatorId: '900',
      partHash: 'legacy-part-hash', channelId: source.channelId, guildId: source.guildId, provider: source.provider,
      nativeId: source.nativeId, generation: source.generation, conductorId: 'fixture', repoKey: 'repo:fixture',
      partIndex: 0, partCount: 1, nonce: `${requestId}-nonce`, deliveryChannelId: target.channelId,
      presentation: 'legacy', agentPacket: legacyPacket, status: 'attempted'
    };
    state.receipt(null, 'direct-post-attempt', attempt);
    state.receipt(null, 'direct-post-outcome', { ...attempt, outcome: 'sent', messageId: `${requestId}-message` });
    fs.writeFileSync(destination, JSON.stringify({ address: target, proof: 'A'.repeat(43) }));
  } finally { state.close(); }
  try {
    const cli = path.resolve(__dirname, '../src/cli.js');
    const result = require('node:child_process').spawnSync(process.execPath, [cli, 'agent-send', '--db', db,
      '--provider', source.provider, '--channel-id', source.channelId, '--native-id', source.nativeId,
      '--generation', '1', '--target-file', destination, '--text-file', textFile, '--dedupe-key', 'cli-legacy-retry'],
    { encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).status, 'sent');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('an interrupted v1 retry recovers before v2 validation without posting', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-cli-legacy-interrupted-'));
  const db = path.join(dir, 'surface.sqlite');
  const secret = path.join(dir, 'secret');
  const textFile = path.join(dir, 'gone.txt');
  const destination = path.join(dir, 'destination.json');
  const state = new SurfaceState(db);
  try {
    fs.writeFileSync(secret, `DISCORD_TOKEN=${token}\n`, { mode: 0o600 });
    state.setConfig({ operatorId: '900', guildId: source.guildId, secretFile: secret });
    state.bind({ ...source, workspace: dir, conductorId: 'fixture', repoKey: 'repo:fixture' });
    const requestId = 'cli-legacy-interrupted';
    const legacyPacket = { ...packet, id: requestId, source, target };
    state.receipt(null, 'direct-post-attempt', {
      journal: 'direct-post-v1', requestId, attemptId: `${requestId}-attempt`, sourcePath: textFile,
      textHash: crypto.createHash('sha256').update(JSON.stringify(legacyPacket)).digest('hex'), operatorId: '900',
      partHash: 'legacy-part-hash', channelId: source.channelId, guildId: source.guildId, provider: source.provider,
      nativeId: source.nativeId, generation: source.generation, conductorId: 'fixture', repoKey: 'repo:fixture',
      partIndex: 0, partCount: 1, nonce: `${requestId}-nonce`, deliveryChannelId: target.channelId,
      presentation: 'legacy', agentPacket: legacyPacket, status: 'attempted'
    });
    fs.writeFileSync(destination, JSON.stringify({ address: target, proof: 'A'.repeat(43) }));
  } finally { state.close(); }
  const methods = [];
  const printed = [];
  const previousExitCode = process.exitCode;
  try {
    // Public agent-send entrypoint: the v1 destination file must reach legacy custody
    // recovery instead of failing exact-v2 prevalidation before runDirectPost.
    const result = await agentSend({ db, provider: source.provider, 'channel-id': source.channelId,
      'native-id': source.nativeId, generation: '1', 'target-file': destination, 'text-file': textFile,
      'dedupe-key': 'cli-legacy-interrupted' }, {
      print: value => printed.push(value),
      fetchImpl: async (_url, options) => {
        methods.push(options.method);
        if (options.method === 'POST') throw new Error('unexpected Discord POST');
        return { ok: true, status: 200, json: async () => ({ id: target.channelId, guild_id: target.guildId }) };
      }
    });
    assert.equal(result.status, 'unknown');
    assert.equal(printed.length, 1);
    assert.equal(printed[0].status, 'unknown');
    assert.equal(process.exitCode, 1);
    assert.equal(methods.filter(method => method === 'POST').length, 0);
  } finally {
    process.exitCode = previousExitCode;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
