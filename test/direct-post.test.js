const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { SurfaceState, READINESS, DIRECT_POST_OUTCOMES: stateOutcomes } = require('../src/state');
const { THREAD_STATES } = require('../src/state/thread-enrollment');
const { main } = require('../src/cli');
const { createSurfaceConsumer } = require('../src/discord');
const { runDirectPost } = require('../src/direct-post');
const { decodeAgentMessage, encodeAgentMessage, issueAgentAddress, KINDS } = require('../src/agent-message');
const { AGENT_ATTACHMENT_CONTENT_TYPE, AGENT_ATTACHMENT_FILENAME } = require('../src/agent-attachment');
const { AGENT_PRESENTATIONS } = require('../src/agent-presentation');
const { createDirectPostHandlers, DIRECT_POST_OUTCOMES } = require('../src/state/direct-post');

const CODEX = '9caa5d21-2169-429d-918b-5f08651b5dbd';
const CLAUDE = '79e3da8e-94b4-4aff-8f88-b45b3a451dd1';

function fixture(t, provider = 'codex') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'direct-post-'));
  const state = new SurfaceState(path.join(dir, 'surface.sqlite'));
  state.setConfig({ operatorId: 'operator', guildId: 'guild', secretFile: path.join(dir, 'discord.env') });
  fs.writeFileSync(path.join(dir, 'discord.env'), 'DISCORD_TOKEN=fixture-token\n', { mode: 0o600 });
  const nativeId = provider === 'claude' ? CLAUDE : CODEX;
  state.bind({ channelId: 'channel', guildId: 'guild', provider, nativeId, workspace: dir,
    endpoint: provider === 'claude' ? '/tmp/claude-channel.sock' : undefined, conductorId: 'conductor', repoKey: 'repo:fixture' });
  const textFile = path.join(dir, 'milestone.txt');
  t.after(() => { state.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, state, nativeId, textFile };
}

function agentFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-direct-post-'));
  const state = new SurfaceState(path.join(dir, 'surface.sqlite'));
  state.setConfig({ operatorId: '900', guildId: '100', secretFile: path.join(dir, 'discord.env') });
  fs.writeFileSync(path.join(dir, 'discord.env'), 'DISCORD_TOKEN=fixture\n', { mode: 0o600 });
  state.bind({ channelId: '101', guildId: '100', provider: 'codex', nativeId: CODEX, workspace: dir,
    conductorId: 'conductor', repoKey: 'repo:fixture' });
  let binding = state.getBinding('101');
  binding = state.setBindingReadiness('101', READINESS.READY, 'agent fixture ready', binding);
  state.enrollThread({ threadId: '103', parentChannelId: '101', guildId: '100' }, binding);
  state.setThreadBaseline('103', '0', binding);
  state.markThreadBoundary('103', THREAD_STATES.READY, 'agent fixture child ready', null, null, binding);
  const textFile = path.join(dir, 'milestone.txt');
  t.after(() => { state.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, state, nativeId: CODEX, agentThreadId: '103', textFile };
}

function response(id, status = 200) {
  return { ok: status >= 200 && status < 300, status, body: { cancel() {} }, json: async () => ({ id }) };
}

function fetchRecorder({ responses = [], pending = false } = {}) {
  const calls = [];
  let release;
  const fetchImpl = async (_url, options) => {
    calls.push({ body: JSON.parse(options.body), signal: options.signal });
    if (pending) return new Promise((resolve, reject) => {
      release = () => resolve(response(`direct-${calls.length}`));
      options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
    });
    return responses[calls.length - 1] || response(`direct-${calls.length}`);
  };
  return { calls, fetchImpl, release: () => release?.() };
}

function multipartRecorder() {
  const calls = [];
  const fetchImpl = async (_url, options) => {
    const parts = [];
    for await (const [name, value] of options.body.entries()) {
      parts.push([name, typeof value === 'string' ? value : {
        filename: value.name,
        bytes: Buffer.from(await value.arrayBuffer())
      }]);
    }
    calls.push(parts);
    return response(`file-${calls.length}`);
  };
  return { calls, fetchImpl };
}

function preparationSeed(f, preparationId, overrides = {}) {
  const owner = f.state.directPostOwnerIdentity(process.pid);
  return {
    preparationId,
    requestId: `request-${preparationId}`,
    custodyRoot: f.dir,
    sourcePath: path.join(f.dir, `${preparationId}.bin`),
    stagedPath: path.join(f.dir, '.direct-post-files', `${preparationId}.bin`),
    filename: `${preparationId}.bin`,
    size: 0,
    caption: 'held file',
    captionHash: 'caption-hash',
    channelId: 'channel',
    guildId: 'guild',
    provider: 'codex',
    nativeId: f.nativeId,
    generation: 1,
    operatorId: 'operator',
    inReplyTo: null,
    conductorId: 'conductor',
    repoKey: 'repo:fixture',
    ownerPid: owner?.ownerPid || 999999,
    ownerStartTime: owner?.ownerStartTime || null,
    ownerCommand: owner?.ownerCommand || null,
    ...overrides
  };
}

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
    conductorId: 'other-conductor', repoKey: 'repo:other' });
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
    conductorId: 'conductor', repoKey: 'repo:fixture' });
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

test('direct post inspection preserves captured dependency kinds after factory creation', () => {
  const BindingError = class extends Error {};
  const StaleGenerationError = class extends Error {};
  const StateCorruptError = class extends Error {};
  const dependencies = {
    BindingError,
    StaleGenerationError,
    StateCorruptError,
    DIRECT_POST_ATTEMPT: 'direct-post-attempt',
    DIRECT_POST_OUTCOME: 'direct-post-outcome',
    DIRECT_POST_OUTCOMES: ['sent', 'not_sent', 'rejected', 'rate_limited', 'unknown', 'stale'],
    assertText(value, name, max = 512) {
      if (typeof value !== 'string' || value.length === 0 || value.length > max) throw new TypeError(`${name} invalid`);
      return value;
    },
    bindingMatchesExpected: () => true,
    parseJson(value, fallback) {
      if (typeof value !== 'string') return fallback;
      try { return JSON.parse(value); } catch { return fallback; }
    },
    now: () => '2026-09-13T00:00:00.000Z'
  };
  const binding = {
    active: true,
    channelId: 'channel-1',
    guildId: 'guild-1',
    provider: 'codex',
    nativeId: CODEX,
    generation: 1,
    conductorId: null,
    repoKey: null
  };
  const meta = {
    requestId: 'request-1',
    inReplyTo: null,
    attemptId: 'attempt-1',
    sourcePath: '/tmp/source.md',
    textHash: 'text-hash',
    operatorId: 'operator-1',
    partHash: 'part-hash',
    channelId: 'channel-1',
    guildId: 'guild-1',
    provider: 'codex',
    nativeId: CODEX,
    generation: 1,
    conductorId: null,
    repoKey: null,
    partIndex: 0,
    partCount: 1,
    nonce: 'nonce-1',
    binding
  };
  const attempt = { journal: 'direct-post-v1', ...meta, status: 'attempted' };
  const outcome = { ...attempt, outcome: 'sent' };
  const rows = [
    { id: 1, kind: 'direct-post-attempt', detail: attempt, createdAt: '2026-09-13T00:00:00.000Z' },
    { id: 2, kind: 'direct-post-outcome', detail: outcome, createdAt: '2026-09-13T00:00:01.000Z' }
  ];
  const receipts = [];
  const state = {
    db: { prepare: () => ({ all: () => [] }) },
    transaction: operation => operation(),
    directPostRows: () => rows.map(row => ({ ...row, detail: { ...row.detail } })),
    directPostBindingCurrent: () => true,
    directPostOwnerIdentity: () => ({ ownerPid: 123 }),
    receipt: (discordId, kind, detail) => receipts.push({ discordId, kind, detail })
  };
  const handlers = createDirectPostHandlers(dependencies);
  dependencies.DIRECT_POST_ATTEMPT = 'mutated-attempt-kind';
  dependencies.DIRECT_POST_OUTCOME = 'mutated-outcome-kind';

  assert.deepEqual(handlers.beginDirectPostPart(state, meta), {
    claimed: false,
    status: 'sent',
    attemptId: 'attempt-1',
    nonce: 'nonce-1',
    outcome
  });
  assert.deepEqual(receipts, []);
});

test('direct post facade exposes the frozen owner outcome vocabulary', () => {
  const owner = require('../dist/state/direct-post.js');
  assert.strictEqual(stateOutcomes, DIRECT_POST_OUTCOMES);
  assert.strictEqual(DIRECT_POST_OUTCOMES, owner.DIRECT_POST_OUTCOMES);
  assert.deepEqual(DIRECT_POST_OUTCOMES, ['sent', 'not_sent', 'rejected', 'rate_limited', 'unknown', 'stale']);
  assert.equal(Object.isFrozen(DIRECT_POST_OUTCOMES), true);
  assert.throws(() => DIRECT_POST_OUTCOMES.push('bogus'), TypeError);
  assert.deepEqual(DIRECT_POST_OUTCOMES, owner.DIRECT_POST_OUTCOMES);
});

test('post sends multipart text in order and records durable per-part outcomes', async t => {
  const f = fixture(t);
  fs.writeFileSync(f.textFile, `first\n${'x'.repeat(2100)}`);
  const recorder = fetchRecorder();
  const result = await runDirectPost({ state: f.state, token: 'fixture', nativeId: f.nativeId, generation: 1, textFile: f.textFile, fetchImpl: recorder.fetchImpl });
  assert.ok(result.parts.length >= 2);
  assert.equal(recorder.calls.map(call => call.body.content).join(''), `first\n${'x'.repeat(2100)}`);
  assert.ok(recorder.calls.every(call => call.body.content.length <= 2000));
  assert.ok(recorder.calls.every(call => call.body.allowed_mentions.parse.length === 0));
  assert.ok(recorder.calls.every(call => !('message_reference' in call.body)));
  assert.equal(result.recorded, true);
  assert.equal(result.duplicate, false);
  assert.equal(result.state, 'sent');
  assert.equal(f.state.listReceipts().filter(row => row.kind === 'direct-post-outcome').length, recorder.calls.length);
});

test('opt-in agent attachment carries the exact wire beside a deterministic preview', async t => {
  const f = agentFixture(t);
  const destination = { guildId: '100', channelId: '102', provider: 'claude', nativeId: CLAUDE, generation: 1 };
  const text = 'Read the task and preserve its addressed destination.';
  fs.writeFileSync(f.textFile, text);
  const calls = [];
  let multipartBody;
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (options.method === 'GET') return { ok: true, status: 200, json: async () => ({ id: destination.channelId, guild_id: destination.guildId }) };
    multipartBody = options.body;
    return response('attachment-message');
  };
  const result = await runDirectPost({
    state: f.state,
    token: 'fixture',
    nativeId: f.nativeId,
    generation: 1,
    agentThreadId: f.agentThreadId,
    textFile: f.textFile,
    dedupeKey: 'attachment-request',
    agentTarget: issueAgentAddress(destination, 'fixture'),
    agentPresentation: AGENT_PRESENTATIONS.ATTACHMENT,
    fetchImpl
  });
  assert.equal(result.status, 'sent');
  assert.equal(calls.length, 2);
  assert.ok(multipartBody instanceof FormData);
  const payload = JSON.parse(multipartBody.get('payload_json'));
  const file = multipartBody.get('files[0]');
  const wire = Buffer.from(await file.arrayBuffer()).toString('utf8');
  const packet = decodeAgentMessage(wire, 'fixture', destination);
  assert.equal(packet.text, text);
  assert.equal(file.name, AGENT_ATTACHMENT_FILENAME);
  assert.equal(file.type, AGENT_ATTACHMENT_CONTENT_TYPE);
  assert.equal(payload.content, 'Agent request from codex to claude: Read the task and preserve its addressed destination.');
  assert.doesNotMatch(payload.content, /discord-tether:agent:v1:|attachment-request|9caa5d21/);
  assert.equal(calls[1].options.headers['Content-Type'], undefined);
  const attempt = f.state.directPostRows('attachment-request').find(row => row.kind === 'direct-post-attempt').detail;
  assert.equal(attempt.presentation, AGENT_PRESENTATIONS.ATTACHMENT);
  assert.equal(attempt.partHash, crypto.createHash('sha256').update(JSON.stringify(wire)).digest('hex'));
  assert.equal(attempt.textHash, crypto.createHash('sha256').update(JSON.stringify(JSON.stringify(packet))).digest('hex'));
});

test('changing carrier after an unknown attachment POST does not bypass custody', async t => {
  const f = agentFixture(t);
  const destination = { guildId: '100', channelId: '102', provider: 'claude', nativeId: CLAUDE, generation: 1 };
  fs.writeFileSync(f.textFile, 'uncertain attachment request');
  let postCalls = 0;
  const firstFetch = async (_url, options) => {
    if (options.method === 'GET') return { ok: true, status: 200, json: async () => ({ id: destination.channelId, guild_id: destination.guildId }) };
    postCalls += 1;
    throw Object.assign(new Error('connection closed after write'), { name: 'TypeError' });
  };
  const input = {
    state: f.state,
    token: 'fixture',
    nativeId: f.nativeId,
    generation: 1,
    agentThreadId: f.agentThreadId,
    textFile: f.textFile,
    dedupeKey: 'uncertain-attachment-request',
    agentTarget: issueAgentAddress(destination, 'fixture')
  };
  const first = await runDirectPost({ ...input, agentPresentation: AGENT_PRESENTATIONS.ATTACHMENT, fetchImpl: firstFetch });
  assert.equal(first.status, 'unknown');
  const second = await runDirectPost({ ...input, fetchImpl: async () => { throw new Error('carrier switch must not POST'); } });
  assert.equal(second.status, 'unknown');
  assert.equal(postCalls, 1);
});

test('reply target uses the bound channel and participates in explicit identity', async t => {
  const f = fixture(t);
  fs.writeFileSync(f.textFile, 'reply milestone');
  const recorder = fetchRecorder();
  const first = await runDirectPost({ state: f.state, token: 'fixture', nativeId: f.nativeId, generation: 1, textFile: f.textFile,
    dedupeKey: 'reply-key', inReplyTo: 'predecessor-message', fetchImpl: recorder.fetchImpl });
  assert.deepEqual(recorder.calls[0].body.message_reference, {
    message_id: 'predecessor-message', channel_id: 'channel', fail_if_not_exists: true
  });
  assert.equal(first.recorded, true);
  assert.equal(first.duplicate, false);
  const repeated = await runDirectPost({ state: f.state, token: 'fixture', nativeId: f.nativeId, generation: 1, textFile: f.textFile,
    dedupeKey: 'reply-key', inReplyTo: 'predecessor-message', fetchImpl: recorder.fetchImpl });
  assert.equal(repeated.recorded, false);
  assert.equal(repeated.duplicate, true);
  assert.equal(repeated.state, 'sent');
  await assert.rejects(runDirectPost({ state: f.state, token: 'fixture', nativeId: f.nativeId, generation: 1, textFile: f.textFile,
    dedupeKey: 'reply-key', inReplyTo: 'different-message', fetchImpl: recorder.fetchImpl }), /identity conflicts/);
  assert.equal(recorder.calls.length, 1);
});

test('derived JavaScript fallback identity separates reply targets', async t => {
  const f = fixture(t);
  fs.writeFileSync(f.textFile, 'derived reply milestone');
  const recorder = fetchRecorder();
  const first = await runDirectPost({ state: f.state, token: 'fixture', nativeId: f.nativeId, generation: 1, textFile: f.textFile,
    inReplyTo: 'first-target', fetchImpl: recorder.fetchImpl });
  const second = await runDirectPost({ state: f.state, token: 'fixture', nativeId: f.nativeId, generation: 1, textFile: f.textFile,
    inReplyTo: 'second-target', fetchImpl: recorder.fetchImpl });
  assert.notEqual(first.requestId, second.requestId);
  assert.equal(first.recorded, true);
  assert.equal(second.recorded, true);
  assert.equal(recorder.calls.length, 2);
});

test('claude-post selection rejects codex and generic post rejects ambiguous native owners', async t => {
  const f = fixture(t, 'claude');
  f.state.bind({ channelId: 'codex-channel', guildId: 'guild', provider: 'codex', nativeId: CLAUDE, workspace: f.dir, conductorId: 'other', repoKey: 'repo:other' });
  fs.writeFileSync(f.textFile, 'milestone');
  await assert.rejects(runDirectPost({ state: f.state, token: 'fixture', nativeId: CLAUDE, generation: 1, textFile: f.textFile, fetchImpl: fetchRecorder().fetchImpl }), /channel-id/);
  const recorder = fetchRecorder();
  const result = await runDirectPost({ state: f.state, token: 'fixture', nativeId: CLAUDE, generation: 1, channelId: 'channel', provider: 'claude', textFile: f.textFile, fetchImpl: recorder.fetchImpl });
  assert.equal(result.parts[0].status, 'sent');
});

test('stale owner and invalid file fail before any network', async t => {
  const f = fixture(t);
  const recorder = fetchRecorder();
  await assert.rejects(runDirectPost({ state: f.state, token: 'fixture', nativeId: f.nativeId, generation: 2, textFile: f.textFile, fetchImpl: recorder.fetchImpl }), /no active conductor/);
  await assert.rejects(runDirectPost({ state: f.state, token: 'fixture', nativeId: f.nativeId, generation: 1, textFile: path.join(f.dir, 'missing.txt'), fetchImpl: recorder.fetchImpl }), /text file is unavailable/);
  fs.writeFileSync(f.textFile, 'x'.repeat(10001));
  await assert.rejects(runDirectPost({ state: f.state, token: 'fixture', nativeId: f.nativeId, generation: 1, textFile: f.textFile, fetchImpl: recorder.fetchImpl }), /10000 character/);
  assert.equal(recorder.calls.length, 0);
});

test('same request claims one sender, abort records unknown, and rerun never blindly resends', async t => {
  const f = fixture(t);
  fs.writeFileSync(f.textFile, 'uncertain milestone');
  const recorder = fetchRecorder({ pending: true });
  const controller = new AbortController();
  const first = runDirectPost({ state: f.state, token: 'fixture', nativeId: f.nativeId, generation: 1, textFile: f.textFile, fetchImpl: recorder.fetchImpl, signal: controller.signal });
  while (recorder.calls.length === 0) await new Promise(resolve => setTimeout(resolve, 2));
  const second = await runDirectPost({ state: f.state, token: 'fixture', nativeId: f.nativeId, generation: 1, textFile: f.textFile, fetchImpl: recorder.fetchImpl });
  assert.equal(second.parts[0].status, 'in_flight');
  assert.equal(second.recorded, false);
  assert.equal(second.duplicate, false);
  assert.equal(second.state, 'in_flight');
  assert.equal(recorder.calls.length, 1);
  controller.abort();
  const uncertain = await first;
  assert.equal(uncertain.status, 'unknown');
  assert.equal(uncertain.recorded, false);
  assert.equal(uncertain.duplicate, false);
  const rerun = await runDirectPost({ state: f.state, token: 'fixture', nativeId: f.nativeId, generation: 1, textFile: f.textFile, fetchImpl: recorder.fetchImpl });
  assert.equal(rerun.parts[0].status, 'unknown');
  assert.equal(rerun.recorded, false);
  assert.equal(rerun.duplicate, false);
  assert.equal(recorder.calls.length, 1);
});

test('not-sent parts retry on explicit command rerun and changing explicit request content is rejected', async t => {
  const f = fixture(t);
  fs.writeFileSync(f.textFile, 'retryable');
  const recorder = fetchRecorder({ responses: [response('bad', 400), response('good')] });
  const first = await runDirectPost({ state: f.state, token: 'fixture', nativeId: f.nativeId, generation: 1, textFile: f.textFile, fetchImpl: recorder.fetchImpl, requestId: 'explicit-request' });
  assert.equal(first.parts[0].status, 'not_sent');
  assert.equal(first.recorded, false);
  assert.equal(first.duplicate, false);
  const retry = await runDirectPost({ state: f.state, token: 'fixture', nativeId: f.nativeId, generation: 1, textFile: f.textFile, fetchImpl: recorder.fetchImpl, requestId: 'explicit-request' });
  assert.equal(retry.parts[0].status, 'sent');
  assert.equal(retry.recorded, true);
  assert.equal(retry.duplicate, false);
  fs.writeFileSync(f.textFile, 'changed');
  await assert.rejects(runDirectPost({ state: f.state, token: 'fixture', nativeId: f.nativeId, generation: 1, textFile: f.textFile, fetchImpl: recorder.fetchImpl, requestId: 'explicit-request' }), /identity conflicts/);
  assert.equal(recorder.calls.length, 2);
});

test('CLI --db and claude-post use the bound channel without native work', async t => {
  const f = fixture(t, 'claude');
  fs.writeFileSync(f.textFile, 'CLI milestone');
  const recorder = fetchRecorder();
  const originalFetch = globalThis.fetch;
  const originalArgv = process.argv;
  globalThis.fetch = recorder.fetchImpl;
  process.argv = ['node', 'src/cli.js', 'claude-post', '--db', path.join(f.dir, 'surface.sqlite'), '--native-id', f.nativeId, '--generation', '1', '--text-file', f.textFile,
    '--dedupe-key', 'cli-key', '--in-reply-to', 'prior-cli-message'];
  try {
    const result = await main();
    assert.equal(result.parts[0].status, 'sent');
    assert.equal(result.recorded, true);
    assert.equal(result.duplicate, false);
    assert.deepEqual(recorder.calls[0].body.message_reference, {
      message_id: 'prior-cli-message', channel_id: 'channel', fail_if_not_exists: true
    });
  } finally {
    globalThis.fetch = originalFetch;
    process.argv = originalArgv;
  }
  assert.equal(recorder.calls.length, 1);
});

test('CLI requires one dedupe key and rejects conflicting aliases before network', async t => {
  const f = fixture(t, 'claude');
  fs.writeFileSync(f.textFile, 'CLI key validation');
  const recorder = fetchRecorder();
  const originalFetch = globalThis.fetch;
  const originalArgv = process.argv;
  globalThis.fetch = recorder.fetchImpl;
  const base = ['node', 'src/cli.js', 'claude-post', '--db', path.join(f.dir, 'surface.sqlite'), '--native-id', f.nativeId,
    '--generation', '1', '--text-file', f.textFile];
  const invoke = async argv => {
    process.argv = argv;
    try { return await main(); }
    finally { process.argv = originalArgv; }
  };
  try {
    await assert.rejects(invoke(base), /dedupe-key or request-id is required/);
    await assert.rejects(invoke([...base, '--dedupe-key', 'canonical', '--request-id', 'legacy']), /must match/);
    const legacy = await invoke([...base, '--request-id', 'legacy-key']);
    assert.equal(legacy.requestId, 'legacy-key');
    assert.equal(legacy.recorded, true);
  } finally {
    globalThis.fetch = originalFetch;
    process.argv = originalArgv;
  }
  assert.equal(recorder.calls.length, 1);
});

test('direct post bot echo is excluded from native intake by message ID or bot nonce', async t => {
  const f = fixture(t);
  fs.writeFileSync(f.textFile, 'saved milestone');
  const recorder = fetchRecorder();
  await runDirectPost({ state: f.state, token: 'fixture', nativeId: f.nativeId, generation: 1, textFile: f.textFile, fetchImpl: recorder.fetchImpl });
  const outcome = f.state.listReceipts().find(row => row.kind === 'direct-post-outcome');
  const detail = JSON.parse(outcome.detail);
  const body = recorder.calls[0].body;
  const byId = f.state.acceptDiscordMessage({ id: 'direct-1', guildId: 'guild', channelId: 'channel', authorId: 'operator', content: body.content, isBot: false, nonce: null });
  assert.equal(byId.accepted, false);
  assert.equal(byId.reason, 'automatic-publication');
  const byNonce = f.state.acceptDiscordMessage({ id: 'foreign-id', guildId: 'guild', channelId: 'channel', authorId: 'operator', content: body.content, isBot: true, nonce: detail.nonce });
  assert.equal(byNonce.accepted, false);
  assert.equal(byNonce.reason, 'automatic-publication');
  let nativeCalls = 0;
  const consumer = createSurfaceConsumer({ state: f.state, providers: { codex: { submit: async () => { nativeCalls += 1; } } }, sendReply: async () => { throw new Error('no reply'); } });
  await consumer.handleMessage({ id: 'native-replay', guildId: 'guild', channelId: 'channel', authorId: 'operator', content: body.content, isBot: false, nonce: null });
  assert.equal(nativeCalls, 0);
});

test('restart marks a dead direct-post attempt unknown before any retry', async t => {
  const f = fixture(t);
  fs.writeFileSync(f.textFile, 'crashed milestone');
  const sourceHash = crypto.createHash('sha256').update(JSON.stringify('crashed milestone')).digest('hex');
  const requestId = 'crashed-request';
  f.state.receipt(null, 'direct-post-attempt', {
    journal: 'direct-post-v1', requestId, attemptId: 'dead-attempt', ownerPid: 999999, sourcePath: f.textFile, textHash: sourceHash, operatorId: 'operator',
    partHash: sourceHash, channelId: 'channel', guildId: 'guild', provider: 'codex', nativeId: f.nativeId, generation: 1,
    conductorId: 'conductor', repoKey: 'repo:fixture', partIndex: 0, partCount: 1, nonce: 'ds-dead-attempt', status: 'attempted'
  });
  const recorder = fetchRecorder();
  const result = await runDirectPost({ state: f.state, token: 'fixture', nativeId: f.nativeId, generation: 1, textFile: f.textFile, requestId, fetchImpl: recorder.fetchImpl });
  assert.equal(result.parts[0].status, 'unknown');
  assert.equal(recorder.calls.length, 0);
});

test('HTTP 500 is unknown and a reopened SQLite state does not resend it', async t => {
  const f = fixture(t);
  fs.writeFileSync(f.textFile, 'server failure');
  const recorder = fetchRecorder({ responses: [response('ignored', 500)] });
  const first = await runDirectPost({ state: f.state, token: 'fixture', nativeId: f.nativeId, generation: 1, textFile: f.textFile, fetchImpl: recorder.fetchImpl, requestId: 'server-failure' });
  f.state.close();
  const reopened = new (require('../src/state').SurfaceState)(path.join(f.dir, 'surface.sqlite'));
  t.after(() => reopened.close());
  const second = await runDirectPost({ state: reopened, token: 'fixture', nativeId: f.nativeId, generation: 1, textFile: f.textFile, fetchImpl: recorder.fetchImpl, requestId: 'server-failure' });
  assert.equal(recorder.calls.length, 1);
  assert.equal(first.status, 'unknown');
  assert.equal(second.status, 'unknown');
});

test('a confirmed direct post survives SQLite reopen without a duplicate send', async t => {
  const f = fixture(t);
  fs.writeFileSync(f.textFile, 'confirmed milestone');
  const recorder = fetchRecorder();
  const first = await runDirectPost({ state: f.state, token: 'fixture', nativeId: f.nativeId, generation: 1, textFile: f.textFile, fetchImpl: recorder.fetchImpl, requestId: 'confirmed-request' });
  assert.equal(first.status, 'sent');
  assert.equal(first.recorded, true);
  assert.equal(first.duplicate, false);
  f.state.close();
  const reopened = new (require('../src/state').SurfaceState)(path.join(f.dir, 'surface.sqlite'));
  t.after(() => reopened.close());
  const second = await runDirectPost({ state: reopened, token: 'fixture', nativeId: f.nativeId, generation: 1, textFile: f.textFile, fetchImpl: recorder.fetchImpl, requestId: 'confirmed-request' });
  assert.equal(second.status, 'sent');
  assert.equal(second.recorded, false);
  assert.equal(second.duplicate, true);
  assert.equal(recorder.calls.length, 1);
  assert.deepEqual(second.messageIds, first.messageIds);
});

test('historic receipts without reply metadata normalize to null', async t => {
  const f = fixture(t);
  fs.writeFileSync(f.textFile, 'historic receipt');
  const recorder = fetchRecorder();
  const first = await runDirectPost({ state: f.state, token: 'fixture', nativeId: f.nativeId, generation: 1, textFile: f.textFile,
    requestId: 'historic-request', fetchImpl: recorder.fetchImpl });
  assert.equal(first.status, 'sent');
  const rows = f.state.db.prepare("SELECT id, detail FROM receipts WHERE discord_id IS NULL AND kind IN ('direct-post-attempt', 'direct-post-outcome')").all();
  for (const row of rows) {
    const detail = JSON.parse(row.detail);
    delete detail.inReplyTo;
    f.state.db.prepare('UPDATE receipts SET detail=? WHERE id=?').run(JSON.stringify(detail), row.id);
  }
  const second = await runDirectPost({ state: f.state, token: 'fixture', nativeId: f.nativeId, generation: 1, textFile: f.textFile,
    requestId: 'historic-request', fetchImpl: recorder.fetchImpl });
  assert.equal(second.duplicate, true);
  assert.equal(recorder.calls.length, 1);
  assert.ok(f.state.directPostRows('historic-request').every(row => row.detail.inReplyTo === null));
});

test('rebind and operator revocation stop before the next multipart network request', async t => {
  for (const revoke of ['rebind', 'operator']) {
    const f = fixture(t);
    fs.writeFileSync(f.textFile, `${'a'.repeat(2000)}${'b'.repeat(2000)}`);
    const recorder = fetchRecorder();
    const originalFetch = recorder.fetchImpl;
    const fetchImpl = async (...args) => {
      const result = await originalFetch(...args);
      if (recorder.calls.length === 1) {
        if (revoke === 'rebind') f.state.rebind({ ...f.state.getBinding('channel'), nativeId: '7b7b7b7b-7b7b-4b7b-8b7b-7b7b7b7b7b7b' });
        else f.state.setConfig({ operatorId: 'another-operator' });
      }
      return result;
    };
    const result = await runDirectPost({ state: f.state, token: 'fixture', nativeId: f.nativeId, generation: 1, textFile: f.textFile, fetchImpl });
    assert.equal(recorder.calls.length, 1);
    assert.equal(result.status, 'stale');
    assert.deepEqual(result.messageIds, ['direct-1']);
  }
});


test('trailing file newline is preserved without sending a blank part', async t => {
  const f = fixture(t);
  const text = 'a'.repeat(2000) + '\n';
  fs.writeFileSync(f.textFile, text);
  const recorder = fetchRecorder();
  const result = await runDirectPost({ state: f.state, token: 'fixture', nativeId: f.nativeId, generation: 1, textFile: f.textFile, fetchImpl: recorder.fetchImpl });
  const contents = recorder.calls.map(call => call.body.content);
  assert.ok(contents.every(content => content.trim() && content.length <= 2000));
  assert.equal(contents.join(''), text);
  assert.equal(result.status, 'sent');
});

test('impossible whitespace-only parts are refused before any network request', async t => {
  const f = fixture(t);
  fs.writeFileSync(f.textFile, ' '.repeat(4000) + 'milestone');
  const recorder = fetchRecorder();
  await assert.rejects(runDirectPost({ state: f.state, token: 'fixture', nativeId: f.nativeId, generation: 1, textFile: f.textFile, fetchImpl: recorder.fetchImpl }), /blank Discord/);
  assert.equal(recorder.calls.length, 0);
  assert.equal(f.state.directPostRows().length, 0);
});

test('actual CLI repeats safely, refuses stale owners and exits nonzero for uncertainty without native work', t => {
  const { spawnSync } = require('node:child_process');
  const f = fixture(t, 'claude');
  fs.writeFileSync(f.textFile, 'executable milestone');
  const calls = path.join(f.dir, 'http-calls.ndjson');
  const preload = path.join(f.dir, 'network-fixture.cjs');
  fs.writeFileSync(preload, `
    const fs = require('node:fs');
    const cp = require('node:child_process');
    for (const name of ['spawn','spawnSync','exec','execSync','execFile','execFileSync']) cp[name] = () => { throw new Error('unexpected native work'); };
    globalThis.fetch = async (url, options) => {
      if (url !== 'https://discord.com/api/v10/channels/channel/messages') throw new Error('wrong destination');
      fs.appendFileSync(${JSON.stringify(calls)}, options.body+'\\n');
      const status = Number(process.env.POST_FIXTURE_STATUS || 200);
      return { ok: status === 200, status, body: { cancel() {} }, json: async () => ({id:'executable-message'}) };
    };
  `);
  const cli = path.resolve(__dirname, '../src/cli.js');
  const args = ['--require', preload, cli, 'claude-post', '--state-dir', f.dir, '--db', path.join(f.dir, 'surface.sqlite'),
    '--native-id', f.nativeId, '--generation', '1', '--text-file', f.textFile, '--dedupe-key', 'cli-executable-key',
    '--in-reply-to', 'prior-executable-message'];
  const run = (argv = args, status = 200) => spawnSync(process.execPath, argv, {
    encoding: 'utf8', timeout: 5000, env: { ...process.env, POST_FIXTURE_STATUS: String(status) }
  });
  const first = run(); assert.equal(first.status, 0, first.stderr);
  const second = run(); assert.equal(second.status, 0, second.stderr);
  assert.equal(fs.readFileSync(calls, 'utf8').trim().split('\n').length, 1);
  assert.deepEqual(JSON.parse(second.stdout).messageIds, JSON.parse(first.stdout).messageIds);
  assert.equal(JSON.parse(first.stdout).recorded, true);
  assert.equal(JSON.parse(first.stdout).duplicate, false);
  assert.equal(JSON.parse(second.stdout).recorded, false);
  assert.equal(JSON.parse(second.stdout).duplicate, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(calls, 'utf8').trim()).message_reference, {
    message_id: 'prior-executable-message', channel_id: 'channel', fail_if_not_exists: true
  });
  const stale = args.slice(); stale[stale.indexOf('--generation') + 1] = '2';
  assert.equal(run(stale).status, 1);
  assert.equal(fs.readFileSync(calls, 'utf8').trim().split('\n').length, 1);
  fs.writeFileSync(f.textFile, 'another milestone');
  const unknownArgs = args.slice(); unknownArgs[unknownArgs.indexOf('--dedupe-key') + 1] = 'cli-unknown-key';
  const unknown = run(unknownArgs, 500); assert.equal(unknown.status, 1, unknown.stderr);
  const retry = run(unknownArgs); assert.equal(retry.status, 1, retry.stderr);
  assert.equal(fs.readFileSync(calls, 'utf8').trim().split('\n').length, 2);
  assert.equal(JSON.parse(unknown.stdout).status, 'unknown');
  assert.equal(JSON.parse(retry.stdout).status, 'unknown');
  assert.equal(f.state.listMessages().length, 0);
});

test('agent reply can correlate by accepted Discord message ID across duplicate request keys', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-reply-correlation-'));
  const state = new SurfaceState(path.join(dir, 'surface.sqlite'));
  const token = 'fixture-token';
  const local = { guildId: '123', channelId: '456', provider: 'codex', nativeId: CODEX, generation: 1 };
  const sourceA = { guildId: '123', channelId: '901', provider: 'claude', nativeId: CLAUDE, generation: 1 };
  const sourceB = { guildId: '123', channelId: '902', provider: 'codex', nativeId: 'd6d5bd73-17e0-4d87-9eb7-84544b93b4f1', generation: 1 };
  state.setConfig({ operatorId: 'operator', guildId: local.guildId, secretFile: path.join(dir, 'discord.env') });
  fs.writeFileSync(path.join(dir, 'discord.env'), 'DISCORD_TOKEN=fixture-token\n', { mode: 0o600 });
  state.bind({ ...local, workspace: dir, conductorId: 'conductor', repoKey: 'repo:fixture' });
  let localBinding = state.getBinding(local.channelId);
  localBinding = state.setBindingReadiness(local.channelId, READINESS.READY, 'fixture ready', localBinding);
  state.enrollThread({ threadId: '457', parentChannelId: local.channelId, guildId: local.guildId }, localBinding);
  state.setThreadBaseline('457', '1000', localBinding);
  state.markThreadBoundary('457', THREAD_STATES.READY, 'fixture adoption', null, null, localBinding);
  const localChild = { ...local, channelId: '457', generation: localBinding.generation };
  const textFile = path.join(dir, 'reply.txt');
  fs.writeFileSync(textFile, 'reply');
  t.after(() => { state.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  const accept = (id, source, key = 'shared-key') => state.acceptDiscordMessage({
    id, guildId: local.guildId, channelId: localChild.channelId, authorId: 'discord-bot', isBot: true,
    content: encodeAgentMessage({ id: key, kind: KINDS.REQUEST, source, target: localChild, replyTo: null, text: 'request' }, token)
  }, { agentToken: token });
  assert.equal(accept('1001', sourceA).accepted, true);
  assert.equal(accept('1002', sourceB).accepted, true);

  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (options.method === 'GET') return { ok: true, status: 200, body: { cancel() {} }, json: async () => ({ id: sourceA.channelId, guild_id: sourceA.guildId }) };
    return response('reply-1');
  };
  const result = await runDirectPost({ state, token, nativeId: local.nativeId, generation: local.generation,
    agentThreadId: localChild.channelId, textFile, dedupeKey: 'result-key', agentKind: KINDS.RESULT, agentReplyTo: '1001', fetchImpl });
  assert.equal(result.parts[0].status, 'sent');
  assert.match(calls[0].url, /\/channels\/901$/);
  const packet = decodeAgentMessage(JSON.parse(calls[1].options.body).content, token, sourceA);
  assert.equal(packet.target.channelId, sourceA.channelId);
  assert.equal(packet.replyTo, 'shared-key');
  await assert.rejects(runDirectPost({ state, token, nativeId: local.nativeId, generation: local.generation,
    agentThreadId: localChild.channelId, textFile, dedupeKey: 'result-key-ambiguous', agentKind: KINDS.RESULT, agentReplyTo: 'shared-key', fetchImpl }), /unknown or does not match/);
  assert.equal(accept('1003', sourceB, '1001').accepted, true);
  const priorCalls = calls.length;
  await assert.rejects(runDirectPost({ state, token, nativeId: local.nativeId, generation: local.generation,
    agentThreadId: localChild.channelId, textFile, dedupeKey: 'result-key-cross-collision', agentKind: KINDS.RESULT, agentReplyTo: '1001', fetchImpl }), /unknown or does not match/);
  assert.equal(calls.length, priorCalls);
});
