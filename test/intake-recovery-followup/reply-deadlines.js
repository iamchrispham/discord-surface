const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('../helpers/intake-recovery-fixture');
const { recoverThread } = require('../../src/discord/thread-enrollment');
const { waitForRecoveryOperation } = require('../../src/discord');
const { settleRecovery } = require('./settle-recovery');

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
    return new Promise(resolve => { releaseSend = resolve; });
  };
  try {
    await settleRecovery(f.gateway.reconcilePending(undefined, { allowPaused: true, readyOnly: true }));
    assert.equal(sendStarted, true);
    assert.equal(f.state.getMessage('101').state, 'reply_unknown');
  } finally {
    channel.send = originalSend;
    releaseSend?.({ id: 'late-reply' });
  }
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline && f.state.getMessage('101').state !== 'replied') {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(f.state.getMessage('101').state, 'replied');
  assert.equal(f.state.getMessage('101').replyMessageId, 'late-reply');
});

test('aborted reply-ready recovery send settles as unknown', { timeout: 4000 }, async t => {
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
  const channel = f.channels.get('1000');
  const originalSend = channel.send;
  let sendStarted = false;
  let releaseSend;
  channel.send = async () => {
    sendStarted = true;
    return new Promise(resolve => { releaseSend = resolve; });
  };
  try {
    const recovery = f.gateway.reconcilePending(undefined, { allowPaused: true, readyOnly: true });
    const startDeadline = Date.now() + 1000;
    while (!sendStarted && Date.now() < startDeadline) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(sendStarted, true);
    f.gateway.pauseConnection('abort pending reply reconciliation');
    await settleRecovery(recovery);
    assert.equal(f.state.getMessage('101').state, 'reply_unknown');
  } finally {
    channel.send = originalSend;
    releaseSend?.({ id: 'late-reply' });
  }
});

test('submitted observer does not post after route readiness is lost before settlement', { timeout: 4000 }, async t => {
  const f = fixture(t);
  const message = f.message('101', '1000');
  assert.equal(f.state.acceptDiscordMessage({ ...message, authorId: 'operator', isBot: false }).accepted, true);
  assert.equal(f.state.claimDispatch('101').claimed, true);
  assert.equal(f.state.markSubmitted('101').state, 'submitted');
  f.enableDelivery();
  const originalObserve = f.gateway.providers.codex.observe;
  let observeStarted = false;
  let releaseObserve;
  f.gateway.providers.codex.observe = async (...args) => {
    observeStarted = true;
    await new Promise(resolve => { releaseObserve = resolve; });
    return originalObserve(...args);
  };
  try {
    const recovery = f.gateway.reconcilePending(undefined, { allowPaused: true, readyOnly: true });
    const startDeadline = Date.now() + 1000;
    while (!observeStarted && Date.now() < startDeadline) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(observeStarted, true);
    const channelDeadline = Date.now() + 1000;
    while (!f.calls.some(call => call.kind === 'channel' && call.id === '1000') && Date.now() < channelDeadline) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    f.gateway.pauseConnection('observer settlement route hold');
    releaseObserve?.();
    await settleRecovery(recovery);
    await f.gateway.consumer.waitForNativeWork();
    assert.equal(f.replies.length, 0);
    assert.equal(f.state.getMessage('101').state, 'reply_ready');
  } finally {
    releaseObserve?.();
    f.gateway.providers.codex.observe = originalObserve;
  }
});

test('reply-ready recovery retries when delivery misses the preflight deadline', { timeout: 4000 }, async t => {
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
  const originalFetch = f.gateway.client.channels.fetch.bind(f.gateway.client.channels);
  let fetchCalls = 0;
  // The single-flight owner must never overlap two lookups for the same
  // destination: the retry continuation attaches to (or reuses) the one settled
  // lookup rather than stacking a speculative second request on top of it.
  let inFlight = 0;
  let peakInFlight = 0;
  f.gateway.client.channels.fetch = async id => {
    fetchCalls += 1;
    inFlight += 1;
    peakInFlight = Math.max(peakInFlight, inFlight);
    try {
      if (fetchCalls === 1) await new Promise(resolve => setTimeout(resolve, 5));
      return await originalFetch(id);
    } finally {
      inFlight -= 1;
    }
  };
  const originalPermission = f.gateway.historyPermission.bind(f.gateway);
  let permissionCalls = 0;
  f.gateway.historyPermission = (...args) => {
    const permission = originalPermission(...args);
    permissionCalls += 1;
    if (permissionCalls === 1) {
      const deadline = Date.now() + 30;
      while (Date.now() < deadline) {}
    }
    return permission;
  };
  try {
    await settleRecovery(f.gateway.reconcilePending(undefined, { allowPaused: true, readyOnly: true }));
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline && f.state.getMessage('101').state !== 'replied') {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.ok(fetchCalls >= 2, 'the preflight timeout must queue another reconciliation pass');
    assert.equal(peakInFlight, 1, `reconciliation lookups must not overlap, peak ${peakInFlight}`);
    assert.equal(f.state.getMessage('101').state, 'replied');
    assert.equal(f.replies.length, 1);
  } finally {
    f.gateway.client.channels.fetch = originalFetch;
    f.gateway.historyPermission = originalPermission;
  }
});

test('reply preparation aborts at the recovery deadline before a held route can send', { timeout: 4000 }, async t => {
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
  const originalPermissionsFor = channel.permissionsFor;
  const originalSendAcknowledgment = f.gateway.sendAcknowledgment.bind(f.gateway);
  const originalFetch = f.gateway.client.channels.fetch.bind(f.gateway.client.channels);
  let acknowledgmentAttempts = 0;
  let fetchCalls = 0;
  f.gateway.sendAcknowledgment = async (...args) => {
    acknowledgmentAttempts += 1;
    if (acknowledgmentAttempts === 1) throw Object.assign(new Error('acknowledgment unavailable'), { status: 503 });
    return originalSendAcknowledgment(...args);
  };
  f.gateway.client.channels.fetch = async id => {
    fetchCalls += 1;
    return originalFetch(id);
  };
  try {
    await settleRecovery(f.gateway.reconcilePending(undefined, { allowPaused: true, readyOnly: true }));
    channel.permissionsFor = () => ({ has: () => false });
    f.gateway.pauseConnection('route held after reply preparation deadline');
    await new Promise(resolve => setTimeout(resolve, 350));
    assert.ok(fetchCalls >= 2, 'reply preparation timeout must queue another reconciliation pass');
    assert.equal(acknowledgmentAttempts, 1, 'held-route retry must stop before acknowledgment preparation');
    assert.equal(f.replies.length, 0, 'a settled preparation must not send through the held route');
    assert.equal(f.state.getMessage('101').state, 'reply_ready');
  } finally {
    channel.permissionsFor = originalPermissionsFor;
    f.gateway.sendAcknowledgment = originalSendAcknowledgment;
  }
});
