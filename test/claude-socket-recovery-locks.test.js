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

test('ownerless preparation locks are reclaimed without deleting a replacement owner', t => {
  const socket = socketPath(t);
  assertSocketDirectory(socket);
  const first = acquireSocketLockWithPath(t, socket);
  const firstRelease = first.release;
  const lockPath = first.lockPath;
  fs.unlinkSync(path.join(lockPath, 'owner'));
  const secondRelease = acquireSocketLockWithPath(t, socket).release;
  assert.throws(firstRelease, /lock owner changed before release/);
  assert.equal(fs.existsSync(path.join(lockPath, 'owner')), true);
  assert.throws(() => acquireSocketLock(socket), /already in progress/);
  assert.doesNotThrow(secondRelease);
  assert.equal(fs.existsSync(lockPath), false);
});

test('malformed owner temporaries from dead processes are reclaimed', t => {
  const socket = socketPath(t);
  assertSocketDirectory(socket);
  const first = acquireSocketLockWithPath(t, socket);
  const lockPath = first.lockPath;
  const ownerPath = path.join(lockPath, 'owner');
  const temporaryPath = path.join(lockPath, '.owner-999999999-crashed');
  t.after(() => fs.rmSync(lockPath, { recursive: true, force: true }));

  fs.unlinkSync(ownerPath);
  fs.writeFileSync(temporaryPath, '', { mode: 0o600 });

  const secondRelease = acquireSocketLock(socket);
  assert.equal(fs.existsSync(temporaryPath), false);
  assert.doesNotThrow(secondRelease);
});

test('ownerless lock replacement is not reclaimed by a stale contender', t => {
  const socket = socketPath(t);
  assertSocketDirectory(socket);
  const first = acquireSocketLockWithPath(t, socket);
  const lockPath = first.lockPath;
  const ownerPath = path.join(lockPath, 'owner');

  const originalOpen = fs.openSync;
  let replacementRelease;
  let replaced = false;
  t.mock.method(fs, 'openSync', (file, ...args) => {
    if (!replaced && file === ownerPath) {
      replaced = true;
      fs.rmSync(lockPath, { recursive: true, force: true });
      replacementRelease = acquireSocketLockWithPath(t, socket).release;
      throw Object.assign(new Error('owner marker missing'), { code: 'ENOENT' });
    }
    return originalOpen(file, ...args);
  });

  assert.throws(() => acquireSocketLock(socket), /already in progress/);
  assert.equal(replaced, true);
  assert.equal(fs.existsSync(ownerPath), true);
  assert.ok(replacementRelease);
  assert.doesNotThrow(replacementRelease);
  assert.equal(fs.existsSync(lockPath), false);
});

test('a regular file at the canonical lock path is refused untouched', t => {
  const socket = socketPath(t);
  assertSocketDirectory(socket);
  const first = acquireSocketLockWithPath(t, socket);
  const lockPath = first.lockPath;
  first.release();
  t.after(() => fs.rmSync(lockPath, { recursive: true, force: true }));
  const ownerBytes = JSON.stringify({ pid: 999999999 });
  fs.writeFileSync(lockPath, ownerBytes, { mode: 0o600 });
  const before = fs.lstatSync(lockPath, { bigint: true });

  const originalRename = fs.renameSync;
  const renamed = [];
  t.mock.method(fs, 'renameSync', (source, ...rest) => {
    if (String(source) === lockPath) renamed.push(String(rest[0]));
    return originalRename(source, ...rest);
  });

  assert.throws(() => acquireSocketLock(socket), /already in progress/);
  const after = fs.lstatSync(lockPath, { bigint: true });
  assert.equal(after.isFile(), true, 'regular file must be preserved');
  assert.equal(after.ino, before.ino, 'regular file identity must be preserved');
  assert.equal(fs.readFileSync(lockPath, 'utf8'), ownerBytes, 'regular file bytes must be preserved');
  assert.deepEqual(renamed, [], 'regular file must not be renamed');

  // A replacement object appearing at the path afterward is also refused and preserved.
  fs.writeFileSync(lockPath, 'replacement-object');
  assert.throws(() => acquireSocketLock(socket), /already in progress/);
  assert.equal(fs.readFileSync(lockPath, 'utf8'), 'replacement-object');
});

test('a symlink at the canonical lock path is refused untouched', t => {
  const socket = socketPath(t);
  assertSocketDirectory(socket);
  const first = acquireSocketLockWithPath(t, socket);
  const lockPath = first.lockPath;
  first.release();
  t.after(() => fs.rmSync(lockPath, { recursive: true, force: true }));
  const target = `${lockPath}.target`;
  fs.symlinkSync(target, lockPath);
  const before = fs.lstatSync(lockPath, { bigint: true });
  assert.equal(before.isSymbolicLink(), true);

  assert.throws(() => acquireSocketLock(socket), /already in progress/);
  const after = fs.lstatSync(lockPath, { bigint: true });
  assert.equal(after.isSymbolicLink(), true, 'symlink must be preserved');
  assert.equal(after.ino, before.ino, 'symlink identity must be preserved');
  assert.equal(fs.readlinkSync(lockPath), target, 'symlink target must be preserved');
});

test('socket-lock release remains retryable after owner removal fails', t => {
  const socket = socketPath(t);
  assertSocketDirectory(socket);
  const { release, lockPath } = acquireSocketLockWithPath(t, socket);
  const originalRename = fs.renameSync;
  let failOwnerMove = true;
  t.mock.method(fs, 'renameSync', (source, destination) => {
    if (failOwnerMove && path.basename(source) === 'owner' && path.basename(path.dirname(destination)).startsWith('.transition-')) {
      failOwnerMove = false;
      const error = new Error('owner move failed');
      error.code = 'EACCES';
      throw error;
    }
    return originalRename(source, destination);
  });
  assert.throws(release, /owner move failed/);
  assert.equal(fs.existsSync(path.join(lockPath, 'owner')), true);
  assert.doesNotThrow(release);
  assert.equal(fs.existsSync(lockPath), false);
});

test('public socket-lock helper retries a transient release failure', async t => {
  const socket = socketPath(t);
  assertSocketDirectory(socket);
  const originalRename = fs.renameSync;
  let failOwnerMove = true;
  t.mock.method(fs, 'renameSync', (source, destination) => {
    if (failOwnerMove && path.basename(source) === 'owner' && path.basename(path.dirname(destination)).startsWith('.transition-')) {
      failOwnerMove = false;
      const error = new Error('owner move failed');
      error.code = 'EACCES';
      throw error;
    }
    return originalRename(source, destination);
  });

  await assert.doesNotReject(() => socketOwnership.withSocketLock(socket, async () => {}));
  assert.equal(failOwnerMove, false);
});

test('aliased socket parents share a live preparation lock', t => {
  const socket = socketPath(t);
  const realDirectory = path.dirname(socket);
  const aliasDirectory = `${realDirectory}-alias`;
  fs.symlinkSync(realDirectory, aliasDirectory, 'dir');
  t.after(() => fs.unlinkSync(aliasDirectory));
  const aliasSocket = path.join(aliasDirectory, path.basename(socket));
  assertSocketDirectory(socket);
  assertSocketDirectory(aliasSocket);
  const release = acquireSocketLock(socket);
  try {
    assert.throws(() => acquireSocketLock(aliasSocket), /already in progress/);
  } finally {
    release();
  }
});

test('foreign-owned socket directory symlinks are refused', t => {
  const socket = socketPath(t, { cleanup: false });
  const realDirectory = path.dirname(socket);
  const aliasDirectory = `${realDirectory}-foreign-alias`;
  fs.symlinkSync(realDirectory, aliasDirectory, 'dir');
  t.after(() => {
    fs.unlinkSync(aliasDirectory);
    removeSocketDirectory(socket);
  });
  const originalLstat = fs.lstatSync;
  t.mock.method(fs, 'lstatSync', (target, ...args) => {
    const stats = originalLstat(target, ...args);
    if (String(target) !== aliasDirectory || (args.length > 0 && args[0] && args[0].bigint)) return stats;
    return {
      ...stats,
      uid: (process.getuid?.() ?? 0) + 1,
      isDirectory: () => false,
      isSymbolicLink: () => true
    };
  });
  assert.throws(
    () => assertSocketDirectory(path.join(aliasDirectory, path.basename(socket))),
    /foreign-owned symlink/
  );
});

test('endpoint names ending in .lock do not collide with coordination artifacts', t => {
  const socket = socketPath(t);
  const sibling = `${socket}.lock`;
  assertSocketDirectory(socket);
  const first = acquireSocketLockWithPath(t, socket);
  const second = acquireSocketLockWithPath(t, sibling);
  assert.notEqual(first.lockPath, second.lockPath);
  const firstRelease = first.release;
  const secondRelease = second.release;
  assert.doesNotThrow(firstRelease);
  assert.doesNotThrow(secondRelease);
});

test('socket basename aliases share one lock only on case-insensitive parents', t => {
  const socket = socketPath(t);
  const alias = path.join(path.dirname(socket), 'LISTENER.SOCK');
  const caseInsensitive = isCaseInsensitiveDirectory(path.dirname(socket));
  assertSocketDirectory(socket);
  assertSocketDirectory(alias);
  const first = acquireSocketLockWithPath(t, socket);
  const firstRelease = first.release;
  try {
    if (caseInsensitive) {
      assert.throws(() => acquireSocketLock(alias), /already in progress/);
    } else {
      const second = acquireSocketLockWithPath(t, alias);
      assert.notEqual(first.lockPath, second.lockPath);
      second.release();
    }
  } finally {
    firstRelease();
  }
});
