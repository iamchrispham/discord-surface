const {
  assert,
  fs,
  path,
  test,
  SurfaceState,
  MESSAGE_STATES,
  recordNativeAcknowledgment,
  watchAcknowledgments,
  fixture,
  submitted,
  waitForCondition,
  directPreparationSeed
} = require('./native-reply-file-fixture');

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
        assert.throws(() => f.state.prepareNativeReplyFile(input), /file custody capacity is exhausted/);
        assert.equal(f.state.nativeReplyFilePreparation(id).preparationId, refused.preparationId);
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

test('newest capacity refusal cleanup survives changed caption and reopen', async t => {
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
        assert.throws(() => f.state.prepareNativeReplyFile({ ...input, caption: 'revised caption' }), /file custody capacity is exhausted/);
        const latest = f.state.nativeReplyFilePreparation(id);
        assert.notEqual(latest.preparationId, refused.preparationId);
        const originalAlive = f.state.directPostOwnerAlive;
        f.state.directPostOwnerAlive = () => false;
        try { assert.equal(f.state.releaseNativeReplyFilePreparation(id, latest.preparationId).phase, 'released'); }
        finally { f.state.directPostOwnerAlive = originalAlive; }
        assert.equal(f.state.nativeReplyFilePreparation(id).preparationId, latest.preparationId);
        assert.equal(f.state.nativeReplyFilePreparation(id).phase, 'released');
        assert.equal(f.state.activeFilePreparationCount(), 8);
        const reopened = new SurfaceState(path.join(f.dir, 'surface.sqlite'));
        try {
          const reply = reopened.recordNativeReply({ ...input, text: 'text after explicit non-reserving cleanup' });
          assert.equal(reply.message.state, MESSAGE_STATES.REPLY_READY);
        } finally { reopened.close(); }
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
