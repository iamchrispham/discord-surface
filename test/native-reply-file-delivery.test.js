const {
  assert,
  fs,
  path,
  EventEmitter,
  test,
  SurfaceState,
  MESSAGE_STATES,
  DiscordGateway,
  fixture,
  submitted,
  waitForCondition
} = require('./native-reply-file-fixture');

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

test('native file send rechecks authorization after loading the snapshot', async t => {
  for (const provider of ['codex', 'claude']) await t.test(provider, async t2 => {
    const f = fixture(t2, provider);
    const id = `native-file-snapshot-auth-${provider}`;
    const source = path.join(f.dir, 'answer.bin');
    fs.writeFileSync(source, Buffer.from('snapshot authorization payload'));
    submitted(f, id);
    const input = { provider, messageId: id, nativeId: f.nativeId, generation: 1,
      stateDir: f.dir, sourcePath: source, caption: 'snapshot authorization' };
    const manifest = f.state.prepareNativeReplyFile(input);
    f.state.recordNativeReply({ ...input, text: input.caption, fileManifest: manifest });
    f.state.beginReply(id);
    const other = new SurfaceState(path.join(f.dir, 'surface.sqlite'));
    const originalReadFileSync = fs.readFileSync;
    let snapshotRead = false;
    let sends = 0;
    const channel = { id: 'channel', send: async () => { sends += 1; return { id: 'posted' }; } };
    const client = new EventEmitter();
    client.user = { id: 'bot' };
    const gateway = new DiscordGateway({ state: f.state, client });
    try {
      fs.readFileSync = (...args) => {
        const bytes = originalReadFileSync(...args);
        if (!snapshotRead && path.resolve(String(args[0])) === path.resolve(manifest.stagedPath)) {
          snapshotRead = true;
          other.setConfig({ operatorId: 'different-operator', guildId: 'guild', secretFile: path.join(f.dir, 'discord.env') });
        }
        return bytes;
      };
      await assert.rejects(() => gateway.sendReply({ id, channel }, {
        id, replyText: input.caption, replyNonce: f.state.getMessage(id).replyNonce,
        replyPart: f.state.listReplyParts(id)[0]
      }), /authorization|authorized|stale/);
    } finally {
      fs.readFileSync = originalReadFileSync;
      other.close();
    }
    assert.equal(snapshotRead, true);
    assert.equal(sends, 0);
    assert.equal(f.state.nativeReplyFilePreparation(id).phase, 'admitted');
    assert.deepEqual(f.state.listReplyParts(id)[0].fileManifest, manifest);
  });
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
