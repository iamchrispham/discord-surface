const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./helpers/intake-recovery-fixture');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const settle = async operation => {
  let timer;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('reconcile caller did not settle')), 2000);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
};

function seedReplyReady(f, id, channelId = '1000') {
  const message = f.message(id, channelId);
  assert.equal(f.state.acceptDiscordMessage({ ...message, authorId: 'operator', isBot: false }).accepted, true);
  assert.equal(f.state.claimDispatch(id).claimed, true);
  assert.equal(f.state.markSubmitted(id).state, 'submitted');
  const stored = f.state.getMessage(id);
  f.state.recordNativeReply({
    provider: stored.provider,
    messageId: stored.id,
    nativeId: stored.nativeId,
    generation: stored.generation,
    text: 'saved reply'
  });
  return stored;
}

for (const adoptThread of [true, false]) {
  test(`reconciliation expiry preserves ${adoptThread ? 'adopted' : 'pre-adoption'} thread retry`, { timeout: 4000 }, async t => {
    const f = fixture(t, { adoptThread });
    const message = f.message('101', '2000');
    const accepted = f.state.acceptDiscordMessage({ ...message, authorId: 'operator', isBot: false });
    assert.equal(accepted.accepted, true);
    f.history.set('2000', [message]);
    f.fail({ id: '2000', kind: 'channel', status: 503 });
    await f.recover();
    const held = f.boundary('2000');
    assert.equal(held.state, adoptThread ? 'unavailable' : 'pending');
    assert.match(held.detail, /Discord HTTP 503/);
    f.fail(null);
    f.calls.length = 0;
    const originalNow = Date.now;
    let reads = 0;
    const start = originalNow();
    Date.now = () => ++reads === 1 ? start : start + f.gateway.recoveryTimeoutMs + 1;
    try { await f.gateway.reconcilePending(); }
    finally { Date.now = originalNow; }
    assert.equal(f.calls.length, 0, 'expired budget must not start a fetch');
    const afterExpiry = f.boundary('2000');
    assert.equal(f.state.getMessage('101').state, 'accepted');
    assert.equal(f.dispatched.length, 0);
    await f.reopen();
    await f.recover();
    // A never-adopted child has no committed cutoff, so retrying the retained
    // boundary observes history without qualifying it; only real adoption does.
    assert.equal(f.boundary('2000').state, adoptThread ? 'ready' : 'pending',
      'later recovery must retry the retained boundary');
    assert.equal(afterExpiry.state, held.state);
    assert.equal(afterExpiry.detail, held.detail);
    assert.equal(f.state.getMessage('101').state, 'accepted');
  });
}

test('reply-ready custody retries after its channel fetch starts before expiry', { timeout: 4000 }, async t => {
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
  f.state.markIntakeBoundary('1000', 'gap', 'explicit uncovered history', '101', '102');
  f.enableDelivery();
  f.gateway.recoveryTimeoutMs = 30;
  const originalFetch = f.gateway.client.channels.fetch.bind(f.gateway.client.channels);
  let attempts = 0;
  f.gateway.client.channels.fetch = async id => {
    attempts += 1;
    if (attempts === 1) throw Object.assign(new Error('fetch failed'), { status: 503 });
    return originalFetch(id);
  };

  await f.gateway.reconcilePending(undefined, { allowPaused: true, readyOnly: true });
  // The first lookup fails as a real SDK-style settlement. A genuine LATER
  // lifecycle invocation retries the destination and delivers the durable reply.
  await f.gateway.reconcilePending(undefined, { allowPaused: true, readyOnly: true });
  const waitUntil = Date.now() + 1000;
  while (f.replies.length === 0 && Date.now() < waitUntil) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }

  assert.ok(attempts >= 2, `expected a genuine later lookup, saw ${attempts} attempts`);
  assert.equal(f.state.getMessage('101').state, 'replied');
  assert.equal(f.replies.length, 1);
});

test('a later submitted observer wakes reconciliation after an earlier candidate expires', { timeout: 4000 }, async t => {
  const f = fixture(t);
  const first = f.message('101', '1000');
  const second = f.message('102', '1000');
  for (const message of [first, second]) {
    assert.equal(f.state.acceptDiscordMessage({ ...message, authorId: 'operator', isBot: false }).accepted, true);
    assert.equal(f.state.claimDispatch(message.id).claimed, true);
    assert.equal(f.state.markSubmitted(message.id).state, 'submitted');
  }
  const firstStored = f.state.getMessage(first.id);
  f.state.recordNativeReply({
    provider: firstStored.provider,
    messageId: firstStored.id,
    nativeId: firstStored.nativeId,
    generation: firstStored.generation,
    text: 'already observed'
  });
  assert.equal(f.state.getMessage(first.id).state, 'reply_ready');
  f.enableDelivery();
  f.gateway.recoveryTimeoutMs = 30;
  f.gateway.sendAcknowledgment = async () => {};
  const originalObserve = f.gateway.providers.codex.observe;
  let observes = 0;
  f.gateway.providers.codex.observe = async (...args) => {
    observes += 1;
    await new Promise(resolve => setTimeout(resolve, 100));
    return originalObserve(...args);
  };
  const originalFetch = f.gateway.client.channels.fetch.bind(f.gateway.client.channels);
  let fetches = 0;
  f.gateway.client.channels.fetch = async id => {
    fetches += 1;
    if (fetches === 1) throw Object.assign(new Error('fetch failed'), { status: 503 });
    return originalFetch(id);
  };

  try {
    await f.gateway.reconcilePending(undefined, { allowPaused: true, readyOnly: true });
    await new Promise(resolve => setTimeout(resolve, 120));
    // The earlier candidate's lookup failed for real; a genuine later observer
    // pass (native observation preserved) delivers both durable replies.
    await f.gateway.reconcilePending(undefined, { allowPaused: true, readyOnly: true });
    const waitUntil = Date.now() + 1500;
    while (f.replies.length < 2 && Date.now() < waitUntil) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  } finally {
    f.gateway.providers.codex.observe = originalObserve;
  }

  assert.ok(observes >= 1, 'native observation must be preserved');
  assert.ok(fetches >= 2, `expected a genuine later pass, saw ${fetches} fetches`);
  assert.equal(f.state.getMessage(first.id).state, 'replied');
  assert.equal(f.state.getMessage(second.id).state, 'replied');
  assert.equal(f.replies.length, 2);
});

test('T1: repeated deadlines and a reconnect keep one outstanding lookup per destination', { timeout: 4000 }, async t => {
  const f = fixture(t);
  seedReplyReady(f, '101', '1000');
  f.enableDelivery();
  f.gateway.recoveryTimeoutMs = 30;
  let fetches = 0;
  f.gateway.client.channels.fetch = () => {
    fetches += 1;
    return new Promise(() => {});
  };

  for (let pass = 0; pass < 3; pass += 1) {
    await settle(f.gateway.reconcilePending(undefined, { allowPaused: true, readyOnly: true }));
  }
  assert.equal(fetches, 1, 'repeated deadline expiry must reuse the single outstanding lookup');

  await f.reopen();
  f.gateway.recoveryTimeoutMs = 30;
  await settle(f.gateway.reconcilePending(undefined, { allowPaused: true, readyOnly: true }));
  assert.equal(fetches, 1, 'a reconnect must attach to the same unresolved lookup');
  assert.equal(f.state.getMessage('101').state, 'reply_ready');
  assert.equal(f.replies.length, 0);
});

test('T2: a permanently pending destination does not block a healthy destination reply', { timeout: 4000 }, async t => {
  const f = fixture(t);
  f.state.bind({
    channelId: '3000', guildId: 'guild', provider: 'codex',
    nativeId: '33333333-3333-4333-8333-333333333333',
    workspace: f.state.getBinding('1000').workspace
  }, { intakeCutoff: '100' });
  f.state.setIntakeBaseline('3000', '100', 'fixture');
  f.state.markIntakeBoundary('3000', 'ready');
  f.channels.set('3000', { ...f.channels.get('1000'), id: '3000' });
  seedReplyReady(f, '101', '1000');
  seedReplyReady(f, '102', '3000');
  f.enableDelivery();
  f.gateway.recoveryTimeoutMs = 30;
  f.gateway.sendAcknowledgment = async () => {};
  const originalFetch = f.gateway.client.channels.fetch.bind(f.gateway.client.channels);
  let stuckFetches = 0;
  f.gateway.client.channels.fetch = id => {
    if (id === '1000') {
      stuckFetches += 1;
      return new Promise(() => {});
    }
    return originalFetch(id);
  };

  await settle(f.gateway.reconcilePending(undefined, { allowPaused: true, readyOnly: true }));
  const waitUntil = Date.now() + 1000;
  while (f.state.getMessage('102').state !== 'replied' && Date.now() < waitUntil) await delay(10);

  assert.equal(f.state.getMessage('102').state, 'replied');
  assert.equal(f.replies.length, 1, 'the healthy destination delivers its durable reply');
  assert.equal(stuckFetches, 1, 'the stuck destination holds one lookup while others progress');
  assert.equal(f.state.getMessage('101').state, 'reply_ready');
});

test('T3: a late successful settlement delivers exactly once with no second speculative fetch', { timeout: 4000 }, async t => {
  const f = fixture(t);
  seedReplyReady(f, '101', '1000');
  f.enableDelivery();
  f.gateway.recoveryTimeoutMs = 30;
  // Isolate the reconciliation lookup from the acknowledgment path's own
  // direct channel fetch, which is a separate workflow.
  f.gateway.sendAcknowledgment = async () => {};
  let fetches = 0;
  let release;
  f.gateway.client.channels.fetch = id => {
    fetches += 1;
    return new Promise(resolve => { release = () => resolve(f.channels.get(id)); });
  };

  // Two genuine passes attach to the SAME unresolved lookup and BOTH give up at
  // their own deadlines before it settles. A later pass must not strand the
  // settlement: the surviving waiter still wakes the durable reply, and no
  // speculative second lookup starts.
  await settle(f.gateway.reconcilePending(undefined, { allowPaused: true, readyOnly: true }));
  await settle(f.gateway.reconcilePending(undefined, { allowPaused: true, readyOnly: true }));
  assert.equal(fetches, 1);
  assert.equal(f.state.getMessage('101').state, 'reply_ready');

  release();
  const waitUntil = Date.now() + 1000;
  while (f.state.getMessage('101').state !== 'replied' && Date.now() < waitUntil) await delay(10);

  assert.equal(f.state.getMessage('101').state, 'replied');
  assert.equal(f.replies.length, 1, 'exactly one durable reply');
  assert.equal(fetches, 1, 'the wake continuation reuses the settled one-use snapshot');
});

test('T4: stop returns without awaiting a stuck lookup and later settlement is inert', { timeout: 4000 }, async t => {
  const f = fixture(t);
  seedReplyReady(f, '101', '1000');
  f.enableDelivery();
  f.gateway.recoveryTimeoutMs = 30;
  let release;
  f.gateway.client.channels.fetch = id => new Promise(resolve => { release = () => resolve(f.channels.get(id)); });
  let reconcileCalls = 0;
  const originalReconcile = f.gateway.reconcilePending.bind(f.gateway);
  f.gateway.reconcilePending = (...args) => {
    reconcileCalls += 1;
    return originalReconcile(...args);
  };

  const pending = f.gateway.reconcilePending(undefined, { allowPaused: true, readyOnly: true });
  await f.gateway.stop();
  await settle(pending).catch(() => {});
  assert.equal(reconcileCalls, 1);
  assert.equal(typeof release, 'function');

  release();
  await delay(100);
  assert.equal(f.replies.length, 0, 'a settlement after stop must not reply');
  assert.equal(f.state.getMessage('101').state, 'reply_ready', 'custody is retained');
  assert.equal(reconcileCalls, 1, 'a settlement after stop must not enqueue reconciliation');
});

test('T5: a pre-settlement lifecycle change is stale, a post-reconnect waiter still settles', { timeout: 4000 }, async t => {
  const f = fixture(t);
  seedReplyReady(f, '101', '1000');
  f.enableDelivery();
  f.gateway.recoveryTimeoutMs = 30;
  f.gateway.sendAcknowledgment = async () => {};
  let releaseStale;
  let staleFetches = 0;
  f.gateway.client.channels.fetch = id => {
    staleFetches += 1;
    return new Promise(resolve => { releaseStale = () => resolve(f.channels.get(id)); });
  };
  await settle(f.gateway.reconcilePending(undefined, { allowPaused: true, readyOnly: true }));
  assert.equal(staleFetches, 1);

  // Retire the lifecycle epoch that owned the waiter before it settles.
  await f.reopen();
  f.gateway.recoveryTimeoutMs = 30;
  f.gateway.sendAcknowledgment = async () => {};
  releaseStale();
  await delay(100);
  assert.equal(f.replies.length, 0, 'a retired epoch settlement must not reply');
  assert.equal(f.dispatched.length, 0);
  assert.equal(f.state.getMessage('101').state, 'reply_ready');

  // A waiter attached after the reconnect is legitimate and still settles.
  let releaseCurrent;
  let currentFetches = 0;
  f.gateway.client.channels.fetch = id => {
    currentFetches += 1;
    return new Promise(resolve => { releaseCurrent = () => resolve(f.channels.get(id)); });
  };
  await settle(f.gateway.reconcilePending(undefined, { allowPaused: true, readyOnly: true }));
  assert.equal(currentFetches, 1);
  releaseCurrent();
  const waitUntil = Date.now() + 1000;
  while (f.state.getMessage('101').state !== 'replied' && Date.now() < waitUntil) await delay(10);

  assert.equal(f.state.getMessage('101').state, 'replied');
  assert.equal(f.replies.length, 1);
  assert.equal(currentFetches, 1);
  assert.equal(f.dispatched.length, 0);
});

test('T6: an immediate rejection does not self-retry; an explicit later call may deliver', { timeout: 4000 }, async t => {
  const f = fixture(t);
  seedReplyReady(f, '101', '1000');
  f.enableDelivery();
  f.gateway.recoveryTimeoutMs = 100;
  f.gateway.sendAcknowledgment = async () => {};
  const originalFetch = f.gateway.client.channels.fetch.bind(f.gateway.client.channels);
  let attempts = 0;
  f.gateway.client.channels.fetch = id => {
    attempts += 1;
    if (attempts === 1) throw Object.assign(new Error('fetch failed'), { status: 503 });
    return originalFetch(id);
  };

  await settle(f.gateway.reconcilePending(undefined, { allowPaused: true, readyOnly: true }));
  await delay(150);
  assert.equal(attempts, 1, 'a synchronous rejection must not create an internal retry chain');
  assert.equal(f.state.getMessage('101').state, 'reply_ready');

  await settle(f.gateway.reconcilePending(undefined, { allowPaused: true, readyOnly: true }));
  const waitUntil = Date.now() + 1000;
  while (f.state.getMessage('101').state !== 'replied' && Date.now() < waitUntil) await delay(10);

  assert.equal(attempts, 2, 'the explicit later invocation starts exactly one fresh lookup');
  assert.equal(f.state.getMessage('101').state, 'replied');
  assert.equal(f.replies.length, 1);
});
