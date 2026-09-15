const test = require('node:test');
const assert = require('node:assert/strict');
const { AGENT_MESSAGE_MAX_ENCODED_LENGTH, PREFIX, issueAgentAddress, encodeAgentMessage, decodeAgentMessage, KINDS } = require('../src/agent-message');

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
const { agentComplete, GATEWAY_CAPABILITIES } = require('../src/cli');
const { THREAD_STATES } = require('../src/state/thread-enrollment');
const { codexPrompt, claudeEvent, messageRequest } = require('../src/native');
const { staticConductorMarker } = require('../src/topic');
const { createMonitorMcp, monitorEvent } = require('../src/claude-monitor');

test('durable agent intake survives reopen, preserves provenance and deduplicates replay', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-packet-'));
  const db = path.join(dir, 'surface.sqlite');
  let state = new SurfaceState(db);
  try {
    state.setConfig({ operatorId: '900', guildId: target.guildId, secretFile: path.join(dir, 'secret') });
    state.bind({ ...target, workspace: dir, endpoint: path.join(dir, 'claude.sock') });
    const binding = state.getBinding(target.channelId);
    const destination = { ...target, generation: binding.generation };
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
    const destination = { ...target, generation: state.getBinding(target.channelId).generation };
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

    const oldPayloadPath = path.join(dir, '.cm-e', `${crypto.createHash('sha256')
      .update(`2\0${path.resolve(db)}\0${agentId}\0${destination.nativeId}\0${destination.generation}`)
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
    oldPayload.version = 2;
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
        params: { content: 'forged event content', meta: { messageId: agentId, nativeId: destination.nativeId, generation: String(destination.generation) } }
      });
      assert.equal(events.length, 1);
      const firstPointer = events[0];
      const firstPayloadText = fs.readFileSync(firstPointer.payloadPath, 'utf8');
      const firstPayload = JSON.parse(firstPayloadText);
      assert.notEqual(firstPointer.payloadPath, oldPayloadPath);
      assert.equal(firstPayload.version, 3);
      assert.equal(firstPayload.content, messageRequest(state.getMessage(agentId)));
      assert.match(firstPayload.content, /Agent result result-1 from codex/);
      assert.match(firstPayload.content, /Correlates to agent message work-1/);
      assert.match(firstPayload.content, /Result body from the authenticated sender\./);
      assert.doesNotMatch(firstPayload.content, /forged event content/);
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

test('explicit sender posts one authenticated packet to recipient and retains source custody', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-send-'));
  const state = new SurfaceState(path.join(dir, 'surface.sqlite'));
  try {
    state.setConfig({ operatorId: '900', guildId: source.guildId, secretFile: path.join(dir, 'secret') });
    state.bind({ ...source, workspace: dir, conductorId: 'test-conductor', repoKey: 'repo:fixture' });
    state.bind({ ...target, workspace: dir, endpoint: path.join(dir, 'target.sock') });
    const destination = { ...target, generation: state.getBinding(target.channelId).generation };
    const textFile = path.join(dir, 'task.txt');
    fs.writeFileSync(textFile, packet.text);
    const requests = [];
    const input = { state, token, nativeId: source.nativeId, generation: 1, channelId: source.channelId, provider: source.provider,
      textFile, dedupeKey: 'send-1', agentTarget: issueAgentAddress(destination, token),
      fetchImpl: async (url, options) => {
        requests.push({ url, body: options.method === 'GET' ? null : JSON.parse(options.body) });
        return { ok: true, status: 200, json: async () => options.method === 'GET'
          ? { id: target.channelId, guild_id: target.guildId }
          : { id: '5000' } };
      } };
    const sent = await runDirectPost(input);
    assert.equal(sent.status, 'sent');
    assert.equal(sent.channelId, target.channelId);
    assert.equal(requests.length, 2);
    assert.ok(requests[0].url.endsWith(`/channels/${target.channelId}`));
    assert.ok(requests[1].url.endsWith(`/channels/${target.channelId}/messages`));
    const decoded = decodeAgentMessage(requests[1].body.content, token, destination);
    assert.equal(decoded.source.nativeId, source.nativeId);
    assert.equal(decoded.text, packet.text);
    assert.equal(state.hasIntakeEvidence('5000'), false);
    const inbound = { id: '5000', guildId: destination.guildId, channelId: destination.channelId,
      authorId: '901', isBot: true, content: requests[1].body.content, attachments: [] };
    assert.equal(state.acceptDiscordMessage(inbound, { agentToken: token }).accepted, true);
    assert.equal(state.getMessage('5000').nativeId, target.nativeId);
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
    const binding = receiver.getBinding(target.channelId);
    const cli = path.resolve(__dirname, '../src/cli.js');
    const args = [cli, 'agent-address', '--db', path.join(dir, 'receiver.sqlite'), '--provider', target.provider,
      '--channel-id', target.channelId, '--native-id', target.nativeId, '--generation', String(binding.generation)];
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
      channelId: source.channelId, provider: source.provider, textFile, dedupeKey: 'remote-target', agentTarget: envelope,
      fetchImpl: async (_url, options) => {
        if (options.method === 'POST') wire = JSON.parse(options.body).content;
        return { ok: true, status: 200, json: async () => options.method === 'GET'
          ? { id: target.channelId, guild_id: target.guildId } : { id: '5100' } };
      } });
    assert.equal(result.status, 'sent');
    const event = { id: '5100', guildId: target.guildId, channelId: target.channelId, authorId: '901', isBot: true, content: wire, attachments: [] };
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
      channelId: source.channelId, provider: source.provider, textFile, dedupeKey: 'remote-child-target', agentTarget: envelope,
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
    const textFile = path.join(dir, 'task.txt');
    fs.writeFileSync(textFile, packet.text);
    const calls = [];
    const result = await runDirectPost({ state, token, nativeId: source.nativeId, generation: 1, channelId: source.channelId,
      provider: source.provider, textFile, dedupeKey: 'guild-check', agentTarget: issueAgentAddress(target, token),
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
    const textFile = path.join(dir, 'task.txt');
    fs.writeFileSync(textFile, packet.text);
    const input = { state, token, nativeId: source.nativeId, generation: source.generation, channelId: source.channelId,
      provider: source.provider, textFile, dedupeKey: 'lookup-retry', agentTarget: issueAgentAddress(target, token) };
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
  for (const testCase of cases) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-nonce-'));
    const state = new SurfaceState(path.join(dir, 'surface.sqlite'));
    try {
      state.setConfig({ operatorId: '900', guildId: testCase.source.guildId, secretFile: path.join(dir, 'secret') });
      state.bind({ ...testCase.source, workspace: dir, conductorId: 'fixture', repoKey: 'repo:fixture' });
      state.bind({ ...testCase.target, workspace: dir, endpoint: path.join(dir, 'target.sock') });
      const destination = { ...testCase.target, generation: state.getBinding(testCase.target.channelId).generation };
      const textFile = path.join(dir, 'task.txt');
      fs.writeFileSync(textFile, packet.text);
      const result = await runDirectPost({ state, token, nativeId: testCase.source.nativeId, generation: testCase.source.generation,
        channelId: testCase.source.channelId, provider: testCase.source.provider, textFile, dedupeKey: 'same-key',
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
    const destination = { ...target, generation: state.getBinding(target.channelId).generation };
    const consumer = createSurfaceConsumer({ state, providers: {}, agentCredential: () => token });
    const content = encodeAgentMessage({ ...packet, target: destination }, token);
    const incoming = { id: '7000', guildId: target.guildId, channelId: target.channelId, author: { id: '901', bot: true }, content };
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
    const destination = path.join(dir, 'destination.json');
    const textFile = path.join(dir, 'text.txt');
    fs.writeFileSync(destination, JSON.stringify(issueAgentAddress(target, token)));
    fs.writeFileSync(textFile, 'CLI task');
    const cli = path.resolve(__dirname, '../src/cli.js');
    const argv = [process.execPath, cli, 'agent-send', '--db', db, '--provider', source.provider,
      '--channel-id', source.channelId, '--native-id', source.nativeId, '--generation', '1',
      '--target-file', destination, '--text-file', textFile, '--dedupe-key', 'cli-1'];
    const script = `process.argv=${JSON.stringify(argv)};
      globalThis.fetch=async(url,options)=>{
        if (options.method === 'GET') {
          if (!String(url).endsWith('/channels/102')) throw new Error('wrong destination');
          return {ok:true,status:200,json:async()=>({id:'102',guild_id:'100'})};
        }
        if (!String(url).endsWith('/channels/102/messages')) throw new Error('wrong destination');
        if (!JSON.parse(options.body).content.startsWith('discord-tether:agent:v1:')) throw new Error('unsigned payload');
        return {ok:true,status:200,json:async()=>({id:'8000'})};
      };
      require(${JSON.stringify(cli)}).main().catch(e=>{console.error(e);process.exitCode=1});`;
    for (const invalid of [null, false, '', {}, { ...target, generation: 0 }]) {
      fs.writeFileSync(destination, JSON.stringify(invalid));
      const refused = require('node:child_process').spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 5000 });
      assert.equal(refused.status, 1);
      assert.equal(state.directPostRows('cli-1').length, 0);
      assert.match(refused.stderr, /complete binding address/);
    }
    fs.writeFileSync(destination, JSON.stringify(issueAgentAddress(target, token)));
    const child = require('node:child_process').spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 5000 });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(JSON.parse(child.stdout).status, 'sent');
    assert.equal(state.directPostRows('cli-1').at(-1).detail.messageId, '8000');

    const request = { ...packet, id: 'cli-request', source: target, target: source };
    assert.equal(state.acceptDiscordMessage({ id: '8050', guildId: source.guildId, channelId: source.channelId,
      authorId: '901', isBot: true, attachments: [], content: encodeAgentMessage(request, token) }, { agentToken: token }).accepted, true);
    const replyText = path.join(dir, 'reply.txt');
    fs.writeFileSync(replyText, 'CLI result');
    const replyArgv = [process.execPath, cli, 'agent-send', '--db', db, '--provider', source.provider,
      '--channel-id', source.channelId, '--native-id', source.nativeId, '--generation', '1',
      '--text-file', replyText, '--dedupe-key', 'cli-result', '--agent-reply-to', request.id];
    const replyScript = script.replace(JSON.stringify(argv), JSON.stringify(replyArgv));
    const reply = require('node:child_process').spawnSync(process.execPath, ['-e', replyScript], { encoding: 'utf8', timeout: 5000 });
    assert.equal(reply.status, 0, reply.stderr);
    assert.equal(JSON.parse(reply.stdout).status, 'sent');
    assert.equal(state.directPostRows('cli-result').at(-1).detail.messageId, '8000');

    const emptyReplyArgv = [...argv, '--dedupe-key', 'cli-empty-reply', '--agent-reply-to='];
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


test('invalid destination proof refuses before custody and source revocation during lookup prevents POST', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-proof-'));
  const state = new SurfaceState(path.join(dir, 'surface.sqlite'));
  try {
    state.setConfig({ operatorId: '900', guildId: source.guildId, secretFile: path.join(dir, 'secret') });
    state.bind({ ...source, workspace: dir, conductorId: 'fixture', repoKey: 'repo:fixture' });
    const textFile = path.join(dir, 'task.txt');
    fs.writeFileSync(textFile, packet.text);
    let posts = 0;
    const input = { state, token, nativeId: source.nativeId, generation: 1, channelId: source.channelId,
      provider: source.provider, textFile, dedupeKey: 'proof-check', agentTarget: issueAgentAddress(target, token),
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
    const request = { ...packet, source: target, target: source };
    const intake = state.acceptDiscordMessage({ id: '8100', guildId: source.guildId, channelId: source.channelId,
      authorId: '901', isBot: true, attachments: [], content: encodeAgentMessage(request, token) }, { agentToken: token });
    assert.equal(intake.accepted, true);
    const textFile = path.join(dir, 'result.txt');
    fs.writeFileSync(textFile, 'Useful result');
    let calls = 0;
    const input = { state, token, nativeId: source.nativeId, generation: 1, channelId: source.channelId,
      provider: source.provider, textFile, dedupeKey: 'result-check', agentTarget: request.source,
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
    const resultPacket = { id: 'result-check', kind: KINDS.RESULT, source, target, replyTo: request.id, text: 'Useful result' };
    assert.deepEqual(resultRows.find(row => row.kind === 'direct-post-attempt').detail.agentPacket, resultPacket);
    assert.deepEqual(resultRows.find(row => row.kind === 'direct-post-outcome').detail.agentPacket, resultPacket);
    assert.equal((await runDirectPost(input)).duplicate, true);
    assert.equal((await runDirectPost({ ...input, dedupeKey: 'result-no-target', agentTarget: null })).status, 'sent');
    assert.equal(calls, 4);
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
      replyTo: request.id, text: 'Useful child result'
    });
    const resultIntake = receiver.acceptDiscordMessage({ id: '8201', guildId: peerChild.guildId, channelId: peerChild.channelId,
      authorId: '901', isBot: true, attachments: [], content: wire }, { agentToken: token });
    assert.equal(resultIntake.accepted, true);
    assert.equal(receiver.getMessage('8201').channelId, target.channelId);
    assert.equal(receiver.getMessage('8201').deliveryChannelId, peerChild.channelId);
  } finally { state.close(); receiver.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('agent retry preserves a predecessor journal without inventing completion evidence', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-handled-upgrade-'));
  const state = new SurfaceState(path.join(dir, 'surface.sqlite'));
  try {
    state.setConfig({ operatorId: '900', guildId: source.guildId, secretFile: path.join(dir, 'secret') });
    const owners = bindAgentOwners(state, dir);
    const request = { id: 'a2-upgrade-request', kind: KINDS.REQUEST, source: owners.source, target: owners.target, replyTo: null, text: 'Handle this predecessor request.' };
    const requestMessageId = 'a2-upgrade-request-event';
    assert.equal(state.acceptDiscordMessage({ id: requestMessageId, guildId: owners.target.guildId, channelId: owners.target.channelId,
      authorId: '901', isBot: true, attachments: [], content: encodeAgentMessage(request, token) }, { agentToken: token }).accepted, true);
    const textFile = path.join(dir, 'a2-upgrade-result.txt');
    fs.writeFileSync(textFile, 'Predecessor-compatible result.');
    let sends = 0;
    const input = { state, token, nativeId: owners.target.nativeId, generation: owners.target.generation,
      channelId: owners.target.channelId, provider: owners.target.provider, textFile, dedupeKey: 'a2-upgrade-result',
      agentTarget: issueAgentAddress(owners.source, token), agentKind: KINDS.RESULT, agentReplyTo: request.id,
      fetchImpl: async (_url, options) => {
        if (options.method === 'POST') sends += 1;
        return { ok: true, status: 200, json: async () => options.method === 'GET'
          ? { id: owners.source.channelId, guild_id: owners.source.guildId } : { id: 'a2-upgrade-result-event' } };
      } };
    assert.equal((await runDirectPost(input)).status, 'sent');
    const before = state.directPostRows('a2-upgrade-result');
    const attemptBefore = before.find(row => row.kind === 'direct-post-attempt').detail;
    const outcomeBefore = before.find(row => row.kind === 'direct-post-outcome').detail;
    assert.ok(attemptBefore.agentPacket);
    state.db.prepare("SELECT id, detail FROM receipts WHERE discord_id IS NULL AND kind IN ('direct-post-attempt', 'direct-post-outcome') AND json_extract(detail, '$.requestId')=?")
      .all('a2-upgrade-result').forEach(row => {
        const detail = JSON.parse(row.detail);
        delete detail.agentPacket;
        state.db.prepare('UPDATE receipts SET detail=? WHERE id=?').run(JSON.stringify(detail), row.id);
      });
    const retry = await runDirectPost(input);
    assert.equal(retry.duplicate, true);
    assert.equal(retry.status, 'sent');
    assert.equal(sends, 1);
    const after = state.directPostRows('a2-upgrade-result');
    assert.equal(after.length, before.length);
    assert.equal(after.find(row => row.kind === 'direct-post-attempt').detail.nonce, attemptBefore.nonce);
    assert.equal(after.find(row => row.kind === 'direct-post-outcome').detail.messageId, outcomeBefore.messageId);
    assert.equal(after.find(row => row.kind === 'direct-post-attempt').detail.agentPacket, undefined);

    assert.equal(state.claimDispatch(requestMessageId).claimed, true);
    state.markSubmitted(requestMessageId);
    recordNativeAcknowledgment(state, { provider: owners.target.provider, messageId: requestMessageId,
      nativeId: owners.target.nativeId, generation: owners.target.generation });
    assert.throws(() => state.completeAgentHandledWithoutPost({ messageId: requestMessageId,
      provider: owners.target.provider, nativeId: owners.target.nativeId, generation: owners.target.generation }), /immutable correlated result/);
    assert.equal(state.getMessage(requestMessageId).state, MESSAGE_STATES.SUBMITTED);
  } finally { state.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

function bindAgentOwners(state, dir) {
  state.bind({ ...source, workspace: dir, conductorId: 'a2-source', repoKey: 'repo:a2-source' });
  state.bind({ ...target, workspace: dir, endpoint: '/tmp/agent-a2-target.sock', conductorId: 'a2-target', repoKey: 'repo:a2-target' });
  let sourceBinding = state.getBinding(source.channelId);
  let targetBinding = state.getBinding(target.channelId);
  sourceBinding = state.setBindingReadiness(source.channelId, READINESS.READY, 'A2 fixture ready', sourceBinding);
  targetBinding = state.setBindingReadiness(target.channelId, READINESS.READY, 'A2 fixture ready', targetBinding);
  return {
    source: { ...source, generation: sourceBinding.generation },
    target: { ...target, generation: targetBinding.generation }
  };
}

test('authenticated agent result reaches an explicit no-post terminal state', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-handled-result-'));
  const state = new SurfaceState(path.join(dir, 'surface.sqlite'));
  try {
    state.setConfig({ operatorId: '900', guildId: source.guildId, secretFile: path.join(dir, 'secret') });
    const owners = bindAgentOwners(state, dir);
    const resultPacket = {
      id: 'a2-result', kind: KINDS.RESULT, source: owners.source, target: owners.target,
      replyTo: 'remote-request', text: 'Authenticated result.'
    };
    const messageId = 'a2-result-event';
    const intake = state.acceptDiscordMessage({
      id: messageId, guildId: owners.target.guildId, channelId: owners.target.channelId,
      authorId: '901', isBot: true, attachments: [], content: encodeAgentMessage(resultPacket, token)
    }, { agentToken: token });
    assert.equal(intake.accepted, true);
    assert.equal(state.claimDispatch(messageId).claimed, true);
    state.markSubmitted(messageId);
    const complete = () => state.completeAgentHandledWithoutPost({
      messageId, provider: owners.target.provider, nativeId: owners.target.nativeId, generation: owners.target.generation
    });
    assert.throws(complete, /matching native acknowledgment/);
    recordNativeAcknowledgment(state, { provider: owners.target.provider, messageId, nativeId: owners.target.nativeId, generation: owners.target.generation });

    state.db.prepare('UPDATE messages SET reply_nonce=? WHERE discord_id=?').run('reply-custody-nonce', messageId);
    assert.throws(complete, /empty reply custody/);
    state.db.prepare('UPDATE messages SET reply_nonce=NULL, reply_next_part=1 WHERE discord_id=?').run(messageId);
    assert.throws(complete, /empty reply custody/);
    state.db.prepare('UPDATE messages SET reply_next_part=0 WHERE discord_id=?').run(messageId);
    state.db.prepare('INSERT INTO reply_parts(discord_id, part_index, content, nonce, state, updated_at) VALUES(?, ?, ?, ?, ?, ?)')
      .run(messageId, 0, 'owned reply part', 'reply-custody-part-nonce', 'pending', new Date().toISOString());
    assert.throws(complete, /empty reply custody/);
    state.db.prepare('DELETE FROM reply_parts WHERE discord_id=?').run(messageId);

    const completed = complete();
    assert.equal(completed.completed, true);
    assert.equal(completed.disposition, 'result-consumed');
    assert.equal(completed.message.state, MESSAGE_STATES.AGENT_HANDLED_WITHOUT_POST);
    assert.equal(completed.evidence.receiptId > 0, true);
    assert.equal(state.listReceipts().filter(row => row.discord_id === messageId && row.kind === 'result-consumed').length, 1);
    assert.deepEqual(state.recoveryCandidates(), []);
    assert.equal(state.hasUnresolved(owners.target.channelId), false);
    assert.throws(() => state.recordNativeReply({
      provider: owners.target.provider, messageId, nativeId: owners.target.nativeId,
      generation: owners.target.generation, text: 'Late reply must not reopen custody.'
    }), /reply is not accepted/);
    const duplicate = state.completeAgentHandledWithoutPost({
      messageId, provider: owners.target.provider, nativeId: owners.target.nativeId, generation: owners.target.generation
    });
    assert.equal(duplicate.duplicate, true);
    assert.equal(state.getMessage(messageId).state, MESSAGE_STATES.AGENT_HANDLED_WITHOUT_POST);
    const currentBinding = state.getBinding(owners.target.channelId);
    state.unbind(owners.target.channelId, { expectedBinding: currentBinding });
    assert.throws(complete, /stale|current|authorization/i);
  } finally { state.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('agent request completion requires a full reversed result receipt', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-handled-request-'));
  const state = new SurfaceState(path.join(dir, 'surface.sqlite'));
  try {
    state.setConfig({ operatorId: '900', guildId: source.guildId, secretFile: path.join(dir, 'secret') });
    const owners = bindAgentOwners(state, dir);
    const request = { id: 'a2-request', kind: KINDS.REQUEST, source: owners.source, target: owners.target, replyTo: null, text: 'Handle this request.' };
    const requestMessageId = 'a2-request-event';
    assert.equal(state.acceptDiscordMessage({
      id: requestMessageId, guildId: owners.target.guildId, channelId: owners.target.channelId,
      authorId: '901', isBot: true, attachments: [], content: encodeAgentMessage(request, token)
    }, { agentToken: token }).accepted, true);
    assert.equal(state.claimDispatch(requestMessageId).claimed, true);
    state.markSubmitted(requestMessageId);
    recordNativeAcknowledgment(state, { provider: owners.target.provider, messageId: requestMessageId, nativeId: owners.target.nativeId, generation: owners.target.generation });
    assert.throws(() => state.completeAgentHandledWithoutPost({
      messageId: requestMessageId, provider: owners.target.provider, nativeId: owners.target.nativeId, generation: owners.target.generation
    }), /immutable correlated result/);
    assert.equal(state.getMessage(requestMessageId).state, MESSAGE_STATES.SUBMITTED);

    const wrongReply = {
      id: 'a2-wrong-reply-result', kind: KINDS.RESULT, source: owners.target, target: owners.source,
      replyTo: 'a2-different-request', text: 'Unrelated result.'
    };
    assert.equal(state.acceptDiscordMessage({
      id: 'a2-wrong-reply-event', guildId: owners.source.guildId, channelId: owners.source.channelId,
      authorId: '902', isBot: true, attachments: [], content: encodeAgentMessage(wrongReply, token)
    }, { agentToken: token }).accepted, true);
    assert.throws(() => state.completeAgentHandledWithoutPost({
      messageId: requestMessageId, provider: owners.target.provider, nativeId: owners.target.nativeId, generation: owners.target.generation
    }), /immutable correlated result/);

    const result = {
      id: 'a2-received-result', kind: KINDS.RESULT, source: owners.target, target: owners.source,
      replyTo: request.id, text: 'The request is complete.'
    };
    const resultMessageId = 'a2-received-result-event';
    assert.equal(state.acceptDiscordMessage({
      id: resultMessageId, guildId: owners.source.guildId, channelId: owners.source.channelId,
      authorId: '902', isBot: true, attachments: [], content: encodeAgentMessage(result, token)
    }, { agentToken: token }).accepted, true);
    const completed = state.completeAgentHandledWithoutPost({
      messageId: requestMessageId, provider: owners.target.provider, nativeId: owners.target.nativeId, generation: owners.target.generation
    });
    assert.equal(completed.completed, true);
    assert.equal(completed.evidence.kind, 'received-result');
    assert.equal(completed.evidence.packetId, result.id);
    assert.equal(completed.evidence.replyTo, request.id);
    assert.deepEqual(completed.evidence.source, request.target);
    assert.deepEqual(completed.evidence.target, request.source);
    assert.equal(state.getMessage(requestMessageId).state, MESSAGE_STATES.AGENT_HANDLED_WITHOUT_POST);
    assert.equal(state.getMessage(resultMessageId).state, MESSAGE_STATES.ACCEPTED);
  } finally { state.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('request completion accepts nonce-only direct-result reconciliation', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-handled-unknown-result-'));
  const state = new SurfaceState(path.join(dir, 'surface.sqlite'));
  try {
    state.setConfig({ operatorId: '900', guildId: source.guildId, secretFile: path.join(dir, 'secret') });
    const owners = bindAgentOwners(state, dir);
    const request = { id: 'a2-unknown-request', kind: KINDS.REQUEST, source: owners.source, target: owners.target, replyTo: null, text: 'Wait for a reliable result.' };
    const messageId = 'a2-unknown-request-event';
    assert.equal(state.acceptDiscordMessage({ id: messageId, guildId: owners.target.guildId, channelId: owners.target.channelId,
      authorId: '901', isBot: true, attachments: [], content: encodeAgentMessage(request, token) }, { agentToken: token }).accepted, true);
    assert.equal(state.claimDispatch(messageId).claimed, true);
    state.markSubmitted(messageId);
    recordNativeAcknowledgment(state, { provider: owners.target.provider, messageId,
      nativeId: owners.target.nativeId, generation: owners.target.generation });
    const textFile = path.join(dir, 'a2-unknown-result.txt');
    fs.writeFileSync(textFile, 'Uncertain result.');
    const result = await runDirectPost({ state, token, nativeId: owners.target.nativeId, generation: owners.target.generation,
      channelId: owners.target.channelId, provider: owners.target.provider, textFile, dedupeKey: 'a2-unknown-result',
      agentTarget: issueAgentAddress(owners.source, token), agentKind: KINDS.RESULT, agentReplyTo: request.id,
      fetchImpl: async (_url, options) => {
        if (options.method === 'POST') throw Object.assign(new Error('transport outcome unknown'), { outcome: 'unknown' });
        return { ok: true, status: 200, json: async () => ({ id: owners.source.channelId, guild_id: owners.source.guildId }) };
      } });
    assert.equal(result.status, 'unknown');
    assert.equal(state.directPostRows('a2-unknown-result').at(-1).detail.outcome, 'unknown');
    assert.throws(() => state.completeAgentHandledWithoutPost({ messageId,
      provider: owners.target.provider, nativeId: owners.target.nativeId, generation: owners.target.generation }), /immutable correlated result/);
    const attempt = state.directPostRows('a2-unknown-result').find(row => row.kind === 'direct-post-attempt');
    state.reconcileDirectPostOutcome('a2-unknown-result', attempt.detail.attemptId, 'sent', {
      source: 'operator-reconciliation', nonce: attempt.detail.nonce
    });
    const completed = state.completeAgentHandledWithoutPost({ messageId,
      provider: owners.target.provider, nativeId: owners.target.nativeId, generation: owners.target.generation });
    assert.equal(completed.evidence.kind, 'sent-result');
    assert.equal(completed.evidence.nonce, attempt.detail.nonce);
    assert.equal(completed.evidence.messageId, undefined);
    assert.equal(state.getMessage(messageId).state, MESSAGE_STATES.AGENT_HANDLED_WITHOUT_POST);
  } finally { state.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('agent-complete guards mutation on Gateway capability and requests a wake', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-complete-cli-'));
  const db = path.join(dir, 'surface.sqlite');
  let state = new SurfaceState(db);
  try {
    state.setConfig({ operatorId: '900', guildId: source.guildId, secretFile: path.join(dir, 'secret') });
    const owners = bindAgentOwners(state, dir);
    const request = { id: 'a2-cli-request', kind: KINDS.REQUEST, source: owners.source, target: owners.target, replyTo: null, text: 'Complete from CLI.' };
    const messageId = 'a2-cli-request-event';
    assert.equal(state.acceptDiscordMessage({
      id: messageId, guildId: owners.target.guildId, channelId: owners.target.channelId,
      authorId: '901', isBot: true, attachments: [], content: encodeAgentMessage(request, token)
    }, { agentToken: token }).accepted, true);
    assert.equal(state.claimDispatch(messageId).claimed, true);
    state.markSubmitted(messageId);
    recordNativeAcknowledgment(state, { provider: owners.target.provider, messageId, nativeId: owners.target.nativeId, generation: owners.target.generation });
    const resultFile = path.join(dir, 'a2-cli-result.txt');
    fs.writeFileSync(resultFile, 'CLI result.');
    const sent = await runDirectPost({
      state, token, nativeId: owners.target.nativeId, generation: owners.target.generation,
      channelId: owners.target.channelId, provider: owners.target.provider, textFile: resultFile,
      dedupeKey: 'a2-cli-result', agentTarget: issueAgentAddress(owners.source, token),
      agentKind: KINDS.RESULT, agentReplyTo: request.id,
      fetchImpl: async (_url, options) => ({ ok: true, status: 200, json: async () => options.method === 'GET'
        ? { id: owners.source.channelId, guild_id: owners.source.guildId } : { id: 'a2-cli-sent-result' } })
    });
    assert.equal(sent.status, 'sent');
    const argsFor = id => ({ 'message-id': id, provider: owners.target.provider,
      'native-id': owners.target.nativeId, generation: String(owners.target.generation) });
    const stoppedResult = { id: 'a2-cli-stopped-result', kind: KINDS.RESULT, source: owners.source, target: owners.target,
      replyTo: 'remote-request', text: 'Complete while Gateway is stopped.' };
    const stoppedMessageId = 'a2-cli-stopped-result-event';
    assert.equal(state.acceptDiscordMessage({
      id: stoppedMessageId, guildId: owners.target.guildId, channelId: owners.target.channelId,
      authorId: '901', isBot: true, attachments: [], content: encodeAgentMessage(stoppedResult, token)
    }, { agentToken: token }).accepted, true);
    assert.equal(state.claimDispatch(stoppedMessageId).claimed, true);
    state.markSubmitted(stoppedMessageId);
    recordNativeAcknowledgment(state, { provider: owners.target.provider, messageId: stoppedMessageId,
      nativeId: owners.target.nativeId, generation: owners.target.generation });
    const stopped = agentComplete({ ...argsFor(stoppedMessageId), 'state-dir': dir }, {
      gatewayProcessStatus: () => ({ state: 'stopped', pid: null }),
      print: () => {}
    });
    assert.equal(stopped.completed, true);
    assert.equal(stopped.gatewayWake.requested, false);
    state.close();
    state = null;

    const args = { ...argsFor(messageId), 'state-dir': dir };
    const unknown = () => agentComplete(args, {
      gatewayProcessStatus: () => ({}),
      print: () => {}
    });
    assert.throws(unknown, /Gateway status is unknown/);
    const unsupported = () => agentComplete(args, {
      gatewayProcessStatus: () => ({ state: 'running', pid: 7301, capabilities: [] }),
      print: () => {}
    });
    assert.throws(unsupported, /does not support agent handled-without-post completion/);
    state = new SurfaceState(db);
    assert.equal(state.getMessage(messageId).state, MESSAGE_STATES.SUBMITTED);
    state.close();
    state = null;

    let wakeOptions;
    const output = [];
    const completed = agentComplete(args, {
      gatewayProcessStatus: () => ({ state: 'running', pid: 7301, capabilities: [GATEWAY_CAPABILITIES.agentHandledWithoutPost] }),
      requestGatewayRecovery: (_paths, options) => {
        wakeOptions = options;
        return { requested: true, pid: 7301, signal: 'SIGUSR2' };
      },
      print: value => output.push(value)
    });
    assert.equal(completed.completed, true);
    assert.equal(completed.gatewayWake.requested, true);
    assert.equal(wakeOptions.expectedPid, 7301);
    assert.equal(wakeOptions.requiredCapability, GATEWAY_CAPABILITIES.agentHandledWithoutPost);
    assert.equal(output.length, 1);
    state = new SurfaceState(db);
    assert.equal(state.getMessage(messageId).state, MESSAGE_STATES.AGENT_HANDLED_WITHOUT_POST);
  } finally { state?.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('no-post completion releases a queued same-owner message through the wake path', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-handled-queue-'));
  const state = new SurfaceState(path.join(dir, 'surface.sqlite'));
  let firstObserveStartedResolve;
  let releaseFirstObserve;
  const firstObserveStarted = new Promise(resolve => { firstObserveStartedResolve = resolve; });
  try {
    state.setConfig({ operatorId: '900', guildId: source.guildId, secretFile: path.join(dir, 'secret') });
    const owners = bindAgentOwners(state, dir);
    const firstPacket = { id: 'a2-queue-first', kind: KINDS.RESULT, source: owners.source, target: owners.target,
      replyTo: 'first-request', text: 'First result.' };
    const secondPacket = { id: 'a2-queue-second', kind: KINDS.RESULT, source: owners.source, target: owners.target,
      replyTo: 'second-request', text: 'Second result.' };
    const dispatches = [];
    const observations = [];
    const replies = [];
    const consumer = createSurfaceConsumer({
      state,
      providers: {
        claude: {
          async dispatch(message) { dispatches.push(message.id); return { status: 'submitted' }; },
          observe(message, _outcome, { signal }) {
            observations.push(message.id);
            if (message.id !== 'a2-queue-first-event') return { text: 'Second native answer.' };
            firstObserveStartedResolve();
            return new Promise(resolve => {
              releaseFirstObserve = resolve;
              signal?.addEventListener('abort', () => resolve({ stopped: true }), { once: true });
            });
          }
        }
      },
      agentCredential: () => token,
      sendTransportReceipt: async () => ({ id: 'transport-receipt' }),
      sendReply: async (message, reply) => { replies.push(message.id); return { id: `reply-${reply.id}` }; }
    });
    const eventFor = (id, value) => ({ id, guildId: owners.target.guildId, channelId: owners.target.channelId,
      author: { id: '901', bot: true }, content: encodeAgentMessage(value, token), attachments: [], channel: {} });
    const first = consumer.handleMessage(eventFor('a2-queue-first-event', firstPacket));
    await firstObserveStarted;
    const firstMessage = state.getMessage('a2-queue-first-event');
    recordNativeAcknowledgment(state, { provider: owners.target.provider, messageId: firstMessage.id,
      nativeId: owners.target.nativeId, generation: owners.target.generation });
    const second = consumer.handleMessage(eventFor('a2-queue-second-event', secondPacket));
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(dispatches, ['a2-queue-first-event']);
    state.completeAgentHandledWithoutPost({ messageId: firstMessage.id, provider: owners.target.provider,
      nativeId: owners.target.nativeId, generation: owners.target.generation });
    assert.equal(consumer.releaseHandledWithoutPost(), false);
    for (let attempt = 0; attempt < 100 && dispatches.length < 2; attempt += 1) await new Promise(resolve => setTimeout(resolve, 1));
    assert.deepEqual(dispatches, ['a2-queue-first-event', 'a2-queue-second-event']);
    const secondResult = await second;
    assert.equal(secondResult.message.state, MESSAGE_STATES.REPLIED);
    assert.equal(state.getMessage(firstMessage.id).state, MESSAGE_STATES.AGENT_HANDLED_WITHOUT_POST);
    assert.deepEqual(observations, ['a2-queue-first-event', 'a2-queue-second-event']);
    assert.deepEqual(replies, ['a2-queue-second-event']);
    releaseFirstObserve?.({ stopped: true });
    await first;
  } finally { state.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('handled completion leaves later accepted owner work recoverable after restart', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-handled-restart-'));
  const db = path.join(dir, 'surface.sqlite');
  let state = new SurfaceState(db);
  try {
    state.setConfig({ operatorId: '900', guildId: source.guildId, secretFile: path.join(dir, 'secret') });
    const owners = bindAgentOwners(state, dir);
    const eventFor = (id, packetValue) => ({ id, guildId: owners.target.guildId, channelId: owners.target.channelId,
      authorId: '901', isBot: true, attachments: [], content: encodeAgentMessage(packetValue, token) });
    const firstPacket = { id: 'a2-restart-first', kind: KINDS.RESULT, source: owners.source, target: owners.target,
      replyTo: 'restart-first-request', text: 'First result is consumed.' };
    const secondPacket = { id: 'a2-restart-second', kind: KINDS.RESULT, source: owners.source, target: owners.target,
      replyTo: 'restart-second-request', text: 'Second result remains queued.' };
    assert.equal(state.acceptDiscordMessage(eventFor('a2-restart-first-event', firstPacket), { agentToken: token }).accepted, true);
    assert.equal(state.acceptDiscordMessage(eventFor('a2-restart-second-event', secondPacket), { agentToken: token }).accepted, true);
    assert.equal(state.claimDispatch('a2-restart-first-event').claimed, true);
    state.markSubmitted('a2-restart-first-event');
    recordNativeAcknowledgment(state, { provider: owners.target.provider, messageId: 'a2-restart-first-event',
      nativeId: owners.target.nativeId, generation: owners.target.generation });
    state.completeAgentHandledWithoutPost({ messageId: 'a2-restart-first-event', provider: owners.target.provider,
      nativeId: owners.target.nativeId, generation: owners.target.generation });
    assert.deepEqual(state.recoveryCandidates().map(message => message.id), ['a2-restart-second-event']);
    state.close();
    state = new SurfaceState(db);
    assert.deepEqual(state.recoveryCandidates().map(message => message.id), ['a2-restart-second-event']);
  } finally { state?.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
