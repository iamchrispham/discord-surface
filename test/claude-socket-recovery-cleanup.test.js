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

test('qualification preserves unrelated accepted connections', { timeout: 6000 }, async t => {
  const socket = socketPath(t, { cleanup: false });
  const directory = path.dirname(socket);
  const server = http.createServer((request, response) => {
    request.resume();
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ provider: 'claude' }));
  });
  const activeConnections = new Set();
  let firstServerConnection;
  server.on('connection', connection => {
    if (!firstServerConnection) firstServerConnection = connection;
    activeConnections.add(connection);
    connection.on('close', () => activeConnections.delete(connection));
  });
  const keepAliveAgent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  t.after(async () => {
    try {
      for (const connection of activeConnections) connection.destroy();
      keepAliveAgent.destroy();
      await closeListeningServer(server);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
  await listenOn(server, socket);
  const baselineRequestListeners = server.listenerCount('request');
  const unrelated = await requestOverSocket(socket, { agent: keepAliveAgent, method: 'GET' });
  assert.equal(unrelated.statusCode, 200, 'unrelated connection must be served before capture');
  const unrelatedSocket = unrelated.clientSocket;
  assert.ok(unrelatedSocket, 'unrelated client socket must be observable');
  assert.equal(unrelatedSocket.destroyed, false, 'unrelated connection must stay open before capture');

  const identity = await socketOwnership.boundSocketIdentity(server, socket);
  assert.ok(identity, 'capture must succeed against an ordinary bound server');
  assert.equal(unrelatedSocket.destroyed, false, 'unrelated accepted connection must survive capture');
  assert.equal(activeConnections.size, 1, 'only the nonce connection may be closed by capture');
  assert.equal(activeConnections.has(firstServerConnection), true, 'the unrelated connection must remain accepted');
  assert.equal(firstServerConnection.destroyed, false, 'the unrelated accepted connection must remain open');

  const reused = await requestOverSocket(socket, { agent: keepAliveAgent, method: 'GET' });
  assert.equal(reused.statusCode, 200, 'unrelated connection must remain usable after capture');
  assert.equal(reused.clientSocket, unrelatedSocket, 'follow-up request must reuse the unrelated connection');
  assert.equal(server.listenerCount('request'), baselineRequestListeners, 'temporary qualification listener must be removed');

  unrelatedSocket.destroy();
  keepAliveAgent.destroy();
});

test('startup stop retains its lock until the failed listener actually closes', { timeout: 6000 }, async t => {
  const { dir, state } = fixture();
  const socket = socketPath(t, { cleanup: false });
  state.bind({ channelId: 'channel', guildId: 'guild-1', provider: 'claude', nativeId: CLAUDE_ID, workspace: dir, endpoint: socket }, { intakeCutoff: '100' });
  let server;
  let closed = false;
  let witnessResolve;
  const witnessed = new Promise(resolve => { witnessResolve = resolve; });
  const connections = new Set();
  const originalCreate = http.createServer;
  t.mock.method(http, 'createServer', handler => {
    server = originalCreate.call(http, (request, response) => {
      if (request.method === 'HEAD' && request.url === '/identity' && request.headers['x-discord-socket-qualification']) {
        request.resume();
        witnessResolve();
        return;
      }
      return handler(request, response);
    });
    server.on('connection', connection => {
      connections.add(connection);
      connection.on('close', () => connections.delete(connection));
    });
    server.once('close', () => { closed = true; });
    return server;
  });
  const channel = new ClaudeChannel({ state, nativeId: CLAUDE_ID, socketPath: socket, mcp: { notification: async () => {} } });
  let client;
  let stopping;
  const starting = channel.start().catch(error => error);
  try {
    await witnessed;
    const accepted = once(server, 'connection');
    client = net.createConnection(socket);
    client.on('error', () => {});
    await Promise.all([once(client, 'connect'), accepted]);
    let stopResolved = false;
    stopping = channel.stop().then(() => { stopResolved = true; }, error => { throw error; });
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    let lockCanAcquire = false;
    try {
      const release = acquireSocketLock(socket);
      lockCanAcquire = true;
      release();
    } catch {
      // A live preparation lock refusing the contender is the expected path.
    }
    // The disputed ordering is conditional, not a frozen pre-close snapshot: a correct
    // correction may already have closed the failed listener two immediate turns after
    // stop() was called, but stop() must never resolve and the preparation lock must
    // never become re-acquirable while that listener is still open with live sockets.
    assert.ok(!stopResolved || closed, 'stop must not resolve before the failed listener actually closes');
    assert.ok(!lockCanAcquire || closed, 'preparation lock must not be acquirable before the failed listener actually closes');
    client.destroy();
    let deadline;
    const finishedInTime = await Promise.race([
      stopping.then(() => true),
      new Promise(resolve => { deadline = setTimeout(() => resolve(false), 500); })
    ]).finally(() => clearTimeout(deadline));
    assert.equal(finishedInTime, true, 'stop must finish within the fixture bound once the listener closes');
    assert.equal(closed, true, 'failed listener must actually close before stop resolves');
    await waitForCondition(() => connections.size === 0, 'failed listener retains an accepted connection', 500);
    await stopping;
    await starting;
  } finally {
    client?.destroy();
    for (const connection of connections) connection.destroy();
    try { await stopping; } catch {}
    try { await channel.stop(); } catch {}
    if (server && !closed) await new Promise(resolve => server.close(() => resolve()));
    state.close();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(path.dirname(socket), { recursive: true, force: true });
  }
});

test('startup qualification quarantines a replacement before closing the failed listener', { timeout: 8000 }, async t => {
  const socket = socketPath(t, { cleanup: false });
  const { dir, state } = fixture();
  t.after(() => state.close());
  state.bind({ channelId: 'claude', guildId: 'guild-1', provider: 'claude', nativeId: CLAUDE_ID, workspace: dir, endpoint: socket }, { intakeCutoff: '100' });
  let witnessResolve;
  const witnessed = new Promise(resolve => { witnessResolve = resolve; });
  let releaseQualification;
  const qualificationReleased = new Promise(resolve => { releaseQualification = resolve; });
  const originalCreateServer = http.createServer;
  t.mock.method(http, 'createServer', handler => originalCreateServer.call(http, (request, response) => {
    if (request.method === 'HEAD' && request.url === '/identity' && request.headers['x-discord-socket-qualification']) {
      request.resume();
      witnessResolve();
      void qualificationReleased.then(() => handler(request, response));
      return;
    }
    handler(request, response);
  }));
  const channel = new ClaudeChannel({ state, nativeId: CLAUDE_ID, socketPath: socket, mcp: { notification: async () => {} } });
  const starting = channel.start();
  await witnessed;

  const oldPath = `${socket}.old`;
  fs.renameSync(socket, oldPath);
  const replacement = http.createServer((_request, response) => response.end('replacement'));
  t.after(async () => {
    if (replacement.listening) await new Promise(resolve => replacement.close(resolve));
    try { fs.unlinkSync(oldPath); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    try { await channel.stop(); } catch {}
    fs.rmSync(path.dirname(socket), { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await listenOn(replacement, socket);
  releaseQualification();

  await assert.rejects(starting, /pathname identity changed|qualification refused/);
  assert.equal(fs.lstatSync(socket).isSocket(), true, 'replacement listener must survive failed qualification');
  const response = await requestOverSocket(socket);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body, 'replacement');
});

test('startup cleanup uses the listener identity when the pathname changes before callback', { timeout: 8000 }, async t => {
  const socket = socketPath(t, { cleanup: false });
  const movedPath = `${socket}.old`;
  const { dir, state } = fixture();
  state.bind({ channelId: 'claude', guildId: 'guild-1', provider: 'claude', nativeId: CLAUDE_ID, workspace: dir, endpoint: socket }, { intakeCutoff: '100' });
  const replacement = http.createServer((_request, response) => response.end('replacement'));
  t.after(async () => {
    if (replacement.listening) await closeListeningServer(replacement);
    try { fs.unlinkSync(movedPath); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    try { await channel.stop(); } catch {}
    try { state.close(); } catch {}
    fs.rmSync(path.dirname(socket), { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const originalCreateServer = http.createServer;
  t.mock.method(http, 'createServer', (...args) => {
    const server = originalCreateServer(...args);
    const originalListen = server.listen.bind(server);
    server.listen = (...listenArgs) => {
      const callback = listenArgs[listenArgs.length - 1];
      if (listenArgs[0] !== socket || typeof callback !== 'function') return originalListen(...listenArgs);
      listenArgs[listenArgs.length - 1] = (...callbackArgs) => {
        fs.renameSync(socket, movedPath);
        replacement.listen(socket, () => callback(...callbackArgs));
      };
      return originalListen(...listenArgs);
    };
    return server;
  });

  const channel = new ClaudeChannel({ state, nativeId: CLAUDE_ID, socketPath: socket, mcp: { notification: async () => {} } });
  await assert.rejects(channel.start(), /pathname identity|qualification refused/);
  assert.equal(fs.lstatSync(socket).isSocket(), true, 'replacement listener must survive failed qualification');
  const response = await requestOverSocket(socket);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body, 'replacement');
});

test('stop retains server custody when replacement quarantine setup fails', { timeout: 8000 }, async t => {
  const socket = socketPath(t, { cleanup: false });
  const { dir, state } = fixture();
  t.after(() => state.close());
  state.bind({ channelId: 'claude', guildId: 'guild-1', provider: 'claude', nativeId: CLAUDE_ID, workspace: dir, endpoint: socket }, { intakeCutoff: '100' });
  const channel = new ClaudeChannel({ state, nativeId: CLAUDE_ID, socketPath: socket, mcp: { notification: async () => {} } });
  await channel.start();
  const oldPath = `${socket}.old`;
  fs.renameSync(socket, oldPath);
  fs.writeFileSync(socket, 'replacement');
  let failQuarantine = true;
  const originalQuarantine = socketOwnership.quarantineMismatchedSocket;
  t.mock.method(socketOwnership, 'quarantineMismatchedSocket', (...args) => {
    if (failQuarantine) throw new Error('quarantine unavailable');
    return originalQuarantine(...args);
  });
  t.after(async () => {
    try { await channel.stop(); } catch {}
    try { fs.unlinkSync(oldPath); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    fs.rmSync(path.dirname(socket), { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const stopError = await channel.stop().catch(error => error);
  assert.ok(stopError instanceof AggregateError);
  assert.ok(stopError.errors.some(error => /quarantine unavailable/.test(String(error))));
  assert.ok(channel.server, 'failed quarantine must retain the listener reference');
  assert.throws(() => acquireSocketLock(socket), /already in progress/);
  assert.equal(fs.readFileSync(socket, 'utf8'), 'replacement');

  failQuarantine = false;
  await channel.stop();
  assert.equal(fs.readFileSync(socket, 'utf8'), 'replacement');
  const release = acquireSocketLock(socket);
  release();
});

test('startup retains server custody when replacement quarantine setup fails', { timeout: 8000 }, async t => {
  const socket = socketPath(t, { cleanup: false });
  const { dir, state } = fixture();
  t.after(() => state.close());
  state.bind({ channelId: 'claude', guildId: 'guild-1', provider: 'claude', nativeId: CLAUDE_ID, workspace: dir, endpoint: socket }, { intakeCutoff: '100' });
  let witnessResolve;
  const witnessed = new Promise(resolve => { witnessResolve = resolve; });
  let releaseQualification;
  const qualificationReleased = new Promise(resolve => { releaseQualification = resolve; });
  const originalCreateServer = http.createServer;
  t.mock.method(http, 'createServer', handler => originalCreateServer.call(http, (request, response) => {
    if (request.method === 'HEAD' && request.url === '/identity' && request.headers['x-discord-socket-qualification']) {
      request.resume();
      witnessResolve();
      void qualificationReleased.then(() => handler(request, response));
      return;
    }
    handler(request, response);
  }));
  const originalQuarantine = socketOwnership.quarantineMismatchedSocket;
  let failQuarantine = true;
  t.mock.method(socketOwnership, 'quarantineMismatchedSocket', (...args) => {
    if (failQuarantine) throw new Error('quarantine unavailable during startup');
    return originalQuarantine(...args);
  });
  const channel = new ClaudeChannel({ state, nativeId: CLAUDE_ID, socketPath: socket, mcp: { notification: async () => {} } });
  const starting = channel.start();
  await witnessed;

  const oldPath = `${socket}.old`;
  fs.renameSync(socket, oldPath);
  const replacement = http.createServer((_request, response) => response.end('replacement'));
  t.after(async () => {
    if (replacement.listening) await new Promise(resolve => replacement.close(resolve));
    try { fs.unlinkSync(oldPath); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    try { await channel.stop(); } catch {}
    fs.rmSync(path.dirname(socket), { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await listenOn(replacement, socket);
  releaseQualification();

  await assert.rejects(starting, /listener cleanup failed/);
  assert.ok(channel.server, 'failed startup quarantine must retain the listener reference');
  assert.throws(() => acquireSocketLock(socket), /already in progress/);
  const response = await requestOverSocket(socket);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body, 'replacement');

  failQuarantine = false;
  await channel.stop();
  assert.equal(fs.lstatSync(socket).isSocket(), true, 'replacement listener must survive retry cleanup');
  await new Promise(resolve => replacement.close(resolve));
});

test('stop refuses a directory replacement without stranding it', { timeout: 8000 }, async t => {
  const socket = socketPath(t, { cleanup: false });
  const { dir, state } = fixture();
  t.after(() => state.close());
  state.bind({ channelId: 'claude', guildId: 'guild-1', provider: 'claude', nativeId: CLAUDE_ID, workspace: dir, endpoint: socket }, { intakeCutoff: '100' });
  const channel = new ClaudeChannel({ state, nativeId: CLAUDE_ID, socketPath: socket, mcp: { notification: async () => {} } });
  await channel.start();
  const oldPath = `${socket}.old`;
  fs.renameSync(socket, oldPath);
  fs.mkdirSync(socket, { mode: 0o700 });
  t.after(async () => {
    try { await channel.stop(); } catch {}
    try { fs.rmSync(oldPath, { recursive: true, force: true }); } catch {}
    fs.rmSync(path.dirname(socket), { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const stopError = await channel.stop().catch(error => error);
  assert.ok(stopError instanceof AggregateError);
  assert.ok(stopError.errors.some(error => /is a directory/.test(String(error))));
  assert.ok(channel.server, 'directory replacement must retain the listener reference');
  assert.throws(() => acquireSocketLock(socket), /already in progress/);
  assert.equal(fs.lstatSync(socket).isDirectory(), true, 'directory replacement must remain untouched');

  fs.rmdirSync(socket);
  await channel.stop();
  const release = acquireSocketLock(socket);
  release();
});

test('quarantine refuses a FIFO replacement without moving it', { timeout: 8000 }, async t => {
  const socket = socketPath(t);
  await orphan(socket);
  const expected = socketOwnership.socketPathIdentity(socket);
  const original = `${socket}.old`;
  fs.renameSync(socket, original);
  const created = spawnSync('mkfifo', [socket], { timeout: 2000 });
  assert.equal(created.status, 0, String(created.stderr));
  const before = fs.readdirSync(path.dirname(socket)).sort();

  assert.throws(() => socketOwnership.quarantineMismatchedSocket(socket, expected), /unsupported type/);
  assert.equal(fs.lstatSync(socket).isFIFO(), true);
  assert.equal(fs.lstatSync(original).isSocket(), true);
  assert.deepEqual(fs.readdirSync(path.dirname(socket)).sort(), before);
});

test('namespace isolation refuses acquisition against the real home and system temporary root', { timeout: 8000 }, t => {
  // Negative control: drop the baseline shims so acquisition resolves the real
  // passwd-backed home and the real '/tmp'. The realpath guard is the primary gate
  // that makes acquisition refuse before any coordination I/O; the write hooks
  // below are fail-loud backstops. This test never writes inside either real
  // namespace, even though acquisition is deliberately pointed at them.
  const realHome = trueUserInfo().homedir;
  const suiteRoots = [SUITE_TEMP_ROOT, SUITE_HOME_ROOT, SUITE_SHARED_TEMP_ROOT];
  const consulted = [];
  // Gate on the suite's isolation: if the module-level baseline install were ever
  // removed, these fail before the guard is even reached.
  assert.equal(os.userInfo().homedir, SUITE_HOME_ROOT, 'baseline home shim must be active');
  assert.equal(fs.realpathSync('/tmp'), SUITE_SHARED_TEMP_ROOT, "baseline '/tmp' shim must be active");
  os.userInfo = trueUserInfo;
  fs.realpathSync = trueRealpathSync;
  // Per-test `t.after` hooks run BEFORE node:test restores `t.mock.method` shims,
  // so an after-hook baseline reinstall would be clobbered by that restore. The
  // module-level `test.beforeEach(installBaselineNamespaceMocks)` is what repairs
  // the baseline for the next test; keep this hook only as a best-effort backstop.
  t.after(installBaselineNamespaceMocks);
  t.mock.method(fs, 'realpathSync', (target, ...options) => {
    const value = String(target);
    if (value === realHome || value === '/tmp') {
      consulted.push(value);
      throw Object.assign(new Error(`namespace guard blocked realpath ${value}`), { code: 'EACCES' });
    }
    return trueRealpathSync(target, ...options);
  });
  // The realpath guard above is the primary refusal gate: it makes acquisition
  // refuse before it can derive any coordination candidate. These write hooks are
  // fail-loud backstops, so a future change that reaches coordination I/O outside
  // the disposable roots aborts here instead of writing to the real namespace.
  let outsideWriteAttempt;
  let socketDirectory;
  const suiteOwnedTarget = value => suiteRoots.some(root => value === root || value.startsWith(`${root}${path.sep}`)) ||
    value.startsWith('/tmp/dss-') ||
    (socketDirectory !== undefined && (value === socketDirectory || value.startsWith(`${socketDirectory}${path.sep}`)));
  const guardWrite = (operation, ...targets) => {
    for (const target of targets) {
      const value = String(target);
      if (value && !suiteOwnedTarget(value)) {
        outsideWriteAttempt = `${operation} ${value}`;
        throw Object.assign(new Error(`namespace guard blocked ${operation} ${value}`), { code: 'EACCES' });
      }
    }
  };
  t.mock.method(fs, 'mkdirSync', (target, options) => {
    guardWrite('mkdir', target);
    return trueMkdirSync(target, options);
  });
  t.mock.method(fs, 'renameSync', (source, destination) => {
    guardWrite('rename', source, destination);
    return trueRenameSync(source, destination);
  });
  t.mock.method(fs, 'linkSync', (existingPath, newPath) => {
    guardWrite('link', existingPath, newPath);
    return trueLinkSync(existingPath, newPath);
  });
  t.mock.method(fs, 'writeFileSync', (target, data, options) => {
    guardWrite('writeFile', target);
    return trueWriteFileSync(target, data, options);
  });
  t.mock.method(fs, 'unlinkSync', target => {
    guardWrite('unlink', target);
    return trueUnlinkSync(target);
  });

  const socket = socketPath(t);
  // The socket directory is itself a disposable fixture under /tmp; resolve it so
  // the guard permits its (non-coordination) case-sensitivity probes.
  socketDirectory = trueRealpathSync(path.dirname(socket));
  assert.throws(() => acquireSocketLock(socket), /namespace root is unusable/);
  assert.ok(consulted.includes(realHome), `the real home ${realHome} must have been consulted`);
  assert.ok(consulted.includes('/tmp'), "the real '/tmp' must have been consulted");
  assert.equal(outsideWriteAttempt, undefined, 'no coordination write hook may fire outside the disposable suite roots');
});
