const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./helpers/intake-recovery-fixture');

async function settle(operation) {
  let timer;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('recovery caller did not settle')), 4000);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function operatorMessage(f, id, channelId) {
  return { ...f.message(id, channelId), authorId: 'operator', isBot: false, attachments: [] };
}

function accept(f, id, channelId, ready, { visible = true } = {}) {
  const accepted = f.state.acceptDiscordMessage(operatorMessage(f, id, channelId),
    { expectedBinding: f.state.getBinding('1000'), ready });
  assert.equal(accepted.accepted, true);
  if (visible) f.history.set(channelId, [f.message(id, channelId)]);
}

// The live message reaches custody while the last history page is in flight, so that page misses it.
function landDuringFinalFetch(f, id, channelId, options) {
  const fetchHistory = f.gateway.fetchHistory;
  let landed = false;
  f.gateway.fetchHistory = async (channel, fetchOptions) => {
    const page = await fetchHistory(channel, fetchOptions);
    if (!landed && channel.id === channelId && page.length === 0) {
      landed = true;
      accept(f, id, channelId, false, options);
    }
    return page;
  };
  return () => landed;
}

// The live message reaches custody after the ready record and before the final watermark check.
// The binding is READY by then, so live intake accepts it as ready, as intakeMessage would.
function landAfterReadyRecord(f, id) {
  const mark = f.state.markIntakeBoundary.bind(f.state);
  let landed = false;
  f.state.markIntakeBoundary = (...args) => {
    const result = mark(...args);
    if (!landed && result && args[0] === '1000' && args[1] === 'ready') {
      landed = true;
      accept(f, id, '1000', true);
    }
    return result;
  };
  return () => landed;
}

async function run(f, entrypoint) {
  if (entrypoint === 'reconnect') f.enableDelivery();
  return settle(entrypoint === 'reconnect'
    ? f.gateway.beginReconnectRecovery('probe')
    : f.gateway.recoverTransport('startup'));
}

async function assertDispatchedOnce(f, entrypoint, id) {
  if (entrypoint !== 'reconnect') {
    assert.equal(f.state.getMessage(id).state, 'accepted');
    assert.equal(f.dispatched.length, 0);
    return;
  }
  await f.gateway.consumer.waitForNativeWork();
  assert.equal(f.state.getMessage(id).state, 'replied');
  assert.equal(f.dispatched.filter(message => message.id === id).length, 1);
}

for (const window of ['final-fetch', 'ready-record']) {
  for (const entrypoint of ['result', 'reconnect']) {
    test(`channel custody landing at ${window} reaches ready through ${entrypoint}`, { timeout: 8000 }, async t => {
      const f = fixture(t);
      const landed = window === 'final-fetch' ? landDuringFinalFetch(f, '101', '1000') : landAfterReadyRecord(f, '101');
      const result = await run(f, entrypoint);
      assert.ok(landed());
      assert.equal(f.boundary('1000').state, 'ready', f.boundary('1000').detail);
      assert.equal(f.state.getBinding('1000').readiness, 'ready');
      assert.equal(f.cursor('1000'), '101');
      assert.equal(result.ready, true);
      await assertDispatchedOnce(f, entrypoint, '101');
    });
  }
}

for (const entrypoint of ['result', 'reconnect']) {
  test(`thread custody landing at final-fetch reaches ready through ${entrypoint}`, { timeout: 8000 }, async t => {
    const f = fixture(t);
    const landed = landDuringFinalFetch(f, '102', '2000');
    const result = await run(f, entrypoint);
    assert.ok(landed());
    assert.equal(f.boundary('2000').state, 'ready', f.boundary('2000').detail);
    assert.equal(f.cursor('2000'), '102');
    assert.equal(result.ready, true);
    await assertDispatchedOnce(f, entrypoint, '102');
  });
}

test('channel custody that history never shows records gap after one extra pass', { timeout: 8000 }, async t => {
  const f = fixture(t);
  const landed = landDuringFinalFetch(f, '101', '1000', { visible: false });
  const result = await run(f, 'result');
  assert.ok(landed());
  assert.equal(result.ready, false);
  assert.equal(f.boundary('1000').state, 'gap');
  assert.equal(f.boundary('1000').detail, 'live Discord custody arrived while recovery readiness was closing');
  assert.equal(f.boundary('1000').gap_to, '101');
  assert.equal(f.state.getBinding('1000').readiness, 'gap');
  assert.equal(f.calls.filter(call => call.kind === 'history' && call.id === '1000').length, 2);
  assert.equal(f.state.getMessage('101').state, 'accepted');
});

test('history beyond the page bound still records gap', { timeout: 8000 }, async t => {
  const f = fixture(t);
  f.history.set('1000', Array.from({ length: 11 }, (_, index) => f.message(String(101 + index), '1000')));
  const result = await run(f, 'result');
  assert.equal(result.ready, false);
  assert.equal(f.boundary('1000').state, 'gap');
  assert.match(f.boundary('1000').detail, /history page bound 10 reached/);
  assert.equal(f.state.getBinding('1000').readiness, 'gap');
});
