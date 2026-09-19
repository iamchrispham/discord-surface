const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { fixture } = require('./helpers/intake-recovery-fixture');

for (const kind of ['channel', 'history']) {
  test(`pre-adoption thread ${kind} 503 stays pending and preserves observed custody`, async t => {
    const f = fixture(t, { adoptThread: false });
    const binding = f.state.getBinding('1000');
    const message = { ...f.message('101', '2000'), authorId: 'operator', isBot: false, attachments: [] };

    f.fail({ id: '2000', kind, status: 503 });
    await f.recover();
    assert.equal(f.boundary('2000').state, 'pending');

    const accepted = f.state.acceptDiscordMessage(message, { expectedBinding: binding });
    assert.equal(accepted.accepted, true);
    assert.equal(f.state.getMessage('101').state, 'accepted');

    f.history.set('2000', [message]);
    f.fail(null);
    await f.recover();
    assert.equal(f.boundary('2000').state, 'ready');
    assert.equal(f.boundary('2000').adoptedThroughId, '101');
    assert.equal(f.state.getMessage('101').state, 'accepted');
  });
}

for (const [state, detail] of [['gap', 'explicit child gap'], ['unavailable', 'explicit child hold']]) {
  test(`thread delivery 503 preserves enrolled ${state} boundary`, async t => {
    const f = fixture(t);
    const binding = f.state.getBinding('1000');
    const message = { ...f.message('101', '2000'), authorId: 'operator', isBot: false, attachments: [] };
    const accepted = f.state.acceptDiscordMessage(message, { expectedBinding: binding });
    assert.equal(accepted.accepted, true);
    f.state.markThreadBoundary('2000', state, detail, '101', '202', binding);
    f.fail({ id: '2000', kind: 'channel', status: 503 });

    await assert.rejects(() => f.gateway.threadDeliveryMessage({ id: '101', channelId: '2000' }), /Discord HTTP 503 during recovery/);

    const boundary = f.boundary('2000');
    assert.equal(boundary.state, state);
    assert.equal(boundary.detail, detail);
    assert.equal(boundary.gapFrom, '101');
    assert.equal(boundary.gapTo, '202');
  });
}

for (const id of ['1000', '2000']) {
  for (const kind of ['channel', 'history']) {
    test(`${id} ${kind} 503 retries after database reopen without resetting coverage`, async t => {
      const f = fixture(t);
      f.fail({ id, kind, status: 503 });
      await f.recover();
      assert.equal(f.boundary(id).state, 'unavailable');
      assert.equal(f.cursor(id), '100');
      await f.reopen();
      f.fail(null); f.calls.length = 0;
      await f.recover();
      assert.equal(f.boundary(id).state, 'ready');
      assert.ok(f.calls.some(c => c.id === id && c.kind === kind));
      assert.equal(f.cursor(id), '100');
    });
  }
  test(`${id} HTTP 403 and unclassified unavailable remain held after reopen`, async t => {
    const f = fixture(t);
    f.fail({ id, kind: 'channel', status: 403 });
    await f.recover();
    await f.reopen(); f.fail(null); f.calls.length = 0;
    await f.recover();
    assert.equal(f.boundary(id).state, 'unavailable');
    assert.equal(f.calls.filter(c => c.id === id).length, 0);
    assert.equal(f.cursor(id), '100');
  });
  test(`${id} partial history survives a later 503 and resumes from durable coverage`, async t => {
    const f = fixture(t);
    f.history.set(id, [f.message('101', id), f.message('102', id)]);
    f.fail({ id, kind: 'history', status: 503, after: '101' });
    await f.recover();
    assert.equal(f.boundary(id).state, 'unavailable');
    assert.equal(f.cursor(id), '101');
    assert.ok(f.state.getMessage('101'));
    assert.equal(f.state.getMessage('102'), null);
    await f.reopen(); f.fail(null); f.calls.length = 0;
    await f.recover();
    assert.equal(f.boundary(id).state, 'ready');
    assert.equal(f.cursor(id), '102');
    assert.ok(f.state.getMessage('102'));
    assert.equal(f.calls.find(c => c.id === id && c.kind === 'history').after, '101');
  });
  test(`${id} explicit gap never retries even with a prior 503 detail`, async t => {
    const f = fixture(t);
    f.fail({ id, kind: 'channel', status: 503 }); await f.recover();
    const detail = f.boundary(id).detail;
    if (id === '1000') f.state.markIntakeBoundary(id, 'gap', detail);
    else f.state.markThreadBoundary(id, 'gap', detail);
    await f.reopen(); f.fail(null); f.calls.length = 0;
    await f.recover();
    assert.equal(f.boundary(id).state, 'gap');
    assert.equal(f.calls.filter(c => c.id === id).length, 0);
  });
}

for (const id of ['1000', '2000']) {
  test(`${id} retry still validates permissions before advancing history`, async t => {
    const f = fixture(t);
    f.fail({ id, kind: 'channel', status: 503 }); await f.recover();
    await f.reopen(); f.fail(null);
    f.channels.get(id).permissionsFor = () => ({ has: () => false });
    await f.recover();
    assert.equal(f.boundary(id).state, 'unavailable');
    assert.equal(f.cursor(id), '100');
    f.channels.get(id).permissionsFor = () => ({ has: () => true });
    f.calls.length = 0;
    await f.recover();
    assert.equal(f.calls.filter(c => c.id === id).length, 0, 'permission failure must not retain the retry marker');
  });
  test(`${id} stopped recovery preserves the retry boundary until a later invocation`, async t => {
    const f = fixture(t);
    f.fail({ id, kind: 'channel', status: 503 }); await f.recover();
    await f.reopen(); f.fail(null); f.calls.length = 0;
    const controller = new AbortController(); controller.abort();
    await f.recover(controller.signal);
    assert.equal(f.boundary(id).state, 'unavailable');
    assert.equal(f.calls.length, 0);
    await f.recover();
    assert.equal(f.boundary(id).state, 'ready');
  });
}

for (const id of ['1000', '2000']) {
  test(`${id} startup retry delivers accepted custody exactly once to its unchanged owner`, { timeout: 5000 }, async t => {
    const f = fixture(t);
    const originalOwner = f.state.getBinding('1000');
    const message = f.message('101', id);
    await f.gateway.consumer.intakeMessage(message, false, null, originalOwner);
    await f.gateway.consumer.waitForReceipts();
    assert.equal(f.state.getMessage('101').state, 'accepted');
    f.history.set(id, [message]);
    f.fail({ id, kind: 'channel', status: 503 });
    if (id === '1000') await assert.rejects(f.gateway.start(f.secret), /intake recovery is unavailable/);
    else await f.gateway.start(f.secret);
    assert.equal(f.boundary(id).state, 'unavailable');
    await f.reopen(); f.fail(null); f.enableDelivery();
    await f.gateway.start(f.secret);
    await f.gateway.reconcilePending();
    await f.gateway.consumer.waitForNativeWork();
    await f.gateway.reconcilePending();
    assert.equal(f.boundary(id).state, 'ready');
    assert.equal(f.state.getMessage('101').state, 'replied');
    assert.equal(f.dispatched.length, 1);
    assert.equal(f.dispatched[0].nativeId, originalOwner.nativeId);
    assert.equal(f.dispatched[0].generation, originalOwner.generation);
    assert.equal(f.replies.filter(r => r.content === 'recovered answer' && r.channelId === id).length, 1);
  });
}

function freezeRecoveryClock(t) {
  const RealDate = global.Date;
  const instant = RealDate.now();
  global.Date = class extends RealDate {
    constructor(...args) { super(...(args.length ? args : [instant])); }
    static now() { return instant; }
  };
  t.after(() => { global.Date = RealDate; });
}

for (const id of ['1000', '2000']) {
  for (const kind of ['channel', 'history']) {
    test(id + ' retry preserves a newer gap during ' + kind + ' fetch', { timeout: 3000 }, async t => {
      freezeRecoveryClock(t);
      const f = fixture(t);
      f.fail({ id, kind: 'channel', status: 503 });
      await f.recover();
      assert.equal(f.boundary(id).state, 'unavailable');
      f.fail(null);
      let injected = false;
      const inject = () => {
        if (injected) return;
        injected = true;
        const owner = f.state.getBinding('1000');
        if (id === '1000') f.state.markIntakeBoundary(id, 'gap', 'newer unresolved custody', '101', '110', owner);
        else f.state.markThreadBoundary(id, 'gap', 'newer unresolved custody', '101', '110', owner);
      };
      if (kind === 'channel') {
        const fetch = f.gateway.client.channels.fetch.bind(f.gateway.client.channels);
        f.gateway.client.channels.fetch = async channelId => {
          const value = await fetch(channelId);
          if (channelId === id) inject();
          return value;
        };
      } else {
        const fetch = f.gateway.fetchHistory.bind(f.gateway);
        f.gateway.fetchHistory = async (channel, options) => {
          const value = await fetch(channel, options);
          if (channel.id === id) inject();
          return value;
        };
      }
      await f.recover();
      assert.equal(injected, true, 'probe must reach the awaited fetch');
      assert.equal(f.boundary(id).state, 'gap', 'retry erased a newer gap');
      assert.equal(f.boundary(id).detail, 'newer unresolved custody');
      assert.equal(f.dispatched.length, 0);
    });
  }
}
test('pre-adoption 503 waits for later recovery instead of scheduling itself again', { timeout: 3000 }, async t => {
  const f = fixture(t, { adoptThread: false });
  f.fail({ id: '2000', kind: 'channel', status: 503 });
  await f.gateway.recoverTransport('startup');
  for (let i = 0; i < 4 && f.gateway.liveCheckpointPromise; i++) {
    await f.gateway.liveCheckpointPromise;
  }
  assert.ok(!f.gateway.liveCheckpointRetryTimer, 'persistent 503 armed another live retry');
  assert.equal(f.calls.filter(c => c.kind === 'channel' && c.id === '2000').length, 1,
    'one recovery invocation caused repeated child fetches');
  assert.equal(f.dispatched.length, 0);
});

for (const expired of [true, false]) {
  test('parent retry with ' + (expired ? 'expired' : 'fresh') + ' deadline before first fetch', { timeout: 3000 }, async t => {
    const f = fixture(t);
    f.fail({ id: '1000', kind: 'channel', status: 503 });
    await f.recover();
    const held = f.boundary('1000');
    assert.equal(held.state, 'unavailable');
    f.fail(null); f.calls.length = 0;
    const originalNow = Date.now;
    const readiness = f.state.setBindingReadiness.bind(f.state);
    f.state.setBindingReadiness = (...args) => {
      const result = readiness(...args);
      if (expired && args[0] === '1000' && args[1] === 'recovering') {
        const exhausted = originalNow() + f.gateway.recoveryTimeoutMs + 1;
        Date.now = () => exhausted;
      }
      return result;
    };
    try { await f.recover(); }
    finally { Date.now = originalNow; f.state.setBindingReadiness = readiness; }
    if (expired) {
      assert.equal(f.calls.filter(c => c.id === '1000').length, 0, 'no fetch started');
      assert.equal(f.boundary('1000').state, held.state, 'unused deadline erased retryability');
      assert.equal(f.boundary('1000').detail, held.detail);
    }
    assert.equal(f.cursor('1000'), '100');
    assert.equal(f.dispatched.length, 0);
    await f.reopen(); await f.recover();
    assert.equal(f.boundary('1000').state, 'ready', 'later recovery must remain possible');
  });
}
const { recoverThread } = require('../src/discord/thread-enrollment');
const { waitForRecoveryOperation } = require('../src/discord');
for (const expired of [true, false]) {
  test('child retry with ' + (expired ? 'expired' : 'fresh') + ' shared deadline', { timeout: 3000 }, async t => {
    const f = fixture(t);
    f.fail({ id: '2000', kind: 'channel', status: 503 });
    await f.recover();
    const held = f.boundary('2000');
    assert.equal(held.state, 'unavailable');
    f.fail(null); f.calls.length = 0;
    await recoverThread(f.gateway, held, new AbortController().signal,
      f.gateway.lifecycleEpoch, waitForRecoveryOperation, false, Date.now() + (expired ? -1 : 2000));
    if (expired) {
      assert.equal(f.calls.filter(c => c.id === '2000').length, 0, 'no fetch started');
      assert.equal(f.boundary('2000').state, held.state, 'unused deadline erased retryability');
      assert.equal(f.boundary('2000').detail, held.detail);
    }
    assert.equal(f.cursor('2000'), '100');
    assert.equal(f.dispatched.length, 0);
    await f.reopen();
    await f.recover();
    assert.equal(f.boundary('2000').state, 'ready', 'later recovery must remain possible');
  });
}


test('recovery fetch inventory stays covered by parent, child and delivery lifecycle cases', () => {
  const source = path.join(__dirname, '../src');
  const consumers = {};
  for (const relative of fs.readdirSync(source, { recursive: true })) {
    if (!/\.(?:js|ts)$/.test(relative)) continue;
    const count = (fs.readFileSync(path.join(source, relative), 'utf8').match(/\brecoveryFetch\(/g) || []).length;
    if (count) consumers[relative.split(path.sep).join('/')] = count;
  }
  assert.deepEqual(consumers, { 'discord.js': 5, 'discord/thread-enrollment.ts': 2 },
    'map each new recovery fetch to deadline, concurrent-boundary and delivery custody cases');
});

test('pre-adoption retry never clears an explicit gap carrying the prior 503 detail', async t => {
  const f = fixture(t, { adoptThread: false });
  f.fail({ id: '2000', kind: 'channel', status: 503 });
  await f.recover();
  const detail = f.boundary('2000').detail;
  f.state.markThreadBoundary('2000', 'gap', detail, '101', '202', f.state.getBinding('1000'));
  const held = f.boundary('2000');
  f.fail(null); f.calls.length = 0;
  await f.recover();
  assert.deepEqual(f.boundary('2000'), held);
  assert.equal(f.calls.filter(call => call.id === '2000').length, 0);
});

for (const kind of ['channel', 'history']) {
  test('parent retry preserves same-owner readiness-only hold during ' + kind + ' fetch', async t => {
    freezeRecoveryClock(t);
    const f = fixture(t);
    f.fail({ id: '1000', kind: 'channel', status: 503 });
    await f.recover();
    f.fail(null);
    let held;
    const inject = () => {
      held = f.boundary('1000');
      f.state.setBindingReadiness('1000', 'unavailable', 'native endpoint lost', f.state.getBinding('1000'));
    };
    if (kind === 'channel') {
      const fetch = f.gateway.client.channels.fetch.bind(f.gateway.client.channels);
      f.gateway.client.channels.fetch = async id => {
        const value = await fetch(id);
        if (id === '1000') inject();
        return value;
      };
    } else {
      const fetch = f.gateway.fetchHistory.bind(f.gateway);
      f.gateway.fetchHistory = async (channel, options) => {
        const value = await fetch(channel, options);
        if (channel.id === '1000') inject();
        return value;
      };
    }
    await f.recover();
    assert.ok(held);
    assert.equal(f.state.getBinding('1000').readiness, 'unavailable');
    assert.deepEqual(f.boundary('1000'), held);
    assert.equal(f.dispatched.length, 0);
  });
}

for (const fetchKind of ['channel', 'baseline', 'history']) {
  for (const retry of [false, true]) for (const concurrent of ['arrival', 'gap', 'readiness-hold']) {
    test(`parent failed ${fetchKind} keeps current custody: retry=${retry}, ${concurrent}`, { timeout: 5000 }, async t => {
      const f = fixture(t);
      if (fetchKind === 'baseline') {
        f.state.db.prepare('DELETE FROM intake_watermarks WHERE channel_id=?').run('1000');
        f.state.markIntakeBoundary('1000', 'pending', 'new binding needs baseline');
      }
      if (retry) {
        f.fail({ id: '1000', kind: 'channel', status: 503 });
        await f.recover(); f.fail(null);
      }
      let heldBinding;
      const injectFailure = () => {
        const binding = f.state.getBinding('1000');
        const message = { ...f.message('101', '1000'), authorId: 'operator', isBot: false, attachments: [] };
        assert.equal(f.state.acceptDiscordMessage(message, { expectedBinding: binding }).accepted, true);
        f.history.set('1000', [f.message('101', '1000')]);
        if (concurrent === 'gap') f.state.markIntakeBoundary('1000', 'gap', 'newer explicit hold', '101', '110', binding);
        if (concurrent === 'readiness-hold') {
          f.state.setBindingReadiness('1000', 'unavailable', 'newer readiness hold', binding);
          heldBinding = f.state.getBinding('1000');
        }
        throw Object.assign(new Error('fetch failed'), { status: 503 });
      };
      const originalChannelFetch = f.gateway.client.channels.fetch;
      let reached = false;
      if (fetchKind === 'channel') {
        const fetch = f.gateway.client.channels.fetch.bind(f.gateway.client.channels);
        f.gateway.client.channels.fetch = async id => {
          if (id !== '1000') return fetch(id);
          reached = true; injectFailure();
        };
      } else {
        const fetch = f.gateway.fetchHistory.bind(f.gateway);
        f.gateway.fetchHistory = async (channel, options) => {
          if (channel.id !== '1000') return fetch(channel, options);
          assert.equal(options.after, fetchKind === 'baseline' ? undefined : '100');
          reached = true; injectFailure();
        };
      }
      await f.recover();
      assert.equal(reached, true);
      assert.equal(f.state.getMessage('101').state, 'accepted');
      assert.equal(f.boundary('1000').last_seen_id, '101');
      assert.equal(f.cursor('1000'), fetchKind === 'baseline' ? null : '100');
      assert.equal(f.dispatched.length, 0);
      if (concurrent === 'gap') {
        assert.equal(f.boundary('1000').state, 'gap');
        assert.equal(f.boundary('1000').detail, 'newer explicit hold');
      } else if (concurrent === 'readiness-hold') {
        assert.equal(f.state.getBinding('1000').readiness, 'unavailable');
        assert.deepEqual(f.state.getBinding('1000'), heldBinding);
      } else {
        assert.equal(f.boundary('1000').state, 'unavailable');
        assert.match(f.boundary('1000').detail, /Discord HTTP 503 during recovery/);
        f.gateway.client.channels.fetch = originalChannelFetch;
        await f.reopen();
        await f.recover();
        assert.equal(f.boundary('1000').state, 'ready');
        assert.equal(f.state.getMessage('101').state, 'accepted');
      }
    });
  }
}
