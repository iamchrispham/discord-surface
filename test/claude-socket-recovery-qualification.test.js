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

test('qualified bound identity cleans its own real socket', { timeout: 6000 }, async t => {
  const socket = socketPath(t, { cleanup: false });
  const directory = path.dirname(socket);
  const controlPath = path.join(directory, 'control.sock');
  const server = http.createServer((request, response) => {
    response.end();
  });
  const controlServer = http.createServer((request, response) => {
    response.end();
  });
  t.after(async () => {
    try {
      if (controlServer.listening) {
        const controlClosed = once(controlServer, 'close');
        controlServer.close();
        await controlClosed;
      }
      if (server.listening) {
        const serverClosed = once(server, 'close');
        server.close();
        await serverClosed;
      }
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socket, resolve);
  });
  const candidate = await socketOwnership.boundSocketIdentity(server, socket);
  try {
    await new Promise((resolve, reject) => {
      controlServer.once('error', reject);
      controlServer.listen(controlPath, resolve);
    });
    const controlIdentity = socketOwnership.socketPathIdentity(controlPath);
    assert.ok(controlIdentity, 'control socket path identity must be readable');
    socketOwnership.unlinkSocketIfOwned(controlPath, controlIdentity);
    assert.equal(fs.existsSync(controlPath), false, 'pathname identity must remove a live real socket');
  } finally {
    if (controlServer.listening) {
      const controlClosed = once(controlServer, 'close');
      controlServer.close();
      await controlClosed;
    }
  }
  assert.ok(candidate, 'descriptor-backed bound identity must be captured');
  socketOwnership.unlinkSocketIfOwned(socket, candidate);
  assert.equal(fs.existsSync(socket), false, 'qualified bound identity must clean its own real socket path');
});

test('capture refuses a different real listener at the path', { timeout: 6000 }, async t => {
  const directory = fs.mkdtempSync('/tmp/dss-');
  fs.chmodSync(directory, 0o700);
  const publicPath = path.join(directory, 'public.sock');
  const movedPath = path.join(directory, 'moved.sock');
  const privatePath = path.join(directory, 'private.sock');
  const serverA = http.createServer((request, response) => {
    response.end();
  });
  const serverB = http.createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ id: 'ordinary-logical-id' }));
  });
  t.after(async () => {
    try {
      if (fs.existsSync(publicPath)) fs.renameSync(publicPath, privatePath);
      if (serverA.listening) {
        const aClosed = once(serverA, 'close');
        serverA.close();
        await aClosed;
      }
      if (serverB.listening) {
        const bClosed = once(serverB, 'close');
        serverB.close();
        await bClosed;
      }
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
  await new Promise((resolve, reject) => {
    serverA.once('error', reject);
    serverA.listen(publicPath, resolve);
  });
  fs.renameSync(publicPath, movedPath);
  await new Promise((resolve, reject) => {
    serverB.once('error', reject);
    serverB.listen(publicPath, resolve);
  });
  const probePublicListener = () => new Promise((resolve, reject) => {
    let abort;
    const request = http.request({
      socketPath: publicPath,
      path: '/identity',
      method: 'GET',
      agent: false,
      headers: { connection: 'close' }
    }, response => {
      const status = response.statusCode;
      response.resume();
      void once(response, 'end').then(() => {
        clearTimeout(abort);
        resolve(status);
      }, error => {
        clearTimeout(abort);
        reject(error);
      });
    });
    abort = setTimeout(() => request.destroy(new Error('public listener request timed out')), 500);
    request.once('error', error => {
      clearTimeout(abort);
      reject(error);
    });
    request.end();
  });
  assert.equal(await probePublicListener(), 200, 'public listener must serve the identity probe');
  const bIdentity = socketOwnership.socketPathIdentity(publicPath);
  assert.ok(bIdentity, 'public listener path identity must be readable');
  let captureOutcome;
  try {
    captureOutcome = { status: 'fulfilled', value: await socketOwnership.boundSocketIdentity(serverA, publicPath) };
  } catch (error) {
    captureOutcome = { status: 'rejected', error };
  }
  assert.equal(await probePublicListener(), 200, 'different real listener must remain reachable');
  const observedIdentity = socketOwnership.socketPathIdentity(publicPath);
  assert.ok(observedIdentity, 'public listener path identity must remain readable');
  assert.equal(observedIdentity.dev, bIdentity.dev, 'public listener dev must be preserved');
  assert.equal(observedIdentity.ino, bIdentity.ino, 'public listener ino must be preserved');
  assert.equal(observedIdentity.ctimeNs, bIdentity.ctimeNs, 'public listener ctimeNs must be preserved');
  assert.equal(observedIdentity.birthtimeNs, bIdentity.birthtimeNs, 'public listener birthtimeNs must be preserved');
  assert.equal(captureOutcome.status, 'rejected', 'capture must refuse a different real listener at the path');
});

test('pending qualification keeps the preparation lock through stop', { timeout: 6000 }, async t => {
  const socket = socketPath(t, { cleanup: false });
  const { dir, state } = fixture();
  t.after(() => state.close());
  state.bind({ channelId: 'claude', guildId: 'guild-1', provider: 'claude', nativeId: CLAUDE_ID, workspace: dir, endpoint: socket }, { intakeCutoff: '100' });
  let signalObservedResolve;
  const signalObserved = new Promise(resolve => { signalObservedResolve = resolve; });
  let suppliedServer;
  let baselineRequestListeners;
  t.mock.method(socketOwnership, 'boundSocketIdentity', (server, _socketPath, signal) => {
    suppliedServer = server;
    baselineRequestListeners = server.listenerCount('request');
    signalObservedResolve();
    return new Promise((resolve, reject) => {
      const abortError = () => reject(new Error('Claude channel bound socket qualification aborted'));
      if (signal?.aborted) { abortError(); return; }
      signal?.addEventListener('abort', abortError, { once: true });
    });
  });
  const channel = new ClaudeChannel({ state, nativeId: CLAUDE_ID, socketPath: socket, mcp: { notification: async () => {} } });
  t.after(async () => {
    try { await channel.stop(); } catch {}
    removeSocketDirectory(socket);
  });

  const starting = channel.start();
  const startingOutcome = starting.then(() => null, error => error);
  await signalObserved;
  assert.equal(channel.ready, false, 'channel must not become ready while qualification is pending');
  assert.throws(() => acquireSocketLock(socket), /already in progress/, 'preparation lock must survive a pending qualification');

  const stopping = channel.stop();
  await new Promise(resolve => setImmediate(resolve));
  const startError = await startingOutcome;
  assert.match(startError.message, /Claude channel stopped during listener startup/);
  await stopping;

  const release = acquireSocketLock(socket);
  release();
  assert.ok(suppliedServer, 'the channel must supply its bound server to the capture call');
  assert.equal(
    suppliedServer.listenerCount('request'),
    baselineRequestListeners,
    'no qualification listener may remain after stopped startup'
  );
});

test('qualification abort disposes its own proof resources', { timeout: 6000 }, async t => {
  const socket = socketPath(t, { cleanup: false });
  const directory = path.dirname(socket);
  const server = http.createServer((request, response) => {
    request.resume();
    if (withhold) {
      held.push({ request, response });
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ provider: 'claude' }));
  });
  let withhold = true;
  const held = [];
  const observed = [];
  let observedResolve;
  const witnessed = new Promise(resolve => { observedResolve = resolve; });
  server.on('request', () => {
    observed.push(Date.now());
    observedResolve();
  });
  t.after(async () => {
    for (const entry of held) {
      try { entry.response.destroy(); } catch {}
      try { entry.request.destroy(); } catch {}
    }
    try { await closeListeningServer(server); } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
  await listenOn(server, socket);
  const baselineRequestListeners = server.listenerCount('request');
  const controller = new AbortController();
  const capture = socketOwnership.boundSocketIdentity(server, socket, controller.signal);
  await witnessed;
  const proofSocket = held[0]?.request?.socket;
  assert.ok(proofSocket, 'the withheld proof request socket must be observable');
  controller.abort();
  await assert.rejects(capture, /Claude channel bound socket qualification aborted/);
  assert.equal(server.listenerCount('request'), baselineRequestListeners, 'temporary qualification listener must be removed');
  await waitForCondition(() => proofSocket.destroyed === true, 'proof connection must be closed on abort');
  assert.equal(fs.existsSync(socket), true, 'aborted capture must leave the socket pathname in place');

  withhold = false;
  const followUp = await requestOverSocket(socket, { method: 'GET' });
  assert.equal(followUp.statusCode, 200, 'supplied server must keep serving ordinary requests after abort');
});

test('qualification deadline rejects a late witness', { timeout: 6000 }, async t => {
  const socket = socketPath(t, { cleanup: false });
  const directory = path.dirname(socket);
  const held = [];
  const server = http.createServer((request, response) => {
    request.resume();
    held.push({ request, response });
  });
  const activeConnections = new Set();
  server.on('connection', connection => {
    activeConnections.add(connection);
    connection.on('close', () => activeConnections.delete(connection));
  });
  let observedResolve;
  const witnessed = new Promise(resolve => { observedResolve = resolve; });
  server.on('request', () => { observedResolve(); });  t.after(async () => {
    for (const entry of held) {
      try { entry.response.destroy(); } catch {}
      try { entry.request.destroy(); } catch {}
    }
    try { await closeListeningServer(server); } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
  await listenOn(server, socket);
  const baselineRequestListeners = server.listenerCount('request');
  let outcome = 'pending';
  let rejectedMessage = '';
  const started = Date.now();
  const capture = socketOwnership.boundSocketIdentity(server, socket);
  capture.then(
    () => { outcome = 'fulfilled'; },
    error => { outcome = 'rejected'; rejectedMessage = error.message; }
  );
  await witnessed;
  await assert.rejects(capture, /Claude channel bound socket qualification timed out/);
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 900, `deadline must not fire prematurely (elapsed ${elapsed}ms)`);
  assert.ok(elapsed < 4000, `deadline must stay bounded (elapsed ${elapsed}ms)`);
  assert.match(rejectedMessage, /Claude channel bound socket qualification timed out/);
  await waitForCondition(() => activeConnections.size === 0, 'proof connection must be closed at deadline');

  for (const entry of held) {
    try { entry.response.writeHead(200); } catch {}
    try { entry.response.end(JSON.stringify({ provider: 'claude' })); } catch {}
  }
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(outcome, 'rejected', 'no late witness may convert a timed-out capture into success');
  assert.equal(server.listenerCount('request'), baselineRequestListeners, 'temporary qualification listener must be removed');
  assert.equal(fs.existsSync(socket), true, 'timed-out capture must leave the socket pathname in place');
});

test('qualification rejects pathname replacement after its witness', { timeout: 6000 }, async t => {
  const directory = fs.mkdtempSync('/tmp/dss-');
  fs.chmodSync(directory, 0o700);
  const publicPath = path.join(directory, 'public.sock');
  const movedPath = path.join(directory, 'moved.sock');
  const privatePath = path.join(directory, 'private.sock');
  const held = [];
  let observedResolve;
  const witnessed = new Promise(resolve => { observedResolve = resolve; });
  const serverA = http.createServer((request, response) => {
    request.resume();
    held.push({ request, response });
    observedResolve();
  });
  const serverB = http.createServer((request, response) => {
    request.resume();
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ provider: 'claude', id: 'ordinary-logical-id' }));
  });
  t.after(async () => {
    try {
      if (fs.existsSync(publicPath)) fs.renameSync(publicPath, privatePath);
      for (const entry of held) {
        try { entry.response.destroy(); } catch {}
        try { entry.request.destroy(); } catch {}
      }
      await closeListeningServer(serverA);
      await closeListeningServer(serverB);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
  await listenOn(serverA, publicPath);
  const capture = socketOwnership.boundSocketIdentity(serverA, publicPath);
  await witnessed;
  fs.renameSync(publicPath, movedPath);
  await listenOn(serverB, publicPath);
  const bIdentity = socketOwnership.socketPathIdentity(publicPath);
  assert.ok(bIdentity, 'replacement listener path identity must be readable');
  for (const entry of held) {
    try { entry.response.end(); } catch {}
  }
  await assert.rejects(capture, /Claude channel bound socket qualification refused/);

  const probe = await requestOverSocket(publicPath, { method: 'GET' });
  assert.equal(probe.statusCode, 200, 'replacement listener must remain reachable');
  const observedIdentity = socketOwnership.socketPathIdentity(publicPath);
  assert.ok(observedIdentity, 'replacement identity must remain readable');
  assert.equal(observedIdentity.dev, bIdentity.dev, 'replacement dev must be preserved');
  assert.equal(observedIdentity.ino, bIdentity.ino, 'replacement ino must be preserved');
  assert.equal(observedIdentity.ctimeNs, bIdentity.ctimeNs, 'replacement ctimeNs must be preserved');
  assert.equal(observedIdentity.birthtimeNs, bIdentity.birthtimeNs, 'replacement birthtimeNs must be preserved');
});

test('unrelated requests cannot qualify the bound listener', { timeout: 6000 }, async t => {
  const directory = fs.mkdtempSync('/tmp/dss-');
  fs.chmodSync(directory, 0o700);
  const publicPath = path.join(directory, 'public.sock');
  const movedPath = path.join(directory, 'moved.sock');
  const privatePath = path.join(directory, 'private.sock');
  const serverA = http.createServer((request, response) => {
    request.resume();
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ provider: 'claude', id: 'server-a' }));
  });
  let nonceRequests = 0;
  const serverB = http.createServer((request, response) => {
    request.resume();
    if (request.headers['x-discord-socket-qualification'] !== undefined) nonceRequests += 1;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ provider: 'claude', id: 'ordinary-logical-id' }));
  });
  t.after(async () => {
    try {
      if (fs.existsSync(publicPath)) fs.renameSync(publicPath, privatePath);
      await closeListeningServer(serverA);
      await closeListeningServer(serverB);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
  await listenOn(serverA, publicPath);
  fs.renameSync(publicPath, movedPath);
  await listenOn(serverB, publicPath);
  const bIdentity = socketOwnership.socketPathIdentity(publicPath);
  assert.ok(bIdentity, 'replacement listener path identity must be readable');

  const unrelated = await requestOverSocket(publicPath, { method: 'GET' });
  assert.equal(unrelated.statusCode, 200, 'unrelated request must reach the replacement listener');
  assert.equal(nonceRequests, 0, 'unrelated traffic must not carry the qualification nonce');

  await assert.rejects(
    socketOwnership.boundSocketIdentity(serverA, publicPath),
    /Claude channel bound socket qualification refused/,
    'capture must refuse when the supplied server never witnessed the request'
  );
  assert.equal(nonceRequests, 1, 'the qualification request must reach the other real listener');
  const probe = await requestOverSocket(publicPath, { method: 'GET' });
  assert.equal(probe.statusCode, 200, 'replacement listener must remain reachable');
  const observedIdentity = socketOwnership.socketPathIdentity(publicPath);
  assert.ok(observedIdentity, 'replacement identity must remain readable');
  assert.equal(observedIdentity.dev, bIdentity.dev, 'replacement dev must be preserved');
  assert.equal(observedIdentity.ino, bIdentity.ino, 'replacement ino must be preserved');
  assert.equal(observedIdentity.ctimeNs, bIdentity.ctimeNs, 'replacement ctimeNs must be preserved');
  assert.equal(observedIdentity.birthtimeNs, bIdentity.birthtimeNs, 'replacement birthtimeNs must be preserved');
});
