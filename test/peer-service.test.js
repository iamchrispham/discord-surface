const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./fixtures/peer-fixture');
const { createPeerService } = require('../src/peer/service');
const { READINESS } = require('../src/state');
const id = '11111111-1111-1111-1111-111111111111';
function service(f, extras = {}) {
  return createPeerService({ state: f.state, provider: 'claude', token: 'fixture',
    callerDependencies: { resolveClaudeCaller: async () => ({ harness: 'claude-code', sessionId: id }) },
    fetchImpl: async () => { assert.fail('refused send reached network'); }, ...extras });
}
function addRecipient(f) {
  f.state.bind({ guildId: '100', channelId: '201', provider: 'codex', nativeId: '22222222-2222-2222-2222-222222222222',
    workspace: '/tmp', conductorId: 'recipient', repoKey: 'github.com/test/recipient' });
  const target = f.state.setBindingReadiness('201', READINESS.READY, 'fixture', f.state.getBinding('201'));
  f.state.enrollThread({ threadId: '202', parentChannelId: '201', guildId: '100' }, target);
  f.state.markThreadBoundary('202', 'ready', 'fixture', null, null, target);
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

test('peer list omits the caller even when its child is ready', async t => {
  const f = fixture(t); const peer = service(f);
  assert.deepEqual(await peer.list(), []);
  f.enroll('102');
  assert.deepEqual(await peer.list(), []);
  f.state.setBindingReadiness('101', READINESS.GAP, 'fixture', f.state.getBinding('101'));
  assert.deepEqual(await peer.list(), []);
  const before = f.state.listReceipts().length;
  await assert.rejects(peer.send(request), /not ready/);
  assert.equal(f.state.listReceipts().length, before);
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
  await assert.rejects(peer.send({ ...request, reply_to: 'other' }), /exactly one of peer/);
  await assert.rejects(peer.send({ ...request, text_file: '/ignored' }), /exactly one of text/);
  assert.equal(f.state.listReceipts().length, before);
});

test('peer packet IDs refuse invalid lengths and characters before custody', async t => {
  const f = fixture(t); const peer = service(f); const before = f.state.listReceipts().length;
  await assert.rejects(peer.send({ ...request, dedupe_key: 'a'.repeat(129) }), /valid packet id/);
  await assert.rejects(peer.send({ ...request, dedupe_key: 'job:123' }), /valid packet id/);
  await assert.rejects(peer.send({ peer: request.peer, text: 'hello', dedupe_key: 'ok', reply_to: 'job:123' }), /exactly one of peer/);
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
