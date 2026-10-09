'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { fixture, preparationSeed } = require('../direct-post-fixture');
const { fixture: nativeFixture, submitted } = require('../native-reply-file-fixture');
const { fixture: boardFixture, seedBoardAttempt, BOARD_OUTCOMES } = require('../board-refresh-fixture');
const { FAKE_PID, mockProcessKill, probeError, receiptIds } = require('./fixtures.cjs');

// ---------------------------------------------------------------------------
// Test 7: PREPARING retention and ESRCH release
// ---------------------------------------------------------------------------

test('direct and native preparing cleanup retain bytes on indeterminate evidence and release on ESRCH', t => {
  const direct = fixture(t);
  const directSeed = preparationSeed(direct, '44444444-4444-4444-8444-444444444444', {
    ownerPid: FAKE_PID,
    ownerStartTime: null,
    ownerCommand: null
  });
  const directPreparation = direct.state.beginDirectPostFilePreparation(directSeed);
  const directPartial = `${directPreparation.stagedPath}.partial`;
  fs.mkdirSync(path.dirname(directPartial), { recursive: true, mode: 0o700 });
  fs.writeFileSync(directPartial, Buffer.from('direct held bytes'), { mode: 0o600 });

  const directBefore = receiptIds(direct.state).length;
  const directActiveBefore = direct.state.activeFilePreparationCount();
  const allowProbe = mockProcessKill(null);
  try {
    assert.throws(
      () => direct.state.releaseDirectPostFilePreparation(directPreparation.preparationId),
      /direct post file preparation owner is still active/
    );
  } finally {
    allowProbe.restore();
    assert.deepEqual(allowProbe.calls, [[FAKE_PID, 0]]);
  }
  assert.equal(direct.state.directPostFilePreparation(directPreparation.requestId).phase, 'preparing');
  assert.deepEqual(fs.readFileSync(directPartial), Buffer.from('direct held bytes'));
  assert.equal(receiptIds(direct.state).length, directBefore);
  assert.equal(direct.state.activeFilePreparationCount(), directActiveBefore);

  const esrchProbe = mockProcessKill('ESRCH');
  let directReleased;
  try {
    directReleased = direct.state.releaseDirectPostFilePreparation(directPreparation.preparationId);
  } finally {
    esrchProbe.restore();
    assert.deepEqual(esrchProbe.calls, [[FAKE_PID, 0]]);
  }
  assert.equal(directReleased.phase, 'released');
  assert.equal(direct.state.directPostFilePreparation(directPreparation.requestId).phase, 'released');
  assert.equal(fs.existsSync(directPartial), false);
  assert.equal(receiptIds(direct.state).length, directBefore + 1);
  assert.equal(directActiveBefore - direct.state.activeFilePreparationCount(), 1);

  const native = nativeFixture(t);
  const messageId = '970001';
  const preparationId = '44444444-4444-4444-8444-444444444444';
  submitted(native, messageId);
  const stagedPath = path.join(native.dir, '.direct-post-files', `${preparationId}.bin`);
  fs.mkdirSync(path.dirname(stagedPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(`${stagedPath}.partial`, Buffer.from('native held bytes'), { mode: 0o600 });
  native.state.receipt(messageId, 'native-reply-file-preparation', {
    journal: 'native-reply-file-v1',
    phase: 'preparing',
    preparationId,
    stagedPath,
    ownerPid: FAKE_PID,
    ownerStartTime: null,
    ownerCommand: null
  });

  const nativeBefore = receiptIds(native.state).length;
  const nativeActiveBefore = native.state.activeFilePreparationCount();
  const nativeAllow = mockProcessKill(null);
  try {
    assert.throws(
      () => native.state.releaseNativeReplyFilePreparation(messageId, preparationId),
      /native reply file preparation owner is still active/
    );
  } finally {
    nativeAllow.restore();
    assert.deepEqual(nativeAllow.calls, [[FAKE_PID, 0]]);
  }
  assert.equal(native.state.nativeReplyFilePreparation(messageId).phase, 'preparing');
  assert.deepEqual(fs.readFileSync(`${stagedPath}.partial`), Buffer.from('native held bytes'));
  assert.equal(receiptIds(native.state).length, nativeBefore);
  assert.equal(native.state.activeFilePreparationCount(), nativeActiveBefore);

  const nativeEsrch = mockProcessKill('ESRCH');
  let nativeReleased;
  try {
    nativeReleased = native.state.releaseNativeReplyFilePreparation(messageId, preparationId);
  } finally {
    nativeEsrch.restore();
    assert.deepEqual(nativeEsrch.calls, [[FAKE_PID, 0]]);
  }
  assert.equal(nativeReleased.phase, 'released');
  assert.equal(native.state.nativeReplyFilePreparation(messageId).phase, 'released');
  assert.equal(fs.existsSync(`${stagedPath}.partial`), false);
  assert.equal(receiptIds(native.state).length, nativeBefore + 1);
  assert.equal(nativeActiveBefore - native.state.activeFilePreparationCount(), 1);
});

// ---------------------------------------------------------------------------
// Test 8: dynamic probe and capture are read at call time
// ---------------------------------------------------------------------------

test('directPostOwnerEvidence reads the current capture method and probe at call time', t => {
  const f = fixture(t);
  const originalIdentity = f.state.directPostOwnerIdentity;
  const originalKill = process.kill;
  let mode = 'ok';
  const calls = [];
  process.kill = (pid, signal) => {
    calls.push([pid, signal]);
    if (mode !== 'ok') throw probeError(mode);
    return true;
  };
  try {
    f.state.directPostOwnerIdentity = () => ({ ownerStartTime: 'A', ownerCommand: 'command' });
    assert.deepEqual(
      f.state.directPostOwnerEvidence(FAKE_PID, { ownerStartTime: 'A', ownerCommand: 'command' }),
      { status: 'matching-live', reason: 'identity-match' }
    );

    f.state.directPostOwnerIdentity = () => ({ ownerStartTime: 'B', ownerCommand: 'command' });
    assert.deepEqual(
      f.state.directPostOwnerEvidence(FAKE_PID, { ownerStartTime: 'A', ownerCommand: 'command' }),
      { status: 'absent', reason: 'identity-mismatch' }
    );

    mode = 'ESRCH';
    assert.deepEqual(
      f.state.directPostOwnerEvidence(FAKE_PID, null),
      { status: 'absent', reason: 'probe-absent' }
    );
    assert.deepEqual(calls, [[FAKE_PID, 0], [FAKE_PID, 0], [FAKE_PID, 0]], 'probe must be read dynamically each call');
  } finally {
    process.kill = originalKill;
    f.state.directPostOwnerIdentity = originalIdentity;
  }
});

// ---------------------------------------------------------------------------
// Test 9: callback errors, defaults and missing evidence method
// ---------------------------------------------------------------------------

test('recovery propagates callback errors and defaults missing owner evidence to indeterminate', t => {
  const direct = fixture(t);
  direct.state.receipt(null, 'direct-post-attempt', {
    journal: 'direct-post-v1',
    requestId: 'callback-error',
    attemptId: 'callback-error',
    ownerPid: FAKE_PID,
    status: 'attempted'
  });
  const beforeThrow = receiptIds(direct.state);
  assert.throws(
    () => direct.state.recoverDirectPostReceipts(() => { throw new Error('owner callback exploded'); }),
    /owner callback exploded/
  );
  assert.deepEqual(receiptIds(direct.state), beforeThrow, 'thrown callback must not settle');

  const omitted = fixture(t);
  omitted.state.receipt(null, 'direct-post-attempt', {
    journal: 'direct-post-v1',
    requestId: 'omitted-default',
    attemptId: 'omitted-default'
  });
  const beforeOmitted = receiptIds(omitted.state);
  assert.equal(omitted.state.recoverDirectPostReceipts(undefined), 0, 'missing pid defaults to hold');
  assert.deepEqual(receiptIds(omitted.state), beforeOmitted);

  const board = boardFixture();
  try {
    const seeded = seedBoardAttempt(board, 'default-owner-hold');
    const beforeBoard = receiptIds(board.state);
    assert.equal(board.state.recoverBoardRefreshAttempt(seeded.target, seeded.attemptId), 0, 'default board callback must hold without owner evidence');
    assert.deepEqual(receiptIds(board.state), beforeBoard);
    assert.equal(board.state.inspectBoardRequest('default-owner-hold', seeded.target).status, BOARD_OUTCOMES.IN_FLIGHT);
  } finally {
    board.state.close();
    fs.rmSync(board.dir, { recursive: true, force: true });
  }

  const bare = fixture(t);
  const messageId = '970029';
  bare.state.acceptDiscordMessage({ id: messageId, guildId: 'guild', channelId: 'channel', authorId: 'operator', isBot: false, content: 'question' });
  bare.state.receipt(messageId, 'transport-receipt-attempt', {
    transport: 'interaction-callback',
    nonce: 'missing-method',
    ownerPid: FAKE_PID,
    ownerIdentity: { ownerStartTime: 'fixture-start' },
    status: 'attempted'
  });
  const originalEvidence = bare.state.directPostOwnerEvidence;
  bare.state.directPostOwnerEvidence = undefined;
  const beforeBare = receiptIds(bare.state);
  try {
    assert.equal(bare.state.recoverInteractionCallbacksInTransaction(null), 0, 'missing evidence method must hold, never prove absence');
    assert.deepEqual(receiptIds(bare.state), beforeBare);
    assert.equal(
      bare.state.listReceipts().some(row => row.discord_id === messageId && row.kind === 'transport-receipt-outcome'),
      false
    );
  } finally {
    bare.state.directPostOwnerEvidence = originalEvidence;
  }
});
