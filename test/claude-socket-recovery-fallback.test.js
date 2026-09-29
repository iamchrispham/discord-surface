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

test('fallback lock roots ignore per-process runtime directories', t => {
  const root = path.join('/tmp', `dss-root-${randomUUID()}`);
  const runtimeA = fs.mkdtempSync('/tmp/dss-runtime-a-');
  const runtimeB = fs.mkdtempSync('/tmp/dss-runtime-b-');
  fs.chmodSync(runtimeA, 0o700);
  fs.chmodSync(runtimeB, 0o700);
  const userInfo = os.userInfo();
  t.mock.method(os, 'userInfo', () => ({ ...userInfo, homedir: root }));
  const previousRuntimeRoot = process.env.XDG_RUNTIME_DIR;
  process.env.XDG_RUNTIME_DIR = runtimeA;
  t.after(() => {
    if (previousRuntimeRoot === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = previousRuntimeRoot;
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(runtimeA, { recursive: true, force: true });
    fs.rmSync(runtimeB, { recursive: true, force: true });
  });

  const socket = socketPath(t);
  const first = acquireSocketLockWithPath(t, socket);
  try {
    process.env.XDG_RUNTIME_DIR = runtimeB;
    assert.throws(() => acquireSocketLock(socket), /already in progress/);
  } finally {
    first.release();
  }
});

test('fallback lock root remains stable when passwd home recovers', t => {
  const initialHome = path.join('/tmp', `dss-initial-home-${randomUUID()}`);
  const recoveredHome = path.join('/tmp', `dss-recovered-home-${randomUUID()}`);
  const sharedRoot = fs.mkdtempSync('/tmp/dss-recovery-root-');
  fs.chmodSync(sharedRoot, 0o1777);
  const userInfo = os.userInfo();
  let home = initialHome;
  t.mock.method(os, 'userInfo', () => ({ ...userInfo, homedir: home }));
  const originalRealpath = fs.realpathSync;
  t.mock.method(fs, 'realpathSync', (target, ...args) => {
    if (String(target) === '/tmp') return sharedRoot;
    return originalRealpath(target, ...args);
  });
  t.after(() => {
    fs.rmSync(recoveredHome, { recursive: true, force: true });
    fs.rmSync(sharedRoot, { recursive: true, force: true });
  });

  const socket = socketPath(t);
  const first = acquireSocketLockWithPath(t, socket);
  try {
    fs.mkdirSync(recoveredHome, { mode: 0o700 });
    home = recoveredHome;
    assert.throws(() => acquireSocketLock(socket), /already in progress/,
      'home recovery must not move contenders to a second lock namespace');
  } finally {
    first.release();
  }
});

test('fallback lock root remains stable when home identity is temporarily unavailable', t => {
  const recoveredHome = path.join('/tmp', `dss-recovered-home-${randomUUID()}`);
  const sharedRoot = fs.mkdtempSync('/tmp/dss-recovery-root-');
  fs.chmodSync(sharedRoot, 0o1777);
  const userInfo = os.userInfo();
  let homeAvailable = false;
  t.mock.method(os, 'userInfo', () => {
    if (!homeAvailable) throw new Error('passwd home unavailable');
    return { ...userInfo, homedir: recoveredHome };
  });
  const originalRealpath = fs.realpathSync;
  t.mock.method(fs, 'realpathSync', (target, ...args) => {
    if (String(target) === '/tmp') return sharedRoot;
    return originalRealpath(target, ...args);
  });
  t.after(() => fs.rmSync(recoveredHome, { recursive: true, force: true }));
  t.after(() => fs.rmSync(sharedRoot, { recursive: true, force: true }));

  const socket = socketPath(t);
  const first = acquireSocketLockWithPath(t, socket);
  try {
    fs.mkdirSync(recoveredHome, { mode: 0o700 });
    homeAvailable = true;
    assert.throws(() => acquireSocketLock(socket), /already in progress/,
      'home recovery must not move contenders to a second lock namespace');
  } finally {
    first.release();
  }
});

test('ambiguous fallback roots are refused when the publication marker disappears', t => {
  const missingHome = path.join('/tmp', `dss-missing-home-${randomUUID()}`);
  const userInfo = os.userInfo();
  t.mock.method(os, 'userInfo', () => ({ ...userInfo, homedir: missingHome }));
  const previousRuntimeRoot = process.env.XDG_RUNTIME_DIR;
  delete process.env.XDG_RUNTIME_DIR;

  const sharedRoot = fs.mkdtempSync('/tmp/dss-ambiguous-root-');
  fs.chmodSync(sharedRoot, 0o1777);
  const originalRealpath = fs.realpathSync;
  t.mock.method(fs, 'realpathSync', (target, ...args) => {
    if (String(target) === '/tmp') return sharedRoot;
    return originalRealpath(target, ...args);
  });
  t.after(() => {
    if (previousRuntimeRoot === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = previousRuntimeRoot;
    fs.rmSync(sharedRoot, { recursive: true, force: true });
  });

  const first = acquireSocketLockWithPath(t, socketPath(t));
  const rendezvousName = fs.readdirSync(sharedRoot).find(entry => entry.startsWith('.discord-surface-locks-'));
  assert.ok(rendezvousName);
  const markerPath = path.join(sharedRoot, rendezvousName, 'fallback-root');
  fs.unlinkSync(markerPath);
  const ownerName = process.geteuid?.() ?? process.getuid?.() ?? 'shared';
  fs.mkdtempSync(path.join(sharedRoot, `.claude-channel-${ownerName}-`));

  try {
    assert.throws(() => acquireSocketLock(socketPath(t)), /fallback-root rendezvous is ambiguous/);
  } finally {
    first.release();
  }
});

test('missing home and runtime roots bootstrap an unpredictable owner-only child under shared temp', t => {
  const missingHome = path.join('/tmp', `dss-missing-home-${randomUUID()}`);
  const userInfo = os.userInfo();
  t.mock.method(os, 'userInfo', () => ({ ...userInfo, homedir: missingHome }));
  const previousRuntimeRoot = process.env.XDG_RUNTIME_DIR;
  delete process.env.XDG_RUNTIME_DIR;

  const sharedTempRoot = fs.mkdtempSync('/tmp/dss-shared-temp-');
  fs.chmodSync(sharedTempRoot, 0o1777);
  const originalRealpath = fs.realpathSync;
  t.mock.method(fs, 'realpathSync', (target, ...args) => {
    if (String(target) === '/tmp') return sharedTempRoot;
    return originalRealpath(target, ...args);
  });
  const stableTempRoot = sharedTempRoot;
  const owner = process.geteuid?.() ?? process.getuid?.();
  const ownerName = owner === undefined ? 'shared' : String(owner);
  const decoy = path.join(stableTempRoot, `.claude-channel-${ownerName}`);
  fs.mkdirSync(decoy, { mode: 0o700, recursive: true });
  const originalStat = fs.statSync;
  t.mock.method(fs, 'statSync', (target, ...args) => {
    const stats = originalStat(target, ...args);
    if (String(target) !== stableTempRoot || (args.length > 0 && args[0] && args[0].bigint)) return stats;
    return {
      ...stats,
      uid: 0,
      mode: (stats.mode & ~0o1777) | 0o1777,
      isDirectory: () => stats.isDirectory(),
      isSymbolicLink: () => stats.isSymbolicLink()
    };
  });
  t.after(() => {
    if (previousRuntimeRoot === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = previousRuntimeRoot;
    fs.rmSync(sharedTempRoot, { recursive: true, force: true });
  });

  const socket = socketPath(t);
  const { release, lockPath } = acquireSocketLockWithPath(t, socket);
  try {
    const privateRoot = path.dirname(path.dirname(lockPath));
    assert.equal(path.dirname(privateRoot), stableTempRoot);
    assert.notEqual(privateRoot, decoy);
    assert.match(path.basename(privateRoot), new RegExp(`^\\.claude-channel-${ownerName}-[A-Za-z0-9]+$`));
    const privateStats = fs.lstatSync(privateRoot);
    assert.equal(privateStats.isDirectory(), true);
    assert.equal(privateStats.isSymbolicLink(), false);
    if (owner !== undefined) assert.equal(privateStats.uid, owner);
    assert.equal(privateStats.mode & 0o077, 0);

    const sibling = socketPath(t);
    const second = acquireSocketLockWithPath(t, sibling);
    try {
      assert.equal(path.dirname(path.dirname(second.lockPath)), path.dirname(path.dirname(lockPath)),
        'contenders must publish one coordinated fallback namespace');
    } finally {
      second.release();
    }
  } finally {
    release();
  }
});

test('foreign users cannot exhaust both predictable fallback rendezvous names', t => {
  const missingHome = path.join('/tmp', `dss-missing-home-${randomUUID()}`);
  const userInfo = os.userInfo();
  t.mock.method(os, 'userInfo', () => ({ ...userInfo, homedir: missingHome }));
  const previousRuntimeRoot = process.env.XDG_RUNTIME_DIR;
  delete process.env.XDG_RUNTIME_DIR;

  const sharedRoot = fs.mkdtempSync('/tmp/dss-rendezvous-root-');
  fs.chmodSync(sharedRoot, 0o1777);
  t.after(() => {
    if (previousRuntimeRoot === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = previousRuntimeRoot;
    fs.rmSync(sharedRoot, { recursive: true, force: true });
  });
  const originalRealpath = fs.realpathSync;
  t.mock.method(fs, 'realpathSync', (target, ...args) => {
    if (String(target) === '/tmp') return sharedRoot;
    return originalRealpath(target, ...args);
  });
  const owner = process.geteuid?.() ?? process.getuid?.();
  const ownerName = owner === undefined ? 'shared' : String(owner);
  const componentPrefix = `.discord-surface-locks-${ownerName}-coordination`;
  const minimumComponentLength = 90 + 1 - sharedRoot.length - path.sep.length;
  const rendezvousName = componentPrefix.length >= minimumComponentLength
    ? componentPrefix
    : `${componentPrefix}${'x'.repeat(minimumComponentLength - componentPrefix.length)}`;
  const deterministic = path.join(sharedRoot, rendezvousName);
  const shared = path.join(sharedRoot, `${rendezvousName}-shared`);
  const election = path.join(sharedRoot, `${rendezvousName}-election`);
  const electionMarker = path.join(sharedRoot, `${rendezvousName}-fallback-election`);
  fs.mkdirSync(deterministic, { mode: 0o700 });
  fs.mkdirSync(shared, { mode: 0o700 });
  fs.mkdirSync(election, { mode: 0o700 });
  fs.writeFileSync(electionMarker, `${rendezvousName}-random-foreign\n`, { mode: 0o600 });
  const originalStat = fs.statSync;
  t.mock.method(fs, 'statSync', (target, ...args) => {
    const stats = originalStat(target, ...args);
    if (String(target) !== sharedRoot || (args.length > 0 && args[0] && args[0].bigint)) return stats;
    return {
      ...stats,
      uid: owner === undefined ? 1 : owner + 1,
      mode: (stats.mode & ~0o1777) | 0o1777,
      isDirectory: () => stats.isDirectory(),
      isSymbolicLink: () => stats.isSymbolicLink()
    };
  });
  const originalLstat = fs.lstatSync;
  t.mock.method(fs, 'lstatSync', (target, ...args) => {
    const stats = originalLstat(target, ...args);
    if ((String(target) !== deterministic && String(target) !== shared && String(target) !== election && String(target) !== electionMarker) ||
      (args.length > 0 && args[0] && args[0].bigint)) return stats;
    return {
      ...stats,
      uid: owner === undefined ? 1 : owner + 1,
      isDirectory: () => stats.isDirectory(),
      isSymbolicLink: () => stats.isSymbolicLink()
    };
  });

  const socket = socketPath(t);
  const { release, lockPath } = acquireSocketLockWithPath(t, socket);
  try {
    const rendezvousChildren = fs.readdirSync(sharedRoot)
      .filter(entry => entry === rendezvousName || entry.startsWith(`${rendezvousName}-`));
    assert.ok(rendezvousChildren.some(entry => entry !== rendezvousName && entry !== `${rendezvousName}-shared`),
      'selection must create an unpredictable owner-controlled rendezvous');
    assert.equal(path.dirname(path.dirname(lockPath)).startsWith(sharedRoot), true);

    const sibling = socketPath(t);
    const second = acquireSocketLockWithPath(t, sibling);
    try {
      assert.equal(path.dirname(path.dirname(second.lockPath)), path.dirname(path.dirname(lockPath)),
        'fallback contenders must share the coordinated election namespace');
    } finally {
      second.release();
    }
  } finally {
    release();
  }
});

test('concurrent fallback contenders publish one coordinated namespace', { timeout: 8000 }, async t => {
  const sharedRoot = fs.mkdtempSync('/tmp/dss-concurrent-root-');
  fs.chmodSync(sharedRoot, 0o1777);
  const missingHome = path.join('/tmp', `dss-missing-home-${randomUUID()}`);
  const barrier = path.join(sharedRoot, 'start');
  const modulePath = path.resolve(__dirname, '../src/claude/socket-ownership');
  const sockets = [socketPath(t), socketPath(t)];
  const childScript = `
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const [modulePath, socket, sharedRoot, missingHome, barrier] = process.argv.slice(1);
    const userInfo = os.userInfo();
    os.userInfo = () => ({ ...userInfo, homedir: missingHome });
    const originalRealpath = fs.realpathSync;
    fs.realpathSync = (target, ...args) => String(target) === '/tmp'
      ? sharedRoot
      : originalRealpath(target, ...args);
    const deadline = setTimeout(() => process.exit(2), 7000);
    deadline.unref();
    process.stdout.write('ready\\n');
    const waitForStart = setInterval(() => {
      if (!fs.existsSync(barrier)) return;
      clearInterval(waitForStart);
      try {
        const { acquireSocketLock } = require(modulePath);
        const release = acquireSocketLock(socket);
        const privateRoot = fs.readdirSync(sharedRoot)
          .find(entry => entry.startsWith('.claude-channel-'));
        process.stdout.write(path.join(sharedRoot, privateRoot) + '\\n');
        process.stdin.resume();
        process.stdin.on('end', () => {
          try { release(); process.exit(0); }
          catch (error) { process.stderr.write(String(error)); process.exit(1); }
        });
      } catch (error) {
        process.stderr.write(String(error));
        process.exit(1);
      }
    }, 2);
  `;
  const children = sockets.map(socket => spawn(process.execPath, ['-e', childScript, modulePath, socket, sharedRoot, missingHome, barrier], {
    stdio: ['pipe', 'pipe', 'pipe']
  }));
  t.after(() => {
    for (const child of children) child.kill('SIGKILL');
    fs.rmSync(sharedRoot, { recursive: true, force: true });
  });
  await Promise.all(children.map(child => once(child.stdout, 'data')));
  fs.writeFileSync(barrier, 'go');
  const roots = await Promise.all(children.map(async child => String((await once(child.stdout, 'data'))[0]).trim()));
  assert.equal(roots[0], roots[1]);
  for (const child of children) child.stdin.end();
  await Promise.all(children.map(child => once(child, 'exit')));
});

test('a foreign shared-temp namespace cannot preempt the owner-controlled root', t => {
  const ownerRoot = isolatedNamespaceRoot(t);
  const socket = socketPath(t);
  const probe = acquireSocketLockWithPath(t, socket);
  const namespaceName = path.basename(path.dirname(probe.lockPath));
  probe.release();

  const sharedRoot = fs.mkdtempSync('/tmp/dss-shared-root-');
  fs.chmodSync(sharedRoot, 0o1777);
  t.after(() => fs.rmSync(sharedRoot, { recursive: true, force: true }));
  const decoy = path.join(sharedRoot, namespaceName);
  fs.mkdirSync(decoy, { mode: 0o700 });

  const originalStat = fs.statSync;
  t.mock.method(fs, 'statSync', (target, ...args) => {
    const stats = originalStat(target, ...args);
    if (String(target) !== sharedRoot) return stats;
    return {
      ...stats,
      uid: 0,
      mode: (stats.mode & ~0o1777) | 0o1777,
      isDirectory: () => stats.isDirectory(),
      isSymbolicLink: () => stats.isSymbolicLink()
    };
  });
  const originalLstat = fs.lstatSync;
  t.mock.method(fs, 'lstatSync', (target, ...args) => {
    const stats = originalLstat(target, ...args);
    if (String(target) !== decoy || (args.length > 0 && args[0] && args[0].bigint)) return stats;
    return {
      ...stats,
      uid: (process.getuid?.() ?? 0) + 1,
      isDirectory: () => stats.isDirectory(),
      isSymbolicLink: () => stats.isSymbolicLink()
    };
  });
  t.mock.method(os, 'tmpdir', () => sharedRoot);

  const release = acquireSocketLock(socket);
  release();
  assert.equal(fs.existsSync(decoy), true, 'the foreign shared-temp decoy must remain untouched');
  assert.equal(path.dirname(path.dirname(probe.lockPath)), ownerRoot,
    'the lock must stay under the owner-controlled root');
});
