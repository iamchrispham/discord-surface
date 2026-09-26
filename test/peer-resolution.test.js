const test = require('node:test');
const assert = require('node:assert/strict');
const { READINESS } = require('../src/state');
const { resolvePeerBinding, requireReadyPeer } = require('../dist/peer/resolution');

const { fixture } = require('./fixtures/peer-fixture');

test('peer resolution returns current owner and requires an enrolled ready child', t => {
  const f = fixture(t);
  const select = { repoKey: 'github.com/test/repo', provider: 'claude' };
  assert.throws(() => requireReadyPeer(f.state, resolvePeerBinding(f.state, select)), /no enrolled child/);
  f.enroll('102');
  assert.equal(requireReadyPeer(f.state, resolvePeerBinding(f.state, select)).childId, '102');
  f.state.db.prepare('UPDATE bindings SET generation=2, native_id=? WHERE channel_id=?')
    .run('22222222-2222-2222-2222-222222222222', '101');
  assert.equal(resolvePeerBinding(f.state, select).generation, 2);
  assert.equal(resolvePeerBinding(f.state, select).nativeId, '22222222-2222-2222-2222-222222222222');
});

test('gap and ambiguous children never select an arbitrary route', t => {
  const f = fixture(t); f.enroll('102');
  f.state.setBindingReadiness('101', READINESS.GAP, 'fixture', f.state.getBinding('101'));
  assert.throws(() => requireReadyPeer(f.state, resolvePeerBinding(f.state, { conductorId: 'test-conductor' })), /not ready/);
  f.ready(); f.enroll('103');
  assert.throws(() => requireReadyPeer(f.state, resolvePeerBinding(f.state, { conductorId: 'test-conductor' })), /ambiguous/);
});

test('channel names resolve inside the configured guild and ignore unbound collisions', t => {
  const f = fixture(t); const selector = { channelName: 'advisor' };
  const channels = [{ id: '101', guildId: '100', name: 'advisor' }, { id: '999', guildId: '200', name: 'advisor' }];
  assert.equal(resolvePeerBinding(f.state, selector, channels).channelId, '101');
  assert.equal(resolvePeerBinding(f.state, selector, [...channels, { id: '103', guildId: '100', name: 'advisor' }]).channelId, '101');
  assert.throws(() => resolvePeerBinding(f.state, selector, []), /unknown/);
});

test('malformed selectors and inactive owners refuse rather than guess', t => {
  const f = fixture(t);
  for (const selector of [null, {}, { conductorId: 'test-conductor', channelName: 'advisor' }, { repoKey: 'x', provider: 'other' }]) {
    assert.throws(() => resolvePeerBinding(f.state, selector), /selector/);
  }
  f.state.db.prepare('UPDATE bindings SET active=0').run();
  assert.throws(() => resolvePeerBinding(f.state, { conductorId: 'test-conductor' }), /no active binding/);
});

test('ready watermark cannot mask the current binding refusal reason', t => {
  const f = fixture(t); f.enroll('102');
  f.state.markIntakeBoundary('101', 'ready', 'history recovered');
  const binding = f.state.setBindingReadiness('101', READINESS.GAP, 'native transcript unavailable', f.state.getBinding('101'));
  assert.throws(() => requireReadyPeer(f.state, binding), /native transcript unavailable/);
  f.state.markIntakeBoundary('101', 'gap', 'history request refused');
  assert.throws(() => requireReadyPeer(f.state, binding), /history request refused/);
});

test('readiness reasons do not cross an owner generation or legacy receipt', t => {
  const f = fixture(t); f.enroll('102');
  f.state.setBindingReadiness('101', READINESS.GAP, 'old owner diagnostic', f.state.getBinding('101'));
  f.state.db.prepare("UPDATE bindings SET generation=generation+1 WHERE channel_id='101'").run();
  assert.throws(() => requireReadyPeer(f.state, f.state.getBinding('101')), /^Error: peer is not ready: gap$/);
  f.state.receipt(null, 'binding-readiness', { channelId: '101', readiness: 'gap', detail: 'unscoped old receipt' });
  assert.throws(() => requireReadyPeer(f.state, f.state.getBinding('101')), /^Error: peer is not ready: gap$/);
});
