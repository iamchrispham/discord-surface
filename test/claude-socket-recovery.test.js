const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const http = require('node:http');
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

// Per-test isolated lock namespace: redirect the passwd-backed home root to a
// fresh temporary directory so tests never mutate the real coordination namespace.
function isolatedNamespaceRoot(t) {
  const root = fs.mkdtempSync('/tmp/dss-root-');
  fs.chmodSync(root, 0o700);
  const userInfo = os.userInfo();
  t.mock.method(os, 'userInfo', () => ({ ...userInfo, homedir: root }));
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

// Test-local helpers for the real-socket qualification scenarios below. They are
// intentionally small and bounded: every wait has a deadline, and callers own
// socket-directory teardown so failure branches clean up too.
function listenOn(server, socket) {
  return new Promise((resolve, reject) => {
    const onError = error => { server.off('error', onError); reject(error); };
    server.once('error', onError);
    server.listen(socket, () => {
      server.off('error', onError);
      resolve(server);
    });
  });
}

function closeListeningServer(server) {
  if (!server || !server.listening) return Promise.resolve();
  return new Promise(resolve => {
    server.close(() => resolve());
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  });
}

function requestOverSocket(socket, { method = 'GET', requestPath = '/identity', headers = {}, agent = false } = {}) {
  return new Promise((resolve, reject) => {
    let timer;
    const request = http.request({
      socketPath: socket,
      path: requestPath,
      method,
      agent,
      headers: agent ? { ...headers } : { connection: 'close', ...headers }
    }, response => {
      const clientSocket = request.socket;
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('error', error => { clearTimeout(timer); reject(error); });
      response.on('end', () => {
        clearTimeout(timer);
        resolve({
          statusCode: response.statusCode,
          body: Buffer.concat(chunks).toString('utf8'),
          clientSocket
        });
      });
    });
    timer = setTimeout(() => request.destroy(new Error('test HTTP request timed out')), 3000);
    request.on('error', error => { clearTimeout(timer); reject(error); });
    request.end();
  });
}

async function waitForCondition(predicate, message, timeout = 3000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (predicate()) return;
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
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
  fs.mkdirSync(deterministic, { mode: 0o700 });
  fs.mkdirSync(shared, { mode: 0o700 });
  fs.mkdirSync(election, { mode: 0o700 });
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
    if ((String(target) !== deterministic && String(target) !== shared && String(target) !== election) ||
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

test('stop aborts a pending MCP connection and releases startup', { timeout: 8000 }, async t => {
  const socket = socketPath(t, { cleanup: false });
  const { dir, state } = fixture();
  t.after(() => state.close());
  state.bind({ channelId: 'claude', guildId: 'guild-1', provider: 'claude', nativeId: CLAUDE_ID, workspace: dir, endpoint: socket });
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

test('stop preserves a replacement listener published before old close', { timeout: 8000 }, async t => {
  const socket = socketPath(t, { cleanup: false });
  const { dir, state } = fixture();
  t.after(() => state.close());
  state.bind({ channelId: 'claude', guildId: 'guild-1', provider: 'claude', nativeId: CLAUDE_ID, workspace: dir, endpoint: socket });
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
  state.bind({ channelId: 'claude', guildId: 'guild-1', provider: 'claude', nativeId: CLAUDE_ID, workspace: dir, endpoint: socket });
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
  state.bind({ channelId: 'channel', guildId: 'guild-1', provider: 'claude', nativeId: CLAUDE_ID, workspace: dir, endpoint: socket });
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
    let deadline;
    const finishedInTime = await Promise.race([
      stopping.then(() => true),
      new Promise(resolve => { deadline = setTimeout(() => resolve(false), 500); })
    ]).finally(() => clearTimeout(deadline));
    assert.equal(finishedInTime, true, 'stop must finish within the fixture bound once the listener closes');
    assert.equal(closed, true, 'failed listener must actually close before stop resolves');
    assert.equal(connections.size, 0, 'failed listener retains no accepted connection');
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
  state.bind({ channelId: 'claude', guildId: 'guild-1', provider: 'claude', nativeId: CLAUDE_ID, workspace: dir, endpoint: socket });
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

test('stop retains server custody when replacement quarantine setup fails', { timeout: 8000 }, async t => {
  const socket = socketPath(t, { cleanup: false });
  const { dir, state } = fixture();
  t.after(() => state.close());
  state.bind({ channelId: 'claude', guildId: 'guild-1', provider: 'claude', nativeId: CLAUDE_ID, workspace: dir, endpoint: socket });
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
