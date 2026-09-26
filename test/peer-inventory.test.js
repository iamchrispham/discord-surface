const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, service, addRecipient } = require('./fixtures/peer-fixture');
const { READINESS } = require('../src/state');
const { THREAD_STATES } = require('../src/state/thread-enrollment');

test('inventory destination binding gap is diagnostic and read-only', async t => {
  const f = fixture(t); f.enroll('102'); addRecipient(f);
  assert.equal(f.state.getBinding('101').readiness, READINESS.READY);
  assert.equal(f.state.getThreadEnrollment('102').state, THREAD_STATES.READY);
  f.state.setBindingReadiness('201', READINESS.GAP, 'fixture destination gap', f.state.getBinding('201'));
  let calls = 0;
  const peer = service(f, { fetchImpl: async () => { calls += 1; } });
  const receipts = f.state.listReceipts();
  const messages = f.state.db.prepare('SELECT * FROM messages ORDER BY rowid').all();
  const listed = await peer.list();
  const caller = listed.find(entry => entry.channelId === '101');
  const target = listed.find(entry => entry.channelId === '201');
  assert.ok(caller, 'caller row is present');
  assert.equal(caller.reachable, true);
  assert.equal(caller.childId, '102');
  assert.ok(target, 'target row is present');
  assert.equal(target.reachable, false);
  assert.equal(target.reason, 'peer is not ready: fixture destination gap');
  assert.equal(calls, 0);
  assert.deepEqual(f.state.listReceipts(), receipts);
  assert.deepEqual(f.state.db.prepare('SELECT * FROM messages ORDER BY rowid').all(), messages);
});

test('inventory destination binding unavailable is diagnostic and read-only', async t => {
  const f = fixture(t); f.enroll('102'); addRecipient(f);
  assert.equal(f.state.getBinding('101').readiness, READINESS.READY);
  assert.equal(f.state.getThreadEnrollment('102').state, THREAD_STATES.READY);
  f.state.setBindingReadiness('201', READINESS.UNAVAILABLE, 'fixture destination unavailable', f.state.getBinding('201'));
  let calls = 0;
  const peer = service(f, { fetchImpl: async () => { calls += 1; } });
  const receipts = f.state.listReceipts();
  const messages = f.state.db.prepare('SELECT * FROM messages ORDER BY rowid').all();
  const listed = await peer.list();
  const caller = listed.find(entry => entry.channelId === '101');
  const target = listed.find(entry => entry.channelId === '201');
  assert.ok(caller, 'caller row is present');
  assert.equal(caller.reachable, true);
  assert.equal(caller.childId, '102');
  assert.ok(target, 'target row is present');
  assert.equal(target.reachable, false);
  assert.equal(target.reason, 'peer is not ready: fixture destination unavailable');
  assert.equal(calls, 0);
  assert.deepEqual(f.state.listReceipts(), receipts);
  assert.deepEqual(f.state.db.prepare('SELECT * FROM messages ORDER BY rowid').all(), messages);
});

test('inventory destination child gap is diagnostic and read-only', async t => {
  const f = fixture(t); f.enroll('102'); const target = addRecipient(f);
  assert.equal(f.state.getBinding('101').readiness, READINESS.READY);
  assert.equal(f.state.getThreadEnrollment('102').state, THREAD_STATES.READY);
  assert.equal(f.state.getBinding('201').readiness, READINESS.READY);
  f.state.markThreadBoundary('202', THREAD_STATES.GAP, 'fixture destination child gap', null, null, target);
  let calls = 0;
  const peer = service(f, { fetchImpl: async () => { calls += 1; } });
  const receipts = f.state.listReceipts();
  const messages = f.state.db.prepare('SELECT * FROM messages ORDER BY rowid').all();
  const listed = await peer.list();
  const caller = listed.find(entry => entry.channelId === '101');
  const destination = listed.find(entry => entry.channelId === '201');
  assert.ok(caller, 'caller row is present');
  assert.equal(caller.reachable, true);
  assert.equal(caller.childId, '102');
  assert.ok(destination, 'target row is present');
  assert.equal(destination.reachable, false);
  assert.equal(destination.reason, 'peer child is not ready: fixture destination child gap');
  assert.equal(calls, 0);
  assert.deepEqual(f.state.listReceipts(), receipts);
  assert.deepEqual(f.state.db.prepare('SELECT * FROM messages ORDER BY rowid').all(), messages);
});

test('inventory excludes inactive and foreign guild bindings', async t => {
  const f = fixture(t); f.enroll('102'); addRecipient(f);
  f.state.bind({ guildId: '100', channelId: '301', provider: 'codex', nativeId: '33333333-3333-3333-3333-333333333333', workspace: '/tmp' });
  f.state.setBindingReadiness('301', READINESS.READY, 'fixture', f.state.getBinding('301'));
  f.state.unbind('301');
  assert.equal(f.state.getBinding('301').active, false);
  const row = f.state.db.prepare("SELECT * FROM bindings WHERE channel_id='201'").get();
  f.state.db.prepare(`INSERT INTO bindings(channel_id, guild_id, provider, native_id, workspace, session_root, endpoint,
    category_id, conductor_id, repo_key, readiness, generation, active, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('401', '999', row.provider, '44444444-4444-4444-4444-444444444444',
    row.workspace, row.session_root, row.endpoint, row.category_id, null, row.repo_key, row.readiness,
    row.generation, row.active, row.updated_at);
  assert.equal(f.state.getBinding('401').guildId, '999');
  const listed = await service(f).list();
  assert.deepEqual(listed.map(entry => entry.channelId).sort(), ['101', '201']);
});
