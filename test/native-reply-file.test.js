const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const readline = require('node:readline');
const test = require('node:test');
const { SurfaceState, MESSAGE_STATES } = require('../src/state');
const { DiscordGateway, createSurfaceConsumer } = require('../src/discord');
const { recordNativeAcknowledgment, watchAcknowledgments } = require('../src/acknowledgment.js');

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
  else if (dispatchState === MESSAGE_STATES.SUBMITTED) f.state.markSubmitted(id);
}

function waitForCondition(predicate, timeoutMs = 2000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      if (predicate()) return resolve();
      if (Date.now() - startedAt >= timeoutMs) return reject(new Error('condition was not met before timeout'));
      setImmediate(check);
    };
    check();
  });
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
    provider: f.provider,
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

test('early file-reply acknowledgment wakes the existing Gateway consumer when ready', async t => {
  for (const provider of ['codex', 'claude']) for (const dispatchState of [MESSAGE_STATES.SUBMITTED, MESSAGE_STATES.DISPATCHING, MESSAGE_STATES.UNCERTAIN]) {
    await t.test(`${provider} ${dispatchState}`, async t2 => {
      const f = fixture(t2, provider);
      const id = `native-file-early-ack-${provider}-${dispatchState}`;
      const source = path.join(f.dir, 'answer.bin');
      const bytes = Buffer.from([0, 4, 8, 255]);
      fs.writeFileSync(source, bytes);
      submitted(f, id, dispatchState);
      const reactions = [];
      const posts = [];
      const observations = [];
      const resumes = [];
      const channel = {
        id: 'channel',
        messages: { fetch: async () => ({ react: async reaction => reactions.push(reaction) }) },
        send: async payload => {
          if (!String(payload.content || '').startsWith('Receipt:')) posts.push(payload);
          return { id: `posted-${posts.length}` };
        }
      };
      const client = new EventEmitter();
      client.user = { id: 'bot' };
      client.login = async token => assert.equal(token, 'fixture');
      client.channels = { fetch: async channelId => { assert.equal(channelId, 'channel'); return channel; } };
      client.destroy = async () => {};
      const gateway = new DiscordGateway({ state: f.state, client, providers: {
        [provider]: { observe: async () => { observations.push(id); return { text: 'answer with file' }; } }
      } });
      gateway.registerApplicationCommand = async () => {};
      gateway.recoverTransport = async () => {
        gateway.ready = true;
        return { ready: true, state: 'ready' };
      };
      const resumeSubmitted = gateway.consumer.resumeSubmitted;
      gateway.consumer.resumeSubmitted = (...args) => {
        resumes.push(id);
        return resumeSubmitted(...args);
      };
      try {
        await gateway.start(path.join(f.dir, 'discord.env'));
        await gateway.acknowledgments.drain();
        const manifest = f.state.prepareNativeReplyFile({ provider, messageId: id, nativeId: f.nativeId, generation: 1,
          stateDir: f.dir, sourcePath: source, caption: 'answer with file' });
        await waitForCondition(() => reactions.length === 1);
        await gateway.acknowledgments.drain();
        assert.deepEqual(reactions, ['👀']);
        assert.equal(f.state.getMessage(id).state, dispatchState);
        f.state.recordNativeReply({ provider, messageId: id, nativeId: f.nativeId, generation: 1,
          text: 'answer with file', fileManifest: manifest });
        await gateway.acknowledgments.drain();
        await waitForCondition(() => posts.length === 1);
        assert.deepEqual(resumes, dispatchState === MESSAGE_STATES.SUBMITTED ? [id, id] : [id]);
        assert.deepEqual(observations, dispatchState === MESSAGE_STATES.SUBMITTED ? [id, id] : [id]);
        assert.equal(posts[0].content, 'answer with file');
        assert.deepEqual(posts[0].files[0].attachment, bytes);
        assert.equal(posts[0].files[0].name, 'answer.bin');
        assert.equal(f.state.getMessage(id).state, MESSAGE_STATES.REPLIED);
        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(reactions, ['👀']);
        assert.equal(posts.length, 1);
      } finally {
        await gateway.stop();
      }
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

test('inactive binding cannot release admitted native file custody', async t => {
  for (const provider of ['codex', 'claude']) for (const recorded of [false, true]) {
    await t.test(`${provider} ${recorded ? 'pending' : 'no-part'}`, t2 => {
      const f = fixture(t2, provider);
      const id = `native-file-inactive-${provider}-${recorded}`;
      const source = path.join(f.dir, 'retained.bin');
      const bytes = Buffer.from('retained payload');
      fs.writeFileSync(source, bytes);
      submitted(f, id);
      const manifest = f.state.prepareNativeReplyFile({ provider, messageId: id, nativeId: f.nativeId, generation: 1,
        stateDir: f.dir, sourcePath: source, caption: 'retained caption' });
      if (recorded) f.state.recordNativeReply({ provider, messageId: id, nativeId: f.nativeId, generation: 1,
        text: 'retained caption', fileManifest: manifest });
      f.state.db.prepare('UPDATE bindings SET active=0 WHERE channel_id=?').run('channel');
      assert.equal(f.state.currentMessageBinding(f.state.getMessage(id)).identity, false);
      assert.throws(() => f.state.releaseNativeReplyFilePreparation(id, manifest.preparationId), /sent file part/);
      assert.equal(f.state.nativeReplyFilePreparation(id).phase, 'admitted');
      assert.deepEqual(fs.readFileSync(manifest.stagedPath), bytes);
      assert.equal(f.state.activeFilePreparationCount(), 1);
    });
  }
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
  assert.throws(() => f.state.beginDirectPostFilePreparation(directPreparationSeed(f, 8)), error => {
    assert.match(error.message, /capacity is exhausted/);
    const held = JSON.parse(error.message.slice(error.message.indexOf('[')));
    assert.equal(held.length, 8);
    assert.ok(held.some(detail => detail.preparationId === manifest.preparationId &&
      detail.messageId === id && detail.phase === 'admitted'));
    return true;
  });
  f.state.recordNativeReply({ provider: 'codex', messageId: id, nativeId: f.nativeId, generation: 1, text: 'capacity', fileManifest: manifest });
  f.state.beginReply(id);
  f.state.markReplyPartSent(id, 0, 'capacity-posted');
  f.state.releaseNativeReplyFilePreparation(id, manifest.preparationId);
  assert.equal(f.state.activeFilePreparationCount(), 7);
  assert.equal(f.state.beginDirectPostFilePreparation(directPreparationSeed(f, 8)).phase, 'preparing');
});

test('full native file capacity records ownership without reserving a file', async t => {
  for (const provider of ['codex', 'claude']) await t.test(provider, t2 => {
    const f = fixture(t2, provider);
    for (let index = 0; index < 8; index += 1) f.state.beginDirectPostFilePreparation(directPreparationSeed(f, index));
    const id = `native-file-full-capacity-${provider}`;
    const source = path.join(f.dir, 'full-capacity.bin');
    fs.writeFileSync(source, Buffer.from('full capacity payload'));
    submitted(f, id, MESSAGE_STATES.UNCERTAIN);
    const input = { provider, messageId: id, nativeId: f.nativeId, generation: 1,
      stateDir: f.dir, sourcePath: source, caption: 'full capacity' };

    assert.throws(() => f.state.prepareNativeReplyFile(input), /file custody capacity is exhausted/);
    assert.equal(f.state.activeFilePreparationCount(), 8);
    const refused = f.state.nativeReplyFilePreparation(id);
    assert.deepEqual({ phase: refused?.phase, reservesCapacity: refused?.reservesCapacity },
      { phase: 'preparing', reservesCapacity: false });
    assert.equal(fs.existsSync(path.join(f.dir, '.direct-post-files')), false);
    const acknowledgmentRows = f.state.listReceipts().filter(row => row.discord_id === id && row.kind === 'native-ack');
    assert.equal(acknowledgmentRows.length, 1);
    assert.deepEqual(JSON.parse(acknowledgmentRows[0].detail), { provider, nativeId: f.nativeId, generation: 1, source: 'native-reply-file' });
    assert.throws(() => f.state.reconcileUncertain(id, 'not_submitted'), /native acknowledgment prevents retrying delivery/);
    assert.equal(f.state.claimDispatch(id).claimed, false);

    assert.throws(() => f.state.prepareNativeReplyFile(input), /file custody capacity is exhausted/);
    assert.equal(f.state.listReceipts().filter(row => row.discord_id === id && row.kind === 'native-ack').length, 1);
  });
});

test('native-only capacity rejection reports native holders', async t => {
  for (const provider of ['codex', 'claude']) await t.test(provider, t2 => {
    const f = fixture(t2, provider);
    const holders = [];
    for (let index = 0; index < 8; index += 1) {
      const id = `native-only-holder-${provider}-${index}`;
      const source = path.join(f.dir, `${id}.bin`);
      fs.writeFileSync(source, Buffer.from(id));
      submitted(f, id);
      holders.push(f.state.prepareNativeReplyFile({
        provider,
        messageId: id,
        nativeId: f.nativeId,
        generation: 1,
        stateDir: f.dir,
        sourcePath: source,
        caption: `native holder ${index}`
      }));
    }
    assert.equal(f.state.activeFilePreparationCount(), 8);

    assert.throws(() => f.state.beginDirectPostFilePreparation(directPreparationSeed(f, 8)), error => {
      assert.match(error.message, /capacity is exhausted/);
      const held = JSON.parse(error.message.slice(error.message.indexOf('[')));
      assert.equal(held.length, 8);
      assert.equal(held.every(detail => detail.messageId), true);
      assert.deepEqual(new Set(held.map(detail => detail.messageId)), new Set(holders.map(detail => detail.messageId)));
      assert.deepEqual(new Set(held.map(detail => detail.preparationId)), new Set(holders.map(detail => detail.preparationId)));
      return true;
    });
  });
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

const CONCURRENT_CHILD_DEADLINE_MS = 8000;
const CONCURRENT_PARENT_CASE_TIMEOUT_MS = 3000;
const CONCURRENT_PARENT_DEADLINE_MS = 20000;
function concurrentPreparationWorker() {
  const fs = require('node:fs');
  const path = require('node:path');
  const { parentPort, workerData } = require('node:worker_threads');
  const { SurfaceState } = require(path.join(workerData.snapshot, 'src/state'));
  const state = new SurfaceState(workerData.dbPath);
  const realOpenSync = fs.openSync;
  let stageHeld = true;
  function waitForFile(file) {
    const started = Date.now();
    const cell = new Int32Array(new SharedArrayBuffer(4));
    while (!fs.existsSync(file)) {
      if (Date.now() - started > workerData.deadlineMs - 500) throw new Error('child self-deadline waiting for marker');
      Atomics.wait(cell, 0, 0, 20);
    }
  }
  fs.openSync = function controlledOpenSync(file, ...args) {
    if (stageHeld && String(file).endsWith('.partial')) {
      stageHeld = false;
      fs.writeFileSync(workerData.preparingFile, JSON.stringify({ messageId: workerData.messageId }), { mode: 0o600 });
      waitForFile(workerData.releaseStageFile);
    }
    return realOpenSync.call(fs, file, ...args);
  };
  try {
    const manifest = state.prepareNativeReplyFile({
      provider: workerData.provider,
      messageId: workerData.messageId,
      nativeId: workerData.nativeId,
      generation: 1,
      stateDir: workerData.stateDir,
      sourcePath: workerData.sourcePath,
      caption: workerData.caption
    });
    parentPort.postMessage({ kind: 'admitted', manifest });
    waitForFile(workerData.recordFile);
    const recorded = state.recordNativeReply({
      provider: workerData.provider,
      messageId: workerData.messageId,
      nativeId: workerData.nativeId,
      generation: 1,
      text: workerData.caption,
      fileManifest: manifest
    });
    parentPort.postMessage({ kind: 'recorded', state: recorded.message.state });
  } catch (error) {
    parentPort.postMessage({ kind: 'error', error: String(error?.stack || error) });
    process.exitCode = 1;
  } finally {
    state.close();
  }
}

function concurrentPreparationChild(workerProgram) {
  const { Worker } = require('node:worker_threads');
  const worker = new Worker(workerProgram, {
    eval: true,
    workerData: {
      snapshot: process.env.SNAPSHOT_ROOT,
      dbPath: process.env.DB_PATH,
      stateDir: process.env.STATE_DIR,
      sourcePath: process.env.SOURCE_PATH,
      preparingFile: process.env.PREPARING_FILE,
      releaseStageFile: process.env.RELEASE_STAGE_FILE,
      recordFile: process.env.RECORD_FILE,
      provider: process.env.PROVIDER,
      nativeId: process.env.NATIVE_ID,
      messageId: process.env.MESSAGE_ID,
      caption: process.env.CAPTION,
      deadlineMs: Number(process.env.CHILD_DEADLINE_MS || 8000)
    }
  });
  const deadline = setTimeout(() => {
    console.error('child self-deadline exceeded');
    process.exit(124);
  }, Number(process.env.CHILD_DEADLINE_MS || 8000));
  worker.on('message', message => process.stdout.write(JSON.stringify(message) + '\n'));
  worker.on('error', error => {
    clearTimeout(deadline);
    console.error(error?.stack || String(error));
    process.exitCode = 1;
  });
  worker.on('exit', code => {
    clearTimeout(deadline);
    if (code !== 0) process.exitCode = code;
  });
}

function concurrentPreparationChildProgram() {
  const workerProgram = `(${concurrentPreparationWorker.toString()})()`;
  return `(${concurrentPreparationChild.toString()})(${JSON.stringify(workerProgram)})`;
}

function concurrentWithTimeout(promise, timeoutMs, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function concurrentWaitForFile(file, timeoutMs, label) {
  const started = Date.now();
  while (!fs.existsSync(file)) {
    if (Date.now() - started >= timeoutMs) throw new Error(`${label} exceeded ${timeoutMs}ms`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

function concurrentChildMessages(child) {
  const lines = readline.createInterface({ input: child.stdout });
  const messages = [];
  const waiters = [];
  let stderr = '';
  const fail = error => {
    while (waiters.length) waiters.shift().reject(error);
  };
  lines.on('line', line => {
    if (!line.trim()) return;
    try {
      const message = JSON.parse(line);
      messages.push(message);
      for (let index = waiters.length - 1; index >= 0; index -= 1) {
        const waiter = waiters[index];
        if (message.kind === waiter.kind) {
          waiters.splice(index, 1);
          waiter.resolve(message);
        }
      }
    } catch (error) { fail(error); }
  });
  child.stdout.on('error', fail);
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += chunk; });
  return {
    stderr: () => stderr,
    waitFor(kind, timeoutMs) {
      const existing = messages.find(message => message.kind === kind);
      if (existing) return Promise.resolve(existing);
      return concurrentWithTimeout(new Promise((resolve, reject) => waiters.push({ kind, resolve, reject })), timeoutMs, `child ${kind}`);
    }
  };
}

function concurrentWaitForExit(child, timeoutMs) {
  if (child.exitCode !== null) return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  return concurrentWithTimeout(new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal }))), timeoutMs, 'child exit');
}

test('concurrent PREPARING native file wakes existing Gateway with exact attachment', { timeout: CONCURRENT_PARENT_DEADLINE_MS }, async t => {
  for (const provider of ['codex', 'claude']) await t.test(provider, async t2 => {
    const f = fixture(t2, provider);
    const id = `native-file-concurrent-preparing-${provider}`;
    const source = path.join(f.dir, 'answer.bin');
    const bytes = Buffer.from([0, 4, 8, 255]);
    const caption = `concurrent caption ${provider}`;
    const preparingFile = path.join(f.dir, 'preparing.json');
    const releaseStageFile = path.join(f.dir, 'release-stage');
    const recordFile = path.join(f.dir, 'record-reply');
    fs.writeFileSync(source, bytes);
    submitted(f, id);
    const reactions = [];
    const finalPosts = [];
    const channel = {
      id: 'channel',
      messages: { fetch: async targetId => ({ react: async reaction => { assert.equal(targetId, id); reactions.push(reaction); } }) },
      send: async payload => {
        if (!String(payload.content || '').startsWith('Receipt:')) finalPosts.push(payload);
        return { id: `final-${provider}` };
      }
    };
    const client = new EventEmitter();
    client.user = { id: 'bot' };
    client.login = async token => { assert.equal(token, 'fixture'); return token; };
    client.channels = { fetch: async channelId => { assert.equal(channelId, 'channel'); return channel; } };
    client.destroy = async () => {};
    let observations = 0;
    let observationStarted;
    const observation = new Promise(resolve => { observationStarted = resolve; });
    const gateway = new DiscordGateway({ state: f.state, client, providers: {
      [provider]: { observe: async () => { observations += 1; observationStarted(); return { text: 'observer text' }; } }
    } });
    gateway.registerApplicationCommand = async () => {};
    gateway.recoverTransport = async () => { gateway.ready = true; return { ready: true, state: 'ready' }; };
    gateway.schedulePendingHandoffRecoveryPoll = () => {};
    let child = null;
    try {
      await gateway.start(path.join(f.dir, 'discord.env'));
      await gateway.acknowledgments.drain();
      child = spawn(process.execPath, ['-e', concurrentPreparationChildProgram()], {
        env: {
          ...process.env,
          SNAPSHOT_ROOT: process.env.SNAPSHOT_ROOT || path.resolve(__dirname, '..'),
          DB_PATH: path.join(f.dir, 'surface.sqlite'),
          STATE_DIR: f.dir,
          SOURCE_PATH: source,
          PREPARING_FILE: preparingFile,
          RELEASE_STAGE_FILE: releaseStageFile,
          RECORD_FILE: recordFile,
          PROVIDER: provider,
          NATIVE_ID: f.nativeId,
          MESSAGE_ID: id,
          CAPTION: caption,
          CHILD_DEADLINE_MS: String(CONCURRENT_CHILD_DEADLINE_MS)
        },
        stdio: ['ignore', 'pipe', 'pipe']
      });
      const childState = concurrentChildMessages(child);
      await concurrentWaitForFile(preparingFile, CONCURRENT_PARENT_CASE_TIMEOUT_MS, 'child PREPARING signal').catch(error => {
        throw new Error(`${error.message}; stderr=${childState.stderr()}`);
      });
      await gateway.acknowledgments.drain();
      await concurrentWithTimeout(observation, CONCURRENT_PARENT_CASE_TIMEOUT_MS, 'submitted observation');
      assert.equal(observations, 1);
      assert.equal(reactions.length, 1);
      assert.deepEqual(reactions, ['👀']);
      assert.equal(f.state.getMessage(id).state, MESSAGE_STATES.SUBMITTED);
      assert.equal(f.state.nativeReplyFilePreparation(id).phase, 'preparing');

      fs.writeFileSync(releaseStageFile, 'release\n', { mode: 0o600 });
      const admitted = await childState.waitFor('admitted', CONCURRENT_PARENT_CASE_TIMEOUT_MS);
      assert.equal(admitted.manifest.filename, 'answer.bin');
      fs.writeFileSync(recordFile, 'record\n', { mode: 0o600 });
      await childState.waitFor('recorded', CONCURRENT_PARENT_CASE_TIMEOUT_MS);
      const exit = await concurrentWaitForExit(child, CONCURRENT_PARENT_CASE_TIMEOUT_MS);
      assert.equal(exit.code, 0, childState.stderr());
      for (let attempt = 0; attempt < 3 && finalPosts.length === 0; attempt += 1) {
        await gateway.acknowledgments.drain();
        await new Promise(resolve => setImmediate(resolve));
      }
      await waitForCondition(() => finalPosts.length === 1, CONCURRENT_PARENT_CASE_TIMEOUT_MS);
      assert.equal(finalPosts.length, 1);
      assert.equal(reactions.length, 1);
      assert.equal(finalPosts[0].content, caption);
      assert.equal(finalPosts[0].files.length, 1);
      assert.deepEqual(finalPosts[0].files[0].attachment, bytes);
      assert.equal(finalPosts[0].files[0].name, 'answer.bin');
      assert.equal(f.state.getMessage(id).state, MESSAGE_STATES.REPLIED);
      const manifest = f.state.nativeReplyFilePreparation(id);
      assert.equal(manifest.phase, 'admitted');
      assert.equal(f.state.releaseNativeReplyFilePreparation(id, manifest.preparationId).phase, 'released');
      assert.equal(f.state.activeFilePreparationCount(), 0);
      assert.equal(fs.existsSync(manifest.stagedPath), false);
    } finally {
      try {
        if (child && child.exitCode === null && child.signalCode === null) {
          const exited = concurrentWaitForExit(child, CONCURRENT_PARENT_CASE_TIMEOUT_MS);
          child.kill('SIGKILL');
          await exited;
        }
      } finally {
        await gateway.stop();
      }
    }
  });
});

test('startup initial drain wakes a reply-ready native file', async t => {
  for (const provider of ['codex', 'claude']) await t.test(provider, async t2 => {
    const f = fixture(t2, provider);
    const id = `native-file-startup-ready-${provider}`;
    const source = path.join(f.dir, 'startup.bin');
    fs.writeFileSync(source, Buffer.from(`startup bytes ${provider}`));
    submitted(f, id, MESSAGE_STATES.SUBMITTED);
    recordNativeAcknowledgment(f.state, { provider, messageId: id, nativeId: f.nativeId, generation: 1 });

    const acknowledgmentReactions = [];
    const acknowledgmentWatch = watchAcknowledgments({
      state: f.state,
      send: async (_message, reaction) => {
        acknowledgmentReactions.push(reaction);
        return { targetMessageId: id };
      }
    });
    try {
      await acknowledgmentWatch.drain();
    } finally {
      await acknowledgmentWatch.stop();
    }
    assert.deepEqual(acknowledgmentReactions, ['👀']);

    const manifest = f.state.prepareNativeReplyFile({
      provider,
      messageId: id,
      nativeId: f.nativeId,
      generation: 1,
      stateDir: f.dir,
      sourcePath: source,
      caption: 'startup caption'
    });
    f.state.recordNativeReply({
      provider,
      messageId: id,
      nativeId: f.nativeId,
      generation: 1,
      text: 'startup caption',
      fileManifest: manifest
    });
    assert.equal(f.state.getMessage(id).state, MESSAGE_STATES.REPLY_READY);

    const resumed = [];
    const unexpectedAcknowledgmentDeliveries = [];
    const startupWatch = watchAcknowledgments({
      state: f.state,
      send: async (_message, reaction) => {
        unexpectedAcknowledgmentDeliveries.push(reaction);
        return { targetMessageId: id };
      },
      deliver: async () => {
        throw new Error('reply-ready startup wake must not deliver another acknowledgment');
      },
      onAcknowledged: messageId => {
        resumed.push(messageId);
      }
    });
    try {
      await startupWatch.drain();
      await waitForCondition(() => resumed.length === 1, 1000).catch(error => {
        throw new Error(`startup initial drain did not wake reply-ready native file: ${error.message}`);
      });
      assert.deepEqual(resumed, [id]);
      assert.deepEqual(unexpectedAcknowledgmentDeliveries, []);
    } finally {
      await startupWatch.stop();
    }
  });
});

test('full-capacity refusal blocks competing text until later file retry', async t => {
  for (const provider of ['codex', 'claude']) for (const dispatchState of [MESSAGE_STATES.SUBMITTED, MESSAGE_STATES.UNCERTAIN]) {
    await t.test(`${provider} ${dispatchState}`, t2 => {
      const f = fixture(t2, provider);
      const held = [];
      try {
        for (let index = 0; index < 8; index += 1) {
          const seed = directPreparationSeed(f, index);
          seed.ownerPid = 999999;
          seed.ownerStartTime = null;
          seed.ownerCommand = null;
          held.push(f.state.beginDirectPostFilePreparation(seed));
        }
        assert.equal(f.state.activeFilePreparationCount(), 8);

        const id = `native-file-capacity-retry-${provider}-${dispatchState}`;
        const source = path.join(f.dir, 'capacity-retry.bin');
        fs.writeFileSync(source, Buffer.from(`capacity retry bytes ${provider}`));
        submitted(f, id, dispatchState);
        const input = {
          provider,
          messageId: id,
          nativeId: f.nativeId,
          generation: 1,
          stateDir: f.dir,
          sourcePath: source,
          caption: 'capacity retry caption'
        };

        assert.throws(() => f.state.prepareNativeReplyFile(input), /file custody capacity is exhausted/);
        const refused = f.state.nativeReplyFilePreparation(id);
        const other = new SurfaceState(path.join(f.dir, 'surface.sqlite'));
        try {
          assert.throws(
            () => other.recordNativeReply({ ...input, text: 'competing text' }),
            /native reply file preparation is still in progress/,
            'capacity refusal must keep competing text from closing the reply'
          );
        } finally {
          other.close();
        }

        assert.deepEqual(
          { phase: refused?.phase, reservesCapacity: refused?.reservesCapacity },
          { phase: 'preparing', reservesCapacity: false }
        );
        assert.equal(f.state.getMessage(id).state, dispatchState);
        assert.equal(f.state.listReplyParts(id).length, 0);
        assert.equal(f.state.activeFilePreparationCount(), 8);
        assert.equal(fs.existsSync(path.join(f.dir, '.direct-post-files')), false);

        assert.equal(f.state.releaseDirectPostFilePreparation(held[0].preparationId).phase, 'released');
        assert.equal(f.state.activeFilePreparationCount(), 7);

        const manifest = f.state.prepareNativeReplyFile(input);
        assert.equal(manifest.phase, 'admitted');
        assert.notEqual(manifest.preparationId, refused.preparationId);
        assert.equal(f.state.nativeReplyFilePreparation(id).preparationId, manifest.preparationId);
        assert.equal(f.state.activeFilePreparationCount(), 8);

        const recorded = f.state.recordNativeReply({
          ...input,
          text: 'capacity retry caption',
          fileManifest: manifest
        });
        assert.equal(recorded.message.state, MESSAGE_STATES.REPLY_READY);
        assert.equal(f.state.listReplyParts(id)[0].fileManifest.preparationId, manifest.preparationId);
        f.state.beginReply(id);
        f.state.markReplyPartSent(id, 0, 'capacity-retry-posted');
        assert.equal(f.state.releaseNativeReplyFilePreparation(id, manifest.preparationId).phase, 'released');
        assert.equal(f.state.activeFilePreparationCount(), 7);
      } finally {
        for (const preparation of held) {
          try {
            f.state.releaseDirectPostFilePreparation(preparation.preparationId);
          } catch {}
        }
      }
    });
  }
});

test('old capacity refusal cleanup cannot shadow a later admitted native file', async t => {
  for (const provider of ['codex', 'claude']) await t.test(provider, t2 => {
    const f = fixture(t2, provider);
    const held = [];
    const ownerAlive = f.state.directPostOwnerAlive;
    try {
      for (let index = 0; index < 8; index += 1) {
        const seed = directPreparationSeed(f, index);
        seed.ownerPid = 999999;
        seed.ownerStartTime = null;
        seed.ownerCommand = null;
        held.push(f.state.beginDirectPostFilePreparation(seed));
      }
      assert.equal(f.state.activeFilePreparationCount(), 8);

      const id = `native-file-marker-shadow-${provider}`;
      const source = path.join(f.dir, 'marker-shadow.bin');
      const originalBytes = Buffer.from(`marker shadow bytes ${provider}`);
      fs.writeFileSync(source, originalBytes);
      submitted(f, id, MESSAGE_STATES.SUBMITTED);
      const input = {
        provider,
        messageId: id,
        nativeId: f.nativeId,
        generation: 1,
        stateDir: f.dir,
        sourcePath: source,
        caption: 'marker shadow caption'
      };

      assert.throws(() => f.state.prepareNativeReplyFile(input), /file custody capacity is exhausted/);
      const oldMarker = f.state.nativeReplyFilePreparation(id);
      assert.deepEqual(
        { phase: oldMarker?.phase, reservesCapacity: oldMarker?.reservesCapacity },
        { phase: 'preparing', reservesCapacity: false }
      );
      assert.equal(f.state.activeFilePreparationCount(), 8);

      f.state.directPostOwnerAlive = () => false;
      assert.equal(f.state.releaseDirectPostFilePreparation(held[0].preparationId).phase, 'released');
      assert.equal(f.state.activeFilePreparationCount(), 7);

      const admitted = f.state.prepareNativeReplyFile(input);
      assert.equal(admitted.phase, 'admitted');
      assert.notEqual(admitted.preparationId, oldMarker.preparationId);
      assert.equal(f.state.activeFilePreparationCount(), 8);

      const releasedOld = f.state.releaseNativeReplyFilePreparation(id, oldMarker.preparationId);
      assert.equal(releasedOld.phase, 'released');
      const latest = f.state.nativeReplyFilePreparation(id);
      assert.equal(latest.phase, 'admitted');
      assert.equal(latest.preparationId, admitted.preparationId);
      assert.equal(f.state.activeFilePreparationCount(), 8);
      assert.equal(fs.existsSync(admitted.stagedPath), true);
      assert.deepEqual(fs.readFileSync(admitted.stagedPath), originalBytes);

      const other = new SurfaceState(path.join(f.dir, 'surface.sqlite'));
      try {
        assert.throws(
          () => other.recordNativeReply({ ...input, text: 'competing text after old marker cleanup' }),
          /native reply file custody requires its admitted attachment/
        );
      } finally {
        other.close();
      }

      const recorded = f.state.recordNativeReply({
        ...input,
        text: input.caption,
        fileManifest: admitted
      });
      assert.equal(recorded.message.state, MESSAGE_STATES.REPLY_READY);
      f.state.beginReply(id);
      f.state.markReplyPartSent(id, 0, 'marker-shadow-posted');
      assert.equal(f.state.releaseNativeReplyFilePreparation(id, admitted.preparationId).phase, 'released');
      assert.equal(f.state.activeFilePreparationCount(), 7);
      assert.equal(fs.existsSync(admitted.stagedPath), false);
    } finally {
      for (const preparation of held) {
        try {
          f.state.releaseDirectPostFilePreparation(preparation.preparationId);
        } catch {}
      }
      f.state.directPostOwnerAlive = ownerAlive;
    }
  });
});

test('terminal native file retry validates its immutable request identity', t => {
  const f = fixture(t, 'codex');
  const id = 'native-file-terminal-retry-identity';
  const source = path.join(f.dir, 'terminal-retry.bin');
  fs.writeFileSync(source, Buffer.from('terminal retry bytes'));
  submitted(f, id, MESSAGE_STATES.SUBMITTED);
  const input = {
    provider: 'codex',
    messageId: id,
    nativeId: f.nativeId,
    generation: 1,
    stateDir: f.dir,
    sourcePath: source,
    caption: 'terminal retry caption'
  };

  const manifest = f.state.prepareNativeReplyFile(input);
  f.state.recordNativeReply({ ...input, text: input.caption, fileManifest: manifest });
  assert.equal(f.state.getMessage(id).state, MESSAGE_STATES.REPLY_READY);

  assert.throws(
    () => f.state.prepareNativeReplyFile({ ...input, caption: 'different terminal caption' }),
    /identity conflicts with its admitted custody/
  );

  fs.writeFileSync(source, Buffer.from('different terminal bytes'));
  assert.throws(
    () => f.state.prepareNativeReplyFile(input),
    /identity conflicts with its admitted custody/
  );
  assert.equal(f.state.nativeReplyFilePreparation(id).preparationId, manifest.preparationId);
});
