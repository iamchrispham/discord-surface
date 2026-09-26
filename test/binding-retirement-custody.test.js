'use strict';

// F4 regression fixture: retiring a conductor binding while a publication is already
// admitted into POST must not silently drop custody of that in-flight post.
//
// T1 is the defect proof: src/state.js unbind() consults hasUnresolved (messages table)
// and hasUnresolvedBindingPost (src/state/direct-post.ts). Before the repair the latter
// skipped conductor-identified direct-post-attempt rows, so an admitted
// conductor-to-conductor POST was invisible and retirement was allowed.
//
// T2 is a plain always-green control proving the happy path (POST completes, then
// retirement deactivates the source binding and its enrolled child) still works.

const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, addRecipient } = require('./fixtures/peer-fixture');
const { createPeerService } = require('../src/peer/service');

const CALLER_SESSION_ID = '11111111-1111-1111-1111-111111111111';
const REQUEST_ID = 'retry-status-probe';
const SEND_INPUT = { peer: { conductorId: 'recipient' }, text: 'hello', dedupe_key: REQUEST_ID };

function setup(t) {
  const f = fixture(t);
  f.enroll('102');
  addRecipient(f);
  return f;
}

function createPeer(f, fetchImpl) {
  return createPeerService({
    state: f.state,
    provider: 'claude',
    token: 'fixture',
    callerDependencies: { resolveClaudeCaller: async () => ({ harness: 'claude-code', sessionId: CALLER_SESSION_ID }) },
    fetchImpl
  });
}

function rowKinds(rows, kind) {
  return rows.filter(row => row.kind === kind);
}

test('conductor retirement retains custody of an admitted in-flight publication', {
  timeout: 5000
}, async t => {
  const f = setup(t);
  let release;
  let entered;
  let posts = 0;
  const held = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const deadline = setTimeout(release, 3000);
  t.after(() => { clearTimeout(deadline); release(); });

  const peer = createPeer(f, async (url, options) => {
    if (options.method === 'GET') return { ok: true, status: 200, json: async () => ({ id: '202', guild_id: '100' }) };
    posts += 1;
    entered();
    await held;
    return { ok: true, status: 200, json: async () => ({ id: '10001' }) };
  });

  const source = f.state.getBinding('101');
  const pending = peer.send(SEND_INPUT);

  try {
    await started;
    const admitted = f.state.directPostRows(REQUEST_ID);
    assert.equal(rowKinds(admitted, 'direct-post-attempt').length, 1, 'exactly one admitted direct-post attempt');
    assert.equal(rowKinds(admitted, 'direct-post-outcome').length, 0, 'no outcome while the POST is still held');

    const bindingBefore = f.state.getBinding('101');
    const enrollmentsBefore = f.state.listThreadEnrollments('101');
    const watermarkBefore = f.state.getIntakeWatermark('101');
    const receiptsBefore = f.state.listReceipts();

    assert.throws(() => f.state.unbind('101', { expectedBinding: source }), /work is unresolved/,
      'F4: conductor retirement must refuse while an admitted publication is unresolved');

    assert.deepEqual(f.state.getBinding('101'), bindingBefore, 'binding unchanged by the refused retirement');
    assert.deepEqual(f.state.listThreadEnrollments('101'), enrollmentsBefore, 'enrollments unchanged');
    assert.deepEqual(f.state.getIntakeWatermark('101'), watermarkBefore, 'intake watermark unchanged');
    assert.deepEqual(f.state.listReceipts(), receiptsBefore, 'receipts unchanged');
  } finally {
    console.log(JSON.stringify({ sourceActive: f.state.getBinding('101').active, posts }));
    release();
    const resolved = await pending;
    assert.equal(posts, 1, 'exactly one network POST');
    assert.equal(resolved.status, 'sent', 'the admitted POST resolves as sent');
  }

  assert.equal(f.state.unbind('101', { expectedBinding: source }), true, 'retirement succeeds once custody drains');
  assert.equal(f.state.getBinding('101').active, false, 'source binding is deactivated');
  assert.equal(f.state.listThreadEnrollments('101').find(row => row.threadId === '102').active, false,
    'enrolled child is deactivated');
});

test('focused control: an admitted publication completes before retirement', { timeout: 5000 }, async t => {
  const f = setup(t);
  const peer = createPeer(f, async (url, options) => options.method === 'GET'
    ? { ok: true, status: 200, json: async () => ({ id: '202', guild_id: '100' }) }
    : { ok: true, status: 200, json: async () => ({ id: '10001' }) });

  const source = f.state.getBinding('101');
  const resolved = await peer.send(SEND_INPUT);
  assert.equal(resolved.status, 'sent');

  const rows = f.state.directPostRows(REQUEST_ID);
  assert.equal(rowKinds(rows, 'direct-post-attempt').length, 1, 'exactly one direct-post attempt');
  const outcomes = rowKinds(rows, 'direct-post-outcome');
  assert.equal(outcomes.length, 1, 'exactly one direct-post outcome');
  assert.equal(outcomes[0].detail.outcome, 'sent');

  assert.equal(f.state.unbind('101', { expectedBinding: source }), true, 'retirement succeeds after custody drains');
  assert.equal(f.state.getBinding('101').active, false, 'source binding is deactivated');
  assert.equal(f.state.listThreadEnrollments('101').find(row => row.threadId === '102').active, false,
    'enrolled child is deactivated');
});
