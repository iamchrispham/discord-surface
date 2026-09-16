const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { SurfaceState, MESSAGE_STATES } = require('../src/state');
const { DiscordGateway, createSurfaceConsumer } = require('../src/discord');

const NATIVE = {
  codex: '9caa5d21-2169-429d-918b-5f08651b5dbd',
  claude: '79e3da8e-94b4-4aff-8f88-b45b3a451dd1'
};

function fixture(t, provider = 'codex') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-reply-file-'));
  const state = new SurfaceState(path.join(dir, 'surface.sqlite'));
  state.setConfig({ operatorId: 'operator', guildId: 'guild', secretFile: path.join(dir, 'discord.env') });
  fs.writeFileSync(path.join(dir, 'discord.env'), 'DISCORD_TOKEN=fixture\n', { mode: 0o600 });
  state.bind({ channelId: 'channel', guildId: 'guild', provider, nativeId: NATIVE[provider], workspace: dir,
    endpoint: provider === 'claude' ? '/tmp/claude.sock' : undefined, conductorId: 'conductor', repoKey: 'repo:fixture' });
  const binding = state.getBinding('channel');
  state.setBindingReadiness('channel', 'ready', 'fixture ready', binding);
  t.after(() => { try { state.close(); } catch {} fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, state, provider, nativeId: NATIVE[provider] };
}

function submitted(f, id, dispatchState = MESSAGE_STATES.SUBMITTED) {
  f.state.acceptDiscordMessage({ id, guildId: 'guild', channelId: 'channel', authorId: 'operator', isBot: false, content: 'question' });
  f.state.claimDispatch(id);
  if (dispatchState === MESSAGE_STATES.UNCERTAIN) f.state.markUncertain(id, new Error('dispatch interrupted'));
  else f.state.markSubmitted(id);
}

function directPreparationSeed(f, index) {
  const preparationId = `55555555-5555-4555-8555-${String(index).padStart(12, '0')}`;
  const owner = f.state.directPostOwnerIdentity(process.pid);
  return {
    preparationId,
    requestId: `direct-capacity-${index}`,
    custodyRoot: f.dir,
    sourcePath: path.join(f.dir, `${preparationId}.bin`),
    stagedPath: path.join(f.dir, '.direct-post-files', `${preparationId}.bin`),
    filename: `${preparationId}.bin`,
    size: 0,
    caption: 'held direct file',
    captionHash: `caption-hash-${index}`,
    channelId: 'channel',
    guildId: 'guild',
    provider: 'codex',
    nativeId: f.nativeId,
    generation: 1,
    operatorId: 'operator',
    inReplyTo: null,
    ownerPid: owner.ownerPid,
    ownerStartTime: owner.ownerStartTime,
    ownerCommand: owner.ownerCommand
  };
}

test('Codex and Claude file replies recover submitted and uncertain dispatch', async t => {
  for (const provider of ['codex', 'claude']) for (const dispatchState of [MESSAGE_STATES.SUBMITTED, MESSAGE_STATES.UNCERTAIN]) {
    await t.test(`${provider} ${dispatchState}`, async t2 => {
    const f = fixture(t2, provider);
    const id = `native-file-${provider}`;
    const source = path.join(f.dir, 'answer.bin');
    const bytes = Buffer.from([0, 4, 8, 255]);
    fs.writeFileSync(source, bytes);
    submitted(f, id, dispatchState);
    assert.equal(f.state.getMessage(id).state, dispatchState);
    const manifest = f.state.prepareNativeReplyFile({ provider, messageId: id, nativeId: f.nativeId, generation: 1,
      stateDir: f.dir, sourcePath: source, caption: 'answer with file' });
    assert.deepEqual(f.state.prepareNativeReplyFile({ provider, messageId: id, nativeId: f.nativeId, generation: 1,
      stateDir: f.dir, sourcePath: source, caption: 'answer with file' }), manifest);
    fs.writeFileSync(source, Buffer.from('changed source'));
    assert.throws(() => f.state.prepareNativeReplyFile({ provider, messageId: id, nativeId: f.nativeId, generation: 1,
      stateDir: f.dir, sourcePath: source, caption: 'answer with file' }), /identity conflicts/);
    fs.unlinkSync(source);
    const recorded = f.state.recordNativeReply({ provider, messageId: id, nativeId: f.nativeId, generation: 1,
      text: 'answer with file', fileManifest: manifest });
    assert.equal(recorded.message.state, MESSAGE_STATES.REPLY_READY);
    assert.deepEqual(f.state.listReplyParts(id)[0].fileManifest, manifest);
    f.state.beginReply(id);
    const calls = [];
    const client = new EventEmitter();
    client.user = { id: 'bot' };
    const gateway = new DiscordGateway({ state: f.state, client });
    const sent = await gateway.sendReply({ id, channel: { id: 'channel', send: async payload => { calls.push(payload); return { id: 'posted' }; } } }, {
      id, replyText: 'answer with file', replyNonce: f.state.getMessage(id).replyNonce, replyPart: f.state.listReplyParts(id)[0]
    });
    assert.equal(sent.id, 'posted');
    assert.equal(calls[0].content, 'answer with file');
    assert.deepEqual(calls[0].files[0].attachment, bytes);
    assert.equal(calls[0].files[0].name, 'answer.bin');
    f.state.markReplyPartSent(id, 0, sent.id);
    assert.equal(fs.existsSync(manifest.stagedPath), true);
    assert.equal(f.state.nativeReplyFilePreparation(id).phase, 'admitted');
    assert.equal(f.state.releaseNativeReplyFilePreparation(id, manifest.preparationId).phase, 'released');
    assert.equal(fs.existsSync(manifest.stagedPath), false);
    });
  }
});

test('native reply retries preserve staged custody across source availability changes', async t => {
  for (const provider of ['codex', 'claude']) await t.test(provider, t2 => {
    const f = fixture(t2, provider);
    const id = `native-file-retry-source-${provider}`;
    const source = path.join(f.dir, 'answer.bin');
    const alternate = path.join(f.dir, 'alternate', 'answer.bin');
    const unavailable = path.join(f.dir, 'missing', 'answer.bin');
    const bytes = Buffer.from('retry payload');
    fs.writeFileSync(source, bytes);
    submitted(f, id);
    const input = { provider, messageId: id, nativeId: f.nativeId, generation: 1, stateDir: f.dir, caption: 'retry caption' };
    const manifest = f.state.prepareNativeReplyFile({ ...input, sourcePath: source });

    fs.mkdirSync(path.dirname(alternate), { recursive: true });
    fs.writeFileSync(alternate, bytes);
    assert.deepEqual(f.state.prepareNativeReplyFile({ ...input, sourcePath: alternate }), manifest);

    fs.unlinkSync(source);
    assert.deepEqual(f.state.prepareNativeReplyFile({ ...input, sourcePath: source }), manifest);

    assert.throws(() => f.state.prepareNativeReplyFile({ ...input, sourcePath: unavailable }), /identity conflicts/);
    assert.equal(f.state.nativeReplyFilePreparation(id).phase, 'admitted');
  });
});

test('file replies keep the caption on their attachment part', async t => {
  for (const provider of ['codex', 'claude']) await t.test(provider, t2 => {
    const f = fixture(t2, provider);
    const id = `native-file-parts-${provider}`;
    const source = path.join(f.dir, 'parts.bin');
    fs.writeFileSync(source, Buffer.from('parts payload'));
    submitted(f, id);
    const manifest = f.state.prepareNativeReplyFile({ provider, messageId: id, nativeId: f.nativeId, generation: 1,
      stateDir: f.dir, sourcePath: source, caption: 'caption' });
    assert.throws(() => f.state.recordNativeReply({ provider, messageId: id, nativeId: f.nativeId, generation: 1,
      text: 'caption', parts: ['', 'caption'], fileManifest: manifest }), /exactly one caption part/);
    assert.equal(f.state.listReplyParts(id).length, 0);
    const recorded = f.state.recordNativeReply({ provider, messageId: id, nativeId: f.nativeId, generation: 1,
      text: 'caption', parts: ['caption'], fileManifest: manifest });
    assert.equal(recorded.message.state, MESSAGE_STATES.REPLY_READY);
    assert.deepEqual(f.state.listReplyParts(id)[0].fileManifest, manifest);
  });
});

test('uncertain file preparation persists native acknowledgment before delivery retry', async t => {
  for (const provider of ['codex', 'claude']) await t.test(provider, t2 => {
    const f = fixture(t2, provider);
    const id = `native-file-uncertain-ack-${provider}`;
    const source = path.join(f.dir, 'uncertain.bin');
    fs.writeFileSync(source, Buffer.from('uncertain payload'));
    submitted(f, id, MESSAGE_STATES.UNCERTAIN);
    const other = new SurfaceState(path.join(f.dir, 'surface.sqlite'));
    const originalRename = fs.renameSync;
    let observedDuringStaging = false;
    try {
      fs.renameSync = (from, to) => {
        const result = originalRename(from, to);
        if (!observedDuringStaging && String(to).includes(`${path.sep}.direct-post-files${path.sep}`)) {
          observedDuringStaging = true;
          const observed = other.getMessage(id);
          assert.equal(other.hasNativeAcknowledgment(observed), true);
          assert.throws(() => other.reconcileUncertain(id, 'not_submitted'), /native acknowledgment/);
          assert.equal(other.claimDispatch(id).claimed, false);
        }
        return result;
      };
      const manifest = f.state.prepareNativeReplyFile({ provider, messageId: id, nativeId: f.nativeId, generation: 1,
        stateDir: f.dir, sourcePath: source, caption: 'uncertain caption' });
      assert.equal(observedDuringStaging, true);
      assert.equal(manifest.phase, 'admitted');
      assert.equal(f.state.nativeReplyFilePreparation(id).phase, 'admitted');
      f.state.close();
      const reopened = new SurfaceState(path.join(f.dir, 'surface.sqlite'));
      assert.equal(reopened.nativeReplyFilePreparation(id).preparationId, manifest.preparationId);
      assert.equal(reopened.nativeReplyFilePreparation(id).phase, 'admitted');
      assert.throws(() => reopened.reconcileUncertain(id, 'not_submitted'), /native acknowledgment/);
      assert.equal(reopened.claimDispatch(id).claimed, false);
      reopened.close();
    } finally {
      fs.renameSync = originalRename;
      other.close();
    }
  });
});

test('native file custody survives not-sent reconciliation and named cleanup only', t => {
  const f = fixture(t);
  const id = 'native-file-reconcile';
  const source = path.join(f.dir, 'answer.bin');
  fs.writeFileSync(source, Buffer.from('payload'));
  submitted(f, id);
  const manifest = f.state.prepareNativeReplyFile({ provider: 'codex', messageId: id, nativeId: f.nativeId, generation: 1,
    stateDir: f.dir, sourcePath: source, caption: 'caption' });
  f.state.recordNativeReply({ provider: 'codex', messageId: id, nativeId: f.nativeId, generation: 1, text: 'caption', fileManifest: manifest });
  f.state.beginReply(id);
  f.state.markReplyFailure(id, new Error('transport uncertain'), true, 0);
  f.state.reconcileReplyDelivery(id, 'not_sent');
  assert.deepEqual(f.state.listReplyParts(id)[0].fileManifest, manifest);
  assert.equal(f.state.nativeReplyFilePreparation(id).phase, 'admitted');
  assert.throws(() => f.state.releaseNativeReplyFilePreparation(id, manifest.preparationId), /sent file part/);
  f.state.beginReply(id);
  f.state.markReplyPartSent(id, 0, 'posted');
  f.state.releaseNativeReplyFilePreparation(id, manifest.preparationId);
  assert.equal(fs.existsSync(manifest.stagedPath), false);
});

test('dead native preparation owner can release a pre-stage reservation', t => {
  const f = fixture(t);
  const id = 'native-file-dead-owner';
  submitted(f, id);
  const preparationId = '33333333-3333-4333-8333-333333333333';
  const stagedPath = path.join(f.dir, '.direct-post-files', `${preparationId}.bin`);
  fs.mkdirSync(path.dirname(stagedPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(`${stagedPath}.partial`, Buffer.from('partial'));
  f.state.receipt(id, 'native-reply-file-preparation', {
    journal: 'native-reply-file-v1', phase: 'preparing', preparationId, stagedPath,
    ownerPid: 999999, ownerStartTime: null, ownerCommand: null
  });
  const released = f.state.releaseNativeReplyFilePreparation(id, preparationId);
  assert.equal(released.phase, 'released');
  assert.equal(fs.existsSync(`${stagedPath}.partial`), false);
  assert.equal(f.state.activeFilePreparationCount(), 0);
});

test('text reply cannot close a message while native file preparation is pending', t => {
  const f = fixture(t);
  const id = 'native-file-preparing-fence';
  submitted(f, id);
  const preparationId = '44444444-4444-4444-8444-444444444444';
  f.state.receipt(id, 'native-reply-file-preparation', {
    journal: 'native-reply-file-v1', phase: 'preparing', preparationId,
    messageId: id, ownerPid: process.pid, ownerStartTime: null, ownerCommand: null
  });
  assert.throws(() => f.state.recordNativeReply({ provider: 'codex', messageId: id, nativeId: f.nativeId,
    generation: 1, text: 'observer text' }), /preparation is still in progress/);
  assert.equal(f.state.getMessage(id).state, MESSAGE_STATES.SUBMITTED);
});

test('direct and native preparations share capacity and release permits replacement', t => {
  const f = fixture(t);
  for (let index = 0; index < 7; index += 1) f.state.beginDirectPostFilePreparation(directPreparationSeed(f, index));
  assert.equal(f.state.activeFilePreparationCount(), 7);
  const id = 'native-file-capacity';
  const source = path.join(f.dir, 'capacity.bin');
  fs.writeFileSync(source, Buffer.from('capacity payload'));
  submitted(f, id);
  const manifest = f.state.prepareNativeReplyFile({ provider: 'codex', messageId: id, nativeId: f.nativeId, generation: 1,
    stateDir: f.dir, sourcePath: source, caption: 'capacity' });
  assert.equal(f.state.activeFilePreparationCount(), 8);
  assert.throws(() => f.state.beginDirectPostFilePreparation(directPreparationSeed(f, 8)), /capacity is exhausted/);
  f.state.recordNativeReply({ provider: 'codex', messageId: id, nativeId: f.nativeId, generation: 1, text: 'capacity', fileManifest: manifest });
  f.state.beginReply(id);
  f.state.markReplyPartSent(id, 0, 'capacity-posted');
  f.state.releaseNativeReplyFilePreparation(id, manifest.preparationId);
  assert.equal(f.state.activeFilePreparationCount(), 7);
  assert.equal(f.state.beginDirectPostFilePreparation(directPreparationSeed(f, 8)).phase, 'preparing');
});

test('stale native cleanup cannot release a later preparation for the same message', t => {
  const f = fixture(t);
  const id = 'native-file-stale-cleanup';
  const firstId = '66666666-6666-4666-8666-666666666666';
  const secondId = '77777777-7777-4777-8777-777777777777';
  submitted(f, id);
  const firstPath = path.join(f.dir, '.direct-post-files', `${firstId}.bin`);
  const secondPath = path.join(f.dir, '.direct-post-files', `${secondId}.bin`);
  fs.mkdirSync(path.dirname(firstPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(firstPath, Buffer.from('first'));
  fs.writeFileSync(secondPath, Buffer.from('second'));
  const base = { journal: 'native-reply-file-v1', messageId: id, ownerPid: 999999, ownerStartTime: null, ownerCommand: null };
  f.state.receipt(id, 'native-reply-file-preparation', { ...base, phase: 'preparing', preparationId: firstId, stagedPath: firstPath });
  f.state.receipt(id, 'native-reply-file-preparation', { ...base, phase: 'released', preparationId: firstId, stagedPath: firstPath });
  f.state.receipt(id, 'native-reply-file-preparation', { ...base, phase: 'preparing', preparationId: secondId, stagedPath: secondPath });
  assert.equal(f.state.releaseNativeReplyFilePreparation(id, firstId).phase, 'released');
  assert.equal(fs.existsSync(secondPath), true);
  assert.equal(f.state.nativeReplyFilePreparation(id).preparationId, secondId);
});

test('missing native snapshot is definitive not-sent and retains retry custody', async t => {
  const f = fixture(t);
  const id = 'native-file-missing-snapshot';
  const source = path.join(f.dir, 'missing.bin');
  fs.writeFileSync(source, Buffer.from('will be removed'));
  submitted(f, id);
  const manifest = f.state.prepareNativeReplyFile({ provider: 'codex', messageId: id, nativeId: f.nativeId, generation: 1,
    stateDir: f.dir, sourcePath: source, caption: 'missing snapshot' });
  f.state.recordNativeReply({ provider: 'codex', messageId: id, nativeId: f.nativeId, generation: 1,
    text: 'missing snapshot', fileManifest: manifest });
  f.state.beginReply(id);
  fs.unlinkSync(manifest.stagedPath);
  let sends = 0;
  const client = new EventEmitter();
  client.user = { id: 'bot' };
  const gateway = new DiscordGateway({ state: f.state, client });
  await assert.rejects(() => gateway.sendReply({ id, channel: { id: 'channel', send: async () => { sends += 1; } } }, {
    id, replyText: 'missing snapshot', replyNonce: f.state.getMessage(id).replyNonce, replyPart: f.state.listReplyParts(id)[0]
  }), error => error.outcome === 'not_sent');
  assert.equal(sends, 0);
  f.state.markReplyFailure(id, new Error('staged snapshot is unavailable'), false, 0);
  f.state.reconcileReplyDelivery(id, 'not_sent');
  assert.equal(f.state.nativeReplyFilePreparation(id).phase, 'admitted');
  assert.throws(() => f.state.releaseNativeReplyFilePreparation(id, manifest.preparationId), /sent file part/);
});

test('sent cleanup reopens after unlink-before-released receipt failure', t => {
  const f = fixture(t);
  const id = 'native-file-cleanup-crash';
  const source = path.join(f.dir, 'cleanup.bin');
  fs.writeFileSync(source, Buffer.from('cleanup payload'));
  submitted(f, id);
  const manifest = f.state.prepareNativeReplyFile({ provider: 'codex', messageId: id, nativeId: f.nativeId, generation: 1,
    stateDir: f.dir, sourcePath: source, caption: 'cleanup' });
  f.state.recordNativeReply({ provider: 'codex', messageId: id, nativeId: f.nativeId, generation: 1,
    text: 'cleanup', fileManifest: manifest });
  f.state.beginReply(id);
  f.state.markReplyPartSent(id, 0, 'cleanup-posted');
  const receipt = f.state.receipt.bind(f.state);
  f.state.receipt = (messageId, kind, detail) => {
    if (kind === 'native-reply-file-preparation' && detail?.phase === 'released') throw new Error('injected release receipt failure');
    return receipt(messageId, kind, detail);
  };
  assert.throws(() => f.state.releaseNativeReplyFilePreparation(id, manifest.preparationId), /injected release receipt failure/);
  assert.equal(fs.existsSync(manifest.stagedPath), false);
  f.state.receipt = receipt;
  f.state.close();
  const reopened = new SurfaceState(path.join(f.dir, 'surface.sqlite'));
  assert.equal(reopened.nativeReplyFilePreparation(id).phase, 'admitted');
  assert.equal(fs.existsSync(manifest.stagedPath), false);
  assert.equal(reopened.releaseNativeReplyFilePreparation(id, manifest.preparationId).phase, 'released');
  assert.equal(reopened.releaseNativeReplyFilePreparation(id, manifest.preparationId).phase, 'released');
  reopened.close();
});

test('native reply custody reopens with child delivery and waits for reconciliation', async t => {
  for (const provider of ['codex', 'claude']) await t.test(provider, async t2 => {
    for (const resolution of ['sent', 'not_sent']) await t2.test(resolution, async t3 => {
      const f = fixture(t3, provider);
      const parentChannelId = 'channel';
      const childChannelId = `child-${provider}-${resolution}`;
      const binding = f.state.getBinding(parentChannelId);
      f.state.enrollThread({ threadId: childChannelId, parentChannelId, guildId: 'guild' }, binding);
      f.state.setThreadBaseline(childChannelId, null, binding);
      f.state.markThreadBoundary(childChannelId, 'ready', 'native restart fixture', null, null, binding);
      const id = `native-file-reopen-${provider}-${resolution}`;
      assert(f.state.acceptDiscordMessage({ id, guildId: 'guild', channelId: childChannelId,
        authorId: 'operator', isBot: false, content: 'file request' }).accepted);
      f.state.claimDispatch(id);
      f.state.markSubmitted(id);
      const source = path.join(f.dir, 'result.bin');
      const bytes = Buffer.from([1, 127, 254, 10]);
      fs.writeFileSync(source, bytes);
      const manifest = f.state.prepareNativeReplyFile({ provider, messageId: id, nativeId: f.nativeId, generation: 1,
        stateDir: f.dir, sourcePath: source, caption: 'saved caption' });
      f.state.recordNativeReply({ provider, messageId: id, nativeId: f.nativeId, generation: 1,
        text: 'saved caption', fileManifest: manifest });
      f.state.beginReply(id);
      const nonce = f.state.listReplyParts(id)[0].nonce;
      fs.unlinkSync(source);
      f.state.close();
      f.state = new SurfaceState(path.join(f.dir, 'surface.sqlite'));
      assert.equal(f.state.recoverAfterRestart().replying, 1);
      assert.equal(f.state.getMessage(id).state, 'reply_unknown');
      assert.deepEqual(f.state.listReplyParts(id)[0].fileManifest, manifest);
      assert.equal(f.state.activeFilePreparationCount(), 1);
      assert.throws(() => f.state.releaseNativeReplyFilePreparation(id, manifest.preparationId), /sent file part/);
      assert(!f.state.recoveryCandidates().some(candidate => candidate.id === id));

      const calls = [];
      const channel = { id: childChannelId, parentId: parentChannelId, guildId: 'guild', type: 11,
        isThread: () => true, permissionsFor: () => ({ has: () => true }),
        send: async payload => { calls.push(payload); return { id: 'verified-send' }; } };
      const client = new EventEmitter();
      client.user = { id: 'bot' };
      client.channels = { fetch: async channelId => { assert.equal(channelId, childChannelId); return channel; } };
      const gateway = new DiscordGateway({ state: f.state, client });
      const consumer = createSurfaceConsumer({ state: f.state, providers: {},
        sendReply: (message, reply) => gateway.sendReply(message, reply) });
      const incoming = { id, channelId: parentChannelId,
        channel: { id: parentChannelId, send: () => { throw new Error('parent fallback'); } } };
      await consumer.deliverReply(incoming, { message: f.state.getMessage(id) });
      assert.equal(calls.length, 0);
      f.state.reconcileReplyDelivery(id, resolution, resolution === 'sent'
        ? { partIndex: 0, replyMessageId: 'already-sent' } : {});
      await consumer.deliverReply(incoming, { message: f.state.getMessage(id) });
      assert.equal(calls.length, resolution === 'sent' ? 0 : 1);
      if (calls.length) {
        assert.deepEqual(calls[0].files[0].attachment, bytes);
        assert.equal(calls[0].content, 'saved caption');
        assert.equal(calls[0].files[0].name, 'result.bin');
      }
      assert.equal(f.state.listReplyParts(id)[0].nonce, nonce);
      assert.equal(f.state.getMessage(id).state, 'replied');
      assert(fs.existsSync(manifest.stagedPath));
      f.state.releaseNativeReplyFilePreparation(id, manifest.preparationId);
      assert.equal(f.state.activeFilePreparationCount(), 0);
      assert.equal(fs.existsSync(manifest.stagedPath), false);
      f.state.close();
    });
  });
});

test('public native-reply command accepts Claude alias and records file custody', t => {
  const f = fixture(t, 'claude');
  const id = 'native-file-cli';
  const caption = path.join(f.dir, 'caption.txt');
  const source = path.join(f.dir, 'answer.bin');
  fs.writeFileSync(caption, 'from cli');
  fs.writeFileSync(source, Buffer.from('cli-payload'));
  submitted(f, id);
  const result = spawnSync(process.execPath, [path.join(__dirname, '..', 'src', 'cli.js'), 'claude-reply', '--state-dir', f.dir,
    '--message-id', id, '--native-id', f.nativeId, '--generation', '1', '--text-file', caption, '--attachment-file', source],
  { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /filePreparationId/);
  const manifest = f.state.listReplyParts(id)[0].fileManifest;
  assert.equal(manifest.filename, 'answer.bin');
  f.state.beginReply(id);
  f.state.markReplyPartSent(id, 0, 'cli-posted');
  const cleanup = spawnSync(process.execPath, [path.join(__dirname, '..', 'src', 'cli.js'), 'native-reply-file-cleanup', '--state-dir', f.dir,
    '--message-id', id, '--preparation-id', manifest.preparationId], { encoding: 'utf8' });
  assert.equal(cleanup.status, 0, cleanup.stderr);
  assert.match(cleanup.stdout, /"phase": "released"/);
});

function nativeFileFinalRegressionInput(f, messageId, sourcePath, caption) {
  return {
    provider: f.provider,
    messageId,
    nativeId: f.nativeId,
    generation: 1,
    stateDir: f.dir,
    sourcePath,
    caption
  };
}

test('native reply rejects a competing text reply before reservation', async t => {
  for (const provider of ['codex', 'claude']) await t.test(provider, t2 => {
    const f = fixture(t2, provider);
    const id = `native-file-final-pre-reservation-${provider}`;
    const source = path.join(f.dir, 'answer.bin');
    fs.writeFileSync(source, Buffer.from('payload'));
    submitted(f, id);
    const input = nativeFileFinalRegressionInput(f, id, source, 'caption A');
    const other = new SurfaceState(path.join(f.dir, 'surface.sqlite'));
    const originalOwnerIdentity = f.state.directPostOwnerIdentity;
    const ownerIdentity = originalOwnerIdentity.bind(f.state);
    f.state.directPostOwnerIdentity = pid => {
      const identity = ownerIdentity(pid);
      other.recordNativeReply({ ...input, text: 'competing text' });
      return identity;
    };
    try {
      assert.throws(() => f.state.prepareNativeReplyFile(input), /reply is not accepted in state reply_ready/);
    } finally {
      f.state.directPostOwnerIdentity = originalOwnerIdentity;
      other.close();
    }
    assert.equal(f.state.activeFilePreparationCount(), 0);
    assert.equal(f.state.nativeReplyFilePreparation(id), null);
    assert.equal(f.state.getMessage(id).state, MESSAGE_STATES.REPLY_READY);
  });
});

test('native reply authorization loss during final staging retains ACK and custody', async t => {
  for (const provider of ['codex', 'claude']) await t.test(provider, t2 => {
    const f = fixture(t2, provider);
    const id = `native-file-final-auth-loss-${provider}`;
    const source = path.join(f.dir, 'answer.bin');
    fs.writeFileSync(source, Buffer.from('payload'));
    submitted(f, id, MESSAGE_STATES.UNCERTAIN);
    const input = nativeFileFinalRegressionInput(f, id, source, 'caption A');
    const other = new SurfaceState(path.join(f.dir, 'surface.sqlite'));
    const originalRename = fs.renameSync;
    let authorizationChanged = false;
    try {
      fs.renameSync = (from, to) => {
        const result = originalRename(from, to);
        if (!authorizationChanged && String(to).includes(`${path.sep}.direct-post-files${path.sep}`)) {
          authorizationChanged = true;
          other.setConfig({ operatorId: 'different-operator', guildId: 'guild', secretFile: path.join(f.dir, 'discord.env') });
        }
        return result;
      };
      assert.throws(() => f.state.prepareNativeReplyFile(input), /authorization is no longer valid/);
      assert.equal(authorizationChanged, true);
      const pending = f.state.nativeReplyFilePreparation(id);
      assert.equal(pending.phase, 'preparing');
      assert.equal(f.state.activeFilePreparationCount(), 1);
      assert.equal(f.state.getMessage(id).state, MESSAGE_STATES.UNCERTAIN);
      assert.equal(f.state.hasNativeAcknowledgment(f.state.getMessage(id)), true);
      assert(fs.existsSync(pending.stagedPath));
      assert.throws(() => f.state.reconcileUncertain(id, 'not_submitted'), /native acknowledgment prevents retrying delivery/);
      assert.equal(f.state.getMessage(id).state, MESSAGE_STATES.UNCERTAIN);
    } finally {
      fs.renameSync = originalRename;
      other.close();
    }
  });
});

test('native reply caption mismatch refuses and matching admitted caption retries', async t => {
  for (const provider of ['codex', 'claude']) await t.test(provider, t2 => {
    const f = fixture(t2, provider);
    const id = `native-file-final-caption-${provider}`;
    const source = path.join(f.dir, 'answer.bin');
    fs.writeFileSync(source, Buffer.from('payload'));
    submitted(f, id);
    const input = nativeFileFinalRegressionInput(f, id, source, 'caption A');
    const manifest = f.state.prepareNativeReplyFile(input);
    assert.throws(() => f.state.recordNativeReply({ ...input, text: 'caption B',
      parts: ['caption B'], fileManifest: manifest }), /not admitted for this reply/);
    assert.equal(f.state.listReplyParts(id).length, 0);
    assert.equal(f.state.nativeReplyFilePreparation(id).phase, 'admitted');
    const recorded = f.state.recordNativeReply({ ...input, text: 'caption A',
      parts: ['caption A'], fileManifest: manifest });
    assert.equal(recorded.message.state, MESSAGE_STATES.REPLY_READY);
    assert.equal(f.state.listReplyParts(id).length, 1);
    assert.equal(f.state.listReplyParts(id)[0].content, 'caption A');
    assert.deepEqual(f.state.listReplyParts(id)[0].fileManifest, manifest);
  });
});

test('native reply preparation retry exposes its existing preparation ID', async t => {
  for (const provider of ['codex', 'claude']) await t.test(provider, t2 => {
    const f = fixture(t2, provider);
    const id = `native-file-final-preparing-retry-${provider}`;
    const source = path.join(f.dir, 'answer.bin');
    fs.writeFileSync(source, Buffer.from('payload'));
    submitted(f, id);
    const preparationId = `88888888-8888-4888-8888-${provider === 'codex' ? '888888888888' : '999999999999'}`;
    const stagedPath = path.join(f.dir, '.direct-post-files', `${preparationId}.bin`);
    f.state.receipt(id, 'native-reply-file-preparation', {
      journal: 'native-reply-file-v1',
      phase: 'preparing',
      preparationId,
      messageId: id,
      stagedPath,
      ownerPid: process.pid,
      ownerStartTime: null,
      ownerCommand: null
    });
    assert.throws(() => f.state.prepareNativeReplyFile(nativeFileFinalRegressionInput(f, id, source, 'caption A')), error =>
      /already in progress/.test(error.message) && error.message.includes(preparationId));
    assert.equal(f.state.nativeReplyFilePreparation(id).preparationId, preparationId);
    assert.equal(f.state.activeFilePreparationCount(), 1);
  });
});
