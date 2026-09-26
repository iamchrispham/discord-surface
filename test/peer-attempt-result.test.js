'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { fixture, service, addRecipient } = require('./fixtures/peer-fixture');

const request = { peer: { conductorId: 'recipient' }, text: 'retry after rate limit', dedupe_key: 'held-retry' };

// Causal reproduction for PR109 F2: the newest admitted attempt owns the readback.
// Previously the passive readback picked the last outcome row, so a retry held in
// flight reported the older rate_limited outcome instead of 'in_flight'.
test('peer result reports in_flight while a retry is unresolved after a rate_limited failure', { timeout: 5000 }, async t => {
  const f = fixture(t);
  f.enroll('102');
  addRecipient(f);
  let release;
  const held = new Promise(resolve => { release = resolve; });
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  let posts = 0;
  const peer = service(f, { fetchImpl: async (url, options) => {
    if (options.method === 'GET') return { ok: true, status: 200, json: async () => ({ id: '202', guild_id: '100' }) };
    posts += 1;
    if (posts === 1) return { ok: false, status: 429, json: async () => ({ retry_after: 1 }) };
    entered();
    await held;
    return { ok: true, status: 200, json: async () => ({ id: '10001' }) };
  } });
  assert.equal((await peer.send(request)).status, 'rate_limited', 'first attempt is rate limited');
  const watchdog = setTimeout(release, 3000);
  const retry = peer.send(request);
  try {
    await started;
    const rows = f.state.directPostRows(request.dedupe_key);
    assert.equal(rows.filter(row => row.kind === 'direct-post-attempt').length, 2, 'retry admitted a second attempt');
    assert.equal(rows.filter(row => row.kind === 'direct-post-outcome').length, 1, 'only the first outcome is resolved');
    const heldReadback = await peer.result(request.dedupe_key);
    assert.equal(heldReadback.sendOutcome, 'in_flight',
      'an unresolved newest attempt must not surface the older rate_limited outcome');
  } finally {
    clearTimeout(watchdog);
    release();
    await retry.catch(() => {});
  }
  assert.equal((await retry).status, 'sent', 'the held retry completes with its real outcome');
  assert.equal((await peer.result(request.dedupe_key)).sendOutcome, 'sent');
  assert.equal(posts, 2);
  const rows = f.state.directPostRows(request.dedupe_key);
  assert.equal(rows.filter(row => row.kind === 'direct-post-attempt').length, 2);
  assert.equal(rows.filter(row => row.kind === 'direct-post-outcome').length, 2);
});
