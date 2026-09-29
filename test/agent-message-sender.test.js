const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { issueAgentAddress, decodeAgentMessage } = require('../src/agent-message');
const { SurfaceState, READINESS } = require('../src/state');
const { THREAD_STATES } = require('../src/state/thread-enrollment');
const { runDirectPost } = require('../src/direct-post');
const { source, target, packet, token, enrollChild } = require('./agent-message-fixtures');

test('explicit sender posts one authenticated packet to recipient and retains source custody', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-send-'));
  const state = new SurfaceState(path.join(dir, 'surface.sqlite'));
  try {
    state.setConfig({ operatorId: '900', guildId: source.guildId, secretFile: path.join(dir, 'secret') });
    state.bind({ ...source, workspace: dir, conductorId: 'test-conductor', repoKey: 'repo:fixture' }, { intakeCutoff: '100' });
    state.bind({ ...target, workspace: dir, endpoint: path.join(dir, 'target.sock') }, { intakeCutoff: '100' });
    let sourceBinding = state.getBinding(source.channelId);
    sourceBinding = state.setBindingReadiness(source.channelId, READINESS.READY, 'fixture ready', sourceBinding);
    state.enrollThread({ threadId: '103', parentChannelId: source.channelId, guildId: source.guildId, adoptionCutoff: '4000'}, sourceBinding);
    state.setThreadBaseline('103', '4000', sourceBinding);
    state.markThreadBoundary('103', THREAD_STATES.READY, 'fixture adoption', null, null, sourceBinding);
    let targetBinding = state.getBinding(target.channelId);
    targetBinding = state.setBindingReadiness(target.channelId, READINESS.READY, 'fixture ready', targetBinding);
    state.enrollThread({ threadId: '202', parentChannelId: target.channelId, guildId: target.guildId, adoptionCutoff: '4000'}, targetBinding);
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
    state.bind({ ...source, workspace: dir, conductorId: 'source-conductor', repoKey: 'repo:fixture' }, { intakeCutoff: '100' });
    let parent = state.getBinding(source.channelId);
    parent = state.setBindingReadiness(source.channelId, READINESS.READY, 'fixture ready', parent);
    state.enrollThread({ threadId: '103', parentChannelId: source.channelId, guildId: source.guildId, adoptionCutoff: '7000'}, parent);
    state.setThreadBaseline('103', '7000', parent);
    state.markThreadBoundary('103', THREAD_STATES.READY, 'fixture adoption', null, null, parent);
    state.enrollThread({ threadId: '104', parentChannelId: source.channelId, guildId: source.guildId, adoptionCutoff: '7000'}, parent);
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
    state.bind({ ...source, workspace: dir, conductorId: 'source-conductor', repoKey: 'repo:fixture' }, { intakeCutoff: '100' });
    let parent = state.getBinding(source.channelId);
    parent = state.setBindingReadiness(source.channelId, READINESS.READY, 'fixture ready', parent);
    state.enrollThread({ threadId: '103', parentChannelId: source.channelId, guildId: source.guildId, adoptionCutoff: '7000'}, parent);
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
    state.bind({ ...source, workspace: dir, conductorId: 'source-conductor', repoKey: 'repo:fixture' }, { intakeCutoff: '100' });
    receiver.bind({ ...target, workspace: dir, endpoint: path.join(dir, 'target.sock'), conductorId: 'target-conductor', repoKey: 'repo:target' }, { intakeCutoff: '100' });
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
    state.bind({ ...source, workspace: dir, conductorId: 'source-conductor', repoKey: 'repo:fixture' }, { intakeCutoff: '100' });
    receiver.bind({ ...target, workspace: dir, endpoint: '/tmp/agent-child-target.sock', conductorId: 'target-conductor', repoKey: 'repo:target' }, { intakeCutoff: '100' });
    const sourceChild = enrollChild(state, source, '105');
    const binding = receiver.getBinding(target.channelId);
    receiver.enrollThread({ threadId: '103', parentChannelId: target.channelId, guildId: target.guildId, adoptionCutoff: '5000'}, binding);
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
    state.bind({ ...source, workspace: dir, conductorId: 'test-conductor', repoKey: 'repo:fixture' }, { intakeCutoff: '100' });
    state.bind({ ...target, workspace: dir, endpoint: path.join(dir, 'target.sock') }, { intakeCutoff: '100' });
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
    state.bind({ ...source, workspace: dir, conductorId: 'test-conductor', repoKey: 'repo:fixture' }, { intakeCutoff: '100' });
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
      state.bind({ ...testCase.source, workspace: dir, conductorId: 'fixture', repoKey: 'repo:fixture' }, { intakeCutoff: '100' });
      state.bind({ ...testCase.target, workspace: dir, endpoint: path.join(dir, 'target.sock') }, { intakeCutoff: '100' });
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
