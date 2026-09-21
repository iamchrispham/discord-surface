const {
  test,
  assert,
  spawnSync,
  fs,
  os,
  path,
  createOrdinaryCodexRequestFromEnvironment,
  resolveExistingChannel,
  resolveInvocationIdentity,
  ORDINARY_RECEIPT_KINDS,
  facade,
  emitted,
  ordinaryConstantsFacade,
  ordinaryConstantsEmitted,
  CODEX,
  CODEX_V7,
  OTHER,
  ordinary
} = require('./ordinary-codex-fixture');

test('typed ordinary request rejects missing or conflicting invocation identity', () => {
  assert.throws(() => resolveInvocationIdentity({ CODEX_SESSION_ID: CODEX, PWD: '/tmp/workspace' }), /CODEX_THREAD_ID/);
  assert.equal(resolveInvocationIdentity({ CODEX_THREAD_ID: CODEX, PWD: '/tmp/workspace' }).sessionId, CODEX);
  assert.throws(() => resolveInvocationIdentity({ CODEX_SESSION_ID: CODEX, CODEX_THREAD_ID: OTHER, PWD: '/tmp/workspace' }), /conflict/);
  assert.throws(() => createOrdinaryCodexRequestFromEnvironment({
    channelId: 'channel', guildId: 'guild', workspace: '/tmp/workspace', nativeId: OTHER,
    environment: { CODEX_SESSION_ID: CODEX, CODEX_THREAD_ID: CODEX, PWD: '/tmp/workspace' }
  }), /conflicts/);
  const request = createOrdinaryCodexRequestFromEnvironment({
    channelId: 'channel', guildId: 'guild', workspace: '/tmp/workspace',
    environment: { CODEX_SESSION_ID: CODEX, CODEX_THREAD_ID: CODEX, PWD: '/tmp/workspace' }
  });
  assert.deepEqual(request.identity, { sessionId: CODEX, threadId: CODEX });
  assert.equal(request.nativeId, CODEX);
  const upperRequest = createOrdinaryCodexRequestFromEnvironment({
    channelId: 'channel', guildId: 'guild', nativeId: CODEX.toUpperCase(), workspace: '/tmp/workspace',
    environment: { CODEX_SESSION_ID: CODEX.toUpperCase(), CODEX_THREAD_ID: CODEX.toUpperCase() }
  });
  assert.equal(upperRequest.nativeId, CODEX);
  assert.deepEqual(upperRequest.identity, { sessionId: CODEX, threadId: CODEX });
  assert.equal(resolveInvocationIdentity({ CODEX_SESSION_ID: CODEX_V7, CODEX_THREAD_ID: CODEX_V7, PWD: '/tmp/workspace' }).sessionId, CODEX_V7);
  assert.equal(resolveInvocationIdentity({ CODEX_SESSION_ID: CODEX, CODEX_THREAD_ID: CODEX, PWD: '/checkout' }, '/session-workspace').workspace, '/session-workspace');
  assert.equal(resolveInvocationIdentity({ CODEX_SESSION_ID: CODEX, CODEX_THREAD_ID: CODEX, PWD: '/checkout' }).workspace, undefined);
  assert.throws(() => createOrdinaryCodexRequestFromEnvironment({
    channelId: 'channel', guildId: 'guild',
    environment: { CODEX_SESSION_ID: CODEX, CODEX_THREAD_ID: CODEX, PWD: '/checkout' }
  }), /workspace must come from exact Codex session metadata/);
});

test('ordinary CommonJS facade exposes emitted code and fails closed when output is absent', () => {
  assert.equal(facade.resolveExistingChannel, emitted.resolveExistingChannel);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinary-codex-missing-'));
  try {
    fs.mkdirSync(path.join(root, 'src'));
    fs.copyFileSync(path.resolve(__dirname, '../src/ordinary-codex.js'), path.join(root, 'src/ordinary-codex.js'));
    const result = spawnSync(process.execPath, ['-e', "require('./src/ordinary-codex')"], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /run npm run build before starting/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ordinary constants CommonJS facade preserves emitted values and identity', () => {
  assert.deepEqual(Object.keys(ordinaryConstantsFacade).sort(), ['CLAUDE_ENDPOINT_UNAVAILABLE_PREFIX', 'ORDINARY_RECEIPT_KINDS']);
  assert.equal(ordinaryConstantsFacade.CLAUDE_ENDPOINT_UNAVAILABLE_PREFIX, ordinaryConstantsEmitted.CLAUDE_ENDPOINT_UNAVAILABLE_PREFIX);
  assert.equal(ordinaryConstantsFacade.ORDINARY_RECEIPT_KINDS, ordinaryConstantsEmitted.ORDINARY_RECEIPT_KINDS);
  assert.equal(Object.isFrozen(ordinaryConstantsFacade.ORDINARY_RECEIPT_KINDS), true);
});

test('channel resolution accepts exact ID, mention, and one name only in the configured guild', () => {
  const channels = [
    { id: '123', guildId: 'guild', name: 'ops', messageCapable: true },
    { id: '456', guildId: 'guild', name: 'dev', messageCapable: true },
    { id: '999', guildId: 'guild', name: 'ops', messageCapable: true },
    { id: '789', guildId: 'other-guild', name: 'ops', messageCapable: true }
  ];
  assert.equal(resolveExistingChannel('123', 'guild', channels).name, 'ops');
  assert.equal(resolveExistingChannel('<#456>', 'guild', channels).name, 'dev');
  assert.equal(resolveExistingChannel('dev', 'guild', channels).id, '456');
  assert.equal(resolveExistingChannel('#dev', 'guild', channels).id, '456');
  assert.throws(() => resolveExistingChannel('ops', 'guild', channels), /ambiguous/);
  assert.throws(() => resolveExistingChannel('<#789>', 'guild', channels), /outside/);
  assert.throws(() => resolveExistingChannel('missing', 'guild', channels), /unknown/);
  assert.throws(() => resolveExistingChannel('123', 'guild', [{ ...channels[0], messageCapable: false }]), /message-capable/);
  assert.throws(() => resolveExistingChannel('dev', 'guild', [{ ...channels[1], messageCapable: false }]), /message-capable/);
});
