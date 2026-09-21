const {
  test,
  assert,
  fs,
  os,
  path,
  ORDINARY_BINDING_DECISIONS,
  ordinaryBindingDecision,
  sessionRoot,
  PROVIDERS,
  READINESS,
  ORDINARY_RECEIPT_KINDS,
  CODEX,
  OTHER,
  fixture,
  ordinary,
  transcript
} = require('./ordinary-codex-fixture');

test('ordinary binding decision refuses a non-ordinary or inactive existing owner', () => {
  const request = {
    provider: PROVIDERS.CODEX, channelId: 'channel', guildId: 'guild', nativeId: CODEX, workspace: '/tmp/workspace',
    identity: { sessionId: CODEX, threadId: CODEX }
  };
  assert.equal(ordinaryBindingDecision(null, request), ORDINARY_BINDING_DECISIONS.BIND);
  assert.equal(ordinaryBindingDecision({ ...request, active: true }, request, true), ORDINARY_BINDING_DECISIONS.REUSE);
  assert.equal(ordinaryBindingDecision({ ...request, active: false }, request, true), ORDINARY_BINDING_DECISIONS.REBIND);
  assert.throws(() => ordinaryBindingDecision({ ...request, active: true, conductorId: 'conductor' }, request, false), /already bound/);
});

test('ordinary bind starts pending with paired null conductor identity and holds intake', t => {
  const f = fixture(t);
  const binding = ordinary(f);
  assert.equal(binding.readiness, READINESS.PENDING);
  assert.equal(binding.conductorId, null);
  assert.equal(binding.repoKey, null);
  assert.equal(f.state.isOrdinaryBinding(binding), true);
  assert.throws(() => f.state.rebind({
    channelId: binding.channelId, guildId: 'guild', provider: PROVIDERS.CODEX, nativeId: OTHER, workspace: f.dir
  }), /matching invocation identity/);
  const accepted = f.state.acceptDiscordMessage({
    id: 'pending-input', guildId: 'guild', channelId: binding.channelId,
    authorId: 'operator', isBot: false, content: 'held'
  }, { ready: false });
  assert.equal(accepted.accepted, true);
  assert.equal(f.state.claimDispatch('pending-input').reason, 'binding-not-ready');
  assert.equal(f.state.getMessage('pending-input').state, 'accepted');
  assert.throws(() => f.state.bindOrdinary({
    channelId: 'second-channel', guildId: 'guild', provider: PROVIDERS.CODEX, nativeId: CODEX, workspace: f.dir
  }, f.identity), /already owned/);
  assert.throws(() => f.state.bindOrdinary({
    channelId: binding.channelId, guildId: 'guild', provider: PROVIDERS.CODEX, nativeId: OTHER, workspace: f.dir
  }, { sessionId: OTHER, threadId: OTHER }), /already bound/);
  assert.throws(() => f.state.bindOrdinary({
    channelId: 'identity-mismatch', guildId: 'guild', provider: PROVIDERS.CODEX, nativeId: CODEX, workspace: f.dir
  }, { sessionId: OTHER, threadId: OTHER }), /does not match the native session/);
});

test('ordinary classification excludes a conductor-owned Codex binding', t => {
  const f = fixture(t);
  const binding = f.state.bind({
    channelId: 'conductor-owned', guildId: 'guild', provider: PROVIDERS.CODEX, nativeId: CODEX,
    workspace: f.dir, conductorId: 'conductor', repoKey: 'repo:test'
  });
  f.state.receipt(null, ORDINARY_RECEIPT_KINDS.BOUND, {
    channelId: binding.channelId, provider: binding.provider, nativeId: binding.nativeId,
    workspace: binding.workspace, generation: binding.generation
  });
  assert.equal(f.state.isOrdinaryBindingRecord(binding), false);
  assert.equal(f.state.isOrdinaryBinding(binding), false);
});

test('ordinary binding permits a verified transcript-root relocation', t => {
  const f = fixture(t);
  const binding = ordinary(f);
  const sessionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinary-relocated-root-'));
  t.after(() => fs.rmSync(sessionRoot, { recursive: true, force: true }));
  const request = {
    provider: PROVIDERS.CODEX, channelId: binding.channelId, guildId: 'guild', nativeId: CODEX,
    workspace: f.dir, sessionRoot, identity: { sessionId: CODEX, threadId: CODEX }
  };
  const proof = {
    file: path.join(sessionRoot, `${CODEX}.jsonl`), sessionId: CODEX, threadId: CODEX,
    workspace: f.dir, sessionRoot
  };
  assert.throws(() => ordinaryBindingDecision(binding, request, true), /already bound/);
  assert.equal(ordinaryBindingDecision(binding, request, true, proof), ORDINARY_BINDING_DECISIONS.REBIND);
  const relocated = f.state.rebindOrdinary(request, request.identity, proof);
  assert.equal(relocated.sessionRoot, sessionRoot);
  assert.equal(relocated.generation, 2);
});

test('ordinary root relocation reopens a drained terminal intake watermark', t => {
  const f = fixture(t);
  const binding = ordinary(f);
  f.state.markIntakeBoundary(binding.channelId, READINESS.GAP, 'previous recovery gap', 'gap-from', 'gap-to');
  const sessionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinary-relocated-terminal-root-'));
  t.after(() => fs.rmSync(sessionRoot, { recursive: true, force: true }));
  const request = {
    provider: PROVIDERS.CODEX, channelId: binding.channelId, guildId: 'guild', nativeId: CODEX,
    workspace: f.dir, sessionRoot, identity: { sessionId: CODEX, threadId: CODEX }
  };
  const proof = {
    file: path.join(sessionRoot, `${CODEX}.jsonl`), sessionId: CODEX, threadId: CODEX,
    workspace: f.dir, sessionRoot
  };
  const relocated = f.state.rebindOrdinary(request, request.identity, proof);
  assert.equal(relocated.generation, 2);
  const watermark = f.state.getIntakeWatermark(binding.channelId);
  assert.equal(watermark.state, 'pending');
  assert.equal(watermark.gap_from, null);
  assert.equal(watermark.gap_to, null);
});

test('ordinary root relocation refuses an in-flight dispatch', t => {
  const f = fixture(t);
  const binding = ordinary(f);
  const sessionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinary-relocated-dispatch-root-'));
  t.after(() => fs.rmSync(sessionRoot, { recursive: true, force: true }));
  f.state.recordOrdinaryPreflight(binding, {
    file: path.join(f.dir, 'session.jsonl'), sessionId: CODEX, threadId: CODEX, workspace: f.dir
  });
  f.state.markIntakeBoundary(binding.channelId, 'ready', null, null, null, binding);
  const accepted = f.state.acceptDiscordMessage({
    id: 'dispatching-root-relocation', guildId: 'guild', channelId: binding.channelId,
    authorId: 'operator', isBot: false, content: 'dispatching'
  });
  assert.equal(accepted.accepted, true);
  f.state.claimDispatch(accepted.message.id);
  const request = {
    provider: 'codex', channelId: binding.channelId, guildId: 'guild', nativeId: CODEX,
    workspace: f.dir, sessionRoot, identity: { sessionId: CODEX, threadId: CODEX }
  };
  const proof = {
    file: path.join(sessionRoot, `${CODEX}.jsonl`), sessionId: CODEX, threadId: CODEX,
    workspace: f.dir, sessionRoot
  };
  assert.throws(() => f.state.rebindOrdinary(request, request.identity, proof), /work drains|dispatch/);
  assert.equal(f.state.getBinding(binding.channelId).sessionRoot, binding.sessionRoot);
});

test('ordinary root relocation refuses an uncertain dispatch', t => {
  const f = fixture(t);
  const binding = ordinary(f);
  const sessionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinary-relocated-uncertain-root-'));
  t.after(() => fs.rmSync(sessionRoot, { recursive: true, force: true }));
  f.state.recordOrdinaryPreflight(binding, {
    file: path.join(f.dir, 'session.jsonl'), sessionId: CODEX, threadId: CODEX, workspace: f.dir
  });
  f.state.markIntakeBoundary(binding.channelId, 'ready', null, null, null, binding);
  const accepted = f.state.acceptDiscordMessage({
    id: 'uncertain-root-relocation', guildId: 'guild', channelId: binding.channelId,
    authorId: 'operator', isBot: false, content: 'uncertain'
  });
  assert.equal(accepted.accepted, true);
  f.state.claimDispatch(accepted.message.id);
  f.state.markUncertain(accepted.message.id, new Error('dispatch outcome unknown'));
  const request = {
    provider: 'codex', channelId: binding.channelId, guildId: 'guild', nativeId: CODEX,
    workspace: f.dir, sessionRoot, identity: { sessionId: CODEX, threadId: CODEX }
  };
  const proof = {
    file: path.join(sessionRoot, `${CODEX}.jsonl`), sessionId: CODEX, threadId: CODEX,
    workspace: f.dir, sessionRoot
  };
  assert.throws(() => f.state.rebindOrdinary(request, request.identity, proof), /work drains|dispatch/);
  assert.equal(f.state.getBinding(binding.channelId).sessionRoot, binding.sessionRoot);
});
