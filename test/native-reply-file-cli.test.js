const {
  assert,
  fs,
  path,
  spawnSync,
  EventEmitter,
  test,
  SurfaceState,
  MESSAGE_STATES,
  DiscordGateway,
  createSurfaceConsumer,
  fixture,
  submitted
} = require('./native-reply-file-fixture');

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

test('capacity refusal CLI exposes the cleanup ID and reopens text replies', async t => {
  for (const provider of ['codex', 'claude']) await t.test(provider, t2 => {
    const f = fixture(t2, provider);
    for (let index = 0; index < 8; index += 1) {
      f.state.receipt(null, 'direct-post-file-preparation', {
        journal: 'direct-post-v1',
        preparationId: `55555555-5555-4555-8555-${String(index).padStart(12, '0')}`,
        requestId: `direct-capacity-cli-${index}`,
        phase: 'preparing',
        reservesCapacity: true
      });
    }

    const id = `native-file-capacity-cli-${provider}`;
    const textFile = path.join(f.dir, 'reply.txt');
    const source = path.join(f.dir, 'capacity.bin');
    fs.writeFileSync(textFile, 'capacity reply');
    fs.writeFileSync(source, Buffer.from('capacity payload'));
    submitted(f, id);
    const cli = path.join(__dirname, '..', 'src', 'cli.js');
    const nativeArgs = [cli, 'native-reply', '--state-dir', f.dir, '--provider', provider,
      '--message-id', id, '--native-id', f.nativeId, '--generation', '1', '--text-file', textFile,
      '--attachment-file', source];
    const first = spawnSync(process.execPath, nativeArgs, { encoding: 'utf8' });
    assert.equal(first.status, 1, first.stdout);
    const firstMatch = first.stderr.match(/file custody capacity is exhausted: ([^\s]+)/);
    assert.ok(firstMatch, first.stderr);
    const preparationId = firstMatch[1];
    assert.equal(f.state.nativeReplyFilePreparation(id).preparationId, preparationId);

    const duplicate = spawnSync(process.execPath, nativeArgs, { encoding: 'utf8' });
    assert.equal(duplicate.status, 1, duplicate.stdout);
    const duplicateMatch = duplicate.stderr.match(/file custody capacity is exhausted: ([^\s]+)/);
    assert.ok(duplicateMatch, duplicate.stderr);
    assert.equal(duplicateMatch[1], preparationId);
    assert.equal(f.state.activeFilePreparationCount(), 8);
    assert.equal(fs.existsSync(path.join(f.dir, '.direct-post-files')), false);

    const cleanup = spawnSync(process.execPath, [cli, 'native-reply-file-cleanup', '--state-dir', f.dir,
      '--message-id', id, '--preparation-id', preparationId], { encoding: 'utf8' });
    assert.equal(cleanup.status, 0, cleanup.stderr);
    assert.match(cleanup.stdout, /"phase": "released"/);

    const textReply = spawnSync(process.execPath, [cli, 'native-reply', '--state-dir', f.dir, '--provider', provider,
      '--message-id', id, '--native-id', f.nativeId, '--generation', '1', '--text-file', textFile], { encoding: 'utf8' });
    assert.equal(textReply.status, 0, textReply.stderr);
    assert.match(textReply.stdout, /"recorded": true/);
    assert.equal(f.state.getMessage(id).state, MESSAGE_STATES.REPLY_READY);
  });
});
