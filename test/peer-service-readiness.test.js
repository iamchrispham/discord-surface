const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, service, addRecipient } = require('./fixtures/peer-fixture');
const { createPeerService } = require('../src/peer/service');
const { READINESS } = require('../src/state');
const { THREAD_STATES } = require('../src/state/thread-enrollment');
const { id, request } = require('./peer-service-scenarios/setup.cjs');

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
