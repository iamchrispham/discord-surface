const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { SurfaceState, READINESS, DIRECT_POST_OUTCOMES: stateOutcomes } = require('../src/state');
const { main } = require('../src/cli');
const { runDirectPost } = require('../src/direct-post');
const { AGENT_PRESENTATIONS } = require('../src/agent-presentation');
const { fixture, response, multipartRecorder, preparationSeed, CODEX } = require('./direct-post-fixture');

test('ordinary file post owns an immutable snapshot and explicit resume after source removal', async t => {
  const f = fixture(t);
  const captionFile = path.join(f.dir, 'caption.txt');
  const sourceFile = path.join(f.dir, 'source.bin');
  const bytes = Buffer.from([0, 1, 2, 3, 255]);
  fs.writeFileSync(captionFile, 'attach this exact file');
  fs.writeFileSync(sourceFile, bytes);
  const recorder = multipartRecorder();
  const first = await runDirectPost({ state: f.state, token: 'fixture', nativeId: f.nativeId, generation: 1,
    textFile: captionFile, attachmentFile: sourceFile, dedupeKey: 'file-key', fetchImpl: recorder.fetchImpl });
  assert.equal(first.status, 'sent');
  assert.match(first.filePreparationId, /^[0-9a-f-]{16,80}$/i);
  assert.equal(recorder.calls.length, 1);
  assert.deepEqual(recorder.calls[0].find(([name]) => name === 'files[0]')[1].bytes, bytes);
  const preparation = f.state.directPostFilePreparation('file-key');
  assert.equal(preparation.phase, 'admitted');
  assert.equal(preparation.size, bytes.length);
  fs.writeFileSync(sourceFile, Buffer.from([9, 8, 7, 6, 5]));
  await assert.rejects(() => runDirectPost({ state: f.state, token: 'fixture', nativeId: f.nativeId, generation: 1,
    textFile: captionFile, attachmentFile: sourceFile, dedupeKey: 'file-key', fetchImpl: recorder.fetchImpl }), /identity conflicts/);
  assert.equal(recorder.calls.length, 1);
  fs.unlinkSync(sourceFile);
  const resumed = await runDirectPost({ state: f.state, token: 'fixture', nativeId: f.nativeId, generation: 1,
    resume: true, dedupeKey: 'file-key', fetchImpl: recorder.fetchImpl });
  assert.equal(resumed.duplicate, true);
  assert.equal(recorder.calls.length, 1);
  const released = f.state.releaseDirectPostFilePreparation(preparation.preparationId);
  assert.equal(released.phase, 'released');
  assert.equal(fs.existsSync(preparation.stagedPath), false);
});

test('ordinary file post accepts an empty regular file', async t => {
  const f = fixture(t);
  const captionFile = path.join(f.dir, 'caption.txt');
  const sourceFile = path.join(f.dir, 'empty.bin');
  fs.writeFileSync(captionFile, 'empty payload');
  fs.writeFileSync(sourceFile, Buffer.alloc(0));
  const recorder = multipartRecorder();
  const result = await runDirectPost({ state: f.state, token: 'fixture', nativeId: f.nativeId, generation: 1,
    textFile: captionFile, attachmentFile: sourceFile, dedupeKey: 'empty-file', fetchImpl: recorder.fetchImpl });
  assert.equal(result.status, 'sent');
  assert.deepEqual(recorder.calls[0].find(([name]) => name === 'files[0]')[1].bytes, Buffer.alloc(0));
});

test('unknown file outcome retains custody and refuses cleanup until resolved', async t => {
  const f = fixture(t);
  const captionFile = path.join(f.dir, 'caption.txt');
  const sourceFile = path.join(f.dir, 'source.bin');
  fs.writeFileSync(captionFile, 'uncertain file');
  fs.writeFileSync(sourceFile, Buffer.from([7, 8, 9]));
  const result = await runDirectPost({ state: f.state, token: 'fixture', nativeId: f.nativeId, generation: 1,
    textFile: captionFile, attachmentFile: sourceFile, dedupeKey: 'unknown-file',
    fetchImpl: async () => response('rejected', 500) });
  assert.equal(result.status, 'unknown');
  const preparation = f.state.directPostFilePreparation('unknown-file');
  assert.throws(() => f.state.releaseDirectPostFilePreparation(preparation.preparationId), /resolved network outcome/);
  assert.equal(preparation.phase, 'admitted');
  assert.equal(fs.existsSync(preparation.stagedPath), true);
});

test('preparing cleanup refuses a live owner and releases a pre-stage crash after owner death', async t => {
  const f = fixture(t);
  const live = f.state.beginDirectPostFilePreparation(preparationSeed(f, '11111111-1111-4111-8111-111111111111'));
  fs.mkdirSync(path.dirname(live.stagedPath), { recursive: true, mode: 0o700 });
  const partialBytes = Buffer.from('live staging bytes');
  fs.writeFileSync(`${live.stagedPath}.partial`, partialBytes, { mode: 0o600 });
  assert.throws(() => f.state.releaseDirectPostFilePreparation(live.preparationId), /owner is still active/);
  assert.equal(f.state.directPostFilePreparation(live.requestId).phase, 'preparing');
  assert.deepEqual(fs.readFileSync(`${live.stagedPath}.partial`), partialBytes);
  const dead = f.state.beginDirectPostFilePreparation(preparationSeed(f, '22222222-2222-4222-8222-222222222222', {
    requestId: 'dead-pre-stage', ownerPid: 999999, ownerStartTime: null, ownerCommand: null
  }));
  const released = f.state.releaseDirectPostFilePreparation(dead.preparationId);
  assert.equal(released.phase, 'released');
  assert.equal(f.state.directPostFilePreparation(dead.requestId).phase, 'released');
});

test('resume restores the recorded reply reference and refuses owner, destination, and reference overrides', async t => {
  const f = fixture(t);
  const captionFile = path.join(f.dir, 'caption.txt');
  const sourceFile = path.join(f.dir, 'source.bin');
  fs.writeFileSync(captionFile, 'authority caption');
  fs.writeFileSync(sourceFile, Buffer.from([4, 5, 6]));
  const stopped = new AbortController();
  stopped.abort();
  await runDirectPost({ state: f.state, token: 'fixture', nativeId: f.nativeId, generation: 1,
    textFile: captionFile, attachmentFile: sourceFile, dedupeKey: 'authority-key', inReplyTo: 'recorded-ref',
    signal: stopped.signal, fetchImpl: multipartRecorder().fetchImpl });
  const recorder = multipartRecorder();
  const resumed = await runDirectPost({ state: f.state, token: 'fixture', nativeId: f.nativeId, generation: 1,
    resume: true, dedupeKey: 'authority-key', fetchImpl: recorder.fetchImpl });
  assert.equal(resumed.inReplyTo, 'recorded-ref');
  const payload = JSON.parse(recorder.calls[0].find(([name]) => name === 'payload_json')[1]);
  assert.equal(payload.message_reference.message_id, 'recorded-ref');
  const duplicate = await runDirectPost({ state: f.state, token: 'fixture', nativeId: f.nativeId, generation: 1,
    textFile: captionFile, attachmentFile: sourceFile, dedupeKey: 'authority-key', inReplyTo: 'recorded-ref', fetchImpl: recorder.fetchImpl });
  assert.equal(duplicate.duplicate, true);
  assert.equal(recorder.calls.length, 1);

  const before = new AbortController();
  before.abort();
  await runDirectPost({ state: f.state, token: 'fixture', nativeId: f.nativeId, generation: 1,
    textFile: captionFile, attachmentFile: sourceFile, dedupeKey: 'authority-before', inReplyTo: 'stored-ref',
    signal: before.signal, fetchImpl: recorder.fetchImpl });
  await assert.rejects(runDirectPost({ state: f.state, token: 'fixture', nativeId: f.nativeId, generation: 1,
    resume: true, dedupeKey: 'authority-before', inReplyTo: 'replacement-ref', fetchImpl: recorder.fetchImpl }), /replacement reply reference/);
  const otherNative = '7b7b7b7b-7b7b-4b7b-8b7b-7b7b7b7b7b7b';
  f.state.bind({ channelId: 'other-channel', guildId: 'guild', provider: 'codex', nativeId: otherNative, workspace: f.dir,
    conductorId: 'other-conductor', repoKey: 'repo:other' }, { intakeCutoff: '100' });
  await assert.rejects(runDirectPost({ state: f.state, token: 'fixture', nativeId: otherNative, generation: 1,
    channelId: 'other-channel', resume: true, dedupeKey: 'authority-before', fetchImpl: recorder.fetchImpl }), /immutable channelId/);
  assert.equal(recorder.calls.length, 1);
});

test('CLI resume refuses a supplied replacement caption instead of dropping it', async t => {
  const f = fixture(t);
  const captionFile = path.join(f.dir, 'caption.txt');
  const sourceFile = path.join(f.dir, 'source.bin');
  fs.writeFileSync(captionFile, 'original caption');
  fs.writeFileSync(sourceFile, Buffer.from([3, 2, 1]));
  const stopped = new AbortController();
  stopped.abort();
  await runDirectPost({ state: f.state, token: 'fixture', nativeId: f.nativeId, generation: 1,
    textFile: captionFile, attachmentFile: sourceFile, dedupeKey: 'cli-resume-conflict', signal: stopped.signal,
    fetchImpl: multipartRecorder().fetchImpl });
  const originalArgv = process.argv;
  const recorder = multipartRecorder();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = recorder.fetchImpl;
  process.argv = ['node', 'src/cli.js', 'post', '--state-dir', f.dir, '--db', path.join(f.dir, 'surface.sqlite'),
    '--native-id', f.nativeId, '--generation', '1', '--resume', '--dedupe-key', 'cli-resume-conflict', '--text-file', captionFile];
  try {
    await assert.rejects(main(), /replacement files/);
  } finally {
    globalThis.fetch = originalFetch;
    process.argv = originalArgv;
  }
  assert.equal(recorder.calls.length, 0);
});

test('missing admitted snapshot is known not-sent before HTTP and does not fabricate unknown', async t => {
  const f = fixture(t);
  const captionFile = path.join(f.dir, 'caption.txt');
  const sourceFile = path.join(f.dir, 'source.bin');
  fs.writeFileSync(captionFile, 'missing snapshot');
  fs.writeFileSync(sourceFile, Buffer.from([1, 2, 3]));
  const stopped = new AbortController();
  stopped.abort();
  await runDirectPost({ state: f.state, token: 'fixture', nativeId: f.nativeId, generation: 1,
    textFile: captionFile, attachmentFile: sourceFile, dedupeKey: 'missing-snapshot', signal: stopped.signal,
    fetchImpl: multipartRecorder().fetchImpl });
  const preparation = f.state.directPostFilePreparation('missing-snapshot');
  fs.unlinkSync(preparation.stagedPath);
  const recorder = multipartRecorder();
  const result = await runDirectPost({ state: f.state, token: 'fixture', nativeId: f.nativeId, generation: 1,
    resume: true, dedupeKey: 'missing-snapshot', fetchImpl: recorder.fetchImpl });
  assert.equal(result.status, 'not_sent');
  assert.equal(recorder.calls.length, 0);
  assert.equal(f.state.directPostRows('missing-snapshot').find(row => row.kind === 'direct-post-outcome').detail.outcome, 'not_sent');
});

test('cleanup retry after durable delete releases exactly once and claim cannot send after release', async t => {
  const f = fixture(t);
  const captionFile = path.join(f.dir, 'caption.txt');
  const sourceFile = path.join(f.dir, 'source.bin');
  fs.writeFileSync(captionFile, 'cleanup retry');
  fs.writeFileSync(sourceFile, Buffer.from([8, 9]));
  const stopped = new AbortController();
  stopped.abort();
  await runDirectPost({ state: f.state, token: 'fixture', nativeId: f.nativeId, generation: 1,
    textFile: captionFile, attachmentFile: sourceFile, dedupeKey: 'cleanup-retry', signal: stopped.signal,
    fetchImpl: multipartRecorder().fetchImpl });
  const preparation = f.state.directPostFilePreparation('cleanup-retry');
  fs.unlinkSync(preparation.stagedPath);
  const released = f.state.releaseDirectPostFilePreparation(preparation.preparationId);
  assert.equal(released.phase, 'released');
  const repeated = f.state.releaseDirectPostFilePreparation(preparation.preparationId);
  assert.equal(repeated.phase, 'released');
  const binding = f.state.getBinding('channel');
  assert.throws(() => f.state.beginDirectPostPart({
    requestId: 'cleanup-retry', inReplyTo: null, attemptId: 'late-attempt', sourcePath: preparation.sourcePath,
    textHash: preparation.captionHash, operatorId: 'operator', partHash: preparation.captionHash,
    channelId: 'channel', guildId: 'guild', provider: 'codex', nativeId: f.nativeId, generation: 1,
    conductorId: 'conductor', repoKey: 'repo:fixture', partIndex: 0, partCount: 1, nonce: 'late-nonce', binding,
    presentation: AGENT_PRESENTATIONS.LEGACY, caption: preparation.caption, fileManifest: preparation
  }), /no longer admitted/);
  const recorder = multipartRecorder();
  await assert.rejects(runDirectPost({ state: f.state, token: 'fixture', nativeId: f.nativeId, generation: 1,
    resume: true, dedupeKey: 'cleanup-retry', fetchImpl: recorder.fetchImpl }), /admitted/);
  assert.equal(recorder.calls.length, 0);
});

test('split state and database roots use the recorded custody root for cleanup', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'direct-post-split-roots-'));
  const stateRoot = path.join(dir, 'custody');
  const dbRoot = path.join(dir, 'database');
  fs.mkdirSync(dbRoot, { recursive: true });
  const state = new SurfaceState(path.join(dbRoot, 'surface.sqlite'));
  state.setConfig({ operatorId: 'operator', guildId: 'guild', secretFile: path.join(dir, 'discord.env') });
  fs.writeFileSync(path.join(dir, 'discord.env'), 'DISCORD_TOKEN=fixture-token\n', { mode: 0o600 });
  state.bind({ channelId: 'channel', guildId: 'guild', provider: 'codex', nativeId: CODEX, workspace: dir,
    conductorId: 'conductor', repoKey: 'repo:fixture' }, { intakeCutoff: '100' });
  const captionFile = path.join(dir, 'caption.txt');
  const sourceFile = path.join(dir, 'source.bin');
  fs.writeFileSync(captionFile, 'split roots');
  fs.writeFileSync(sourceFile, Buffer.from([1, 4, 9]));
  t.after(() => { state.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const stopped = new AbortController();
  stopped.abort();
  await runDirectPost({ state, token: 'fixture', nativeId: CODEX, generation: 1, textFile: captionFile,
    attachmentFile: sourceFile, dedupeKey: 'split-roots', stateDir: stateRoot, signal: stopped.signal,
    fetchImpl: multipartRecorder().fetchImpl });
  const preparation = state.directPostFilePreparation('split-roots');
  assert.equal(preparation.custodyRoot, stateRoot);
  assert.match(preparation.stagedPath, new RegExp(`^${stateRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  const released = state.releaseDirectPostFilePreparation(preparation.preparationId);
  assert.equal(released.phase, 'released');
  assert.equal(fs.existsSync(preparation.stagedPath), false);
});

test('mixed unknown and sent custody preserves bytes and recovers one slot exactly once', async t => {
  const f = fixture(t);
  const unknownCaption = path.join(f.dir, 'capacity-unknown.txt');
  const unknownSource = path.join(f.dir, 'capacity-unknown.bin');
  const sentCaption = path.join(f.dir, 'capacity-sent.txt');
  const sentSource = path.join(f.dir, 'capacity-sent.bin');
  fs.writeFileSync(unknownCaption, 'capacity unknown');
  fs.writeFileSync(unknownSource, Buffer.from([1, 2, 3, 4]));
  fs.writeFileSync(sentCaption, 'capacity sent');
  fs.writeFileSync(sentSource, Buffer.from([5, 6, 7, 8]));
  const unknownResult = await runDirectPost({ state: f.state, token: 'fixture', nativeId: f.nativeId, generation: 1,
    textFile: unknownCaption, attachmentFile: unknownSource, dedupeKey: 'capacity-unknown',
    fetchImpl: async () => response('capacity-unknown', 500) });
  assert.equal(unknownResult.status, 'unknown');
  const unknownPreparation = f.state.directPostFilePreparation('capacity-unknown');
  const unknownBytes = fs.readFileSync(unknownPreparation.stagedPath);
  const sentRecorder = multipartRecorder();
  const sentResult = await runDirectPost({ state: f.state, token: 'fixture', nativeId: f.nativeId, generation: 1,
    textFile: sentCaption, attachmentFile: sentSource, dedupeKey: 'capacity-sent', fetchImpl: sentRecorder.fetchImpl });
  assert.equal(sentResult.status, 'sent');
  const sentPreparation = f.state.directPostFilePreparation('capacity-sent');
  const held = [unknownPreparation, sentPreparation];
  for (let index = 0; index < 6; index += 1) {
    const preparationId = crypto.randomUUID();
    held.push(f.state.beginDirectPostFilePreparation(preparationSeed(f, preparationId, {
      requestId: `capacity-preparing-${index}`, ownerPid: 999999, ownerStartTime: null, ownerCommand: null
    })));
  }
  assert.equal(held.length, 8);
  assert.throws(() => f.state.releaseDirectPostFilePreparation(unknownPreparation.preparationId), /resolved network outcome/);
  assert.deepEqual(fs.readFileSync(unknownPreparation.stagedPath), unknownBytes);
  fs.unlinkSync(sentPreparation.stagedPath);
  assert.equal(f.state.releaseDirectPostFilePreparation(sentPreparation.preparationId).phase, 'released');
  assert.equal(f.state.releaseDirectPostFilePreparation(sentPreparation.preparationId).phase, 'released');
  const firstRecovery = f.state.beginDirectPostFilePreparation(preparationSeed(f, crypto.randomUUID(), {
    requestId: 'capacity-recovery-1', ownerPid: 999999, ownerStartTime: null, ownerCommand: null
  }));
  assert.equal(firstRecovery.phase, 'preparing');
  assert.throws(() => f.state.beginDirectPostFilePreparation(preparationSeed(f, crypto.randomUUID(), {
    requestId: 'capacity-recovery-2', ownerPid: 999999, ownerStartTime: null, ownerCommand: null
  })), error => {
    assert.match(error.message, /capacity is exhausted/);
    assert.match(error.message, /capacity-unknown/);
    assert.match(error.message, /unknown/);
    assert.match(error.message, /capacity-recovery-1/);
    return true;
  });
  assert.deepEqual(fs.readFileSync(unknownPreparation.stagedPath), unknownBytes);
});

test('released file request keys refuse before allocating a replacement reservation', async t => {
  const f = fixture(t);
  const captionFile = path.join(f.dir, 'released-caption.txt');
  const sourceFile = path.join(f.dir, 'released-source.bin');
  fs.writeFileSync(captionFile, 'released key');
  fs.writeFileSync(sourceFile, Buffer.from([2, 4, 6]));
  const stopped = new AbortController();
  stopped.abort();
  await runDirectPost({ state: f.state, token: 'fixture', nativeId: f.nativeId, generation: 1,
    textFile: captionFile, attachmentFile: sourceFile, dedupeKey: 'released-key', signal: stopped.signal,
    fetchImpl: multipartRecorder().fetchImpl });
  const preparation = f.state.directPostFilePreparation('released-key');
  assert.equal(f.state.releaseDirectPostFilePreparation(preparation.preparationId).phase, 'released');
  await assert.rejects(() => runDirectPost({ state: f.state, token: 'fixture', nativeId: f.nativeId, generation: 1,
    textFile: captionFile, attachmentFile: sourceFile, dedupeKey: 'released-key', fetchImpl: multipartRecorder().fetchImpl }), /already released/);
  assert.equal(f.state.directPostFilePreparation('released-key').phase, 'released');
});
