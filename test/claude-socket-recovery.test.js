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

test('abrupt listener expiry can re-arm the same Claude binding', { timeout: 8000 }, async t => {
  const socket = socketPath(t, { cleanup: false });
  const { dir, db, state } = fixture();
  state.bind({ channelId: 'claude', guildId: 'guild-1', provider: 'claude', nativeId: CLAUDE_ID, workspace: dir, endpoint: socket, generation: 7 }, { intakeCutoff: '100' });
  const messageId = '101';
  state.acceptDiscordMessage({
    id: messageId, guildId: 'guild-1', channelId: 'claude', authorId: 'operator-1', isBot: false,
    content: 'retain this accepted custody across abrupt listener death'
  }, { ready: false });

  const beforeBinding = state.getBinding('claude');
  assert.equal(beforeBinding.channelId, 'claude');
  assert.equal(beforeBinding.generation, 7);
  const beforeCustody = state.listMessages().map(message => state.getMessage(message.id));
  assert.equal(beforeCustody.length, 1);
  assert.equal(beforeCustody[0].id, messageId);
  // The killed child opens this exact persisted database and the existing binding.
  state.close();

  await orphan(socket, { db, workspace: dir });

  const recoveredState = new SurfaceState(db);
  const channel = new ClaudeChannel({ state: recoveredState, nativeId: CLAUDE_ID, socketPath: socket, mcp: { notification: async () => {} } });
  t.after(async () => {
    try {
      await channel.stop();
    } finally {
      try { recoveredState.close(); } finally {
        removeSocketDirectory(socket);
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });
  await channel.start();
  assert.equal(channel.ready, true, 'public start must re-arm a real listener');
  const socketStats = fs.lstatSync(socket);
  assert.equal(socketStats.isSocket(), true, 're-armed path must be a real unix socket');

  const afterBinding = recoveredState.getBinding('claude');
  assert.equal(afterBinding.nativeId, beforeBinding.nativeId, 'native UUID must survive recovery');
  assert.equal(afterBinding.generation, 7, 'binding generation must not reset');
  assert.equal(afterBinding.workspace, beforeBinding.workspace, 'workspace must survive recovery');
  assert.equal(afterBinding.endpoint, beforeBinding.endpoint, 'endpoint must survive recovery');
  assert.equal(recoveredState.listBindings().length, 1, 'recovery must not create a replacement binding');

  const afterCustody = recoveredState.listMessages().map(message => recoveredState.getMessage(message.id));
  assert.deepEqual(afterCustody, beforeCustody, 'accepted message custody must be unchanged');
});

test('foreign-owned socket directory ancestors below sticky parents are refused', t => {
  const sharedRoot = fs.mkdtempSync('/tmp/dss-foreign-');
  fs.chmodSync(sharedRoot, 0o1777);
  const foreignDirectory = path.join(sharedRoot, 'foreign-directory');
  fs.mkdirSync(foreignDirectory, { mode: 0o700 });
  const socket = path.join(foreignDirectory, 'listener.sock');
  const owner = process.geteuid?.() ?? process.getuid?.();
  if (owner === undefined) return t.skip('requires an effective UID');
  const originalLstatSync = fs.lstatSync;
  t.mock.method(fs, 'lstatSync', (candidate, options) => {
    const stats = originalLstatSync(candidate, options);
    if (candidate !== foreignDirectory) return stats;
    return {
      ...stats,
      uid: owner + 1,
      isDirectory: () => true,
      isSymbolicLink: () => false
    };
  });
  t.after(() => fs.rmSync(sharedRoot, { recursive: true, force: true }));

  assert.throws(() => assertSocketDirectory(socket), /foreign-owned directory/);
});

test('foreign-owned read-only socket ancestors are refused', t => {
  const root = fs.mkdtempSync('/tmp/dss-foreign-parent-');
  const foreign = path.join(root, 'foreign');
  const child = path.join(foreign, 'child');
  fs.mkdirSync(child, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const owner = process.geteuid?.() ?? process.getuid?.();
  if (owner === undefined) return t.skip('requires an effective UID');
  const originalStat = fs.statSync;
  t.mock.method(fs, 'statSync', (candidate, ...args) => {
    const stats = originalStat(candidate, ...args);
    return candidate === foreign ? { ...stats, uid: owner + 1, mode: (stats.mode & ~0o777) | 0o555 } : stats;
  });

  assert.throws(() => assertSocketDirectory(path.join(child, 'listener.sock')), /mutable path component/);
});

test('foreign-owned owner-writable socket ancestors are refused', t => {
  const root = fs.mkdtempSync('/tmp/dss-foreign-writable-');
  const foreign = path.join(root, 'foreign');
  const child = path.join(foreign, 'child');
  fs.mkdirSync(child, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const owner = process.geteuid?.() ?? process.getuid?.();
  if (owner === undefined) return t.skip('requires an effective UID');
  const originalLstat = fs.lstatSync;
  t.mock.method(fs, 'lstatSync', (candidate, ...args) => {
    const stats = originalLstat(candidate, ...args);
    return candidate === foreign ? {
      ...stats,
      uid: owner + 1,
      mode: (stats.mode & ~0o777) | 0o700,
      isDirectory: () => true,
      isSymbolicLink: () => false
    } : stats;
  });

  assert.throws(() => assertSocketDirectory(path.join(child, 'listener.sock')), /foreign-owned directory/);
});

test('owner records preserve a process identity when Linux exposes one', t => {
  isolatedNamespaceRoot(t);
  const socket = socketPath(t);
  assertSocketDirectory(socket);
  const { release, lockPath } = acquireSocketLockWithPath(t, socket);
  try {
    const owner = JSON.parse(fs.readFileSync(path.join(lockPath, 'owner'), 'utf8'));
    assert.equal(owner.pid, process.pid);
    if (process.platform === 'linux') {
      if (owner.identity !== undefined) assert.match(owner.identity, /^(?:proc|ps):/);
    }
  } finally {
    release();
  }
});

test('bound socket identity uses qualified pathname metadata', { timeout: 6000 }, async t => {
  const socket = socketPath(t, { cleanup: false });
  const directory = path.dirname(socket);
  const server = http.createServer((request, response) => {
    response.writeHead(404);
    response.end();
  });
  t.after(async () => {
    try {
      await closeListeningServer(server);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
  await listenOn(server, socket);
  const baselineRequestListeners = server.listenerCount('request');
  const identity = await socketOwnership.boundSocketIdentity(server, socket);
  const stats = fs.lstatSync(socket, { bigint: true });
  assert.ok(identity, 'capture must publish an identity for an owned bound socket');
  assert.equal(identity.dev, stats.dev, 'device must match the qualified pathname');
  assert.equal(identity.ino, stats.ino, 'inode must match the qualified pathname');
  assert.equal(identity.ctimeNs, stats.ctimeNs, 'ctime must match the qualified pathname');
  assert.equal(identity.birthtimeNs, stats.birthtimeNs, 'birthtime must match the qualified pathname');
  assert.equal(
    server.listenerCount('request'),
    baselineRequestListeners,
    'capture must remove its temporary qualification listener'
  );
});

test('socket ownership follows the effective UID when real and effective IDs differ', t => {
  if (process.getuid === undefined || process.geteuid === undefined) return;
  const realUid = process.getuid();
  t.mock.method(process, 'getuid', () => realUid + 1);
  const socket = socketPath(t);
  assert.doesNotThrow(() => assertSocketDirectory(socket));
});

test('live socket locks survive contenders with different timezones', { timeout: 8000 }, async t => {
  const socket = socketPath(t);
  const modulePath = path.resolve(__dirname, '../src/claude/socket-ownership');
  const holder = spawn(process.execPath, ['-e', `
    const deadline = setTimeout(() => process.exit(2), 7000);
    deadline.unref();
    const fs = require('node:fs');
    const os = require('node:os');
    const childUserInfo = os.userInfo();
    os.userInfo = () => ({ ...childUserInfo, homedir: process.argv[3] });
    const childRealpathSync = fs.realpathSync;
    fs.realpathSync = (target, ...options) => String(target) === '/tmp'
      ? process.argv[4]
      : childRealpathSync(target, ...options);
    const { acquireSocketLock } = require(process.argv[1]);
    const release = acquireSocketLock(process.argv[2]);
    process.stdout.write('ready');
    process.stdin.resume();
    process.stdin.on('end', () => {
      try { release(); process.exit(0); } catch (error) { process.stderr.write(String(error)); process.exit(1); }
    });
  `, modulePath, socket, SUITE_HOME_ROOT, SUITE_SHARED_TEMP_ROOT], {
    env: { ...process.env, TZ: 'UTC' },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  t.after(() => holder.kill('SIGKILL'));
  await once(holder.stdout, 'data');
  const contender = spawnSync(process.execPath, ['-e', `
    const deadline = setTimeout(() => process.exit(2), 4000);
    deadline.unref();
    const fs = require('node:fs');
    const os = require('node:os');
    const childUserInfo = os.userInfo();
    os.userInfo = () => ({ ...childUserInfo, homedir: process.argv[3] });
    const childRealpathSync = fs.realpathSync;
    fs.realpathSync = (target, ...options) => String(target) === '/tmp'
      ? process.argv[4]
      : childRealpathSync(target, ...options);
    const { acquireSocketLock } = require(process.argv[1]);
    try { const release = acquireSocketLock(process.argv[2]); release(); process.stdout.write('acquired'); }
    catch (error) { process.stdout.write(String(error)); }
  `, modulePath, socket, SUITE_HOME_ROOT, SUITE_SHARED_TEMP_ROOT], {
    env: { ...process.env, TZ: 'America/Los_Angeles' },
    encoding: 'utf8',
    timeout: 5000
  });
  assert.equal(contender.status, 0, contender.stderr);
  assert.match(contender.stdout, /already in progress/);
  holder.stdin.end();
  await once(holder, 'exit');
});

test('unreadable live owner markers preserve the preparation lock', { timeout: 8000 }, t => {
  if (process.getuid?.() === 0) return t.skip('requires non-root permissions');
  const socket = socketPath(t);
  assertSocketDirectory(socket);
  const { release, lockPath } = acquireSocketLockWithPath(t, socket);
  const ownerPath = path.join(lockPath, 'owner');
  t.after(() => {
    try { fs.chmodSync(ownerPath, 0o600); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  });
  try {
    fs.chmodSync(ownerPath, 0);
    const contender = spawnSync(process.execPath, ['-e', `
      const deadline = setTimeout(() => process.exit(2), 4000);
      deadline.unref();
      const fs = require('node:fs');
      const os = require('node:os');
      const childUserInfo = os.userInfo();
      os.userInfo = () => ({ ...childUserInfo, homedir: process.argv[3] });
      const childRealpathSync = fs.realpathSync;
      fs.realpathSync = (target, ...options) => String(target) === '/tmp'
        ? process.argv[4]
        : childRealpathSync(target, ...options);
      const { acquireSocketLock } = require(process.argv[1]);
      try { acquireSocketLock(process.argv[2]); process.stdout.write('acquired'); }
      catch (error) { process.stdout.write(String(error.code || error)); }
    `, path.resolve(__dirname, '../src/claude/socket-ownership'), socket, SUITE_HOME_ROOT, SUITE_SHARED_TEMP_ROOT], {
      encoding: 'utf8',
      timeout: 5000
    });
    assert.equal(contender.status, 0, contender.stderr);
    assert.match(contender.stdout, /EACCES/);
    assert.equal(fs.existsSync(ownerPath), true);
  } finally {
    fs.chmodSync(ownerPath, 0o600);
    release();
  }
});

test('socket paths overlapping the reserved coordination namespace are refused', t => {
  const socket = socketPath(t);
  assertSocketDirectory(socket);
  const local = acquireSocketLockWithPath(t, socket);
  const namespacePath = path.dirname(local.lockPath);

  // A normal endpoint whose parent merely starts with the namespace name still works.
  const nearNamespace = fs.mkdtempSync('/tmp/.discord-surface-locks-private-');
  fs.chmodSync(nearNamespace, 0o700);
  t.after(() => fs.rmSync(nearNamespace, { recursive: true, force: true }));
  const nearSocket = path.join(nearNamespace, 'listener.sock');
  assertSocketDirectory(nearSocket);
  const near = acquireSocketLockWithPath(t, nearSocket);
  t.after(() => releaseQuietly(near.release));
  assert.equal(path.dirname(near.lockPath), namespacePath);

  // A short symlink-parent alias into the reserved namespace must be refused.
  const alias = `${namespacePath}-alias-${randomUUID()}`;
  fs.symlinkSync(namespacePath, alias, 'dir');
  t.after(() => fs.unlinkSync(alias));

  assert.throws(() => acquireSocketLock(path.join(namespacePath, 'direct.sock')), /conflicts with socket path/);
  assert.throws(() => acquireSocketLock(path.join(alias, 'aliased.sock')), /conflicts with socket path/);
  assert.throws(() => acquireSocketLock(local.lockPath), /conflicts with socket path/);

  local.release();
});

test('socket locks use one fixed namespace and retain it across release', t => {
  const root = isolatedNamespaceRoot(t);
  const socket = socketPath(t);
  assertSocketDirectory(socket);
  const { release, lockPath } = acquireSocketLockWithPath(t, socket);
  const namespacePath = path.dirname(lockPath);
  assert.equal(path.dirname(namespacePath), root);
  assert.match(path.basename(namespacePath), new RegExp(`^\\.discord-surface-locks-${process.getuid()}-coordination`));

  // Changed HOME must not move the lock: the contender still sees the same one.
  const bogus = path.join(root, `dss-bogus-${randomUUID()}`);
  t.mock.method(os, 'homedir', () => bogus);
  assert.throws(() => acquireSocketLock(socket), /already in progress/);

  // Environment-independent retention: the shared namespace must never be an
  // rmdir target (a non-empty namespace would otherwise mask the bug as ENOTEMPTY).
  const rmdirs = [];
  const originalRmdir = fs.rmdirSync;
  t.mock.method(fs, 'rmdirSync', (target, ...args) => {
    rmdirs.push(String(target));
    return originalRmdir(target, ...args);
  });
  release();
  assert.equal(fs.existsSync(lockPath), false, 'release must remove only the lock object');
  // Plain retention assertion: the shared namespace directory must survive release.
  assert.equal(fs.existsSync(namespacePath), true, 'namespace directory must be retained after release');
  assert.equal(fs.lstatSync(namespacePath).isDirectory(), true, 'namespace path must remain a directory');
  assert.equal(rmdirs.includes(namespacePath), false, 'release must never rmdir the shared namespace root');
});

for (const [label, mode] of [
  ['group-writable', 0o777],
  ['read-only', 0o555],
  ['not-searchable', 0o600],
  ['missing', null],
]) {
  test(`an ${label} passwd home falls back to the stable owner-controlled system temporary root`, t => {
    const root = path.join('/tmp', `dss-root-${randomUUID()}`);
    if (mode !== null) {
      fs.mkdirSync(root, { mode: 0o700 });
      fs.chmodSync(root, mode);
    }
    const runtimeRoot = fs.mkdtempSync('/tmp/dss-runtime-root-');
    fs.chmodSync(runtimeRoot, 0o700);
    const userInfo = os.userInfo();
    t.mock.method(os, 'userInfo', () => ({ ...userInfo, homedir: root }));
    const previousRuntimeRoot = process.env.XDG_RUNTIME_DIR;
    process.env.XDG_RUNTIME_DIR = runtimeRoot;
    if (label === 'not-searchable') {
      const originalAccessSync = fs.accessSync;
      t.mock.method(fs, 'accessSync', (target, accessMode, ...args) => {
        if (String(target) === root && (accessMode & fs.constants.X_OK) !== 0) {
          const error = new Error('search access denied');
          error.code = 'EACCES';
          throw error;
        }
        return originalAccessSync(target, accessMode, ...args);
      });
    }
    t.after(() => {
      if (previousRuntimeRoot === undefined) delete process.env.XDG_RUNTIME_DIR;
      else process.env.XDG_RUNTIME_DIR = previousRuntimeRoot;
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(runtimeRoot, { recursive: true, force: true });
    });

    const socket = socketPath(t);
    const { release, lockPath } = acquireSocketLockWithPath(t, socket);
    try {
      const owner = process.geteuid?.() ?? process.getuid?.();
      const stableRoot = fs.realpathSync('/tmp');
      const privateRoot = path.dirname(path.dirname(lockPath));
      const ownerName = owner === undefined ? 'shared' : String(owner);
      assert.equal(path.dirname(privateRoot), stableRoot,
        'an unsafe passwd home must use the system temporary root');
      assert.match(path.basename(privateRoot), new RegExp(`^\\.claude-channel-${ownerName}-[A-Za-z0-9]+$`),
        'the fallback root must use an unpredictable name');
      if (owner !== undefined) {
        assert.equal(fs.lstatSync(privateRoot).uid, owner,
          'the fallback root must remain owner-controlled');
      }
      if (mode !== null) assert.deepEqual(fs.readdirSync(root), [], 'the unsafe home must remain untouched');
    } finally {
      release();
    }
  });
}
