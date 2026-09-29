const {
  test, assert, fs, net, http, os, path, randomUUID, spawn, spawnSync, once, EventEmitter,
  prepareSocket, prepareSocketAsync, ClaudeChannel, SurfaceState, socketOwnership,
  acquireSocketLock, assertSocketDirectory, assertSocketPath, fixture, CLAUDE_ID,
  SUITE_TEMP_ROOT, SUITE_HOME_ROOT, SUITE_SHARED_TEMP_ROOT,
  trueUserInfo, trueRealpathSync, trueMkdirSync, trueRenameSync, trueLinkSync,
  trueWriteFileSync, trueUnlinkSync, baselineUserInfo, baselineRealpathSync,
  installBaselineNamespaceMocks, resetSuiteCoordinationArtifacts, removeSocketDirectory,
  socketPath, acquireSocketLockWithPath, isolatedNamespaceRoot, acquireProbeLock,
  releaseQuietly, listenOn, closeListeningServer, requestOverSocket, waitForCondition,
  isCaseInsensitiveDirectory, orphan
} = require('./claude-socket-recovery-fixture');

test('stop aborts a pending MCP connection and releases startup', { timeout: 8000 }, async t => {
  const socket = socketPath(t, { cleanup: false });
  const { dir, state } = fixture();
  t.after(() => state.close());
  state.bind({ channelId: 'claude', guildId: 'guild-1', provider: 'claude', nativeId: CLAUDE_ID, workspace: dir, endpoint: socket }, { intakeCutoff: '100' });
  let connectStarted;
  const connected = new Promise(resolve => { connectStarted = resolve; });
  let settleConnection;
  const connectionSettled = new Promise(resolve => { settleConnection = resolve; });
  let closeCalls = 0;
  const channel = new ClaudeChannel({
    state,
    nativeId: CLAUDE_ID,
    socketPath: socket,
    mcp: {
      notification: async () => {},
      transportFactory: () => ({}),
      connect: async () => {
        connectStarted();
        return connectionSettled;
      },
      close: async () => { closeCalls += 1; }
    }
  });
  t.after(async () => {
    try { await channel.stop(); } finally { removeSocketDirectory(socket); }
  });
  const starting = channel.start();
  await connected;
  const stopping = channel.stop();
  await new Promise(resolve => setImmediate(resolve));
  assert.throws(() => acquireSocketLock(socket), /already in progress/);
  settleConnection();
  await stopping;
  await assert.rejects(starting, /stopped during MCP connection/);
  assert.equal(channel.ready, false);
  assert.equal(fs.existsSync(socket), false);
  assert.equal(closeCalls, 2);
});

test('stop retains the socket lock until MCP teardown completes', { timeout: 8000 }, async t => {
  const socket = socketPath(t, { cleanup: false });
  const { dir, state } = fixture();
  t.after(() => state.close());
  state.bind({ channelId: 'claude', guildId: 'guild-1', provider: 'claude', nativeId: CLAUDE_ID, workspace: dir, endpoint: socket }, { intakeCutoff: '100' });
  let releaseClose;
  const closeGate = new Promise(resolve => { releaseClose = resolve; });
  let enterClose;
  const entered = new Promise(resolve => { enterClose = resolve; });
  const channel = new ClaudeChannel({
    state,
    nativeId: CLAUDE_ID,
    socketPath: socket,
    mcp: {
      notification: async () => {},
      close: async () => {
        enterClose();
        await closeGate;
      }
    }
  });
  t.after(async () => {
    releaseClose?.();
    try { await channel.stop(); } finally { removeSocketDirectory(socket); }
  });
  await channel.start();
  const stopping = channel.stop();
  await entered;
  assert.throws(() => acquireSocketLock(socket), /already in progress/);
  releaseClose();
  await stopping;
  assert.equal(fs.existsSync(socket), false);
});

test('late stop cleanup preserves a replacement listener', { timeout: 8000 }, async t => {
  const socket = socketPath(t, { cleanup: false });
  const { dir, state } = fixture();
  t.after(() => state.close());
  state.bind({ channelId: 'claude', guildId: 'guild-1', provider: 'claude', nativeId: CLAUDE_ID, workspace: dir, endpoint: socket }, { intakeCutoff: '100' });
  const channel = new ClaudeChannel({ state, nativeId: CLAUDE_ID, socketPath: socket, mcp: { notification: async () => {} } });
  await channel.start();
  const server = channel.server;
  assert.ok(server);
  const originalIdentity = socketOwnership.socketPathIdentity(socket);
  assert.equal(typeof originalIdentity?.ctimeNs, 'bigint');
  const originalClose = server.close.bind(server);
  let finishClose;
  let notifyClose;
  const closeCalled = new Promise(resolve => { notifyClose = resolve; });
  t.mock.method(server, 'close', callback => {
    originalClose(error => {
      finishClose = () => callback(error);
      notifyClose();
    });
  });
  const stopping = channel.stop();
  await closeCalled;
  assert.equal(fs.existsSync(socket), false);
  const replacement = net.createServer(connection => connection.destroy());
  t.after(async () => {
    if (replacement.listening) await new Promise(resolve => replacement.close(resolve));
    removeSocketDirectory(socket);
  });
  await new Promise((resolve, reject) => {
    replacement.once('error', reject);
    replacement.listen(socket, resolve);
  });
  finishClose();
  await stopping;
  assert.equal(fs.lstatSync(socket).isSocket(), true);
  await new Promise(resolve => replacement.close(resolve));
});

test('stop preserves a replacement listener published before old close', { timeout: 8000 }, async t => {
  const socket = socketPath(t, { cleanup: false });
  const { dir, state } = fixture();
  t.after(() => state.close());
  state.bind({ channelId: 'claude', guildId: 'guild-1', provider: 'claude', nativeId: CLAUDE_ID, workspace: dir, endpoint: socket }, { intakeCutoff: '100' });
  const channel = new ClaudeChannel({ state, nativeId: CLAUDE_ID, socketPath: socket, mcp: { notification: async () => {} } });
  await channel.start();
  const oldPath = `${socket}.old-${randomUUID()}`;
  fs.renameSync(socket, oldPath);
  const replacement = http.createServer((_request, response) => response.end('replacement'));
  t.after(async () => {
    if (replacement.listening) await new Promise(resolve => replacement.close(resolve));
    try { fs.unlinkSync(oldPath); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    removeSocketDirectory(socket);
  });
  await new Promise((resolve, reject) => {
    replacement.once('error', reject);
    replacement.listen(socket, resolve);
  });

  await channel.stop();
  assert.equal(fs.lstatSync(socket).isSocket(), true);
  const response = await requestOverSocket(socket);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body, 'replacement');
  await new Promise(resolve => replacement.close(resolve));
});

test('stop retries a failed socket-lock release', { timeout: 8000 }, async t => {
  const socket = socketPath(t, { cleanup: false });
  const { dir, state } = fixture();
  t.after(() => state.close());
  state.bind({ channelId: 'claude', guildId: 'guild-1', provider: 'claude', nativeId: CLAUDE_ID, workspace: dir, endpoint: socket }, { intakeCutoff: '100' });
  const originalAcquire = socketOwnership.acquireSocketLock;
  let releaseCalls = 0;
  t.mock.method(socketOwnership, 'acquireSocketLock', endpoint => {
    const release = originalAcquire(endpoint);
    return () => {
      releaseCalls += 1;
      if (releaseCalls === 1) throw new Error('release failed');
      release();
    };
  });
  const channel = new ClaudeChannel({ state, nativeId: CLAUDE_ID, socketPath: socket, mcp: { notification: async () => {} } });
  t.after(async () => {
    try { await channel.stop(); } finally { removeSocketDirectory(socket); }
  });
  await channel.start();
  await assert.rejects(channel.stop(), error => {
    assert.equal(error.message, 'Claude channel stop failed');
    assert.match(error.errors[0].message, /release failed/);
    return true;
  });
  await channel.stop();
  assert.equal(releaseCalls, 2);
  await channel.start();
  assert.equal(channel.ready, true);
  await channel.stop();
});

test('start calls during stop share one post-stop startup', { timeout: 8000 }, async t => {
  const socket = socketPath(t, { cleanup: false });
  const { dir, state } = fixture();
  t.after(() => state.close());
  state.bind({ channelId: 'claude', guildId: 'guild-1', provider: 'claude', nativeId: CLAUDE_ID, workspace: dir, endpoint: socket }, { intakeCutoff: '100' });
  let releaseClose;
  const closeGate = new Promise(resolve => { releaseClose = resolve; });
  let closeCalls = 0;
  const channel = new ClaudeChannel({
    state,
    nativeId: CLAUDE_ID,
    socketPath: socket,
    mcp: {
      notification: async () => {},
      close: async () => {
        closeCalls += 1;
        if (closeCalls === 1) await closeGate;
      }
    }
  });
  t.after(async () => {
    try { await channel.stop(); } finally { removeSocketDirectory(socket); }
  });
  await channel.start();
  const stopping = channel.stop();
  const first = channel.start();
  const second = channel.start();
  releaseClose();
  await stopping;
  await Promise.all([first, second]);
  assert.equal(channel.ready, true);
  assert.equal(closeCalls, 1);
});

test('stop joins a pending listener startup before releasing the socket lock', { timeout: 8000 }, async t => {
  const socket = socketPath(t);
  const { dir, state } = fixture();
  t.after(() => state.close());
  state.bind({ channelId: 'claude', guildId: 'guild-1', provider: 'claude', nativeId: CLAUDE_ID, workspace: dir, endpoint: socket }, { intakeCutoff: '100' });
  const channel = new ClaudeChannel({ state, nativeId: CLAUDE_ID, socketPath: socket, mcp: { notification: async () => {} } });
  let signalListenCalled;
  const listenCalled = new Promise(resolve => { signalListenCalled = resolve; });
  let resumeListen;
  const listenGate = new Promise(resolve => { resumeListen = resolve; });
  const originalListen = net.Server.prototype.listen;
  t.mock.method(net.Server.prototype, 'listen', function (...args) {
    signalListenCalled();
    void listenGate.then(() => Reflect.apply(originalListen, this, args));
    return this;
  });
  t.after(() => resumeListen());

  const start = channel.start();
  await listenCalled;
  const stop = channel.stop();
  let stopped = false;
  void stop.then(() => { stopped = true; }, () => { stopped = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(stopped, false);
  assert.throws(() => acquireSocketLock(socket), /already in progress/);

  resumeListen();
  await assert.rejects(start, /Claude channel stopped during listener startup/);
  await stop;
});
