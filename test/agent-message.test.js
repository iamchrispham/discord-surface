const test = require('node:test');
const assert = require('node:assert/strict');
const { issueAgentAddress, encodeAgentMessage, decodeAgentMessage, KINDS } = require('../src/agent-message');

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
  assert.throws(() => encodeAgentMessage({ ...packet, text: 'x'.repeat(2000) }, token), /limit/);
  assert.throws(() => decodeAgentMessage('discord-tether:agent:v1:' + 'x'.repeat(2001), token, target), /limit/);
});

const fs = require('node:fs');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { SurfaceState } = require('../src/state');
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

const { createSurfaceConsumer, DiscordGateway, fetchAgentAttachment } = require('../src/discord');
const { attachmentUrlAllowed } = require('../src/agent-attachment');

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
  const wireOne = encodeAgentMessage({ ...packet, target: destination }, token);
  const wireTwo = encodeAgentMessage({ ...packet, id: 'work-2', target: destination }, token);
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
  const wire = encodeAgentMessage({ ...packet, target: destination }, token);
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
  const wire = encodeAgentMessage({ ...packet, target: destination }, token);
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
    consumer.intakeMessage(agentMessage, false, agentMessage.id, binding, false, new AbortController().signal),
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
  assert.deepEqual(state.getMessage(agentMessage.id).agentMessage, { ...packet, target: destination });
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
    assert.equal((await runDirectPost(input)).duplicate, true);
    assert.equal((await runDirectPost({ ...input, dedupeKey: 'result-no-target', agentTarget: null })).status, 'sent');
    assert.equal(calls, 4);
  } finally { state.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
