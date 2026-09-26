const test = require('node:test');
const assert = require('node:assert/strict');

const { fixture } = require('./helpers/intake-recovery-fixture');
const { enrollPublicThread } = require('../src/discord/thread-enrollment');

// Cold public child custody. A brand-new public thread must acquire qualified history
// through the real enrollPublicThread before it is activated, so accepted live custody
// and offline history are admitted exactly once on the lifecycle retry. These two
// TODO fixtures pin the unfixed behavior; the covered control shows the intended
// sequence once a baseline boundary exists.

function coldChild(f, { failReads = false } = {}) {
  let reads = 0;
  const child = {
    ...f.channels.get('2000'),
    id: '3000',
    messages: {
      async fetch(input) {
        if (typeof input === 'string') return { async react() {} };
        reads += 1;
        if (failReads) throw Object.assign(new Error('qualified history unavailable'), { status: 503 });
        return new Map((f.history.get('3000') || []).map(message => [message.id, message]));
      }
    },
    async send(options) { f.replies.push({ channelId: '3000', ...options }); return { id: `reply-${f.replies.length}` }; }
  };
  f.channels.set('3000', child);
  return () => reads;
}

test('cold public child refuses activation when qualified history acquisition fails',
  { todo: 'known defect: public enrollment activates before qualified history acquisition' }, async t => {
    const f = fixture(t);
    const reads = coldChild(f, { failReads: true });
    const before = f.state.getBinding('1000');
    let refusal = null;
    try { await enrollPublicThread(f.state, f.gateway.client, '1000', '3000'); }
    catch (error) { refusal = error; }
    const row = f.state.getThreadEnrollment('3000');
    assert.deepEqual(f.state.getBinding('1000'), before);
    assert.equal(row?.active || false, false,
      'public enrollment activated before qualified history acquisition');
    assert.equal(reads(), 1);
    assert.ok(refusal, 'cold public enrollment must refuse when qualified history is unavailable');
  });

async function coldChildSequence(f, covered) {
  coldChild(f);
  f.history.set('3000', [f.message('200', '3000')]);
  await enrollPublicThread(f.state, f.gateway.client, '1000', '3000');
  if (covered) {
    f.state.setThreadBaseline('3000', '200', f.state.getBinding('1000'));
    f.state.markThreadBoundary('3000', 'ready');
  }
  const binding = f.state.getBinding('1000');
  assert.equal(f.state.acceptDiscordMessage({ ...f.message('201', '3000'), authorId: 'operator',
    isBot: false, attachments: [] }, { ready: false, expectedBinding: binding }).accepted, true);
  f.fail({ id: '3000', kind: 'channel', status: 503 });
  await f.recover();
  assert.match(f.state.getThreadEnrollment('3000').detail, /^Discord HTTP 503 during recovery:/);
  f.history.set('3000', [f.message('202', '3000'), f.message('201', '3000'), f.message('200', '3000')]);
  f.fail(null);
  await enrollPublicThread(f.state, f.gateway.client, '1000', '3000');
  await f.recover();
  f.enableDelivery();
  f.gateway.started = true;
  f.gateway.transportReady = true;
  f.gateway.ready = true;
  await f.gateway.reconcilePending(undefined, { readyOnly: true });
  await f.gateway.consumer.waitForNativeWork();
  const ids = f.dispatched.map(message => message.id).sort();
  assert.deepEqual(ids, ['201', '202'],
    'accepted A and offline B must dispatch exactly once after lifecycle retry');
  assert.equal(f.state.getMessage('200'), null, 'pre-adoption history H must stay excluded');
  assert.equal(f.state.getMessage('201').state, 'replied');
  assert.equal(f.state.getMessage('202').state, 'replied');
  assert.equal(f.state.getBinding('1000').nativeId, binding.nativeId);
  assert.equal(f.state.getBinding('1000').generation, binding.generation);
}

test('cold public child delivers accepted A and offline B exactly once after history retry',
  { todo: 'known defect: cold child accepted custody stays held after history failure' }, async t => {
    await coldChildSequence(fixture(t), false);
  });

test('completed covered child delivers accepted A and offline B after the same failure', async t => {
  await coldChildSequence(fixture(t), true);
});
