const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('../helpers/intake-recovery-fixture');
const { recoverThread } = require('../../src/discord/thread-enrollment');
const { waitForRecoveryOperation } = require('../../src/discord');
const { settleRecovery } = require('./settle-recovery');

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

test('completed-empty parent stays pending while history backfill is in flight', { timeout: 4000 }, async t => {
  const f = fixture(t);
  f.state.db.prepare('UPDATE intake_watermarks SET state=?, last_seen_id=NULL, recovered_through_id=NULL WHERE channel_id=?')
    .run('ready', '1000');
  f.history.set('1000', [f.message('101', '1000')]);
  const originalFetchHistory = f.gateway.fetchHistory.bind(f.gateway);
  let fetchStarted;
  const fetchStartedPromise = new Promise(resolve => { fetchStarted = resolve; });
  let releaseFetch;
  const fetchRelease = new Promise(resolve => { releaseFetch = resolve; });
  f.gateway.fetchHistory = async (channel, ...args) => {
    if (channel.id === '1000') {
      fetchStarted();
      await fetchRelease;
    }
    return originalFetchHistory(channel, ...args);
  };

  const recovery = f.gateway.recoverTransport('startup');
  await fetchStartedPromise;
  assert.equal(f.boundary('1000').state, 'pending');
  assert.equal(f.state.getBinding('1000').readiness, 'pending');

  releaseFetch();
  const result = await settleRecovery(recovery);
  assert.equal(result.ready, true, JSON.stringify(result));
  assert.equal(f.boundary('1000').state, 'ready');
  assert.equal(f.state.getMessage('101').state, 'accepted');
});

test('held live intake preserves verified empty parent coverage across restart', { timeout: 4000 }, async t => {
  const f = fixture(t);
  f.state.db.prepare('UPDATE intake_watermarks SET state=?, last_seen_id=NULL, recovered_through_id=NULL WHERE channel_id=?')
    .run('ready', '1000');
  const older = { ...f.message('100', '1000'), authorId: 'operator', isBot: false, attachments: [] };
  const live = { ...f.message('101', '1000'), authorId: 'operator', isBot: false, attachments: [] };
  assert.equal(f.state.acceptDiscordMessage(live, {
    expectedBinding: f.state.getBinding('1000'),
    ready: true
  }).accepted, true);
  assert.equal(f.boundary('1000').recovered_through_id, '0');
  assert.equal(f.boundary('1000').state, 'pending');
  assert.equal(f.state.getBinding('1000').readiness, 'pending');
  f.history.set('1000', [older, live]);
  f.enableDelivery();
  await f.reopen();

  const result = await settleRecovery(f.gateway.recoverTransport('restart'));

  assert.equal(result.ready, true, JSON.stringify(result));
  assert.equal(f.boundary('1000').state, 'ready');
  assert.equal(f.boundary('1000').recovered_through_id, '101');
  await settleRecovery(f.gateway.reconcilePending(undefined, { allowPaused: true, readyOnly: true }));
  await f.gateway.consumer.waitForNativeWork();
  assert.deepEqual(f.dispatched.map(message => message.id), ['100', '101']);
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

test('completed-empty child holds live custody before startup history replay', { timeout: 4000 }, async t => {
  const f = fixture(t);
  f.state.db.prepare(`UPDATE thread_enrollments
    SET state='ready', adopted_through_id=NULL, last_seen_id=NULL, recovered_through_id=NULL, last_accepted_id=NULL,
      gap_from=NULL, gap_to=NULL, detail='Thread history recovered'
    WHERE thread_id=?`).run('2000');
  const live = { ...f.message('102', '2000'), authorId: 'operator', isBot: false, attachments: [] };
  const older = { ...f.message('101', '2000'), authorId: 'operator', isBot: false, attachments: [] };
  f.enableDelivery();
  f.gateway.started = true;
  f.gateway.transportReady = true;
  f.gateway.ready = true;
  f.gateway.boundMessage(live);
  await Promise.all([...f.gateway.inFlight]);
  await f.gateway.consumer.waitForReceipts();
  assert.equal(f.state.getMessage('102').state, 'accepted');
  assert.equal(f.dispatched.length, 0);
  assert.equal(f.boundary('2000').state, 'pending');
  assert.equal(f.boundary('2000').recoveredThroughId, '0');

  f.history.set('2000', [older, live]);
  const result = await settleRecovery(f.gateway.recoverTransport('startup'));
  assert.equal(result.ready, true, JSON.stringify(result));
  await settleRecovery(f.gateway.reconcilePending(undefined, { allowPaused: true, readyOnly: true }));
  await f.gateway.consumer.waitForNativeWork();

  assert.deepEqual(f.dispatched.map(message => message.id), ['101', '102']);
  assert.equal(f.boundary('2000').state, 'ready');
  assert.equal(f.boundary('2000').recoveredThroughId, '102');
});
