const {
  assert,
  fs,
  path,
  EventEmitter,
  test,
  SurfaceState,
  MESSAGE_STATES,
  DiscordGateway,
  createSurfaceConsumer,
  fixture,
  submitted,
  directPreparationSeed
} = require('./native-reply-file-fixture');

test('HTTP 413 native file upload is definite not-sent and retries the retained snapshot', async t => {
  for (const provider of ['codex', 'claude']) await t.test(provider, async t2 => {
    const f = fixture(t2, provider);
    const id = `native-file-413-${provider}`;
    const source = path.join(f.dir, 'answer.bin');
    const bytes = Buffer.from('413 retained snapshot payload');
    fs.writeFileSync(source, bytes);
    submitted(f, id);
    const input = { provider, messageId: id, nativeId: f.nativeId, generation: 1,
      stateDir: f.dir, sourcePath: source, caption: '413 retained snapshot' };
    const manifest = f.state.prepareNativeReplyFile(input);
    f.state.recordNativeReply({ ...input, text: input.caption, fileManifest: manifest });
    let sends = 0;
    const channel = {
      id: 'channel',
      send: async payload => {
        sends += 1;
        if (sends === 1) {
          const error = new Error('attachment exceeds Discord upload limit');
          error.status = 413;
          throw error;
        }
        assert.deepEqual(payload.files[0].attachment, bytes);
        return { id: 'posted-after-413' };
      }
    };
    const client = new EventEmitter();
    client.user = { id: 'bot' };
    const gateway = new DiscordGateway({ state: f.state, client });
    const consumer = createSurfaceConsumer({ state: f.state, providers: {},
      sendReply: (message, reply) => gateway.sendReply(message, reply) });
    const first = await consumer.deliverReply({ id, channel }, { message: f.state.getMessage(id) });
    assert.equal(first.error.outcome, 'failed');
    assert.equal(first.message.state, 'reply_failed');
    assert.equal(f.state.nativeReplyFilePreparation(id).phase, 'admitted');
    assert.deepEqual(f.state.listReplyParts(id)[0].fileManifest, manifest);
    f.state.reconcileReplyDelivery(id, 'not_sent');
    const second = await consumer.deliverReply({ id, channel }, { message: f.state.getMessage(id) });
    assert.equal(second.message.state, 'replied');
    assert.equal(sends, 2);
    assert.equal(f.state.listReplyParts(id)[0].fileManifest.preparationId, manifest.preparationId);
  });
});

test('old capacity refusal cleanup cannot shadow a later admitted native file', async t => {
  for (const provider of ['codex', 'claude']) for (const cleanupFirst of [true, false]) await t.test(`${provider} old cleanup first ${cleanupFirst}`, t2 => {
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

      if (cleanupFirst) assert.equal(f.state.releaseNativeReplyFilePreparation(id, oldMarker.preparationId).phase, 'released');
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
      assert.equal(f.state.nativeReplyFilePreparation(id).preparationId, admitted.preparationId);
      assert.equal(f.state.nativeReplyFilePreparation(id).phase, 'released');
      if (!cleanupFirst) assert.equal(f.state.releaseNativeReplyFilePreparation(id, oldMarker.preparationId).phase, 'released');
      assert.equal(f.state.nativeReplyFilePreparation(id).preparationId, admitted.preparationId);
      assert.equal(f.state.nativeReplyFilePreparation(id).phase, 'released');
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

test('terminal native file retry validates its immutable request identity', async t => {
  for (const provider of ['codex', 'claude']) for (const terminalState of [MESSAGE_STATES.REPLY_READY, MESSAGE_STATES.REPLIED]) {
    await t.test(`${provider} ${terminalState}`, t2 => {
      const f = fixture(t2, provider);
      const id = `native-file-terminal-retry-${provider}-${terminalState}`;
      const source = path.join(f.dir, 'terminal-retry.bin');
      fs.writeFileSync(source, Buffer.from('terminal retry bytes'));
      submitted(f, id, MESSAGE_STATES.SUBMITTED);
      const input = {
        provider, messageId: id, nativeId: f.nativeId, generation: 1,
        stateDir: f.dir, sourcePath: source, caption: 'terminal retry caption'
      };
      const manifest = f.state.prepareNativeReplyFile(input);
      f.state.recordNativeReply({ ...input, text: input.caption, fileManifest: manifest });
      if (terminalState === MESSAGE_STATES.REPLIED) {
        f.state.beginReply(id);
        f.state.markReplyPartSent(id, 0, 'terminal-retry-posted');
      }
      assert.equal(f.state.getMessage(id).state, terminalState);
      const originalParts = f.state.listReplyParts(id);
      const originalCapacity = f.state.activeFilePreparationCount();
      assert.deepEqual(f.state.prepareNativeReplyFile(input), manifest);
      assert.throws(
        () => f.state.prepareNativeReplyFile({ ...input, caption: 'different terminal caption' }),
        /identity conflicts with its admitted custody/
      );
      fs.writeFileSync(source, Buffer.from('different terminal bytes'));
      assert.throws(
        () => f.state.prepareNativeReplyFile(input),
        /identity conflicts with its admitted custody/
      );
      assert.deepEqual(f.state.nativeReplyFilePreparation(id), manifest);
      assert.deepEqual(f.state.listReplyParts(id), originalParts);
      assert.equal(f.state.activeFilePreparationCount(), originalCapacity);
      assert.equal(f.state.getMessage(id).state, terminalState);
    });
  }
});
