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

test('an unusable fixed namespace root refuses with no fallback', t => {
  const probe = socketPath(t);
  assertSocketDirectory(probe);
  const seed = acquireSocketLockWithPath(t, probe);
  const namespacePath = path.dirname(seed.lockPath);
  seed.release();

  const socket = socketPath(t);
  const originalLstat = fs.lstatSync;
  t.mock.method(fs, 'lstatSync', (target, ...args) => {
    if (target === namespacePath && !(args.length > 0 && args[0] && args[0].bigint)) {
      const stats = originalLstat(target, ...args);
      return {
        dev: stats.dev,
        ino: stats.ino,
        mode: stats.mode & ~0o077,
        uid: stats.uid,
        isDirectory: () => false,
        isSymbolicLink: () => false
      };
    }
    return originalLstat(target, ...args);
  });

  assert.throws(() => acquireSocketLock(socket), /namespace is unusable/);
  assert.equal(fs.existsSync(socket), false, 'refusal must not mutate the socket path');
  assert.equal(fs.existsSync(namespacePath), true, 'refusal must not delete the shared namespace root');
});

// Each facet makes exactly one namespace usability term false, so removing that
// term from lockNamespacePath makes only that facet test fail.
function unusableNamespaceFacets() {
  const healthy = stats => ({
    dev: stats.dev,
    ino: stats.ino,
    mode: stats.mode,
    uid: stats.uid,
    isDirectory: () => true,
    isSymbolicLink: () => false
  });
  return [
    ['not a directory', stats => ({ ...healthy(stats), isDirectory: () => false })],
    ['a symlink', stats => ({ ...healthy(stats), isSymbolicLink: () => true })],
    ['group or other accessible', stats => ({ ...healthy(stats), mode: stats.mode | 0o077 })],
    ['owned by another uid', stats => ({ ...healthy(stats), uid: stats.uid + 1 })]
  ];
}

for (const [label, corrupt] of unusableNamespaceFacets()) {
  test(`an unusable fixed namespace root (${label}) refuses with no fallback`, t => {
    const probe = socketPath(t);
    assertSocketDirectory(probe);
    const seed = acquireSocketLockWithPath(t, probe);
    const namespacePath = path.dirname(seed.lockPath);
    seed.release();

    const socket = socketPath(t);
    const originalLstat = fs.lstatSync;
    t.mock.method(fs, 'lstatSync', (target, ...args) => {
      const stats = originalLstat(target, ...args);
      if (target === namespacePath && !(args.length > 0 && args[0] && args[0].bigint)) return corrupt(stats);
      return stats;
    });

    assert.throws(() => acquireSocketLock(socket), /namespace is unusable/);
    assert.equal(fs.existsSync(socket), false, 'refusal must not mutate the socket path');
    assert.equal(fs.existsSync(namespacePath), true, 'refusal must not delete the shared namespace root');
  });
}

test('staging ENOENT recovery revalidates a replaced fixed namespace', t => {
  const owner = process.getuid?.();
  const { namespacePath } = acquireProbeLock(t);

  function restoreNamespace() {
    fs.rmSync(namespacePath, { recursive: true, force: true });
    fs.mkdirSync(namespacePath, { mode: 0o700 });
    fs.chmodSync(namespacePath, 0o700);
  }
  restoreNamespace();

  const socket = socketPath(t);

  // Simulate the exact race: the namespace passes lockNamespacePath's validation,
  // then the first staging mkdir observes it gone (ENOENT). The recovery branch
  // must revalidate before retrying, because a foreign directory now occupies the
  // fixed path.
  let phase = 'replaced';
  const originalMkdir = fs.mkdirSync;
  t.mock.method(fs, 'mkdirSync', (target, ...args) => {
    const basename = path.basename(String(target));
    if (basename.startsWith('.staging-')) {
      if (phase === 'replaced') {
        phase = 'control';
        fs.rmSync(namespacePath, { recursive: true, force: true });
        originalMkdir(namespacePath, { mode: 0o777 });
        fs.chmodSync(namespacePath, 0o777);
        throw Object.assign(new Error('simulated vanished namespace'), { code: 'ENOENT' });
      }
      if (phase === 'control') {
        phase = 'done';
        fs.rmSync(namespacePath, { recursive: true, force: true });
        throw Object.assign(new Error('simulated vanished namespace'), { code: 'ENOENT' });
      }
    }
    return originalMkdir(target, ...args);
  });

  assert.throws(() => acquireSocketLock(socket), /namespace is unusable/);

  // The foreign replacement must be refused, not repaired or deleted.
  const replacement = fs.lstatSync(namespacePath);
  assert.equal(replacement.isDirectory(), true, 'replacement directory must be preserved');
  assert.equal(replacement.mode & 0o077, 0o077, 'replacement must not be chmod-repaired');
  if (owner !== undefined) assert.equal(replacement.uid, owner);

  const artifacts = [];
  const walk = directory => {
    for (const entry of fs.readdirSync(directory)) {
      const fullPath = path.join(directory, entry);
      artifacts.push({ relative: path.relative(namespacePath, fullPath), name: entry });
      if (fs.lstatSync(fullPath).isDirectory()) walk(fullPath);
    }
  };
  walk(namespacePath);
  assert.deepEqual(artifacts.filter(entry => entry.name.startsWith('.staging-')), [],
    'refusal must not create a staging directory');
  assert.deepEqual(artifacts.filter(entry => entry.name.endsWith('.lock')), [],
    'refusal must not create a lock directory');
  assert.deepEqual(artifacts.filter(entry => entry.name === 'owner'), [],
    'refusal must not create an owner marker');

  // Control: the namespace simply vanishes and the real owner recreates it mode
  // 0700 in the recovery branch, so acquisition still succeeds and release works.
  restoreNamespace();
  const release = acquireSocketLock(socket);
  try {
    const recreated = fs.lstatSync(namespacePath);
    assert.equal(recreated.isDirectory(), true);
    assert.equal(recreated.mode & 0o077, 0);
    if (owner !== undefined) assert.equal(recreated.uid, owner);
  } finally {
    release();
  }
  assert.equal(fs.existsSync(namespacePath), true, 'namespace root must survive release');
});

test('a namespace absent during the orphan scan recovers and acquires', t => {
  const owner = process.getuid?.();
  const { namespacePath } = acquireProbeLock(t);
  const socket = socketPath(t);

  // The namespace validates, then vanishes immediately after that first
  // validation snapshot. That window must stay ENOENT-tolerant so
  // createStagingLock can recreate it.
  const originalLstat = fs.lstatSync;
  let triggered = false;
  t.mock.method(fs, 'lstatSync', (target, ...args) => {
    if (!triggered && target === namespacePath && !(args.length > 0 && args[0] && args[0].bigint)) {
      triggered = true;
      // Capture the real valid snapshot on the first namespace lstat, then mutate
      // and return that snapshot for this one call only.
      const snapshot = originalLstat(target, ...args);
      fs.rmSync(namespacePath, { recursive: true, force: true });
      return snapshot;
    }
    return originalLstat(target, ...args);
  });

  let release;
  assert.doesNotThrow(() => { release = acquireSocketLock(socket); });
  assert.equal(triggered, true, 'race hook must fire');
  try {
    const recreated = fs.lstatSync(namespacePath);
    assert.equal(recreated.isDirectory(), true, 'namespace must be recreated as a directory');
    assert.equal(recreated.mode & 0o077, 0, 'recreated namespace must be owner-only');
    if (owner !== undefined) assert.equal(recreated.uid, owner);
  } finally {
    release();
  }
  assert.equal(fs.existsSync(namespacePath), true, 'namespace root must survive release');
});

test('orphan cleanup tolerates a staging entry removed by a contender', t => {
  const { namespacePath } = acquireProbeLock(t);
  const orphanName = `.staging-999999999-${randomUUID()}`;
  const orphanPath = path.join(namespacePath, orphanName);
  const orphanEntry = path.join(orphanPath, 'marker');
  fs.mkdirSync(orphanPath, { mode: 0o700 });
  fs.writeFileSync(orphanEntry, 'marker', { mode: 0o600 });
  const socket = socketPath(t);
  const originalKill = process.kill;
  t.mock.method(process, 'kill', (pid, signal) => {
    if (pid === 999999999) throw Object.assign(new Error('simulated dead contender'), { code: 'ESRCH' });
    return originalKill(pid, signal);
  });
  const originalLstat = fs.lstatSync;
  let raced = false;
  t.mock.method(fs, 'lstatSync', (target, ...args) => {
    if (!raced && target === orphanEntry && !(args.length > 0 && args[0] && args[0].bigint)) {
      raced = true;
      fs.unlinkSync(orphanEntry);
      throw Object.assign(new Error('simulated contender cleanup'), { code: 'ENOENT' });
    }
    return originalLstat(target, ...args);
  });

  let release;
  assert.doesNotThrow(() => { release = acquireSocketLock(socket); });
  assert.equal(raced, true, 'the per-entry removal race must be exercised');
  release();
});

test('a permissive replacement during the orphan scan is refused and preserved', t => {
  const owner = process.getuid?.();
  const { namespacePath } = acquireProbeLock(t);
  const socket = socketPath(t);
  const orphanName = `.staging-999999999-${randomUUID()}`;

  // The namespace validates, then a foreign permissive directory with a plausible
  // orphan staging dir occupies the fixed path immediately after that first
  // validation snapshot.
  const originalLstat = fs.lstatSync;
  let triggered = false;
  t.mock.method(fs, 'lstatSync', (target, ...args) => {
    if (!triggered && target === namespacePath && !(args.length > 0 && args[0] && args[0].bigint)) {
      triggered = true;
      // Capture the real valid snapshot on the first namespace lstat, then mutate
      // and return that snapshot for this one call only.
      const snapshot = originalLstat(target, ...args);
      fs.rmSync(namespacePath, { recursive: true, force: true });
      fs.mkdirSync(namespacePath, { mode: 0o777 });
      fs.chmodSync(namespacePath, 0o777);
      fs.mkdirSync(path.join(namespacePath, orphanName), { mode: 0o700 });
      return snapshot;
    }
    return originalLstat(target, ...args);
  });

  assert.throws(() => acquireSocketLock(socket), /namespace is unusable/);
  assert.equal(triggered, true, 'race hook must fire');

  const replacement = fs.lstatSync(namespacePath);
  assert.equal(replacement.isDirectory(), true, 'replacement directory must be preserved');
  assert.equal(replacement.mode & 0o077, 0o077, 'replacement must not be chmod-repaired');
  if (owner !== undefined) assert.equal(replacement.uid, owner);
  assert.equal(fs.existsSync(path.join(namespacePath, orphanName)), true,
    'seeded orphan staging dir must not be deleted by refusal');
});

test('coordination lock paths are rejected by the endpoint contract', t => {
  const socket = socketPath(t);
  const { release, lockPath } = acquireSocketLockWithPath(t, socket);
  try {
    assert.throws(() => assertSocketPath(lockPath), /too long/);
  } finally {
    release();
  }
});
