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
  directPreparationSeed
} = require('./native-reply-file-fixture');

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
