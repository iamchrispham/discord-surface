const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { once, EventEmitter } = require('node:events');
const { prepareSocket, prepareSocketAsync, ClaudeChannel } = require('../src/claude-channel');
const { SurfaceState } = require('../src/state');
const socketOwnership = require('../src/claude/socket-ownership');
const { acquireSocketLock, assertSocketDirectory, assertSocketPath } = socketOwnership;
const { fixture, CLAUDE_ID } = require('./surface-fixtures');

function removeSocketDirectory(socket) {
  fs.rmSync(path.dirname(socket), { recursive: true, force: true });
}

function socketPath(t, { cleanup = true } = {}) {
  const dir = fs.mkdtempSync('/tmp/dss-');
  fs.chmodSync(dir, 0o700);
  const socket = path.join(dir, 'listener.sock');
  if (cleanup) t.after(() => removeSocketDirectory(socket));
  return socket;
}

function acquireSocketLockWithPath(t, socket) {
  let lockPath;
  const originalRename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (source, destination) => {
    if (path.basename(source).startsWith('.staging-')) lockPath = destination;
    return originalRename(source, destination);
  });
  const release = acquireSocketLock(socket);
  assert.ok(lockPath);
  assert.equal(fs.existsSync(path.join(lockPath, 'owner')), true);
  return { release, lockPath };
}

// Per-test isolated lock namespace: redirect the owner-controlled os.tmpdir()
// root to a fresh temporary directory so tests never mutate the real shared
// per-UID coordination namespace.
function isolatedNamespaceRoot(t) {
  const root = fs.mkdtempSync('/tmp/dss-root-');
  fs.chmodSync(root, 0o700);
  t.mock.method(os, 'tmpdir', () => root);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return fs.realpathSync(root);
}

function acquireProbeLock(t) {
  const root = isolatedNamespaceRoot(t);
  const probeSocket = socketPath(t);
  const probe = acquireSocketLockWithPath(t, probeSocket);
  const namespacePath = path.dirname(probe.lockPath);
  assert.equal(path.dirname(namespacePath), root, 'namespace must live under the isolated root');
  probe.release();
  return { root, namespacePath };
}

function releaseQuietly(release) {
  if (!release) return;
  try { release(); } catch {}
}

function isCaseInsensitiveDirectory(directory) {
  const probe = `.case-probe-${randomUUID()}`;
  const probePath = path.join(directory, probe);
  const alternatePath = path.join(directory, probe.toUpperCase());
  fs.writeFileSync(probePath, 'probe');
  try { return fs.existsSync(alternatePath); } finally { fs.unlinkSync(probePath); }
}

async function orphan(socket, { db, workspace } = {}) {
  const channelModule = path.resolve(__dirname, '../src/claude-channel');
  const fixturesModule = path.resolve(__dirname, './surface-fixtures');
  const stateModule = path.resolve(__dirname, '../src/state');
  const child = spawn(process.execPath, ['-e', `
    const deadline = setTimeout(() => process.exit(2), 3000);
    deadline.unref();
    const { ClaudeChannel } = require(process.argv[1]);
    const { CLAUDE_ID } = require(process.argv[2]);
    const socket = process.argv[3];
    const dbPath = process.argv[4];
    const workspace = process.argv[5];
    let state;
    if (dbPath) {
      const { SurfaceState } = require(process.argv[6]);
      state = new SurfaceState(dbPath);
    } else {
      const { fixture } = require(process.argv[2]);
      const created = fixture();
      state = created.state;
      state.bind({ channelId: 'claude', guildId: 'guild-1', provider: 'claude', nativeId: CLAUDE_ID, workspace: workspace || created.dir, endpoint: socket });
    }
    const channel = new ClaudeChannel({ state, nativeId: CLAUDE_ID, socketPath: socket, mcp: { notification: async () => {} } });
    channel.start().then(() => process.stdout.write('ready')).catch(error => {
      process.stderr.write(String(error));
      process.exit(1);
    });
  `, channelModule, fixturesModule, socket, db || '', workspace || '', stateModule], { stdio: ['ignore', 'pipe', 'pipe'] });
  const deadline = setTimeout(() => child.kill('SIGKILL'), 4000);
  try {
    await once(child.stdout, 'data');
    child.kill('SIGKILL');
    const [code, signal] = await once(child, 'exit');
    assert.equal(code, null);
    assert.equal(signal, 'SIGKILL');
    assert.equal(fs.lstatSync(socket).isSocket(), true);
  } finally { clearTimeout(deadline); }
}

test('abrupt listener expiry can re-arm the same Claude binding', { timeout: 8000 }, async t => {
  const socket = socketPath(t, { cleanup: false });
  const { dir, db, state } = fixture();
  state.bind({ channelId: 'claude', guildId: 'guild-1', provider: 'claude', nativeId: CLAUDE_ID, workspace: dir, endpoint: socket, generation: 7 });
  const messageId = 'abrupt-custody-message';
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

test('owner records include a boot-unique process identity on Linux', t => {
  const socket = socketPath(t);
  assertSocketDirectory(socket);
  const { release, lockPath } = acquireSocketLockWithPath(t, socket);
  try {
    const owner = JSON.parse(fs.readFileSync(path.join(lockPath, 'owner'), 'utf8'));
    assert.equal(owner.pid, process.pid);
    if (process.platform === 'linux') {
      assert.equal(typeof owner.identity, 'string');
      const bootId = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
      assert.match(owner.identity, new RegExp(`^proc:${bootId}:`));
    }
  } finally {
    release();
  }
});

test('live socket locks survive contenders with different timezones', { timeout: 8000 }, async t => {
  const socket = socketPath(t);
  const modulePath = path.resolve(__dirname, '../src/claude/socket-ownership');
  const holder = spawn(process.execPath, ['-e', `
    const deadline = setTimeout(() => process.exit(2), 7000);
    deadline.unref();
    const { acquireSocketLock } = require(process.argv[1]);
    const release = acquireSocketLock(process.argv[2]);
    process.stdout.write('ready');
    process.stdin.resume();
    process.stdin.on('end', () => {
      try { release(); process.exit(0); } catch (error) { process.stderr.write(String(error)); process.exit(1); }
    });
  `, modulePath, socket], {
    env: { ...process.env, TZ: 'UTC' },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  t.after(() => holder.kill('SIGKILL'));
  await once(holder.stdout, 'data');
  const contender = spawnSync(process.execPath, ['-e', `
    const deadline = setTimeout(() => process.exit(2), 4000);
    deadline.unref();
    const { acquireSocketLock } = require(process.argv[1]);
    try { const release = acquireSocketLock(process.argv[2]); release(); process.stdout.write('acquired'); }
    catch (error) { process.stdout.write(String(error)); }
  `, modulePath, socket], {
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
      const { acquireSocketLock } = require(process.argv[1]);
      try { acquireSocketLock(process.argv[2]); process.stdout.write('acquired'); }
      catch (error) { process.stdout.write(String(error.code || error)); }
    `, path.resolve(__dirname, '../src/claude/socket-ownership'), socket], {
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

test('an unsafe temporary root refuses before bootstrapping the namespace', t => {
  const root = fs.mkdtempSync('/tmp/dss-root-');
  fs.chmodSync(root, 0o777);
  t.mock.method(os, 'tmpdir', () => root);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const socket = socketPath(t);
  assert.throws(() => assertSocketDirectory(socket), /namespace root is unusable/);
  assert.deepEqual(fs.readdirSync(root), [], 'an unsafe root must not receive a fixed namespace');
});

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
  state.bind({ channelId: 'claude', guildId: 'guild-1', provider: 'claude', nativeId: CLAUDE_ID, workspace: dir, endpoint: socket });
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
        uid: stats.uid + 1,
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
  t.mock.method(net, 'createConnection', () => {
    const probe = new EventEmitter();
    probe.destroy = () => {};
    probes.push(probe);
    return probe;
  });
  const { dir, state } = fixture();
  t.after(() => state.close());
  state.bind({ channelId: 'claude', guildId: 'guild-1', provider: 'claude', nativeId: CLAUDE_ID, workspace: dir, endpoint: socket });
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

test('stop aborts a pending MCP connection and releases startup', { timeout: 8000 }, async t => {
  const socket = socketPath(t, { cleanup: false });
  const { dir, state } = fixture();
  t.after(() => state.close());
  state.bind({ channelId: 'claude', guildId: 'guild-1', provider: 'claude', nativeId: CLAUDE_ID, workspace: dir, endpoint: socket });
  let connectStarted;
  const connected = new Promise(resolve => { connectStarted = resolve; });
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
        return new Promise(() => {});
      },
      close: async () => { closeCalls += 1; }
    }
  });
  t.after(async () => {
    try { await channel.stop(); } finally { removeSocketDirectory(socket); }
  });
  const starting = channel.start();
  await connected;
  await channel.stop();
  await assert.rejects(starting, /stopped during MCP connection/);
  assert.equal(channel.ready, false);
  assert.equal(fs.existsSync(socket), false);
  assert.equal(closeCalls, 1);
});

test('stop retains the socket lock until MCP teardown completes', { timeout: 8000 }, async t => {
  const socket = socketPath(t, { cleanup: false });
  const { dir, state } = fixture();
  t.after(() => state.close());
  state.bind({ channelId: 'claude', guildId: 'guild-1', provider: 'claude', nativeId: CLAUDE_ID, workspace: dir, endpoint: socket });
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
  state.bind({ channelId: 'claude', guildId: 'guild-1', provider: 'claude', nativeId: CLAUDE_ID, workspace: dir, endpoint: socket });
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

test('stop retries a failed socket-lock release', { timeout: 8000 }, async t => {
  const socket = socketPath(t, { cleanup: false });
  const { dir, state } = fixture();
  t.after(() => state.close());
  state.bind({ channelId: 'claude', guildId: 'guild-1', provider: 'claude', nativeId: CLAUDE_ID, workspace: dir, endpoint: socket });
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
  state.bind({ channelId: 'claude', guildId: 'guild-1', provider: 'claude', nativeId: CLAUDE_ID, workspace: dir, endpoint: socket });
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
  state.bind({ channelId: 'claude', guildId: 'guild-1', provider: 'claude', nativeId: CLAUDE_ID, workspace: dir, endpoint: socket });
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
