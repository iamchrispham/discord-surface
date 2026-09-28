'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Configure the waiter export BEFORE src/discord destructures it at require time.
const lookups = require('../dist/discord/reconciliation-lookups.js');
const realAttach = lookups.attachReconciliationWaiter;
let releaseCalls = 0;
let lastRelease = null;
lookups.attachReconciliationWaiter = (owner, destinationId, waiter) => {
  const release = realAttach(owner, destinationId, waiter);
  const tracked = () => { releaseCalls += 1; release(); };
  lastRelease = tracked;
  return tracked;
};
const {
  getReconciliationLookup,
  pruneReconciliationWaiters,
  startReconciliationLookup,
  storeReconciliationSnapshot
} = lookups;

const { fixture } = require('./helpers/intake-recovery-fixture');
const { DiscordGateway } = require('../src/discord');

const flush = () => new Promise(resolve => setImmediate(resolve));

function seedSubmitted(f, id = '101', channelId = '1000') {
  const message = f.message(id, channelId);
  assert.equal(f.state.acceptDiscordMessage({ ...message, authorId: 'operator', isBot: false }).accepted, true);
  assert.equal(f.state.claimDispatch(id).claimed, true);
  assert.equal(f.state.markSubmitted(id).state, 'submitted');
}

test('disconnect prunes stale waiters and preserves a shared-client sibling', { timeout: 2000 }, async t => {
  const f = fixture(t);
  const sibling = new DiscordGateway({ state: f.state, client: f.gateway.client });
  try {
    const owner = f.gateway.client;
    const [destA, destB] = ['3001', '3002'];
    let starts = 0;
    let resolveA;
    let resolveB;
    const pendingA = new Promise(resolve => { resolveA = resolve; });
    const pendingB = new Promise(resolve => { resolveB = resolve; });
    const promiseA = startReconciliationLookup(owner, destA, 'message-a', () => { starts += 1; return pendingA; });
    const promiseB = startReconciliationLookup(owner, destB, 'message-b', () => { starts += 1; return pendingB; });
    let aPredicate = 0;
    let bPredicate = 0;
    let aSettled = 0;
    let bSettled = 0;
    const aEpoch = f.gateway.lifecycleEpoch;
    const aConnection = f.gateway.connectionEpoch;
    const bEpoch = sibling.lifecycleEpoch;
    const bConnection = sibling.connectionEpoch;
    lookups.attachReconciliationWaiter(owner, destA, {
      isCurrent: () => {
        aPredicate += 1;
        return !f.gateway.stopping && f.gateway.isCurrentLifecycle(aEpoch) &&
          f.gateway.connectionEpoch === aConnection;
      },
      settled: () => { aSettled += 1; },
      failed: () => {}
    });
    lookups.attachReconciliationWaiter(owner, destB, {
      isCurrent: () => {
        bPredicate += 1;
        return !sibling.stopping && sibling.isCurrentLifecycle(bEpoch) &&
          sibling.connectionEpoch === bConnection;
      },
      settled: () => { bSettled += 1; },
      failed: () => {}
    });
    await flush();
    assert.equal(starts, 2, 'both controlled lookups start exactly once');

    f.gateway.pauseConnection('test');
    assert.equal(aPredicate, 1, 'disconnect must evaluate the retired waiter once');
    assert.equal(bPredicate, 1, 'disconnect must evaluate the sibling waiter once');
    assert.equal(getReconciliationLookup(owner, destA), promiseA);
    assert.equal(getReconciliationLookup(owner, destB), promiseB);
    assert.equal(starts, 2);

    resolveA({ id: destA });
    resolveB({ id: destB });
    await Promise.allSettled([promiseA, promiseB]);
    assert.equal(aSettled, 0, 'the pruned waiter must not settle');
    assert.equal(bSettled, 1, 'the shared-client sibling must still settle');
    assert.equal(aPredicate, 1);
    assert.equal(bPredicate, 2);
  } finally {
    await sibling.stop();
    await f.gateway.stop();
    f.state.close();
  }
});

test('stale waiter pruning isolates a throwing predicate', { timeout: 2000 }, async t => {
  const owner = {};
  const dest = '4001';
  let resolveLookup;
  const pending = new Promise(resolve => { resolveLookup = resolve; });
  let starts = 0;
  const original = startReconciliationLookup(owner, dest, 'message-4001', () => { starts += 1; return pending; });
  let throwingCalls = 0;
  let validCalls = 0;
  let validSettled = 0;
  lookups.attachReconciliationWaiter(owner, dest, {
    isCurrent: () => { throwingCalls += 1; throw new Error('throwing predicate'); },
    settled: () => { throw new Error('a throwing waiter must never settle'); },
    failed: () => {}
  });
  const releaseValid = lookups.attachReconciliationWaiter(owner, dest, {
    isCurrent: () => { validCalls += 1; return true; },
    settled: () => { validSettled += 1; },
    failed: () => {}
  });
  const snapshotObject = { id: 'snapshot-channel' };
  storeReconciliationSnapshot(owner, '4002', 'message-4002', snapshotObject);

  pruneReconciliationWaiters(owner);
  assert.equal(throwingCalls, 1, 'pruning must evaluate the throwing predicate exactly once');
  assert.equal(getReconciliationLookup(owner, dest), original, 'pruning must not replace the lookup');

  await flush();
  assert.equal(starts, 1);
  resolveLookup({ id: dest });
  await original;
  assert.equal(throwingCalls, 1, 'the pruned throwing waiter must not be re-evaluated');
  assert.equal(validCalls, 2, 'the surviving sibling is evaluated at prune and settlement');
  assert.equal(validSettled, 1);
  assert.equal(starts, 1, 'settlement must not start a replacement fetch');
  releaseValid();

  let snapshotFetches = 0;
  const consumed = await startReconciliationLookup(owner, '4002', 'message-4002', () => {
    snapshotFetches += 1;
    return Promise.resolve({ id: 'other' });
  });
  assert.equal(consumed, snapshotObject, 'the exact stored snapshot must be handed off');
  assert.equal(snapshotFetches, 0, 'a consumed snapshot must not start a fetch');
});

test('aborted reconciliation releases its own waiter without replacing the lookup', { timeout: 2000 }, async t => {
  releaseCalls = 0;
  lastRelease = null;
  const f = fixture(t);
  t.after(() => { lookups.attachReconciliationWaiter = realAttach; });
  seedSubmitted(f);
  f.gateway.recoveryTimeoutMs = 30;
  f.gateway.sendAcknowledgment = async () => {};
  f.gateway.consumer.resumeSubmitted = () => ({ status: 'observing' });
  let resolveFetch;
  const pendingFetch = new Promise(resolve => { resolveFetch = resolve; });
  let fetchCount = 0;
  const channel = f.channels.get('1000');
  f.gateway.client.channels.fetch = () => { fetchCount += 1; return pendingFetch; };

  const recovery = f.gateway.reconcilePending(undefined, { allowPaused: true, readyOnly: true });
  await flush();
  const owner = f.gateway.client;
  const originalLookup = getReconciliationLookup(owner, '1000');
  assert.ok(originalLookup, 'the recovery pass must register an in-flight lookup');
  assert.equal(fetchCount, 1);
  assert.ok(lastRelease, 'the pass must register a release for its own waiter');
  assert.equal(releaseCalls, 0);

  const controller = f.gateway.recoveryController;
  assert.ok(controller, 'public reconcilePending must expose the real recovery controller');
  controller.abort();
  await recovery;
  assert.equal(releaseCalls, 1, 'the STOPPED path must release exactly its own waiter');
  assert.equal(getReconciliationLookup(owner, '1000'), originalLookup, 'abort must retain the lookup');
  assert.equal(fetchCount, 1);

  resolveFetch(channel);
  await flush();
  assert.equal(f.state.getMessage('101').state, 'submitted');
  assert.equal(f.replies.length, 0);
  assert.equal(f.dispatched.length, 0);
});
