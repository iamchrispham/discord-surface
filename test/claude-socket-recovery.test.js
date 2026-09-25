const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
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
  const child = spawn(process.execPath, ['-e', `
    setTimeout(() => process.exit(2), 3000);
    require('node:net').createServer().listen(process.argv[1], () => {
      process.stdout.write('ready');
      process.kill(process.pid, 'SIGKILL');
    });
  `, socket], { stdio: ['ignore', 'pipe', 'pipe'] });
  const deadline = setTimeout(() => child.kill('SIGKILL'), 4000);
  try {
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
