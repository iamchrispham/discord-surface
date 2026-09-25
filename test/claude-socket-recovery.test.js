const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const { prepareSocket, prepareSocketAsync, ClaudeChannel } = require('../src/claude-channel');
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

function isCaseInsensitiveDirectory(directory) {
  const probe = `.case-probe-${randomUUID()}`;
  const probePath = path.join(directory, probe);
  const alternatePath = path.join(directory, probe.toUpperCase());
  fs.writeFileSync(probePath, 'probe');
  try { return fs.existsSync(alternatePath); } finally { fs.unlinkSync(probePath); }
}

async function orphan(socket) {
  const channelModule = path.resolve(__dirname, '../src/claude-channel');
  const fixturesModule = path.resolve(__dirname, './surface-fixtures');
  const child = spawn(process.execPath, ['-e', `
    const { ClaudeChannel } = require(process.argv[1]);
    const { fixture, CLAUDE_ID } = require(process.argv[2]);
    const socket = process.argv[3];
    const { dir, state } = fixture();
    state.bind({ channelId: 'claude', guildId: 'guild-1', provider: 'claude', nativeId: CLAUDE_ID, workspace: dir, endpoint: socket });
    const channel = new ClaudeChannel({ state, nativeId: CLAUDE_ID, socketPath: socket, mcp: { notification: async () => {} } });
    setTimeout(() => process.exit(2), 3000);
    channel.start().then(() => process.stdout.write('ready')).catch(error => {
      process.stderr.write(String(error));
      process.exit(1);
    });
  `, channelModule, fixturesModule, socket], { stdio: ['ignore', 'pipe', 'pipe'] });
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
  await orphan(socket);
  const { dir, state } = fixture();
  t.after(() => state.close());
  state.bind({ channelId: 'claude', guildId: 'guild-1', provider: 'claude', nativeId: CLAUDE_ID, workspace: dir, endpoint: socket });
  const channel = new ClaudeChannel({ state, nativeId: CLAUDE_ID, socketPath: socket, mcp: { notification: async () => {} } });
  t.after(async () => {
    try { await channel.stop(); } finally { removeSocketDirectory(socket); }
  });
  await channel.start();
  assert.equal(channel.ready, true);
  assert.equal(state.getBinding('claude').nativeId, CLAUDE_ID);
  assert.equal(state.getBinding('claude').generation, 1);
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

test('coordination artifacts stay outside a valid endpoint namespace', t => {
  const dir = fs.mkdtempSync('/tmp/dss-');
  fs.chmodSync(dir, 0o700);
  const socket = path.join(dir, '.discord-surface-locks');
  t.after(() => removeSocketDirectory(socket));
  assertSocketDirectory(socket);
  assert.equal(fs.existsSync(socket), false);
  const local = acquireSocketLockWithPath(t, socket);
  assert.equal(fs.existsSync(socket), false);
  local.release();

  const nestedEndpoint = local.lockPath;
  assert.equal(fs.existsSync(nestedEndpoint), false);
  assertSocketDirectory(nestedEndpoint);
  const second = acquireSocketLockWithPath(t, nestedEndpoint);
  try {
    assert.notEqual(second.lockPath, nestedEndpoint);
    assert.equal(fs.existsSync(nestedEndpoint), false);
  } finally {
    second.release();
  }
});

test('socket locks fall back from an unusable home and remove empty namespaces', t => {
  const root = fs.mkdtempSync('/tmp/dss-home-');
  const homeFile = path.join(root, 'home');
  fs.writeFileSync(homeFile, 'not a directory');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.mock.method(os, 'homedir', () => homeFile);

  const socket = socketPath(t);
  assertSocketDirectory(socket);
  const { release, lockPath } = acquireSocketLockWithPath(t, socket);
  const namespacePath = path.dirname(lockPath);
  const expectedRoot = process.platform === 'win32' ? fs.realpathSync(os.tmpdir()) : fs.realpathSync('/tmp');
  assert.equal(path.dirname(namespacePath), expectedRoot);
  release();
  assert.equal(fs.existsSync(namespacePath), false);
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

test('legacy lock reclamation preserves a replacement owner', t => {
  const socket = socketPath(t);
  assertSocketDirectory(socket);
  const first = acquireSocketLockWithPath(t, socket);
  const lockPath = first.lockPath;
  first.release();
  t.after(() => fs.rmSync(lockPath, { recursive: true, force: true }));
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999999 }));

  const originalOpen = fs.openSync;
  const originalRead = fs.readFileSync;
  const ownerDescriptors = new Set();
  let replaced = false;
  t.mock.method(fs, 'openSync', (file, ...args) => {
    const descriptor = originalOpen(file, ...args);
    if (file === lockPath) ownerDescriptors.add(descriptor);
    return descriptor;
  });
  t.mock.method(fs, 'readFileSync', (file, ...args) => {
    const value = originalRead(file, ...args);
    if (!replaced && typeof file === 'number' && ownerDescriptors.has(file)) {
      replaced = true;
      fs.unlinkSync(lockPath);
      fs.mkdirSync(lockPath, { mode: 0o700 });
      fs.writeFileSync(path.join(lockPath, 'owner'), JSON.stringify({ pid: process.pid }));
    }
    return value;
  });

  assert.throws(() => acquireSocketLock(socket), /already in progress/);
  assert.equal(fs.lstatSync(lockPath).isDirectory(), true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(lockPath, 'owner'), 'utf8')).pid, process.pid);
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
