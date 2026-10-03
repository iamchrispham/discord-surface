const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { fixture, preparationSeed } = require('./direct-post-fixture');
const { fixture: nativeFixture, submitted } = require('./native-reply-file-fixture');

const PREPARATION_ID = '44444444-4444-4444-8444-444444444444';
const PARTIAL_BYTES = Buffer.from('held-owner-bytes');
const RECORDED_OWNER = { ownerPid: 424242, ownerStartTime: 'fixture-start', ownerCommand: 'fixture-command' };

function receiptCount(state) {
  return state.db.prepare('SELECT COUNT(*) AS count FROM receipts').get().count;
}

function preparationReceiptCount(state) {
  return state.db.prepare('SELECT COUNT(*) AS count FROM receipts WHERE kind=?').get('direct-post-file-preparation').count;
}

function prepareDirect(t) {
  const f = fixture(t);
  f.state.directPostOwnerIdentity = () => RECORDED_OWNER;
  const preparation = f.state.beginDirectPostFilePreparation(preparationSeed(f, PREPARATION_ID));
  fs.mkdirSync(path.dirname(preparation.stagedPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(`${preparation.stagedPath}.partial`, PARTIAL_BYTES, { mode: 0o600 });
  return {
    f,
    preparation,
    partialPath: `${preparation.stagedPath}.partial`,
    cleanup: () => f.state.releaseDirectPostFilePreparation(preparation.preparationId),
    lookup: () => f.state.directPostFilePreparation(preparation.requestId),
    preparationReceipts: () => preparationReceiptCount(f.state),
    latestPreparationReceipt: () => JSON.parse(f.state.db.prepare(
      'SELECT detail FROM receipts WHERE kind=? ORDER BY id DESC LIMIT 1'
    ).get('direct-post-file-preparation').detail)
  };
}

function prepareNative(t) {
  const f = nativeFixture(t);
  const messageId = '940001';
  submitted(f, messageId);
  const stagedPath = path.join(f.dir, '.direct-post-files', `${PREPARATION_ID}.bin`);
  fs.mkdirSync(path.dirname(stagedPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(`${stagedPath}.partial`, PARTIAL_BYTES, { mode: 0o600 });
  f.state.receipt(messageId, 'native-reply-file-preparation', {
    journal: 'native-reply-file-v1',
    phase: 'preparing',
    preparationId: PREPARATION_ID,
    stagedPath,
    ownerPid: 424242,
    ownerStartTime: 'fixture-start',
    ownerCommand: 'fixture-command'
  });
  return {
    f,
    messageId,
    stagedPath,
    partialPath: `${stagedPath}.partial`,
    cleanup: () => f.state.releaseNativeReplyFilePreparation(messageId, PREPARATION_ID),
    lookup: () => f.state.nativeReplyFilePreparation(messageId),
    preparationReceipts: () => f.state.db.prepare('SELECT COUNT(*) AS count FROM receipts WHERE kind=? AND discord_id=?')
      .get('native-reply-file-preparation', messageId).count,
    latestPreparationReceipt: () => JSON.parse(f.state.db.prepare(
      'SELECT detail FROM receipts WHERE kind=? AND discord_id=? ORDER BY id DESC LIMIT 1'
    ).get('native-reply-file-preparation', messageId).detail)
  };
}

function probeKill(code) {
  const calls = [];
  const original = process.kill;
  process.kill = (pid, signal) => {
    calls.push([pid, signal]);
    if (code) throw Object.assign(new Error('fixture probe'), { code });
    return true;
  };
  return { calls, restore: () => { process.kill = original; } };
}

function assertRetainedCustody(h, code) {
  const receiptsBefore = receiptCount(h.f.state);
  const preparationReceiptsBefore = h.preparationReceipts();
  const activeBefore = h.f.state.activeFilePreparationCount();
  const probe = probeKill(code);
  try {
    assert.throws(() => h.cleanup());
  } finally {
    probe.restore();
    assert.deepEqual(probe.calls, [[424242, 0]]);
  }
  assert.equal(h.lookup().phase, 'preparing');
  assert.deepEqual(fs.readFileSync(h.partialPath), PARTIAL_BYTES);
  assert.equal(receiptCount(h.f.state), receiptsBefore);
  assert.equal(h.preparationReceipts(), preparationReceiptsBefore);
  assert.equal(h.f.state.activeFilePreparationCount(), activeBefore);
}

function assertReleasedCustody(h, code) {
  const receiptsBefore = receiptCount(h.f.state);
  const preparationReceiptsBefore = h.preparationReceipts();
  const activeBefore = h.f.state.activeFilePreparationCount();
  const probe = probeKill(code);
  let released;
  try {
    released = h.cleanup();
  } finally {
    probe.restore();
    assert.deepEqual(probe.calls, [[424242, 0]]);
  }
  assert.equal(released.phase, 'released');
  assert.equal(h.lookup().phase, 'released');
  assert.equal(h.latestPreparationReceipt().phase, 'released');
  assert.equal(h.preparationReceipts(), preparationReceiptsBefore + 1);
  assert.equal(fs.existsSync(h.partialPath), false);
  assert.equal(receiptCount(h.f.state), receiptsBefore + 1);
  assert.equal(activeBefore - h.f.state.activeFilePreparationCount(), 1);
}

test('direct preparing cleanup retains custody when probe is denied (EPERM)', t => {
  assertRetainedCustody(prepareDirect(t), 'EPERM');
});

test('native preparing cleanup retains custody when probe is denied (EPERM)', t => {
  assertRetainedCustody(prepareNative(t), 'EPERM');
});

test('direct preparing cleanup retains custody on unexpected probe error (EIO)', t => {
  assertRetainedCustody(prepareDirect(t), 'EIO');
});

test('native preparing cleanup retains custody on unexpected probe error (EIO)', t => {
  assertRetainedCustody(prepareNative(t), 'EIO');
});

test('direct preparing cleanup retains custody when identity capture is unreadable', t => {
  const h = prepareDirect(t);
  h.f.state.directPostOwnerIdentity = () => null;
  assertRetainedCustody(h, null);
});

test('native preparing cleanup retains custody when identity capture is unreadable', t => {
  const h = prepareNative(t);
  h.f.state.directPostOwnerIdentity = () => null;
  assertRetainedCustody(h, null);
});

test('direct preparing cleanup releases custody after confirmed absence (ESRCH)', t => {
  assertReleasedCustody(prepareDirect(t), 'ESRCH');
});

test('native preparing cleanup releases custody after confirmed absence (ESRCH)', t => {
  assertReleasedCustody(prepareNative(t), 'ESRCH');
});

test('direct preparing cleanup retains custody for a matching live owner', t => {
  const h = prepareDirect(t);
  h.f.state.directPostOwnerIdentity = () => RECORDED_OWNER;
  assertRetainedCustody(h, null);
});

test('native preparing cleanup retains custody for a matching live owner', t => {
  const h = prepareNative(t);
  h.f.state.directPostOwnerIdentity = () => RECORDED_OWNER;
  assertRetainedCustody(h, null);
  const script = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).scripts.test;
  const registered = script.split(/\s+/).filter(token => token === 'test/owner-probe-custody.test.js');
  assert.equal(registered.length, 1);
});
