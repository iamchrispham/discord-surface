const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./helpers/intake-recovery-fixture');

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
  let attempts = 0;
  f.gateway.client.channels.fetch = async id => {
    attempts += 1;
    if (attempts === 1) return new Promise(() => {});
    return f.channels.get(id);
  };

  await f.gateway.reconcilePending(undefined, { allowPaused: true, readyOnly: true });
  const waitUntil = Date.now() + 1000;
  while (f.replies.length === 0 && Date.now() < waitUntil) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }

  assert.ok(attempts >= 2);
  assert.equal(f.state.getMessage('101').state, 'replied');
  assert.equal(f.replies.length, 1);
});
