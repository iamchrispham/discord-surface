const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fixture, service, addRecipient } = require('./fixtures/peer-fixture');
const { createPeerService } = require('../src/peer/service');
const { READINESS } = require('../src/state');
const { THREAD_STATES } = require('../src/state/thread-enrollment');
const { decodeAgentMessage, encodeAgentMessage } = require('../src/agent-message');
const id = '11111111-1111-1111-1111-111111111111';
function addOrdinaryRecipient(f) {
  f.state.bind({ guildId: '100', channelId: '301', provider: 'codex', nativeId: '33333333-3333-3333-3333-333333333333',
    workspace: '/tmp' });
  const target = f.state.setBindingReadiness('301', READINESS.READY, 'fixture', f.state.getBinding('301'));
  f.state.enrollThread({ threadId: '302', parentChannelId: '301', guildId: '100' }, target);
  f.state.markThreadBoundary('302', 'ready', 'fixture', null, null, target);
  return target;
}

function addSecondRecipient(f) {
  f.state.bind({ guildId: '100', channelId: '301', provider: 'codex', nativeId: '33333333-3333-3333-3333-333333333333',
    workspace: '/tmp', conductorId: 'second-recipient', repoKey: 'github.com/test/second-recipient' });
  const target = f.state.setBindingReadiness('301', READINESS.READY, 'fixture', f.state.getBinding('301'));
  f.state.enrollThread({ threadId: '302', parentChannelId: '301', guildId: '100' }, target);
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
  const accepted = f.state.acceptDiscordMessage({ id: 'foreign-parent-result-discord', guildId: '100',
    channelId: requestPacket.source.channelId, authorId: '901', isBot: true,
    content: encodeAgentMessage(foreignResult, 'fixture') }, { agentToken: 'fixture' });
  assert.equal(accepted.accepted, true, JSON.stringify(accepted));
  assert.deepEqual((await peer.result(requestPacket.id)).results, []);
});

test('peer custody scopes a reused packet ID to each caller channel', async t => {
  const f = fixture(t); f.enroll('102'); addRecipient(f);
  const secondNativeId = '33333333-3333-3333-3333-333333333333';
  f.state.bind({ guildId: '100', channelId: '301', provider: 'codex', nativeId: secondNativeId,
    workspace: '/tmp', endpoint: '/tmp/second-caller.sock', conductorId: 'second-caller', repoKey: 'github.com/test/second-caller' });
  const secondBinding = f.state.setBindingReadiness('301', READINESS.READY, 'fixture', f.state.getBinding('301'));
  f.state.enrollThread({ threadId: '302', parentChannelId: '301', guildId: '100' }, secondBinding);
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
  assert.equal(posts, 2);
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
  f.state.receipt(null, 'agent-message', { packet: request });
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
  f.state.upsertIntakeWatermark({ channelId: '101', guildId: '100', id: '1' }, true);
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
      f.state.upsertIntakeWatermark({ channelId: '101', guildId: '100', id: '1' }, true);
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
