const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('../helpers/intake-recovery-fixture');
const { recoverThread } = require('../../src/discord/thread-enrollment');
const { waitForRecoveryOperation } = require('../../src/discord');
const { settleRecovery } = require('./settle-recovery');

test('deadline retry waits for an unvisited ready route to finish', { timeout: 4000 }, async t => {
  const f = fixture(t);
  f.state.bind({ channelId: '3000', guildId: 'guild', provider: 'codex',
    nativeId: '33333333-3333-4333-8333-333333333333', workspace: f.state.getBinding('1000').workspace }, { intakeCutoff: '100' });
  f.state.setIntakeBaseline('3000', '100', 'fixture');
  f.state.markIntakeBoundary('3000', 'ready');
  f.channels.set('3000', { ...f.channels.get('1000'), id: '3000' });
  const message = f.message('101', '3000');
  f.history.set('3000', [message]);
  const originalFetchHistory = f.gateway.fetchHistory.bind(f.gateway);
  f.gateway.fetchHistory = async (channel, options) => {
    const delay = channel.id === '1000' ? 80 : channel.id === '3000' ? 400 : 0;
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    return originalFetchHistory(channel, options);
  };

  const result = await settleRecovery(f.gateway.recoverTransport(
    'startup', f.gateway.lifecycleEpoch, null, Date.now() + 50
  ));

  assert.equal(result.ready, false);
  assert.ok(f.calls.some(call => call.id === '3000'), 'the skipped route must be retried');
  assert.equal(f.state.getIntakeWatermark('3000').state, 'ready');
  assert.equal(f.state.getBinding('3000').readiness, 'ready');
  assert.equal(f.state.getMessage('101').state, 'accepted');
});

for (const withArrival of [false, true]) {
  test(`full recovery retains an unavailable sibling, concurrent arrival=${withArrival}`, { timeout: 6000 }, async t => {
    const f = fixture(t);
    f.state.bind({ channelId: '3000', guildId: 'guild', provider: 'codex',
      nativeId: '33333333-3333-4333-8333-333333333333',
      workspace: f.state.getBinding('1000').workspace }, { intakeCutoff: '100' });
    f.state.setIntakeBaseline('3000', '100', 'fixture');
    f.state.markIntakeBoundary('3000', 'ready');
    f.channels.set('3000', { ...f.channels.get('1000'), id: '3000' });
    f.history.set('3000', []);
    f.fail({ kind: 'history', id: '3000', status: 403 });
    let inserted = false;
    if (withArrival) {
      const mark = f.state.markIntakeBoundary.bind(f.state);
      f.state.markIntakeBoundary = (...args) => {
        if (args[0] === '1000' && args[1] === 'ready' && !inserted) {
          inserted = true;
          assert.equal(f.state.acceptDiscordMessage({ ...f.message('101', '1000'),
            authorId: 'operator', isBot: false, attachments: [] },
          { expectedBinding: f.state.getBinding('1000'), ready: false }).accepted, true);
          f.history.set('1000', [f.message('101', '1000')]);
        }
        return mark(...args);
      };
    }
    const result = await settleRecovery(f.gateway.recoverTransport('startup'));
    assert.equal(inserted, withArrival);
    assert.equal(f.boundary('1000').state, 'ready');
    assert.equal(f.state.getIntakeWatermark('3000').state, 'unavailable');
    if (withArrival) assert.equal(f.state.getMessage('101').state, 'accepted');
    assert.equal(f.dispatched.length, 0);
    assert.equal(result.ready, false, 'full recovery must retain the unavailable sibling');
  });
}

for (const id of ['1000', '2000']) {
  for (const change of ['arrival', 'explicit-gap']) {
    test(`${id} pre-fetch CAS loss: ${change}`, { timeout: 4000 }, async t => {
      const f = fixture(t);
      f.fail({ id, kind: 'channel', status: 503 });
      await f.gateway.recoverTransport('startup');
      assert.equal(f.boundary(id).state, 'unavailable');
      f.fail(null);
      const name = id === '1000' ? 'markIntakeBoundary' : 'markThreadBoundary';
      const original = f.state[name].bind(f.state);
      let injected = false;
      f.state[name] = (...args) => {
        if (!injected && args[0] === id && args[1] === 'pending') {
          injected = true;
          if (change === 'arrival') {
            const binding = f.state.getBinding('1000');
            const acceptance = f.state.acceptDiscordMessage({ ...f.message('101', id),
              authorId: 'operator', isBot: false, attachments: [] },
              { expectedBinding: binding, ready: false });
            if (id === '1000') assert.equal(acceptance.accepted, true);
            else assert.equal(f.boundary(id).lastSeenId, '101');
            f.history.set(id, [f.message('101', id)]);
          } else original(id, 'gap', 'newer explicit hold');
        }
        return original(...args);
      };
      const result = await settleRecovery(f.gateway.recoverTransport('startup'));
      assert.ok(injected);
      assert.equal(f.dispatched.length, 0);
      if (change === 'arrival') {
        if (id === '1000') assert.equal(f.state.getMessage('101').state, 'accepted');
        else assert.equal(f.boundary(id).lastSeenId, '101');
        assert.equal(f.boundary(id).state, 'ready', 'current transient marker must recover without another external trigger');
        assert.equal(result.ready, true);
      } else {
        assert.equal(f.boundary(id).state, 'gap');
        assert.equal(f.boundary(id).detail, 'newer explicit hold');
        if (id === '1000') assert.equal(result.ready, false);
      }
    });
  }
}
