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

test('preparation refuses a live socket without deleting it', async t => {
  const socket = socketPath(t);
  const server = net.createServer(connection => connection.destroy());
  await new Promise(resolve => server.listen(socket, resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const inode = fs.lstatSync(socket).ino;
  assert.throws(() => prepareSocket(socket), /already exists/);
  await assert.rejects(prepareSocketAsync(socket), /already exists/);
  assert.equal(fs.lstatSync(socket).ino, inode);
});

test('preparation preserves name-only quarantine directories', async t => {
  isolatedNamespaceRoot(t);
  const socket = socketPath(t);
  const deadPid = 2147480001;
  const quarantine = path.join(path.dirname(socket), `.stale-${deadPid}-unknown-${randomUUID()}`);
  const payload = path.join(quarantine, 'payload');
  fs.mkdirSync(payload, { mode: 0o700, recursive: true });
  fs.writeFileSync(path.join(payload, 'do-not-delete'), 'retained');

  await assert.doesNotReject(prepareSocketAsync(socket));
  assert.equal(fs.existsSync(quarantine), true, 'unmarked quarantine must remain untouched');
  assert.equal(fs.readFileSync(path.join(payload, 'do-not-delete'), 'utf8'), 'retained');
});

test('preparation restores an authenticated orphan quarantine before cleanup', { timeout: 8000 }, async t => {
  isolatedNamespaceRoot(t);
  const socket = socketPath(t, { cleanup: false });
  const server = net.createServer(connection => connection.destroy());
  await new Promise(resolve => server.listen(socket, resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const expected = socketOwnership.socketPathIdentity(socket);
  assert.ok(expected);
  const deadPid = 2147480001;
  const quarantine = path.join(path.dirname(socket), `.stale-${deadPid}-unknown-${randomUUID()}`);
  fs.mkdirSync(quarantine, { mode: 0o700 });
  fs.writeFileSync(path.join(quarantine, 'owner'), JSON.stringify({
    pid: deadPid,
    identity: 'fixture-dead-identity',
    generation: randomUUID()
  }), { mode: 0o600 });
  fs.writeFileSync(path.join(quarantine, 'manifest'), JSON.stringify({
    version: 1,
    endpoint: path.basename(socket),
    socket: Object.fromEntries(Object.entries(expected).map(([key, value]) => [key, value.toString()]))
  }), { mode: 0o600 });
  fs.renameSync(socket, path.join(quarantine, 'socket'));

  await assert.rejects(prepareSocketAsync(socket), /already exists/);
  assert.equal(fs.existsSync(quarantine), false, 'dead quarantine must be reclaimed on restart');
  assert.equal(fs.lstatSync(socket).isSocket(), true, 'live moved endpoint must be restored before probing');
});

test('preparation preserves regular files and symlinks', async t => {
  const socket = socketPath(t);
  fs.writeFileSync(socket, 'retained');
  assert.throws(() => prepareSocket(socket), /not a socket/);
  await assert.rejects(prepareSocketAsync(socket), /not a socket/);
  assert.equal(fs.readFileSync(socket, 'utf8'), 'retained');
  const link = socket + '.link';
  fs.symlinkSync(socket, link);
  assert.throws(() => prepareSocket(link), /not a socket/);
  await assert.rejects(prepareSocketAsync(link), /not a socket/);
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
});

test('concurrent re-arms retain exactly one listener', { timeout: 8000 }, async t => {
  const socket = socketPath(t, { cleanup: false });
  await orphan(socket);
  const { dir, state } = fixture();
  t.after(() => state.close());
  state.bind({ channelId: 'claude', guildId: 'guild-1', provider: 'claude', nativeId: CLAUDE_ID, workspace: dir, endpoint: socket }, { intakeCutoff: '100' });
  const channels = [0, 1].map(() => new ClaudeChannel({ state, nativeId: CLAUDE_ID, socketPath: socket, mcp: { notification: async () => {} } }));
  t.after(async () => {
    try {
      for (const channel of channels) await channel.stop();
    } finally {
      removeSocketDirectory(socket);
    }
  });
  const results = await Promise.allSettled(channels.map(channel => channel.start()));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(channels.filter(channel => channel.ready).length, 1);
  assert.equal(fs.lstatSync(socket).isSocket(), true);
});

test('socket replaced during refusal probe is preserved', { timeout: 8000 }, async t => {
  const socket = socketPath(t);
  await orphan(socket);
  const { EventEmitter } = require('node:events');
  t.mock.method(net, 'createConnection', () => {
    const probe = new EventEmitter();
    probe.destroy = () => {};
    queueMicrotask(() => {
      fs.unlinkSync(socket);
      fs.writeFileSync(socket, 'replacement');
      probe.emit('error', Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }));
    });
    return probe;
  });
  await assert.rejects(prepareSocketAsync(socket), /changed during stale probe/);
  assert.equal(fs.readFileSync(socket, 'utf8'), 'replacement');
});

test('replacement socket during refusal probe is preserved', { timeout: 8000 }, async t => {
  const socket = socketPath(t, { cleanup: false });
  await orphan(socket);

  // Keep the original probe from reusing the moved-aside inode: the old path is
  // renamed away so the allocator cannot hand its inode back to the replacement.
  const originalLstat = fs.lstatSync;
  const realCreateConnection = net.createConnection;
  let signalProbe;
  const probeReady = new Promise(resolve => { signalProbe = resolve; });
  let pendingProbe;
  t.mock.method(net, 'createConnection', () => {
    pendingProbe = new EventEmitter();
    pendingProbe.destroy = () => {};
    signalProbe();
    return pendingProbe;
  });

  const preparing = prepareSocketAsync(socket);
  await probeReady;

  fs.renameSync(socket, `${socket}.stale`);
  const replacement = net.createServer(connection => connection.destroy());
  t.after(async () => {
    if (replacement.listening) await new Promise(resolve => replacement.close(resolve));
    removeSocketDirectory(socket);
  });
  await new Promise((resolve, reject) => {
    replacement.once('error', reject);
    replacement.listen(socket, resolve);
  });
  const replacementIdentity = socketOwnership.socketPathIdentity(socket);
  assert.equal(originalLstat(socket).isSocket(), true);
  assert.ok(replacementIdentity && typeof replacementIdentity.ctimeNs === 'bigint');

  // The old probe's refusal arrives after the replacement listener is live.
  pendingProbe.emit('error', Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }));
  await assert.rejects(preparing, /changed during stale probe/);

  const after = socketOwnership.socketPathIdentity(socket);
  assert.equal(after.dev, replacementIdentity.dev, 'replacement socket device must be preserved');
  assert.equal(after.ino, replacementIdentity.ino, 'replacement socket inode must be preserved');
  assert.equal(after.ctimeNs, replacementIdentity.ctimeNs, 'replacement socket generation must be preserved');
  assert.equal(originalLstat(socket).isSocket(), true, 'replacement path must remain a socket');

  await new Promise((resolve, reject) => {
    const client = realCreateConnection.call(net, socket);
    client.once('connect', () => { client.destroy(); resolve(); });
    client.once('error', reject);
  });
});

test('foreign socket owner is refused before probing', { timeout: 8000 }, async t => {
  const socket = socketPath(t);
  await orphan(socket);
  const originalLstat = fs.lstatSync;
  const before = originalLstat(socket, { bigint: true });
  assert.equal(before.isSocket(), true);

  const originalUnlink = fs.unlinkSync;
  const unlinked = [];
  t.mock.method(fs, 'unlinkSync', (target, ...args) => {
    unlinked.push(String(target));
    return originalUnlink(target, ...args);
  });
  let probes = 0;
  t.mock.method(net, 'createConnection', () => {
    probes += 1;
    const probe = new EventEmitter();
    probe.destroy = () => {};
    return probe;
  });

  // Narrow fixture: only the preparation socket's own stat is rewritten to a
  // foreign owner; every other filesystem observation stays real.
  t.mock.method(fs, 'lstatSync', (target, ...args) => {
    if (target === socket) {
      const stats = originalLstat(target, ...args);
      return {
        dev: stats.dev,
        ino: stats.ino,
        ctimeMs: stats.ctimeMs,
        ctimeNs: stats.ctimeNs,
        uid: stats.uid + 1n,
        isSocket: () => true
      };
    }
    return originalLstat(target, ...args);
  });

  await assert.rejects(prepareSocketAsync(socket), /belongs to another owner/);
  assert.equal(probes, 0, 'foreign ownership must be refused before any probe');
  assert.equal(unlinked.includes(socket), false, 'foreign socket must not be unlinked');

  const after = originalLstat(socket, { bigint: true });
  assert.equal(after.dev, before.dev, 'foreign refusal must preserve socket device');
  assert.equal(after.ino, before.ino, 'foreign refusal must preserve socket inode');
  assert.equal(after.ctimeNs, before.ctimeNs, 'foreign refusal must preserve socket generation');
  assert.equal(after.isSocket(), true, 'foreign refusal must preserve the socket path');
});

test('inconclusive socket probe error preserves custody', { timeout: 8000 }, async t => {
  const socket = socketPath(t);
  await orphan(socket);
  const originalLstat = fs.lstatSync;
  const before = originalLstat(socket, { bigint: true });

  t.mock.method(net, 'createConnection', () => {
    const probe = new EventEmitter();
    probe.destroy = () => {};
    queueMicrotask(() => {
      probe.emit('error', Object.assign(new Error('permission denied'), { code: 'EACCES' }));
    });
    return probe;
  });

  await assert.rejects(prepareSocketAsync(socket), /permission denied/);
  const afterRefusal = originalLstat(socket, { bigint: true });
  assert.equal(afterRefusal.dev, before.dev, 'inconclusive probe must preserve socket device');
  assert.equal(afterRefusal.ino, before.ino, 'inconclusive probe must preserve socket inode');
  assert.equal(afterRefusal.ctimeNs, before.ctimeNs, 'inconclusive probe must preserve socket generation');
  assert.equal(fs.existsSync(socket), true, 'inconclusive probe must preserve the socket path');

  // Real preparation custody must be available again: the failed attempt retained no lock.
  t.mock.restoreAll();
  const release = acquireSocketLock(socket);
  assert.doesNotThrow(() => release());
  assert.equal(fs.existsSync(socket), true, 'released custody must still preserve the stale socket');

  // A real bounded preparation attempt is permitted now that the probe hook is gone.
  await assert.doesNotReject(prepareSocketAsync(socket));
  assert.equal(fs.existsSync(socket), false, 'the conclusive refusal may remove the owned stale socket');
});

test('socket probe timeout preserves custody after late refusal', { timeout: 8000 }, async t => {
  const socket = socketPath(t);
  await orphan(socket);
  const originalLstat = fs.lstatSync;
  const before = originalLstat(socket, { bigint: true });

  let probes = 0;
  let destroyCalls = 0;
  let pendingProbe;
  t.mock.method(net, 'createConnection', () => {
    probes += 1;
    pendingProbe = new EventEmitter();
    pendingProbe.destroy = () => { destroyCalls += 1; };
    pendingProbe.on('error', () => {});
    return pendingProbe;
  });

  // The real 1000 ms probe deadline expires with neither connect nor error.
  await assert.rejects(prepareSocketAsync(socket), /probe timed out/);
  assert.equal(probes, 1, 'timeout must be decided by the single probe');
  assert.equal(destroyCalls, 1, 'timeout must destroy the abandoned probe');

  const afterTimeout = originalLstat(socket, { bigint: true });
  assert.equal(afterTimeout.dev, before.dev, 'timeout must preserve socket device');
  assert.equal(afterTimeout.ino, before.ino, 'timeout must preserve socket inode');
  assert.equal(afterTimeout.ctimeNs, before.ctimeNs, 'timeout must preserve socket generation');
  assert.equal(fs.existsSync(socket), true, 'timeout must preserve the socket path');

  // A late refusal on the already-settled probe must not authorize an unlink.
  pendingProbe.emit('error', Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }));
  const afterLateRefusal = originalLstat(socket, { bigint: true });
  assert.equal(afterLateRefusal.dev, before.dev, 'late refusal must preserve socket device');
  assert.equal(afterLateRefusal.ino, before.ino, 'late refusal must preserve socket inode');
  assert.equal(afterLateRefusal.ctimeNs, before.ctimeNs, 'late refusal must preserve socket generation');
  assert.equal(fs.existsSync(socket), true, 'late refusal must preserve the socket path');

  // Preparation custody was released by the failed attempt.
  t.mock.restoreAll();
  const release = acquireSocketLock(socket);
  assert.doesNotThrow(() => release());
});

test('stop during orphan probe prevents subsequent listener startup', { timeout: 8000 }, async t => {
  const socket = socketPath(t);
  await orphan(socket);
  const { EventEmitter } = require('node:events');
  const probes = [];
  const originalCreateConnection = net.createConnection;
  t.mock.method(net, 'createConnection', (...args) => {
    if (probes.length >= 2) return originalCreateConnection.apply(net, args);
    const probe = new EventEmitter();
    probe.destroy = () => {};
    probes.push(probe);
    return probe;
  });
  const { dir, state } = fixture();
  t.after(() => state.close());
  state.bind({ channelId: 'claude', guildId: 'guild-1', provider: 'claude', nativeId: CLAUDE_ID, workspace: dir, endpoint: socket }, { intakeCutoff: '100' });
  const channel = new ClaudeChannel({ state, nativeId: CLAUDE_ID, socketPath: socket, mcp: { notification: async () => {} } });
  const starting = channel.start();
  const rejected = assert.rejects(starting, /stopped during socket preparation/);
  await channel.stop();
  probes[0].emit('error', Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }));
  await rejected;
  assert.equal(channel.ready, false);
  const restarting = channel.start();
  probes[1].emit('error', Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }));
  await restarting;
  assert.equal(channel.ready, true);
  await channel.stop();
  assert.equal(fs.existsSync(socket), false);
});
