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
const os = require('node:os');
const path = require('node:path');
const { SurfaceState } = require('../src/state');
const { codexPrompt, claudeEvent } = require('../src/native');

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
    const first = await runDirectPost({ ...input, fetchImpl: async () => { throw new Error('temporary lookup outage'); } });
    assert.equal(first.status, 'not_sent');
    assert.equal(state.directPostRows('lookup-retry').find(row => row.kind === 'direct-post-outcome').detail.outcome, 'not_sent');
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
