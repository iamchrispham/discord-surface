const {
  assert,
  fs,
  path,
  test,
  SurfaceState,
  MESSAGE_STATES,
  fixture,
  submitted
} = require('./native-reply-file-fixture');

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
