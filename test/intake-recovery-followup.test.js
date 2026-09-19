const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./helpers/intake-recovery-fixture');

async function settleRecovery(operation) {
  let timer;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('recovery caller did not settle')), 2000);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

for (const entrypoint of ['result', 'startup', 'reconnect']) {
  for (const scenario of ['ready', 'latest-baseline', 'empty-baseline']) {
    test(`${entrypoint} includes recovery after ${scenario} CAS loss`, { timeout: 6000 }, async t => {
      const f = fixture(t);
      const baseline = scenario !== 'ready';
      if (baseline) {
        f.state.db.prepare('DELETE FROM intake_watermarks WHERE channel_id=?').run('1000');
        f.state.markIntakeBoundary('1000', 'pending', 'first baseline');
      }
      let injected = false;
      const accept = id => {
        const binding = f.state.getBinding('1000');
        const message = { ...f.message(id, '1000'), authorId: 'operator', isBot: false, attachments: [] };
        assert.equal(f.state.acceptDiscordMessage(message, { expectedBinding: binding, ready: false }).accepted, true);
      };
      const inject = () => {
        injected = true;
        accept('101');
        f.history.set('1000', [f.message('101', '1000')]);
      };
      if (baseline) {
        const original = f.state.setIntakeBaseline.bind(f.state);
        f.state.setIntakeBaseline = (...args) => {
          if (!injected && args[0] === '1000') inject();
          return original(...args);
        };
        if (scenario === 'empty-baseline') accept('100');
        else f.history.set('1000', [f.message('100', '1000')]);
      } else {
        const original = f.state.markIntakeBoundary.bind(f.state);
        f.state.markIntakeBoundary = (...args) => {
          if (!injected && args[0] === '1000' && args[1] === 'ready') inject();
          return original(...args);
        };
      }
      if (entrypoint === 'startup') {
        await settleRecovery(f.gateway.start(f.secret));
        assert.equal(f.gateway.started, true);
      } else {
        if (entrypoint === 'reconnect') f.enableDelivery();
        const operation = entrypoint === 'reconnect'
          ? f.gateway.beginReconnectRecovery('probe')
          : f.gateway.recoverTransport('startup');
        const result = await settleRecovery(operation);
        assert.equal(result.ready, true, 'caller must receive completed recovery');
      }
      assert.ok(injected);
      assert.equal(f.boundary('1000').state, 'ready');
      assert.equal(f.state.getBinding('1000').readiness, 'ready');
      if (entrypoint === 'reconnect') {
        await f.gateway.consumer.waitForNativeWork();
        assert.equal(f.state.getMessage('101').state, 'replied');
        assert.equal(f.dispatched.filter(message => message.id === '101').length, 1);
      } else {
        assert.equal(f.state.getMessage('101').state, 'accepted');
        assert.equal(f.dispatched.length, 0);
      }
    });
  }
}

for (const withArrival of [false, true]) {
  test(`full recovery retains an unavailable sibling, concurrent arrival=${withArrival}`, { timeout: 6000 }, async t => {
    const f = fixture(t);
    f.state.bind({ channelId: '3000', guildId: 'guild', provider: 'codex',
      nativeId: '33333333-3333-4333-8333-333333333333',
      workspace: f.state.getBinding('1000').workspace });
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

function injectArrivals(f, count = 1) {
  const original = f.state.markIntakeBoundary.bind(f.state);
  let inserted = 0;
  f.state.markIntakeBoundary = (...args) => {
    if (args[0] === '1000' && args[1] === 'ready' && inserted < count) {
      const id = String(101 + inserted++);
      const binding = f.state.getBinding('1000');
      assert.equal(f.state.acceptDiscordMessage({ ...f.message(id, '1000'),
        authorId: 'operator', isBot: false, attachments: [] },
      { expectedBinding: binding, ready: false }).accepted, true);
      f.history.set('1000', Array.from({ length: inserted }, (_, i) => f.message(String(101 + i), '1000')));
    }
    return original(...args);
  };
  return () => inserted;
}

function pauseFollowup(f) {
  const original = f.gateway.fetchHistory;
  let parentCalls = 0;
  let reached;
  let release;
  const entered = new Promise(resolve => { reached = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  f.gateway.fetchHistory = async (channel, options) => {
    if (channel.id === '1000' && ++parentCalls === 2) {
      reached();
      await held;
    }
    return original(channel, options);
  };
  return { entered, release };
}

test('stop settles active recovery and queued followup', { timeout: 3000 }, async t => {
  const f = fixture(t);
  injectArrivals(f);
  const pause = pauseFollowup(f);
  try {
    const operation = f.gateway.recoverTransport('startup');
    await pause.entered;
    await f.gateway.stop();
    const result = await operation;
    assert.equal(result.ready, false);
    assert.equal(result.state, 'stopped');
    assert.equal(f.state.getMessage('101').state, 'accepted');
    assert.equal(f.dispatched.length, 0);
  } finally { pause.release(); }
});

test('queued followup retains a newer explicit gap', { timeout: 3000 }, async t => {
  const f = fixture(t);
  injectArrivals(f);
  const pause = pauseFollowup(f);
  try {
    const operation = f.gateway.recoverTransport('startup');
    await pause.entered;
    f.state.markIntakeBoundary('1000', 'gap', 'new explicit hold');
    pause.release();
    const result = await operation;
    assert.equal(result.ready, false);
    assert.equal(f.boundary('1000').state, 'gap');
    assert.equal(f.boundary('1000').detail, 'new explicit hold');
    assert.equal(f.state.getMessage('101').state, 'accepted');
    assert.equal(f.dispatched.length, 0);
  } finally { pause.release(); }
});

test('initial caller includes three consecutive arrival followups', { timeout: 3000 }, async t => {
  const f = fixture(t);
  const inserted = injectArrivals(f, 3);
  const result = await settleRecovery(f.gateway.recoverTransport('startup'));
  assert.equal(result.ready, true);
  assert.equal(inserted(), 3);
  assert.equal(f.boundary('1000').state, 'ready');
  assert.equal(f.boundary('1000').recovered_through_id, '103');
  for (const id of ['101', '102', '103']) assert.equal(f.state.getMessage(id).state, 'accepted');
  assert.equal(f.dispatched.length, 0);
});


test('selected recovery remains selected after an arrival followup', { timeout: 3000 }, async t => {
  const f = fixture(t);
  f.state.bind({ channelId: '3000', guildId: 'guild', provider: 'codex',
    nativeId: '33333333-3333-4333-8333-333333333333', workspace: f.state.getBinding('1000').workspace });
  f.state.setIntakeBaseline('3000', '100', 'fixture');
  f.state.markIntakeBoundary('3000', 'ready');
  f.channels.set('3000', { ...f.channels.get('1000'), id: '3000' });
  f.history.set('3000', []);
  f.fail({ kind: 'history', id: '3000', status: 403 });
  injectArrivals(f);
  const result = await f.gateway.recoverTransport('startup', f.gateway.lifecycleEpoch, ['1000']);
  assert.equal(f.boundary('1000').state, 'ready');
  assert.equal(f.state.getIntakeWatermark('3000').state, 'ready', 'selected recovery must not alter an unrelated binding');
  assert.equal(result.ready, true);
  assert.equal(f.calls.some(call => call.id === '3000'), false);
  assert.equal(f.state.getMessage('101').state, 'accepted');
  assert.equal(f.dispatched.length, 0);
});
