const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const { issueAgentAddress, encodeAgentMessage } = require('../src/agent-message');
const { SurfaceState, READINESS } = require('../src/state');
const { THREAD_STATES } = require('../src/state/thread-enrollment');
const { runDirectPost } = require('../src/direct-post');
const { createSurfaceConsumer } = require('../src/discord');
const { source, target, packet, token, enrollChild } = require('./agent-message-fixtures');

test('history consumer verifies credential before durable intake', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-history-'));
  const state = new SurfaceState(path.join(dir, 'surface.sqlite'));
  try {
    state.setConfig({ operatorId: '900', guildId: target.guildId, secretFile: path.join(dir, 'secret') });
    state.bind({ ...target, workspace: dir, endpoint: path.join(dir, 'claude.sock') }, { intakeCutoff: '100' });
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
    state.bind({ ...source, workspace: dir, conductorId: 'test-conductor', repoKey: 'repo:fixture' }, { intakeCutoff: '100' });
    state.bind({ ...target, workspace: dir, endpoint: path.join(dir, 'target.sock') }, { intakeCutoff: '100' });
    let sourceBinding = state.getBinding(source.channelId);
    sourceBinding = state.setBindingReadiness(source.channelId, READINESS.READY, 'fixture ready', sourceBinding);
    state.enrollThread({ threadId: '103', parentChannelId: source.channelId, guildId: source.guildId, adoptionCutoff: '7000'}, sourceBinding);
    state.setThreadBaseline('103', '7000', sourceBinding);
    state.markThreadBoundary('103', THREAD_STATES.READY, 'fixture adoption', null, null, sourceBinding);
    let targetBinding = state.getBinding(target.channelId);
    targetBinding = state.setBindingReadiness(target.channelId, READINESS.READY, 'fixture ready', targetBinding);
    state.enrollThread({ threadId: '202', parentChannelId: target.channelId, guildId: target.guildId, adoptionCutoff: '7000'}, targetBinding);
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
    state.bind({ ...source, workspace: dir, conductorId: 'source-conductor', repoKey: 'repo:source' }, { intakeCutoff: '100' });
    state.bind({ ...target, workspace: dir, endpoint: path.join(dir, 'target.sock'), conductorId: 'target-conductor', repoKey: 'repo:target' }, { intakeCutoff: '100' });
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
      state.bind({ ...source, workspace: dir, conductorId: 'fixture', repoKey: 'repo:fixture' }, { intakeCutoff: '100' });
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
    state.bind({ ...source, workspace: dir, conductorId: 'fixture', repoKey: 'repo:fixture' }, { intakeCutoff: '100' });
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
    state.bind({ ...source, workspace: dir, conductorId: 'fixture', repoKey: 'repo:fixture' }, { intakeCutoff: '100' });
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
    state.bind({ ...source, workspace: dir, conductorId: 'fixture', repoKey: 'repo:fixture' }, { intakeCutoff: '100' });
    let binding = state.getBinding(source.channelId);
    binding = state.setBindingReadiness(source.channelId, READINESS.READY, 'fixture ready', binding);
    state.enrollThread({ threadId: '103', parentChannelId: source.channelId, guildId: source.guildId, adoptionCutoff: '7000'}, binding);
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
    state.bind({ ...source, workspace: dir, conductorId: 'fixture', repoKey: 'repo:fixture' }, { intakeCutoff: '100' });
    let binding = state.getBinding(source.channelId);
    binding = state.setBindingReadiness(source.channelId, READINESS.READY, 'fixture ready', binding);
    state.enrollThread({ threadId: '103', parentChannelId: source.channelId, guildId: source.guildId, adoptionCutoff: '7000'}, binding);
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
