const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, service, addRecipient } = require('./fixtures/peer-fixture');
const { createPeerService } = require('../src/peer/service');
const { READINESS, MESSAGE_STATES } = require('../src/state');
const { THREAD_STATES } = require('../src/state/thread-enrollment');
const { decodeAgentMessage, encodeAgentMessage } = require('../src/agent-message');
const { id, addSecondRecipient, request } = require('./peer-service-scenarios/setup.cjs');

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
