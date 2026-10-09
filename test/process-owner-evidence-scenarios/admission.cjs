'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { runDirectPost } = require('../../src/direct-post');
const { fixture, multipartRecorder, response } = require('../direct-post-fixture');
const { fixture: nativeFixture, submitted } = require('../native-reply-file-fixture');

// ---------------------------------------------------------------------------
// Test 10: admitted-file network/manifest checks are unchanged
// ---------------------------------------------------------------------------

test('admitted-file cleanup still enforces sent-part and resolved-network-outcome checks', async t => {
  const native = nativeFixture(t);
  const nativeId = '970010';
  const source = path.join(native.dir, 'answer.bin');
  fs.writeFileSync(source, Buffer.from('native payload'));
  submitted(native, nativeId);
  const manifest = native.state.prepareNativeReplyFile({
    provider: 'codex', messageId: nativeId, nativeId: native.nativeId, generation: 1,
    stateDir: native.dir, sourcePath: source, caption: 'caption'
  });
  native.state.recordNativeReply({ provider: 'codex', messageId: nativeId, nativeId: native.nativeId, generation: 1, text: 'caption', fileManifest: manifest });
  native.state.beginReply(nativeId);
  native.state.markReplyFailure(nativeId, new Error('transport uncertain'), true, 0);
  native.state.reconcileReplyDelivery(nativeId, 'not_sent');
  assert.equal(native.state.nativeReplyFilePreparation(nativeId).phase, 'admitted');
  assert.throws(
    () => native.state.releaseNativeReplyFilePreparation(nativeId, manifest.preparationId),
    /native reply file cleanup requires a sent file part/
  );
  assert.deepEqual(fs.readFileSync(manifest.stagedPath), Buffer.from('native payload'));
  assert.equal(native.state.activeFilePreparationCount(), 1);
  native.state.beginReply(nativeId);
  native.state.markReplyPartSent(nativeId, 0, 'posted');
  const nativeReleased = native.state.releaseNativeReplyFilePreparation(nativeId, manifest.preparationId);
  assert.equal(nativeReleased.phase, 'released');
  assert.equal(fs.existsSync(manifest.stagedPath), false);
  assert.equal(native.state.activeFilePreparationCount(), 0);

  const direct = fixture(t);
  const captionFile = path.join(direct.dir, 'caption.txt');
  const sourceFile = path.join(direct.dir, 'source.bin');
  fs.writeFileSync(captionFile, 'direct caption');
  fs.writeFileSync(sourceFile, Buffer.from([7, 8, 9]));
  const recorder = multipartRecorder();
  const sent = await runDirectPost({
    state: direct.state, token: 'fixture', nativeId: direct.nativeId, generation: 1,
    textFile: captionFile, attachmentFile: sourceFile, dedupeKey: 'admitted-direct-success', fetchImpl: recorder.fetchImpl
  });
  assert.equal(sent.status, 'sent');
  const successful = direct.state.directPostFilePreparation('admitted-direct-success');
  assert.equal(successful.phase, 'admitted');
  const directReleased = direct.state.releaseDirectPostFilePreparation(successful.preparationId);
  assert.equal(directReleased.phase, 'released');
  assert.equal(fs.existsSync(successful.stagedPath), false);

  const unresolved = fixture(t);
  const unresolvedCaption = path.join(unresolved.dir, 'caption.txt');
  const unresolvedSource = path.join(unresolved.dir, 'source.bin');
  fs.writeFileSync(unresolvedCaption, 'unresolved caption');
  fs.writeFileSync(unresolvedSource, Buffer.from([1, 2, 3]));
  const unknown = await runDirectPost({
    state: unresolved.state, token: 'fixture', nativeId: unresolved.nativeId, generation: 1,
    textFile: unresolvedCaption, attachmentFile: unresolvedSource, dedupeKey: 'admitted-direct-unresolved',
    fetchImpl: async () => response('rejected', 500)
  });
  assert.equal(unknown.status, 'unknown');
  const unresolvedPreparation = unresolved.state.directPostFilePreparation('admitted-direct-unresolved');
  assert.equal(unresolvedPreparation.phase, 'admitted');
  assert.throws(
    () => unresolved.state.releaseDirectPostFilePreparation(unresolvedPreparation.preparationId),
    /direct post file cleanup requires a resolved network outcome/
  );
  assert.equal(fs.existsSync(unresolvedPreparation.stagedPath), true);
});

// ---------------------------------------------------------------------------
// Test 11: structural inventory
// ---------------------------------------------------------------------------

test('attempts retain a known producer PID when optional identity capture fails', async t => {
  const f = fixture(t);
  fs.writeFileSync(f.textFile, 'capture unavailable');
  f.state.directPostOwnerIdentity = () => null;
  const result = await runDirectPost({ state: f.state, token: 'fixture', nativeId: f.nativeId,
    generation: 1, textFile: f.textFile, dedupeKey: 'known-pid-without-identity',
    fetchImpl: async () => response('uncertain', 500) });
  assert.equal(result.status, 'unknown');
  const row = f.state.directPostRows('known-pid-without-identity').find(item => item.kind === 'direct-post-attempt');
  assert.ok(row);
  assert.equal(row.detail.ownerPid, process.pid);
});
