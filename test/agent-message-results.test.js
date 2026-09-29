const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const { issueAgentAddress, encodeAgentMessage, decodeAgentMessage, KINDS } = require('../src/agent-message');
const { SurfaceState, MESSAGE_STATES, READINESS } = require('../src/state');
const { THREAD_STATES } = require('../src/state/thread-enrollment');
const { runDirectPost } = require('../src/direct-post');
const { agentSend } = require('../src/cli');
const { source, target, packet, token, enrollChild } = require('./agent-message-fixtures');

test('results reverse an accepted request and reject unrelated or unknown correlation before custody', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-result-'));
  const state = new SurfaceState(path.join(dir, 'surface.sqlite'));
  try {
    state.setConfig({ operatorId: '900', guildId: source.guildId, secretFile: path.join(dir, 'secret') });
    state.bind({ ...source, workspace: dir, conductorId: 'fixture', repoKey: 'repo:fixture' }, { intakeCutoff: '100' });
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
    state.bind({ ...source, workspace: dir, conductorId: 'fixture', repoKey: 'repo:fixture' }, { intakeCutoff: '100' });
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
    assert.equal(state.claimDispatch('8102').claimed, true);
    assert.equal(state.getMessage('8102').agentRoute, sourceChild.channelId);
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
    state.bind({ ...source, workspace: dir, conductorId: 'fixture', repoKey: 'repo:fixture' }, { intakeCutoff: '100' });
    let binding = state.getBinding(source.channelId);
    binding = state.setBindingReadiness(source.channelId, READINESS.READY, 'fixture ready', binding);
    state.enrollThread({ threadId: '103', parentChannelId: source.channelId, guildId: source.guildId, adoptionCutoff: '8000'}, binding);
    state.setThreadBaseline('103', '8000', binding);
    state.markThreadBoundary('103', THREAD_STATES.READY, 'fixture adoption', null, null, binding);
    const localChild = { ...source, channelId: '103', generation: binding.generation };
    const peerChild = { ...target, channelId: '202' };
    receiver.setConfig({ operatorId: '900', guildId: peerChild.guildId, secretFile: path.join(dir, 'secret') });
    receiver.bind({ ...target, workspace: dir, endpoint: '/tmp/agent-result-peer.sock', conductorId: 'peer', repoKey: 'repo:peer' }, { intakeCutoff: '100' });
    const peerBinding = receiver.getBinding(target.channelId);
    receiver.enrollThread({ threadId: peerChild.channelId, parentChannelId: target.channelId, guildId: peerChild.guildId, adoptionCutoff: '8000'}, peerBinding);
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
    state.bind({ ...source, workspace: dir, conductorId: 'fixture', repoKey: 'repo:fixture' }, { intakeCutoff: '100' });
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
    state.bind({ ...source, workspace: dir, conductorId: 'fixture', repoKey: 'repo:fixture' }, { intakeCutoff: '100' });
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
