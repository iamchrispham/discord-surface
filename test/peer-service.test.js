const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fixture, service, addRecipient } = require('./fixtures/peer-fixture');
const { createPeerService } = require('../src/peer/service');
const { READINESS, MESSAGE_STATES } = require('../src/state');
const { THREAD_STATES } = require('../src/state/thread-enrollment');
const { decodeAgentMessage, encodeAgentMessage, PREFIX } = require('../src/agent-message');
const id = '11111111-1111-1111-1111-111111111111';
function addOrdinaryRecipient(f) {
  f.state.bind({ guildId: '100', channelId: '301', provider: 'codex', nativeId: '33333333-3333-3333-3333-333333333333',
    workspace: '/tmp' }, { intakeCutoff: '100' });
  f.state.markIntakeBoundary('301', 'ready', 'fixture history recovered');
  const target = f.state.setBindingReadiness('301', READINESS.READY, 'fixture', f.state.getBinding('301'));
  f.state.enrollThread({ threadId: '302', parentChannelId: '301', guildId: '100', adoptionCutoff: '100' }, target);
  f.state.setThreadBaseline('302', '100', target);
  f.state.markThreadBoundary('302', 'ready', 'fixture', null, null, target);
  return target;
}

function addSecondRecipient(f) {
  f.state.bind({ guildId: '100', channelId: '301', provider: 'codex', nativeId: '33333333-3333-3333-3333-333333333333',
    workspace: '/tmp', conductorId: 'second-recipient', repoKey: 'github.com/test/second-recipient' }, { intakeCutoff: '100' });
  f.state.markIntakeBoundary('301', 'ready', 'fixture history recovered');
  const target = f.state.setBindingReadiness('301', READINESS.READY, 'fixture', f.state.getBinding('301'));
  f.state.enrollThread({ threadId: '302', parentChannelId: '301', guildId: '100', adoptionCutoff: '100' }, target);
  f.state.setThreadBaseline('302', '100', target);
  f.state.markThreadBoundary('302', THREAD_STATES.READY, 'fixture', null, null, target);
  return target;
}
const request = { peer: { conductorId: 'test-conductor' }, text: 'hello', dedupe_key: 'fixture-request' };

test('missing caller refuses listing and sends before network or custody', async t => {
  const f = fixture(t); const before = f.state.listReceipts().length;
  const peer = service(f, { callerDependencies: { resolveClaudeCaller: async () => ({ harness: 'claude-code', sessionId: '22222222-2222-2222-2222-222222222222' }) } });
  await assert.rejects(peer.list(), /no active binding/);
  await assert.rejects(peer.send(request), /no active binding/);
  assert.equal(f.state.listReceipts().length, before);
});

test('peer caller lookup tolerates native UUID casing from CLI bindings', async t => {
  const f = fixture(t);
  f.state.db.prepare("UPDATE bindings SET native_id=upper(native_id) WHERE channel_id='101'").run();
  f.enroll('102');
  const listed = await service(f).list();
  const caller = listed.find(entry => entry.channelId === '101');
  assert.ok(caller, 'uppercase native UUID still lists its caller');
  assert.equal(caller.reachable, false);
  assert.equal(caller.reason, 'caller cannot target itself');
  assert.equal(caller.childId, '102');
});

test('peer list includes the caller and classifies its readiness independently', async t => {
  const f = fixture(t); const peer = service(f);
  const generation = f.state.getBinding('101').generation;
  const callerRow = (readiness, childId, reachable, reason) => ({
    repoKey: 'github.com/test/repo',
    provider: 'claude',
    conductorId: 'test-conductor',
    channelId: '101',
    generation,
    readiness,
    childId,
    reachable,
    reason
  });
  assert.deepEqual(await peer.list(), [callerRow(READINESS.READY, null, false, 'peer has no enrolled child route')]);
  f.enroll('102');
  assert.deepEqual(await peer.list(), [callerRow(READINESS.READY, '102', false, 'caller cannot target itself')]);
  f.state.setBindingReadiness('101', READINESS.GAP, 'fixture', f.state.getBinding('101'));
  assert.deepEqual(await peer.list(), [callerRow(READINESS.GAP, null, false, 'peer is not ready: fixture')]);
  const before = f.state.listReceipts().length;
  await assert.rejects(peer.send(request), /not ready/);
  assert.equal(f.state.listReceipts().length, before);
});

test('peer list returns a channel ID selector for ordinary peers', async t => {
  const f = fixture(t); f.enroll('102'); const target = addOrdinaryRecipient(f);
  const peer = service(f, { fetchImpl: async (url, options) => {
    if (options.method === 'GET') return { ok: true, status: 200, json: async () => ({ id: '302', guild_id: '100' }) };
    return { ok: true, status: 200, json: async () => ({ id: '10001' }) };
  } });
  const listed = await peer.list();
  assert.deepEqual(listed.find(entry => entry.channelId === target.channelId), {
    repoKey: null,
    provider: 'codex',
    conductorId: null,
    channelId: target.channelId,
    generation: target.generation,
    readiness: READINESS.READY,
    childId: '302',
    reachable: true,
    reason: null
  });
  assert.equal((await peer.send({ peer: { channelId: target.channelId }, text: 'hello', dedupe_key: 'ordinary-channel' })).status, 'sent');
});

test('handoff during name lookup refuses before network send or custody', async t => {
  const f = fixture(t); f.enroll('102');
  const peer = service(f, { loadChannels: async () => {
    f.state.db.prepare('UPDATE bindings SET generation=generation+1').run();
    return [{ id: '101', guildId: '100', name: 'advisor' }];
  } });
  const before = f.state.listReceipts().length;
  await assert.rejects(peer.send({ ...request, peer: { channelName: 'advisor' } }), /caller changed/);
  assert.equal(f.state.listReceipts().length, before);
});

test('malformed channel-name selectors refuse before channel lookup', async t => {
  const f = fixture(t); f.enroll('102'); let lookups = 0;
  const peer = service(f, { loadChannels: async () => { lookups++; return []; } });
  await assert.rejects(peer.send({ peer: { channelName: {}, extra: true }, text: 'hello', dedupe_key: 'invalid-channel-selector' }),
    /peer selector requires exactly/);
  assert.equal(lookups, 0);
});

test('tool arguments cannot override the native caller or combine destinations', async t => {
  const f = fixture(t); const peer = service(f); const before = f.state.listReceipts().length;
  await assert.rejects(peer.send({ ...request, nativeId: id }), /invalid peer send/);
  await assert.rejects(peer.send({ text: 'hello', dedupe_key: 'ok' }), /provide peer or reply_to/);
  await assert.rejects(peer.send({ ...request, text_file: '/ignored' }), /exactly one of text/);
  assert.equal(f.state.listReceipts().length, before);
});

test('peer packet IDs refuse invalid lengths and characters before custody', async t => {
  const f = fixture(t); const peer = service(f); const before = f.state.listReceipts().length;
  await assert.rejects(peer.send({ ...request, dedupe_key: 'a'.repeat(129) }), /valid packet id/);
  await assert.rejects(peer.send({ ...request, dedupe_key: 'job:123' }), /valid packet id/);
  await assert.rejects(peer.send({ peer: request.peer, text: 'hello', dedupe_key: 'ok', reply_to: 'job:123' }), /valid packet id/);
  await assert.rejects(peer.send({ reply_to: 'job:123', text: 'hello', dedupe_key: 'ok' }), /valid packet id/);
  assert.equal(f.state.listReceipts().length, before);
});

test('peer packet IDs accept the exact 128-character limit', async t => {
  const f = fixture(t); f.enroll('102'); addRecipient(f);
  const peer = service(f, { fetchImpl: async (url, options) => {
    if (options.method === 'GET') return { ok: true, status: 200, json: async () => ({ id: '202', guild_id: '100' }) };
    return { ok: true, status: 200, json: async () => ({ id: '10001' }) };
  } });
  const result = await peer.send({ peer: { conductorId: 'recipient' }, text: 'hello', dedupe_key: 'a'.repeat(128) });
  assert.equal(result.status, 'sent');
});

test('peer send rejects text that exceeds the signed packet budget before custody', async t => {
  const f = fixture(t); f.enroll('102'); addRecipient(f);
  const textFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'peer-text-')), 'message.txt');
  fs.writeFileSync(textFile, 'a'.repeat(1500));
  t.after(() => fs.rmSync(path.dirname(textFile), { recursive: true, force: true }));
  let posts = 0;
  const peer = service(f, { fetchImpl: async () => { posts += 1; assert.fail('oversized peer text reached network'); } });
  const before = f.state.listReceipts().length;
  for (const [key, input] of [
    ['inline', { text: 'a'.repeat(1500) }],
    ['file', { text_file: textFile }]
  ]) {
    await assert.rejects(peer.send({ peer: { conductorId: 'recipient' }, dedupe_key: `oversized-${key}`, ...input }),
      /peer text exceeds signed packet limit/);
  }
  assert.equal(posts, 0);
  assert.equal(f.state.listReceipts().length, before);
});

test('successful agent send targets the enrolled child and retry keeps one post', async t => {
  const f = fixture(t); f.enroll('102'); let posts = 0; let packet; let wire;
  const target = addRecipient(f);
  const outbound = { ...request, peer: { conductorId: 'recipient' } };
  const { decodeAgentMessage } = require('../src/agent-message');
  const peer = service(f, { fetchImpl: async (url, options) => {
    if (options.method === 'GET') return { ok: true, status: 200, json: async () => ({ id: url.split('/').at(-1), guild_id: '100' }) };
    posts++;
    assert.match(url, /channels\/202\/messages$/);
    wire = await options.body.get('files[0]').text();
    packet = decodeAgentMessage(wire, 'fixture', {
      guildId: '100', channelId: '202', provider: 'codex', nativeId: target.nativeId, generation: 1
    });
    return { ok: true, status: 200, json: async () => ({ id: '10001' }) };
  } });
  assert.equal((await peer.send(outbound)).status, 'sent');
  assert.equal(packet.source.channelId, '102');
  assert.equal(packet.target.channelId, '202');
  assert.equal(packet.text, 'hello');
  assert.equal((await peer.send(outbound)).status, 'sent');
  assert.equal(posts, 1);
  const sentOnly = await peer.result(request.dedupe_key);
  assert.equal(sentOnly.sendOutcome, 'sent');
  assert.deepEqual(sentOnly.deliveries, []);
  assert.deepEqual(sentOnly.results, []);
  assert.equal(f.state.acceptDiscordMessage({ id: '10001', guildId: '100', channelId: '202', authorId: '901', isBot: true,
    content: wire }, { agentToken: 'fixture' }).accepted, true);
  assert.equal((await peer.result(request.dedupe_key)).deliveries[0].completed, false);
  let replyWire;
  const recipient = createPeerService({ state: f.state, provider: 'codex', token: 'fixture',
    callerDependencies: { environment: { CODEX_THREAD_ID: target.nativeId } },
    fetchImpl: async (url, options) => {
      if (options.method === 'GET') return { ok: true, status: 200, json: async () => ({ id: url.split('/').at(-1), guild_id: '100' }) };
      assert.match(url, /channels\/102\/messages$/);
      replyWire = await options.body.get('files[0]').text();
      return { ok: true, status: 200, json: async () => ({ id: '10002' }) };
    } });
  await assert.rejects(recipient.result(request.dedupe_key), /unknown for this caller/);
  assert.equal((await recipient.send({ reply_to: request.dedupe_key, text: 'Substantive result', dedupe_key: 'fixture-result' })).status, 'sent');
  assert.equal(f.state.acceptDiscordMessage({ id: '10002', guildId: '100', channelId: '102', authorId: '901', isBot: true,
    content: replyWire }, { agentToken: 'fixture' }).accepted, true);
  const received = await peer.result(request.dedupe_key);
  assert.equal(received.results[0].text, 'Substantive result');
  assert.equal(received.results[0].completed, false);
  const message = f.state.getMessage('10002');
  f.state.claimDispatch('10002'); f.state.markSubmitted('10002');
  require('../src/acknowledgment').recordNativeAcknowledgment(f.state, {
    provider: 'claude', nativeId: id, generation: 1, messageId: message.id
  });
  f.state.completeAgentHandledWithoutPost({ provider: 'claude', nativeId: id, generation: 1, messageId: message.id });
  assert.equal((await peer.result(request.dedupe_key)).results[0].completed, true);
});

test('retired source child keeps unknown custody across replacement enrollment', async t => {
  const f = fixture(t); f.enroll('102'); addRecipient(f);
  let posts = 0;
  const peer = service(f, { fetchImpl: async (url, options) => {
    if (options.method === 'GET') return { ok: true, status: 200, json: async () => ({ id: '202', guild_id: '100' }) };
    posts += 1;
    throw new Error('transport outcome is unknown');
  } });
  const input = { peer: { conductorId: 'recipient' }, text: 'hello', dedupe_key: 'retired-child-unknown' };
  assert.equal((await peer.send(input)).status, 'unknown');
  const binding = f.state.getBinding('101');
  f.state.deactivateThreadEnrollments('101', binding);
  f.enroll('103');
  assert.equal((await peer.send(input)).status, 'unknown');
  assert.equal(posts, 1);
  assert.equal((await peer.result(input.dedupe_key)).sendOutcome, 'unknown');
});

test('peer result does not accept a parent result for a child-targeted request', async t => {
  const f = fixture(t); f.enroll('102'); const target = addRecipient(f); let requestPacket;
  const peer = service(f, { fetchImpl: async (url, options) => {
    if (options.method === 'GET') return { ok: true, status: 200, json: async () => ({ id: '202', guild_id: '100' }) };
    const wire = await options.body.get('files[0]').text();
    requestPacket = decodeAgentMessage(wire, 'fixture', {
      guildId: '100', channelId: '202', provider: 'codex', nativeId: target.nativeId, generation: 1
    });
    return { ok: true, status: 200, json: async () => ({ id: 'parent-result-request' }) };
  } });
  assert.equal((await peer.send({ ...request, peer: { conductorId: 'recipient' } })).status, 'sent');
  const foreignResult = {
    id: 'foreign-parent-result', kind: 'result',
    source: { guildId: '100', channelId: '201', provider: 'codex', nativeId: target.nativeId, generation: 1 },
    target: requestPacket.source, replyTo: requestPacket.id, text: 'wrong route'
  };
  const accepted = f.state.acceptDiscordMessage({ id: '10003', guildId: '100',
    channelId: requestPacket.source.channelId, authorId: '901', isBot: true,
    content: encodeAgentMessage(foreignResult, 'fixture') }, { agentToken: 'fixture' });
  assert.equal(accepted.accepted, true, JSON.stringify(accepted));
  assert.deepEqual((await peer.result(requestPacket.id)).results, []);
});

test('peer custody scopes a reused packet ID to each caller channel', async t => {
  const f = fixture(t); f.enroll('102'); addRecipient(f);
  const secondNativeId = '33333333-3333-3333-3333-333333333333';
  f.state.bind({ guildId: '100', channelId: '301', provider: 'codex', nativeId: secondNativeId,
    workspace: '/tmp', endpoint: '/tmp/second-caller.sock', conductorId: 'second-caller', repoKey: 'github.com/test/second-caller' }, { intakeCutoff: '100' });
  f.state.markIntakeBoundary('301', 'ready', 'fixture history recovered');
  const secondBinding = f.state.setBindingReadiness('301', READINESS.READY, 'fixture', f.state.getBinding('301'));
  f.state.enrollThread({ threadId: '302', parentChannelId: '301', guildId: '100', adoptionCutoff: '100' }, secondBinding);
  f.state.setThreadBaseline('302', '100', secondBinding);
  f.state.markThreadBoundary('302', THREAD_STATES.READY, 'fixture', null, null, secondBinding);
  let posts = 0;
  const fetchImpl = async (url, options) => {
    if (options.method === 'GET') return { ok: true, status: 200, json: async () => ({ id: '202', guild_id: '100' }) };
    posts += 1;
    return { ok: true, status: 200, json: async () => ({ id: `shared-packet-${posts}` }) };
  };
  const first = service(f, { fetchImpl });
  const second = createPeerService({ state: f.state, provider: 'codex', token: 'fixture',
    callerDependencies: { environment: { CODEX_THREAD_ID: secondNativeId } }, fetchImpl });
  const firstResult = await first.send({ peer: { conductorId: 'recipient' }, text: 'first', dedupe_key: 'shared-packet-id' });
  const secondResult = await second.send({ peer: { conductorId: 'recipient' }, text: 'second', dedupe_key: 'shared-packet-id' });
  assert.equal(firstResult.status, 'sent');
  assert.equal(secondResult.status, 'sent');
  assert.equal((await first.send({ peer: { conductorId: 'recipient' }, text: 'first', dedupe_key: 'shared-packet-id' })).status, 'sent');
  assert.equal(posts, 2);
  assert.equal((await second.result('shared-packet-id')).sendOutcome, 'sent');
});

test('peer custody scopes a reused packet ID to the caller source identity', async t => {
  const f = fixture(t); f.enroll('102'); addRecipient(f);
  const replacementNativeId = '44444444-4444-4444-4444-444444444444';
  let posts = 0;
  const fetchImpl = async (url, options) => {
    if (options.method === 'GET') return { ok: true, status: 200, json: async () => ({ id: '202', guild_id: '100' }) };
    posts += 1;
    return { ok: true, status: 200, json: async () => ({ id: `generation-packet-${posts}` }) };
  };
  const first = service(f, { fetchImpl });
  const input = { peer: { conductorId: 'recipient' }, text: 'first', dedupe_key: 'generation-packet-id' };
  assert.equal((await first.send(input)).status, 'sent');
  f.state.db.prepare("UPDATE bindings SET native_id=?, generation=2 WHERE channel_id='101'").run(replacementNativeId);
  const second = createPeerService({ state: f.state, provider: 'claude', token: 'fixture',
    callerDependencies: { resolveClaudeCaller: async () => ({ harness: 'claude-code', sessionId: replacementNativeId }) }, fetchImpl });
  assert.equal((await second.send({ ...input, text: 'second' })).status, 'sent');
  assert.equal(posts, 2);
});

test('reply_to can select the request source when packet IDs collide', async t => {
  const f = fixture(t); f.enroll('102');
  const first = addRecipient(f);
  const second = addSecondRecipient(f);
  const caller = f.state.getBinding('101');
  const callerAddress = { guildId: caller.guildId, channelId: '102', provider: caller.provider,
    nativeId: caller.nativeId, generation: caller.generation };
  const requestPacket = (binding, channelId) => ({
    id: 'duplicate-request', kind: 'request',
    source: { guildId: binding.guildId, channelId, provider: binding.provider, nativeId: binding.nativeId, generation: binding.generation },
    target: callerAddress, replyTo: null, routingVersion: 2, text: 'hello'
  });
  f.state.receipt(null, 'agent-message', { packet: requestPacket(first, '202') });
  f.state.receipt(null, 'agent-message', { packet: requestPacket(second, '302') });
  let posts = 0;
  const peer = service(f, { fetchImpl: async (url, options) => {
    if (options.method === 'GET') return { ok: true, status: 200, json: async () => ({ id: '202', guild_id: '100' }) };
    posts += 1;
    return { ok: true, status: 200, json: async () => ({ id: '10001' }) };
  } });
  await assert.rejects(peer.send({ reply_to: 'duplicate-request', text: 'reply', dedupe_key: 'ambiguous-reply' }),
    /agent reply target is unknown or does not match/);
  const result = await peer.send({ peer: { conductorId: 'recipient' }, reply_to: 'duplicate-request',
    text: 'reply', dedupe_key: 'selected-reply' });
  assert.equal(result.status, 'sent');
  assert.equal(posts, 1);
});

test('reply_to can select a colliding legacy parent request through its peer', async t => {
  const f = fixture(t); f.enroll('102');
  const first = addRecipient(f);
  const second = addSecondRecipient(f);
  const caller = f.state.getBinding('101');
  const callerAddress = { guildId: caller.guildId, channelId: '102', provider: caller.provider,
    nativeId: caller.nativeId, generation: caller.generation };
  const requestPacket = binding => ({
    id: 'duplicate-legacy-request', kind: 'request',
    source: { guildId: binding.guildId, channelId: binding.channelId, provider: binding.provider,
      nativeId: binding.nativeId, generation: binding.generation },
    target: callerAddress, replyTo: null, routingVersion: 2, text: 'hello'
  });
  f.state.receipt(null, 'agent-message', { packet: requestPacket(first) });
  f.state.receipt(null, 'agent-message', { packet: requestPacket(second) });
  let postUrl;
  let posts = 0;
  let staleNext = false;
  const peer = service(f, { fetchImpl: async (url, options) => {
    if (options.method === 'GET') {
      if (staleNext) {
        f.state.db.prepare("UPDATE bindings SET generation=generation+1 WHERE channel_id='201'").run();
        staleNext = false;
      }
      return { ok: true, status: 200, json: async () => ({ id: '201', guild_id: '100' }) };
    }
    posts += 1;
    postUrl = url;
    return { ok: true, status: 200, json: async () => ({ id: '10001' }) };
  } });
  const result = await peer.send({ peer: { conductorId: 'recipient' }, reply_to: 'duplicate-legacy-request',
    text: 'reply', dedupe_key: 'selected-legacy-reply' });
  assert.equal(result.status, 'sent');
  assert.match(postUrl, /channels\/201\/messages$/);
  assert.equal(posts, 1);
  staleNext = true;
  const stale = await peer.send({ peer: { conductorId: 'recipient' }, reply_to: 'duplicate-legacy-request',
    text: 'stale reply', dedupe_key: 'selected-legacy-stale' });
  assert.equal(stale.status, 'stale');
  assert.equal(posts, 1);
});

test('peer reply uses the selected peer to recover a frozen local route amid collisions', async t => {
  const f = fixture(t); f.enroll('102');
  const first = addRecipient(f);
  const second = addSecondRecipient(f);
  const caller = f.state.getBinding('101');
  const callerAddress = { guildId: caller.guildId, channelId: caller.channelId, provider: caller.provider,
    nativeId: caller.nativeId, generation: caller.generation };
  const acceptLegacyParent = (binding, discordId) => {
    const packet = {
      id: 'frozen-collision-request', kind: 'request',
      source: { guildId: binding.guildId, channelId: binding.channelId, provider: binding.provider,
        nativeId: binding.nativeId, generation: binding.generation },
      target: callerAddress, replyTo: null, text: 'hello'
    };
    const timestamp = new Date().toISOString();
    f.state.db.prepare(`INSERT INTO messages(discord_id, guild_id, channel_id, delivery_channel_id, author_id, content, attachments,
      provider, native_id, workspace, endpoint, conductor_id, repo_key, generation, state, created_at, updated_at)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      discordId, caller.guildId, caller.channelId, caller.channelId, '901', encodeAgentMessage(packet, 'fixture'), '[]',
      caller.provider, caller.nativeId, caller.workspace, caller.endpoint, caller.conductorId, caller.repoKey,
      caller.generation, MESSAGE_STATES.ACCEPTED, timestamp, timestamp
    );
    f.state.receipt(discordId, 'agent-message', { packet, authorId: '901' });
    f.state.receipt(discordId, 'accepted', { channelId: caller.channelId, generation: caller.generation, readiness: 'ready' });
    assert.equal(f.state.claimDispatch(discordId).claimed, true);
  };
  acceptLegacyParent(first, '8105');
  acceptLegacyParent(second, '8106');
  f.enroll('103');
  let posts = 0;
  const peer = service(f, { fetchImpl: async (url, options) => {
    if (options.method === 'GET') return { ok: true, status: 200, json: async () => ({ id: '201', guild_id: '100' }) };
    posts += 1;
    return { ok: true, status: 200, json: async () => ({ id: '10001' }) };
  } });
  const result = await peer.send({ peer: { conductorId: 'recipient' }, reply_to: 'frozen-collision-request',
    text: 'reply', dedupe_key: 'frozen-collision-result' });
  assert.equal(result.status, 'sent');
  assert.equal(posts, 1);
});

test('reply_to continues past a withdrawn child route to an active parent request', async t => {
  const f = fixture(t); f.enroll('102');
  const target = addRecipient(f);
  const caller = f.state.getBinding('101');
  const callerAddress = { guildId: caller.guildId, channelId: '102', provider: caller.provider,
    nativeId: caller.nativeId, generation: caller.generation };
  const requestPacket = channelId => ({
    id: 'withdrawn-child-collision', kind: 'request',
    source: { guildId: target.guildId, channelId, provider: target.provider,
      nativeId: target.nativeId, generation: target.generation },
    target: callerAddress, replyTo: null, routingVersion: 2, text: 'hello'
  });
  const childRequest = requestPacket('202');
  const parentRequest = requestPacket('201');
  f.state.receipt(null, 'agent-message', { packet: childRequest });
  f.state.receipt(null, 'agent-message', { packet: parentRequest });
  f.state.receipt(null, 'agent-request-withdrawn', {
    packetId: childRequest.id, source: childRequest.source, target: childRequest.target
  });
  let postUrl;
  const peer = service(f, { fetchImpl: async (url, options) => {
    if (options.method === 'GET') return { ok: true, status: 200, json: async () => ({ id: '201', guild_id: '100' }) };
    postUrl = url;
    return { ok: true, status: 200, json: async () => ({ id: '10001' }) };
  } });
  const result = await peer.send({ peer: { conductorId: 'recipient' }, reply_to: childRequest.id,
    text: 'reply', dedupe_key: 'withdrawn-child-reply' });
  assert.equal(result.status, 'sent');
  assert.match(postUrl, /channels\/201\/messages$/);
});

test('reply_to refuses a same-peer parent and child collision', async t => {
  const f = fixture(t); f.enroll('102');
  const target = addRecipient(f);
  const caller = f.state.getBinding('101');
  const callerAddress = { guildId: caller.guildId, channelId: '102', provider: caller.provider,
    nativeId: caller.nativeId, generation: caller.generation };
  const requestPacket = channelId => ({
    id: 'same-peer-collision', kind: 'request',
    source: { guildId: target.guildId, channelId, provider: target.provider,
      nativeId: target.nativeId, generation: target.generation },
    target: callerAddress, replyTo: null, routingVersion: 2, text: 'hello'
  });
  f.state.receipt(null, 'agent-message', { packet: requestPacket('202') });
  f.state.receipt(null, 'agent-message', { packet: requestPacket('201') });
  let posts = 0;
  const peer = service(f, { fetchImpl: async () => { posts += 1; assert.fail('ambiguous reply reached network'); } });
  await assert.rejects(peer.send({ peer: { conductorId: 'recipient' }, reply_to: 'same-peer-collision',
    text: 'reply', dedupe_key: 'same-peer-collision-result' }), /ambiguous across parent and child routes/);
  assert.equal(posts, 0);
});

test('peer send rejects inline text that cannot round-trip through UTF-8 staging', async t => {
  const f = fixture(t); f.enroll('102'); addRecipient(f);
  let posts = 0;
  const peer = service(f, { fetchImpl: async () => { posts += 1; assert.fail('invalid UTF-8 text reached network'); } });
  await assert.rejects(peer.send({ peer: { conductorId: 'recipient' }, text: '\ud800', dedupe_key: 'invalid-inline-text' }),
    /round-trip losslessly through UTF-8/);
  assert.equal(posts, 0);
  assert.equal(f.state.directPostRows('invalid-inline-text').length, 0);
});

test('peer result preserves current and rejects stale legacy parent destinations', async t => {
  const f = fixture(t); const target = addRecipient(f);
  const sourceBinding = f.state.getBinding('101');
  const request = {
    id: 'legacy-parent-request', kind: 'request',
    source: { guildId: '100', channelId: '101', provider: 'claude', nativeId: sourceBinding.nativeId, generation: sourceBinding.generation },
    target: { guildId: '100', channelId: '201', provider: 'codex', nativeId: target.nativeId, generation: target.generation },
    replyTo: null, text: 'legacy request'
  };
  const timestamp = new Date().toISOString();
  f.state.db.prepare(`INSERT INTO messages(discord_id, guild_id, channel_id, delivery_channel_id, author_id,
    content, attachments, provider, native_id, workspace, endpoint, conductor_id, repo_key, generation,
    state, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    'legacy-parent-discord', '100', '201', '201', '901', encodeAgentMessage(request, 'fixture'), '[]',
    target.provider, target.nativeId, target.workspace, target.endpoint, target.conductorId, target.repoKey,
    target.generation, 'accepted', timestamp, timestamp);
  f.state.receipt('legacy-parent-discord', 'agent-message', { packet: request, authorId: '901' });
  f.state.receipt('legacy-parent-discord', 'accepted', { channelId: '201', generation: target.generation, readiness: 'ready' });
  assert.equal(f.state.claimDispatch('legacy-parent-discord').claimed, true);
  const calls = [];
  const recipient = createPeerService({ state: f.state, provider: 'codex', token: 'fixture',
    callerDependencies: { environment: { CODEX_THREAD_ID: target.nativeId } },
    fetchImpl: async (url, options) => {
      calls.push({ url, method: options.method });
      return { ok: true, status: 200, json: async () => options.method === 'GET'
        ? { id: '101', guild_id: '100' } : { id: '10002' } };
    } });
  const result = await recipient.send({ reply_to: request.id, text: 'legacy result', dedupe_key: 'legacy-parent-result' });
  assert.equal(result.status, 'sent');
  assert.ok(calls[0].url.endsWith('/channels/101'));
  assert.ok(calls[1].url.endsWith('/channels/101/messages'));
  f.state.db.prepare("UPDATE bindings SET generation=generation+1 WHERE channel_id='101'").run();
  const stale = await recipient.send({ reply_to: request.id, text: 'stale result', dedupe_key: 'legacy-parent-stale' });
  assert.equal(stale.status, 'stale');
});

test('peer result resolves a frozen local child before sibling selection', async t => {
  const f = fixture(t); f.enroll('102'); const recipient = addRecipient(f);
  const binding = f.state.getBinding('101');
  const request = {
    id: 'frozen-local-source-request',
    kind: 'request',
    source: { guildId: '100', channelId: '201', provider: recipient.provider, nativeId: recipient.nativeId, generation: recipient.generation },
    target: { guildId: '100', channelId: '101', provider: binding.provider, nativeId: binding.nativeId, generation: binding.generation },
    replyTo: null,
    text: 'legacy parent request'
  };
  const timestamp = new Date().toISOString();
  f.state.db.prepare(`INSERT INTO messages(discord_id, guild_id, channel_id, delivery_channel_id, author_id, content, attachments,
    provider, native_id, workspace, endpoint, conductor_id, repo_key, generation, state, created_at, updated_at)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    'frozen-local-source-discord', '100', '101', '101', '900', `${PREFIX}legacy`, '[]', binding.provider, binding.nativeId,
    binding.workspace, binding.endpoint, binding.conductorId, binding.repoKey, binding.generation, MESSAGE_STATES.ACCEPTED,
    timestamp, timestamp
  );
  f.state.receipt('frozen-local-source-discord', 'agent-message', { packet: request, authorId: '900' });
  f.state.receipt('frozen-local-source-discord', 'accepted', { channelId: '101', generation: binding.generation, readiness: 'ready' });
  assert.equal(f.state.claimDispatch('frozen-local-source-discord').claimed, true);
  f.state.enrollThread({ threadId: '103', parentChannelId: '101', guildId: '100', adoptionCutoff: '100' }, binding);
  f.state.setThreadBaseline('103', '100', binding);
  f.state.markThreadBoundary('103', THREAD_STATES.READY, 'fixture', null, null, binding);
  let postUrl;
  const peer = service(f, { fetchImpl: async (url, options) => {
    if (options.method === 'GET') {
      f.state.markThreadBoundary('103', THREAD_STATES.UNAVAILABLE, 'fixture child demoted during verification', null, null, binding);
      return { ok: true, status: 200, json: async () => ({ id: '201', guild_id: '100' }) };
    }
    postUrl = url;
    return { ok: true, status: 200, json: async () => ({ id: 'frozen-local-source-result' }) };
  } });
  const result = await peer.send({ reply_to: request.id, text: 'result', dedupe_key: 'frozen-local-source-result' });
  assert.equal(result.status, 'sent');
  assert.equal(f.state.getThreadEnrollment('103').state, THREAD_STATES.UNAVAILABLE);
  assert.match(postUrl, /channels\/201\/messages$/);
  const attempt = f.state.directPostRows('frozen-local-source-result').find(row => row.kind === 'direct-post-attempt');
  assert.equal(attempt.detail.agentPacket.source.channelId, '102');
});

test('peer result resolves a stamped frozen parent route before sibling selection', async t => {
  const f = fixture(t); f.enroll('102'); const recipient = addRecipient(f);
  const binding = f.state.getBinding('101');
  const request = {
    id: 'stamped-frozen-local-source-request',
    kind: 'request',
    source: { guildId: '100', channelId: '201', provider: recipient.provider, nativeId: recipient.nativeId, generation: recipient.generation },
    target: { guildId: '100', channelId: '101', provider: binding.provider, nativeId: binding.nativeId, generation: binding.generation },
    replyTo: null,
    routingVersion: 2,
    text: 'stamped legacy parent request'
  };
  const timestamp = new Date().toISOString();
  f.state.db.prepare(`INSERT INTO messages(discord_id, guild_id, channel_id, delivery_channel_id, author_id, content, attachments,
    provider, native_id, workspace, endpoint, conductor_id, repo_key, generation, state, created_at, updated_at)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    'stamped-frozen-local-source-discord', '100', '101', '101', '900', encodeAgentMessage(request, 'fixture'), '[]', binding.provider,
    binding.nativeId, binding.workspace, binding.endpoint, binding.conductorId, binding.repoKey, binding.generation, MESSAGE_STATES.ACCEPTED,
    timestamp, timestamp
  );
  f.state.receipt('stamped-frozen-local-source-discord', 'agent-message', { packet: request, authorId: '900', routingVersion: 2 });
  f.state.receipt('stamped-frozen-local-source-discord', 'accepted', { channelId: '101', generation: binding.generation, readiness: 'ready' });
  assert.equal(f.state.claimDispatch('stamped-frozen-local-source-discord').claimed, true);
  assert.equal(f.state.getMessage('stamped-frozen-local-source-discord').agentRoute, '102');
  f.state.enrollThread({ threadId: '103', parentChannelId: '101', guildId: '100', adoptionCutoff: '100' }, binding);
  f.state.setThreadBaseline('103', '100', binding);
  f.state.markThreadBoundary('103', THREAD_STATES.READY, 'fixture', null, null, binding);
  let postUrl;
  const peer = service(f, { fetchImpl: async (url, options) => {
    if (options.method === 'GET') return { ok: true, status: 200, json: async () => ({ id: '201', guild_id: '100' }) };
    postUrl = url;
    return { ok: true, status: 200, json: async () => ({ id: 'stamped-frozen-local-source-result' }) };
  } });
  const result = await peer.send({ reply_to: request.id, text: 'result', dedupe_key: 'stamped-frozen-local-source-result' });
  assert.equal(result.status, 'sent');
  assert.match(postUrl, /channels\/201\/messages$/);
  const attempt = f.state.directPostRows('stamped-frozen-local-source-result').find(row => row.kind === 'direct-post-attempt');
  assert.equal(attempt.detail.agentPacket.source.channelId, '102');
});

test('peer-qualified legacy reply finds a child-sourced request and keeps its frozen local route', async t => {
  const f = fixture(t); f.enroll('102'); const recipient = addRecipient(f);
  const caller = f.state.getBinding('101');
  const request = {
    id: 'child-sourced-legacy-request', kind: 'request',
    source: { guildId: recipient.guildId, channelId: '202', provider: recipient.provider,
      nativeId: recipient.nativeId, generation: recipient.generation },
    target: { guildId: caller.guildId, channelId: caller.channelId, provider: caller.provider,
      nativeId: caller.nativeId, generation: caller.generation },
    replyTo: null, text: 'legacy child source'
  };
  const timestamp = new Date().toISOString();
  f.state.db.prepare(`INSERT INTO messages(discord_id, guild_id, channel_id, delivery_channel_id, author_id, content,
    attachments, provider, native_id, workspace, endpoint, conductor_id, repo_key, generation, state, created_at, updated_at)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    'child-sourced-legacy-discord', '100', '101', '101', '900', encodeAgentMessage(request, 'fixture'), '[]',
    caller.provider, caller.nativeId, caller.workspace, caller.endpoint, caller.conductorId, caller.repoKey,
    caller.generation, MESSAGE_STATES.ACCEPTED, timestamp, timestamp
  );
  f.state.receipt('child-sourced-legacy-discord', 'agent-message', { packet: request, authorId: '900' });
  assert.equal(f.state.claimDispatch('child-sourced-legacy-discord').claimed, true);
  assert.equal(f.state.getMessage('child-sourced-legacy-discord').agentRoute, '102');
  f.enroll('103');
  f.state.enrollThread({ threadId: '203', parentChannelId: '201', guildId: '100', adoptionCutoff: '100' }, recipient);
  f.state.setThreadBaseline('203', '100', recipient);
  f.state.markThreadBoundary('203', THREAD_STATES.READY, 'fixture', null, null, recipient);
  let postUrl;
  const peer = service(f, { fetchImpl: async (url, options) => {
    if (options.method === 'GET') return { ok: true, status: 200, json: async () => ({ id: '202', guild_id: '100' }) };
    postUrl = url;
    return { ok: true, status: 200, json: async () => ({ id: 'child-sourced-legacy-result' }) };
  } });
  const result = await peer.send({ peer: { conductorId: 'recipient' }, reply_to: request.id,
    text: 'result', dedupe_key: 'child-sourced-legacy-result' });
  assert.equal(result.status, 'sent');
  assert.match(postUrl, /channels\/202\/messages$/);
  const attempt = f.state.directPostRows('child-sourced-legacy-result').find(row => row.kind === 'direct-post-attempt');
  assert.equal(attempt.detail.agentPacket.source.channelId, '102');
});

test('correlated reply keeps a recorded child route when another child enrolls', async t => {
  const f = fixture(t); f.enroll('102'); const target = addRecipient(f);
  const caller = f.state.getBinding('101');
  const request = {
    id: 'child-route-request', kind: 'request',
    source: { guildId: target.guildId, channelId: '202', provider: target.provider,
      nativeId: target.nativeId, generation: target.generation },
    target: { guildId: caller.guildId, channelId: '102', provider: caller.provider,
      nativeId: caller.nativeId, generation: caller.generation },
    replyTo: null, text: 'child request'
  };
  f.state.receipt(null, 'agent-message', { packet: request });
  f.state.enrollThread({ threadId: '203', parentChannelId: '201', guildId: '100', adoptionCutoff: '100' }, target);
  f.state.setThreadBaseline('203', '100', target);
  f.state.markThreadBoundary('203', THREAD_STATES.READY, 'fixture', null, null, target);
  let postUrl;
  const peer = service(f, { fetchImpl: async (url, options) => {
    if (options.method === 'GET') return { ok: true, status: 200, json: async () => ({ id: '202', guild_id: '100' }) };
    postUrl = url;
    return { ok: true, status: 200, json: async () => ({ id: '10003' }) };
  } });
  const result = await peer.send({ reply_to: request.id, text: 'child result', dedupe_key: 'child-route-result' });
  assert.equal(result.status, 'sent');
  assert.match(postUrl, /channels\/202\/messages$/);
});

test('correlated reply keeps a remote child route after destination demotion', async t => {
  const f = fixture(t); f.enroll('102'); const target = addRecipient(f);
  const caller = f.state.getBinding('101');
  const request = {
    id: 'remote-child-demotion-request', kind: 'request',
    source: { guildId: target.guildId, channelId: '202', provider: target.provider,
      nativeId: target.nativeId, generation: target.generation },
    target: { guildId: caller.guildId, channelId: caller.channelId, provider: caller.provider,
      nativeId: caller.nativeId, generation: caller.generation },
    replyTo: null, text: 'remote child request'
  };
  const timestamp = new Date().toISOString();
  f.state.db.prepare(`INSERT INTO messages(discord_id, guild_id, channel_id, delivery_channel_id, author_id, content,
    attachments, provider, native_id, workspace, endpoint, conductor_id, repo_key, generation, state, created_at, updated_at)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    'remote-child-demotion-discord', caller.guildId, caller.channelId, caller.channelId, '900', encodeAgentMessage(request, 'fixture'), '[]',
    caller.provider, caller.nativeId, caller.workspace, caller.endpoint, caller.conductorId, caller.repoKey, caller.generation,
    MESSAGE_STATES.ACCEPTED, timestamp, timestamp);
  f.state.receipt('remote-child-demotion-discord', 'agent-message', { packet: request, authorId: '900' });
  f.state.receipt('remote-child-demotion-discord', 'accepted', { channelId: caller.channelId, generation: caller.generation, readiness: 'ready' });
  assert.equal(f.state.claimDispatch('remote-child-demotion-discord').claimed, true);
  let posts = 0;
  const peer = service(f, { fetchImpl: async (url, options) => {
    if (options.method === 'GET') {
      f.state.markThreadBoundary('202', THREAD_STATES.UNAVAILABLE, 'remote child demoted during verification', null, null, target);
      return { ok: true, status: 200, json: async () => ({ id: '202', guild_id: '100' }) };
    }
    posts += 1;
    return { ok: true, status: 200, json: async () => ({ id: 'remote-child-demotion-result' }) };
  } });
  const result = await peer.send({ reply_to: request.id, text: 'result', dedupe_key: 'remote-child-demotion-result' });
  assert.equal(result.status, 'sent');
  assert.equal(posts, 1);
});

test('peer-qualified reply keeps the recorded child when the peer has multiple ready children', async t => {
  for (const demoted of [false, true]) {
    await t.test(demoted ? 'recorded child unavailable' : 'recorded child ready', async child => {
      const f = fixture(child); f.enroll('102'); const target = addRecipient(f);
      f.state.enrollThread({ threadId: '203', parentChannelId: '201', guildId: '100', adoptionCutoff: '100' }, target);
      f.state.setThreadBaseline('203', '100', target);
      f.state.markThreadBoundary('203', THREAD_STATES.READY, 'fixture', null, null, target);
      const caller = f.state.getBinding('101');
      const requestPacket = {
        id: 'multi-child-request', kind: 'request',
        source: { guildId: target.guildId, channelId: '202', provider: target.provider,
          nativeId: target.nativeId, generation: target.generation },
        target: { guildId: caller.guildId, channelId: '102', provider: caller.provider,
          nativeId: caller.nativeId, generation: caller.generation },
        replyTo: null, routingVersion: 2, text: 'hello'
      };
      f.state.receipt(null, 'agent-message', { packet: requestPacket });
      if (demoted) f.state.markThreadBoundary('202', THREAD_STATES.UNAVAILABLE, 'fixture', null, null, target);
      let postUrl;
      const peer = service(f, { fetchImpl: async (url, options) => {
        if (options.method === 'GET') return { ok: true, status: 200, json: async () => ({ id: '202', guild_id: '100' }) };
        postUrl = url;
        return { ok: true, status: 200, json: async () => ({ id: '10003' }) };
      } });
      const result = await peer.send({ peer: { conductorId: 'recipient' }, reply_to: requestPacket.id,
        text: 'child result', dedupe_key: 'multi-child-result' });
      assert.equal(result.status, 'sent');
      assert.match(postUrl, /channels\/202\/messages$/);
    });
  }
});

test('new peer request refuses publication after destination child ambiguity appears during verification', async t => {
  const f = fixture(t); f.enroll('102'); const target = addRecipient(f);
  let posts = 0;
  const peer = service(f, { fetchImpl: async (url, options) => {
    if (options.method === 'GET') {
      f.state.enrollThread({ threadId: '203', parentChannelId: '201', guildId: '100', adoptionCutoff: '100' }, target);
      f.state.setThreadBaseline('203', '100', target);
      f.state.markThreadBoundary('203', THREAD_STATES.READY, 'fixture', null, null, target);
      return { ok: true, status: 200, json: async () => ({ id: '202', guild_id: '100' }) };
    }
    posts += 1;
    return { ok: true, status: 200, json: async () => ({ id: '10003' }) };
  } });
  const result = await peer.send({ peer: { conductorId: 'recipient' }, text: 'hello', dedupe_key: 'ambiguous-new' });
  assert.equal(result.status, 'stale');
  assert.equal(posts, 0);
  const rows = f.state.directPostRows('ambiguous-new');
  assert.equal(rows.filter(row => row.kind === 'direct-post-attempt').length, 0);
  assert.deepEqual(rows.filter(row => row.kind === 'direct-post-outcome').map(row => row.detail.outcome), ['stale']);
});

test('peer result refuses to expose text after caller handoff during inspection', async t => {
  const f = fixture(t); f.enroll('102'); addRecipient(f);
  const peer = service(f, { fetchImpl: async (url, options) => {
    if (options.method === 'GET') return { ok: true, status: 200, json: async () => ({ id: '202', guild_id: '100' }) };
    return { ok: true, status: 200, json: async () => ({ id: '10004' }) };
  } });
  const input = { peer: { conductorId: 'recipient' }, text: 'hello', dedupe_key: 'caller-fence-request' };
  assert.equal((await peer.send(input)).status, 'sent');
  const originalDirectPostRows = f.state.directPostRows.bind(f.state);
  let handedOff = false;
  f.state.directPostRows = (...args) => {
    const rows = originalDirectPostRows(...args);
    if (!handedOff) {
      handedOff = true;
      f.state.db.prepare("UPDATE bindings SET generation=generation+1 WHERE channel_id='101'").run();
    }
    return rows;
  };
  await assert.rejects(peer.result(input.dedupe_key), /caller changed during result inspection/);
});

for (const outcome of ['sent', 'unknown']) {
  test(`concurrent peer sends retain one attempt when transport is ${outcome}`, async t => {
    const f = fixture(t); f.enroll('102'); addRecipient(f);
    let release;
    const held = new Promise(resolve => { release = resolve; });
    let entered;
    const started = new Promise(resolve => { entered = resolve; });
    let posts = 0;
    const peer = service(f, { fetchImpl: async (url, options) => {
      if (options.method === 'GET') return { ok: true, status: 200, json: async () => ({ id: '202', guild_id: '100' }) };
      posts++; entered(); await held;
      return { ok: outcome === 'sent', status: outcome === 'sent' ? 200 : 500, json: async () => ({ id: '10001' }) };
    } });
    const input = { ...request, peer: { conductorId: 'recipient' } };
    const first = peer.send(input);
    try {
      await started;
      assert.equal((await peer.send(input)).status, 'in_flight');
    } finally { release(); }
    assert.equal((await first).status, outcome);
    assert.equal((await peer.send(input)).status, outcome);
    assert.equal(posts, 1);
    const rows = f.state.directPostRows(input.dedupe_key);
    assert.equal(rows.filter(row => row.kind === 'direct-post-attempt').length, 1);
    assert.equal(rows.filter(row => row.kind === 'direct-post-outcome').length, 1);
    assert.equal((await peer.result(input.dedupe_key)).sendOutcome, outcome);
  });
}

for (const transition of ['handoff', 'cancel']) {
  test(`peer send refuses publication after ${transition} during channel verification`, async t => {
    const f = fixture(t); f.enroll('102'); addRecipient(f);
    const abort = new AbortController();
    const peer = service(f, { fetchImpl: async (url, options) => {
      assert.equal(options.method, 'GET');
      if (transition === 'handoff') f.state.db.prepare("UPDATE bindings SET generation=generation+1 WHERE channel_id='101'").run();
      else abort.abort();
      return { ok: true, status: 200, json: async () => ({ id: '202', guild_id: '100' }) };
    } });
    const result = await peer.send({ ...request, peer: { conductorId: 'recipient' } }, abort.signal);
    assert.equal(result.status, transition === 'handoff' ? 'stale' : 'not_sent');
    assert.equal(f.state.directPostRows(request.dedupe_key).filter(row => row.kind === 'direct-post-attempt').length, 0);
  });
}

test('target generation is resolved after asynchronous peer name lookup', async t => {
  const f = fixture(t); f.enroll('102'); const target = addRecipient(f);
  const peer = service(f, { loadChannels: async () => {
    f.state.db.prepare("UPDATE bindings SET generation=generation+1 WHERE channel_id='201'").run();
    return [{ id: '201', guildId: '100', name: 'recipient' }];
  }, fetchImpl: async (url, options) => {
    if (options.method === 'GET') return { ok: true, status: 200, json: async () => ({ id: '202', guild_id: '100' }) };
    const wire = await options.body.get('files[0]').text();
    const packet = require('../src/agent-message').decodeAgentMessage(wire, 'fixture', {
      guildId: '100', channelId: '202', provider: 'codex', nativeId: target.nativeId, generation: 2
    });
    assert.equal(packet.target.generation, 2);
    return { ok: true, status: 200, json: async () => ({ id: '10001' }) };
  } });
  assert.equal((await peer.send({ ...request, peer: { channelName: 'recipient' } })).status, 'sent');
});

test('peer send refuses publication after destination handoff during channel verification', async t => {
  const f = fixture(t); f.enroll('102'); addRecipient(f); let posts = 0;
  const peer = service(f, { fetchImpl: async (url, options) => {
    if (options.method === 'GET') {
      f.state.db.prepare("UPDATE bindings SET generation=generation+1 WHERE channel_id='201'").run();
      return { ok: true, status: 200, json: async () => ({ id: '202', guild_id: '100' }) };
    }
    posts += 1;
    return { ok: true, status: 200, json: async () => ({ id: '10001' }) };
  } });
  const result = await peer.send({ ...request, peer: { conductorId: 'recipient' } });
  assert.equal(result.status, 'stale');
  assert.equal(posts, 0);
  assert.equal(f.state.directPostRows(request.dedupe_key).filter(row => row.kind === 'direct-post-attempt').length, 0);
});

test('peer send refuses publication after source intake gap during channel verification', async t => {
  const f = fixture(t); f.enroll('102'); addRecipient(f); let posts = 0;
  f.state.upsertIntakeWatermark({ channelId: '101', guildId: '100', id: '101' }, true);
  const peer = service(f, { fetchImpl: async (url, options) => {
    if (options.method === 'GET') {
      f.state.db.prepare("UPDATE intake_watermarks SET state='gap' WHERE channel_id='101'").run();
      return { ok: true, status: 200, json: async () => ({ id: '202', guild_id: '100' }) };
    }
    posts += 1;
    return { ok: true, status: 200, json: async () => ({ id: '10001' }) };
  } });
  const result = await peer.send({ ...request, peer: { conductorId: 'recipient' } });
  assert.equal(result.status, 'stale');
  assert.equal(posts, 0);
  assert.equal(f.state.directPostRows(request.dedupe_key).filter(row => row.kind === 'direct-post-attempt').length, 0);
});

test('peer send refuses publication after source watermark changes during channel verification', async t => {
  const f = fixture(t); f.enroll('102'); addRecipient(f); let posts = 0;
  const peer = service(f, { fetchImpl: async (url, options) => {
    if (options.method === 'GET') {
      f.state.markIntakeBoundary('101', 'pending', 'fixture recovery started', null, null, f.state.getBinding('101'));
      return { ok: true, status: 200, json: async () => ({ id: '202', guild_id: '100' }) };
    }
    posts += 1;
    return { ok: true, status: 200, json: async () => ({ id: '10001' }) };
  } });
  const result = await peer.send({ ...request, peer: { conductorId: 'recipient' } });
  assert.equal(result.status, 'stale');
  assert.equal(posts, 0);
  assert.equal(f.state.directPostRows(request.dedupe_key).filter(row => row.kind === 'direct-post-attempt').length, 0);
});

test('peer send refuses publication after destination child loses readiness during channel verification', async t => {
  const f = fixture(t); f.enroll('102'); addRecipient(f); let posts = 0;
  const peer = service(f, { fetchImpl: async (url, options) => {
    if (options.method === 'GET') {
      f.state.db.prepare("UPDATE thread_enrollments SET state='pending' WHERE thread_id='202'").run();
      return { ok: true, status: 200, json: async () => ({ id: '202', guild_id: '100' }) };
    }
    posts += 1;
    return { ok: true, status: 200, json: async () => ({ id: '10001' }) };
  } });
  const result = await peer.send({ ...request, peer: { conductorId: 'recipient' } });
  assert.equal(result.status, 'stale');
  assert.equal(posts, 0);
  assert.equal(f.state.directPostRows(request.dedupe_key).filter(row => row.kind === 'direct-post-attempt').length, 0);
});

test('ready caller refuses send to unready destination binding gap before network or custody', async t => {
  const f = fixture(t); f.enroll('102'); addRecipient(f);
  assert.equal(f.state.getBinding('101').readiness, READINESS.READY);
  assert.equal(f.state.getThreadEnrollment('102').state, THREAD_STATES.READY);
  f.state.setBindingReadiness('201', READINESS.GAP, 'fixture destination gap', f.state.getBinding('201'));
  let calls = 0;
  const peer = service(f, { fetchImpl: async () => { calls += 1; assert.fail('unready destination reached network'); } });
  const receipts = f.state.listReceipts();
  const messages = f.state.db.prepare('SELECT * FROM messages ORDER BY rowid').all();
  await assert.rejects(peer.send({ peer: { conductorId: 'recipient' }, text: 'hello', dedupe_key: 'unready-destination-binding-gap' }),
    error => error instanceof Error && error.message === 'peer is not ready: fixture destination gap');
  assert.equal(calls, 0);
  assert.deepEqual(f.state.listReceipts(), receipts);
  assert.deepEqual(f.state.db.prepare('SELECT * FROM messages ORDER BY rowid').all(), messages);
});

test('ready caller refuses send to unready destination binding unavailable before network or custody', async t => {
  const f = fixture(t); f.enroll('102'); addRecipient(f);
  assert.equal(f.state.getBinding('101').readiness, READINESS.READY);
  assert.equal(f.state.getThreadEnrollment('102').state, THREAD_STATES.READY);
  f.state.setBindingReadiness('201', READINESS.UNAVAILABLE, 'fixture destination unavailable', f.state.getBinding('201'));
  let calls = 0;
  const peer = service(f, { fetchImpl: async () => { calls += 1; assert.fail('unready destination reached network'); } });
  const receipts = f.state.listReceipts();
  const messages = f.state.db.prepare('SELECT * FROM messages ORDER BY rowid').all();
  await assert.rejects(peer.send({ peer: { conductorId: 'recipient' }, text: 'hello', dedupe_key: 'unready-destination-binding-unavailable' }),
    error => error instanceof Error && error.message === 'peer is not ready: fixture destination unavailable');
  assert.equal(calls, 0);
  assert.deepEqual(f.state.listReceipts(), receipts);
  assert.deepEqual(f.state.db.prepare('SELECT * FROM messages ORDER BY rowid').all(), messages);
});

test('ready caller refuses send to unready destination child before network or custody', async t => {
  const f = fixture(t); f.enroll('102'); const target = addRecipient(f);
  assert.equal(f.state.getBinding('101').readiness, READINESS.READY);
  assert.equal(f.state.getThreadEnrollment('102').state, THREAD_STATES.READY);
  f.state.markThreadBoundary('202', THREAD_STATES.GAP, 'fixture destination child gap', null, null, target);
  let calls = 0;
  const peer = service(f, { fetchImpl: async () => { calls += 1; assert.fail('unready destination reached network'); } });
  const receipts = f.state.listReceipts();
  const messages = f.state.db.prepare('SELECT * FROM messages ORDER BY rowid').all();
  await assert.rejects(peer.send({ peer: { conductorId: 'recipient' }, text: 'hello', dedupe_key: 'unready-destination-child-gap' }),
    error => error instanceof Error && error.message === 'peer child is not ready: fixture destination child gap');
  assert.equal(calls, 0);
  assert.deepEqual(f.state.listReceipts(), receipts);
  assert.deepEqual(f.state.db.prepare('SELECT * FROM messages ORDER BY rowid').all(), messages);
});

test('peer result refuses publication after correlated destination handoff', async t => {
  const f = fixture(t); f.enroll('102'); const target = addRecipient(f); let requestWire; let posts = 0;
  const peer = service(f, { fetchImpl: async (url, options) => {
    if (options.method === 'GET') return { ok: true, status: 200, json: async () => ({ id: '202', guild_id: '100' }) };
    requestWire = await options.body.get('files[0]').text();
    return { ok: true, status: 200, json: async () => ({ id: '10001' }) };
  } });
  assert.equal((await peer.send({ ...request, peer: { conductorId: 'recipient' } })).status, 'sent');
  assert.equal(f.state.acceptDiscordMessage({ id: '10001', guildId: '100', channelId: '202', authorId: '901', isBot: true,
    content: requestWire }, { agentToken: 'fixture' }).accepted, true);
  const recipient = createPeerService({ state: f.state, provider: 'codex', token: 'fixture',
    callerDependencies: { environment: { CODEX_THREAD_ID: target.nativeId } },
    fetchImpl: async (url, options) => {
      if (options.method === 'GET') {
        f.state.db.prepare("UPDATE bindings SET generation=generation+1 WHERE channel_id='101'").run();
        return { ok: true, status: 200, json: async () => ({ id: '102', guild_id: '100' }) };
      }
      posts += 1;
      return { ok: true, status: 200, json: async () => ({ id: '10002' }) };
    } });
  const result = await recipient.send({ reply_to: request.dedupe_key, text: 'result', dedupe_key: 'result-race' });
  assert.equal(result.status, 'stale');
  assert.equal(posts, 0);
  assert.equal(f.state.directPostRows('result-race').filter(row => row.kind === 'direct-post-attempt').length, 0);
});
