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
    assert.equal(f.boundary('2000').state, 'ready', 'later recovery must retry the retained boundary');
    assert.equal(afterExpiry.state, held.state);
    assert.equal(afterExpiry.detail, held.detail);
    assert.equal(f.state.getMessage('101').state, 'accepted');
  });
}
