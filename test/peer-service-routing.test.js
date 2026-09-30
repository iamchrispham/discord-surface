const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, service, addRecipient } = require('./fixtures/peer-fixture');
const { createPeerService } = require('../src/peer/service');
const { MESSAGE_STATES } = require('../src/state');
const { THREAD_STATES } = require('../src/state/thread-enrollment');
const { decodeAgentMessage, encodeAgentMessage, PREFIX } = require('../src/agent-message');
const { id, request } = require('./peer-service-scenarios/setup.cjs');

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
