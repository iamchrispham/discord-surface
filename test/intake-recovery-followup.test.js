const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./helpers/intake-recovery-fixture');
const { recoverThread } = require('../src/discord/thread-enrollment');
const { waitForRecoveryOperation } = require('../src/discord');

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
    const unknownCoverage = scenario !== 'ready';
    test(unknownCoverage
      ? `${entrypoint} holds an unknown-coverage legacy parent (${scenario}) instead of inventing a baseline`
      : `${entrypoint} includes recovery after ${scenario} CAS loss`, { timeout: 6000 }, async t => {
      const f = fixture(t);
      const baseline = scenario !== 'ready';
      if (baseline) {
        // Named historical/unknown-coverage scenario: the legacy parent route carries
        // no covered cursor. The restored owner refuses to infer one from newest
        // history, so recovery must leave the route visibly held.
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
        if (!unknownCoverage) assert.equal(result.ready, true, 'caller must receive completed recovery');
      }
      if (unknownCoverage) {
        assert.equal(injected, false, 'unknown coverage must not reach a baseline commit');
        assert.equal(f.boundary('1000').state, 'pending');
        assert.match(f.boundary('1000').detail, /requires qualified historical coverage|refused without historical coverage/);
        assert.equal(f.dispatched.length, 0);
        return;
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

test('startup qualifies a completed empty legacy parent and replays post-baseline history', { timeout: 4000 }, async t => {
  const f = fixture(t);
  f.state.db.prepare('UPDATE intake_watermarks SET state=?, last_seen_id=NULL, recovered_through_id=NULL WHERE channel_id=?')
    .run('ready', '1000');
  f.history.set('1000', [f.message('101', '1000')]);
  let historyCalls = 0;
  const originalFetchHistory = f.gateway.fetchHistory.bind(f.gateway);
  f.gateway.fetchHistory = async (channel, ...args) => {
    if (channel.id === '1000') historyCalls += 1;
    return originalFetchHistory(channel, ...args);
  };

  const result = await settleRecovery(f.gateway.recoverTransport('startup'));

  assert.equal(result.ready, true, JSON.stringify(result));
  assert.equal(f.boundary('1000').state, 'ready');
  assert.equal(f.boundary('1000').last_seen_id, '101');
  assert.equal(f.boundary('1000').recovered_through_id, '101');
  assert.ok(historyCalls > 0);
  assert.equal(f.state.getMessage('101').state, 'accepted');
  assert.equal(f.cursor('1000'), '101');
});

test('verified-empty legacy child records adoption before live checkpointing', { timeout: 4000 }, async t => {
  const f = fixture(t, { adoptThread: false });

  const first = await settleRecovery(f.gateway.recoverTransport('startup'));
  assert.equal(first.ready, true, JSON.stringify(first));
  const adopted = f.state.getThreadEnrollment('2000');
  assert.equal(adopted.recoveredThroughId, '0');
  assert.ok(adopted.adoptedAt);

  const message = { ...f.message('101', '2000'), authorId: 'operator', isBot: false, attachments: [] };
  assert.equal(f.state.acceptDiscordMessage(message, {
    expectedBinding: f.state.getBinding('1000'),
    ready: false
  }).accepted, true);
  f.history.set('2000', [message]);
  const checkpointed = await recoverThread(
    f.gateway,
    f.state.getThreadEnrollment('2000'),
    new AbortController().signal,
    f.gateway.lifecycleEpoch,
    waitForRecoveryOperation,
    true,
    Date.now() + f.gateway.recoveryTimeoutMs
  );

  assert.equal(checkpointed, true);
  assert.equal(f.state.getThreadEnrollment('2000').recoveredThroughId, '101');
});

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
    nativeId: '33333333-3333-4333-8333-333333333333', workspace: f.state.getBinding('1000').workspace }, { intakeCutoff: '100' });
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

for (const settled of [false, true]) {
  test(`expired queued recovery preserves healthy custody (${settled ? 'settled' : 'unsettled'} caller)`, { timeout: 3000 }, async t => {
    const f = fixture(t);
    f.state.bind({ channelId: '3000', guildId: 'guild', provider: 'codex',
      nativeId: '33333333-3333-4333-8333-333333333333', workspace: f.state.getBinding('1000').workspace }, { intakeCutoff: '100' });
    f.state.setIntakeBaseline('3000', '100', 'fixture');
    f.state.markIntakeBoundary('3000', 'ready');
    const before = f.state.getIntakeWatermark('3000');
    let entered, release;
    const started = new Promise(resolve => { entered = resolve; });
    const held = new Promise(resolve => { release = resolve; });
    const original = f.gateway.fetchHistory;
    let paused = false;
    f.gateway.fetchHistory = async (channel, options) => {
      if (!paused) { paused = true; entered(); await held; }
      return original(channel, options);
    };
    try {
      const active = f.gateway.recoverTransport('active', f.gateway.lifecycleEpoch, ['1000']);
      await started;
      const queued = f.gateway.recoverTransport('expired', f.gateway.lifecycleEpoch, ['3000'], Date.now() - 1);
      if (settled) await settleRecovery(queued);
      release();
      await settleRecovery(active);
      await settleRecovery(queued);
      await f.gateway.recoveryFollowupPromise;
      assert.deepEqual(f.state.getIntakeWatermark('3000'), before);
      assert.equal(f.calls.some(call => call.id === '3000'), false);
      assert.equal(f.dispatched.length, 0);
    } finally { release(); }
  });
}

for (let hops = 0; hops <= 8; hops++) {
  test(`reconciliation and followup remain serialized at microtask ${hops}`, { timeout: 3000 }, async t => {
    const f = fixture(t);
    let release, entered, active = 0, peak = 0;
    const held = new Promise(resolve => { release = resolve; });
    const started = new Promise(resolve => { entered = resolve; });
    const operation = async reason => {
      active++; peak = Math.max(peak, active);
      if (reason === 'first') { entered(); await held; }
      else for (let step = 0; step < 5; step++) await Promise.resolve();
      active--;
      return { ready: true, state: 'ready' };
    };
    f.gateway.recoverInbound = async (_signal, reason) => operation(reason);
    f.gateway._reconcilePending = async () => { await operation('reconcile'); return []; };
    const first = f.gateway.recoverTransport('first');
    await started;
    const reconciliation = f.gateway.reconcilePending(undefined, { allowPaused: true });
    let late = Promise.resolve();
    for (let hop = 0; hop < hops; hop++) late = late.then(() => {});
    late = late.then(() => f.gateway.recoverTransport('followup'));
    release();
    await settleRecovery(Promise.all([first, late, reconciliation]));
    assert.equal(peak, 1, 'recovery and reconciliation must never own the slot together');
  });
}

for (let hops = 0; hops <= 8; hops++) {
  test(`coordinator drains arrivals ${hops} microtasks after completion`, { timeout: 3000 }, async t => {
    const f = fixture(t);
    const seen = [];
    f.gateway.recoverInbound = async (_signal, reason) => {
      seen.push(reason);
      return { ready: true, state: 'ready' };
    };
    const first = f.gateway.recoverTransport('first');
    const queued = f.gateway.recoverTransport('queued');
    let late = queued;
    for (let hop = 0; hop < hops; hop++) late = late.then(() => {});
    late = late.then(() => f.gateway.recoverTransport('late'));
    await settleRecovery(Promise.all([first, queued, late]));
    assert.deepEqual(seen, ['first', 'queued', 'late']);
    await f.gateway.recoveryFollowupPromise;
    assert.equal(f.gateway.pendingRecoveryRequests.length, 0);
  });
}

test('live custody arriving after the ready write is covered before recovery settles', { timeout: 4000 }, async t => {
  const f = fixture(t);
  const original = f.state.markIntakeBoundary.bind(f.state);
  let injected = false;
  f.state.markIntakeBoundary = (...args) => {
    const result = original(...args);
    if (!injected && args[0] === '1000' && args[1] === 'ready' && result) {
      injected = true;
      const message = { ...f.message('101', '1000'), authorId: 'operator', isBot: false, attachments: [] };
      assert.equal(f.state.acceptDiscordMessage(message, { expectedBinding: f.state.getBinding('1000'), ready: false }).accepted, true);
      f.history.set('1000', [f.message('101', '1000')]);
    }
    return result;
  };
  await settleRecovery(f.gateway.recoverTransport('startup'));
  assert.ok(injected);
  assert.equal(f.state.getBinding('1000').readiness, 'ready');
  assert.equal(f.cursor('1000'), '101');
  assert.equal(f.state.getMessage('101').state, 'accepted');
  assert.equal(f.dispatched.length, 0);
});

test('selected thread recovery reports failure while its route remains held', async t => {
  const f = fixture(t);
  f.fail({ kind: 'channel', id: '2000', status: 403 });
  const result = await settleRecovery(f.gateway.recoverTransport('selected', f.gateway.lifecycleEpoch, ['2000']));
  assert.equal(f.boundary('2000').state, 'unavailable');
  assert.equal(result.ready, false);
  assert.equal(f.dispatched.length, 0);
});

for (const kind of ['channel', 'history']) {
  test(`selected pre-adoption ${kind} 503 remains unresolved without a retry loop`, async t => {
    const f = fixture(t, { adoptThread: false });
    f.fail({ kind, id: '2000', status: 503 });
    const result = await settleRecovery(f.gateway.recoverTransport('selected', f.gateway.lifecycleEpoch, ['2000']));
    assert.equal(result.ready, false);
    assert.equal(f.state.getThreadEnrollment('2000').state, 'pending');
    assert.equal(f.state.getThreadEnrollment('2000').adoptedAt, null);
    assert.equal(f.calls.filter(c => c.kind === kind && c.id === '2000').length, 1);
    assert.equal(Boolean(f.gateway.liveCheckpointRetryTimer), false);
    assert.equal(f.dispatched.length, 0);
  });
}

test('live attachment recovery preserves a verified empty cursor', { timeout: 4000 }, async t => {
  const f = fixture(t);
  f.state.db.prepare(`UPDATE intake_watermarks
    SET state='ready', last_seen_id=NULL, recovered_through_id=NULL
    WHERE channel_id=?`).run('1000');
  const binding = f.state.getBinding('1000');
  const message = { ...f.message('101', '1000'), authorId: 'operator', isBot: false, attachments: [] };

  await f.gateway.recordLiveAttachmentGap(message, binding, new Error('attachment fetch failed'));
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline && f.boundary('1000').state !== 'ready') {
    await new Promise(resolve => setTimeout(resolve, 10));
  }

  assert.equal(f.boundary('1000').state, 'ready');
  assert.equal(f.boundary('1000').recovered_through_id, '0');
});

test('direct reply-ready recovery send settles as unknown at the shared deadline', { timeout: 4000 }, async t => {
  const f = fixture(t);
  const message = f.message('101', '1000');
  assert.equal(f.state.acceptDiscordMessage({ ...message, authorId: 'operator', isBot: false }).accepted, true);
  assert.equal(f.state.claimDispatch('101').claimed, true);
  assert.equal(f.state.markSubmitted('101').state, 'submitted');
  const stored = f.state.getMessage('101');
  f.state.recordNativeReply({
    provider: stored.provider,
    messageId: stored.id,
    nativeId: stored.nativeId,
    generation: stored.generation,
    text: 'saved reply'
  });
  f.enableDelivery();
  f.gateway.recoveryTimeoutMs = 25;
  const channel = f.channels.get('1000');
  const originalSend = channel.send;
  let sendStarted = false;
  let releaseSend;
  channel.send = async () => {
    sendStarted = true;
    await new Promise(resolve => { releaseSend = resolve; });
  };
  try {
    await settleRecovery(f.gateway.reconcilePending(undefined, { allowPaused: true, readyOnly: true }));
    assert.equal(sendStarted, true);
    assert.equal(f.state.getMessage('101').state, 'reply_unknown');
  } finally {
    channel.send = originalSend;
    releaseSend?.({ id: 'late-reply' });
  }
});
for (const pageLimit of [10, 2]) {
  test(`completed-empty parent retains descending history with page limit ${pageLimit}`, { timeout: 4000 }, async t => {
    const f = fixture(t);
    const binding = f.state.getBinding('1000');
    const nativeId = binding.nativeId;
    const generation = binding.generation;
    f.state.db.prepare(`UPDATE intake_watermarks
      SET state='ready', last_seen_id=NULL, recovered_through_id=NULL, last_accepted_id=NULL, detail=?
      WHERE channel_id=?`).run('restart empty channel baseline', '1000');
    f.gateway.historyPageLimit = pageLimit;
    const messages = ['104', '103', '102', '101'].map(id => f.message(id, '1000'));
    const parentCalls = [];
    const originalFetchHistory = f.gateway.fetchHistory.bind(f.gateway);
    f.gateway.fetchHistory = async (channel, options) => {
      if (channel.id !== '1000') return originalFetchHistory(channel, options);
      parentCalls.push(options);
      const after = options.after ? BigInt(options.after) : null;
      const before = options.before ? BigInt(options.before) : null;
      const filtered = messages.filter(message => {
        const value = BigInt(message.id);
        if (after !== null && value <= after) return false;
        if (before !== null && value >= before) return false;
        return true;
      });
      if (after !== null) return filtered.reverse().slice(0, options.limit).reverse();
      return filtered.slice(0, options.limit);
    };

    let result;
    for (let attempt = 0; attempt < 6; attempt++) {
      result = await settleRecovery(f.recover());
      if (result.ready) break;
    }

    assert.equal(parentCalls.length > 0, true);
    assert.equal(result.ready, true);
    assert.equal(f.boundary('1000').state, 'ready');
    assert.equal(f.cursor('1000'), '104');
    for (const id of ['101', '102', '103', '104']) {
      const stored = f.state.getMessage(id);
      assert.equal(stored.state, 'accepted');
      assert.equal(stored.nativeId, nativeId);
      assert.equal(stored.generation, generation);
    }
    assert.equal(f.state.getBinding('1000').nativeId, nativeId);
    assert.equal(f.state.getBinding('1000').generation, generation);
    assert.equal(f.dispatched.length, 0);
  });
}
for (const pageLimit of [10, 2]) {
  test(`historical completed-empty child retains new history with page limit ${pageLimit}`, { timeout: 4000 }, async t => {
    const f = fixture(t);
    f.state.db.prepare(`UPDATE thread_enrollments
      SET adopted_through_id=NULL, last_seen_id=NULL, recovered_through_id=NULL, last_accepted_id=NULL, gap_from=NULL, gap_to=NULL, detail='Thread history recovered'
      WHERE thread_id=?`).run('2000');
    const preRecovery = f.state.getThreadEnrollment('2000');
    assert.equal(preRecovery.active, true);
    assert.equal(preRecovery.state, 'ready');
    assert.ok(preRecovery.adoptedAt);
    assert.equal(preRecovery.adoptedThroughId, null);
    assert.equal(preRecovery.recoveredThroughId, null);
    assert.equal(preRecovery.lastSeenId, null);
    assert.equal(preRecovery.lastAcceptedId, null);
    const parentBinding = f.state.getBinding('1000');
    const nativeId = parentBinding.nativeId;
    const generation = parentBinding.generation;
    const threadAdoptedAt = preRecovery.adoptedAt;
    const threadAdoptedThroughId = preRecovery.adoptedThroughId;
    f.gateway.historyPageLimit = pageLimit;
    const messages = ['104', '103', '102', '101'].map(id => f.message(id, '2000'));
    const childCalls = [];
    const originalFetchHistory = f.gateway.fetchHistory.bind(f.gateway);
    f.gateway.fetchHistory = async (channel, options) => {
      if (channel.id !== '2000') return originalFetchHistory(channel, options);
      childCalls.push(options);
      const after = options.after ? BigInt(options.after) : null;
      const before = options.before ? BigInt(options.before) : null;
      const filtered = messages.filter(message => {
        const value = BigInt(message.id);
        if (after !== null && value <= after) return false;
        if (before !== null && value >= before) return false;
        return true;
      });
      if (after !== null) return filtered.reverse().slice(0, options.limit).reverse();
      return filtered.slice(0, options.limit);
    };

    let result;
    for (let attempt = 0; attempt < 6; attempt++) {
      result = await settleRecovery(f.recover());
      if (result.ready) break;
    }

    assert.equal(result.ready, true);
    const recovered = f.state.getThreadEnrollment('2000');
    assert.equal(recovered.state, 'ready');
    assert.equal(recovered.recoveredThroughId, '104');
    assert.equal(childCalls.length > 0, true);
    assert.equal(f.state.getBinding('1000').nativeId, nativeId);
    assert.equal(f.state.getBinding('1000').generation, generation);
    assert.equal(f.state.getThreadEnrollment('2000').adoptedAt, threadAdoptedAt);
    assert.equal(f.state.getThreadEnrollment('2000').adoptedThroughId, threadAdoptedThroughId);
    assert.equal(f.dispatched.length, 0);
    for (const id of ['101', '102', '103', '104']) {
      const stored = f.state.getMessage(id);
      assert.ok(stored, `message ${id} missing`);
      assert.equal(stored.state, 'accepted');
      assert.equal(stored.nativeId, nativeId);
      assert.equal(stored.generation, generation);
    }
  });
}
