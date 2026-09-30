const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fixture, service, addRecipient } = require('./fixtures/peer-fixture');
const { createPeerService } = require('../src/peer/service');
const { READINESS } = require('../src/state');
const { decodeAgentMessage } = require('../src/agent-message');
const { id, addOrdinaryRecipient, request } = require('./peer-service-scenarios/setup.cjs');

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
