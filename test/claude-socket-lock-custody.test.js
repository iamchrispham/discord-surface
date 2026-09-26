'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const socketOwnership = require('../src/claude/socket-ownership');
const { acquireSocketLock, socketPathIdentity, unlinkSocketIfOwned } = socketOwnership;
const { fixture, CLAUDE_ID } = require('./surface-fixtures');

// A pid above any real pid_max, so the stubbed process probe never touches a live process.
const DEAD_PID = 2147480001;
const DEAD_IDENTITY = 'fixture-dead-identity';

function privateSocketDir(t) {
  const dir = fs.mkdtempSync('/tmp/dss-');
  fs.chmodSync(dir, 0o700);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function claudeSocket(dir) {
  return path.join(dir, `${CLAUDE_ID}.sock`);
}

function privateHome(t) {
  const { dir, state } = fixture();
  t.after(() => {
    try { state.close(); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  return dir;
}

function privateRoot(t) {
  const dir = fs.mkdtempSync('/tmp/dss-home-');
  fs.chmodSync(dir, 0o700);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function acquireSocketLockWithPath(t, socket) {
  let lockPath;
  const originalRename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (source, destination) => {
    if (path.basename(source).startsWith('.staging-')) lockPath = destination;
    return originalRename(source, destination);
  });
  const release = acquireSocketLock(socket);
  assert.ok(lockPath, 'acquireSocketLock must publish a lock directory');
  return { release, lockPath };
}

function stubDeadProcessKill(pid) {
  const originalKill = process.kill;
  process.kill = (target, signal) => {
    if (target === pid) {
      const error = new Error('fixture process is not running');
      error.code = 'ESRCH';
      throw error;
    }
    return originalKill.call(process, target, signal);
  };
  return () => { process.kill = originalKill; };
}

function releaseQuietly(release) {
  if (!release) return;
  try { release(); } catch {}
}

test('a second lock namespace root cannot admit a concurrent lock for one socket', { todo: 'D1 fixed UID namespace pending' }, t => {
  const socket = claudeSocket(privateSocketDir(t));
  const primaryHome = privateHome(t);
  const secondHome = privateRoot(t);
  let home = primaryHome;
  t.mock.method(os, 'homedir', () => home);

  const first = acquireSocketLockWithPath(t, socket);
  const ownerPath = path.join(first.lockPath, 'owner');
  const ownerBefore = fs.readFileSync(ownerPath, 'utf8');
  try {
    home = secondHome;
    let second = null;
    let refusal = null;
    try { second = acquireSocketLock(socket); } catch (error) { refusal = error; }
    releaseQuietly(second);

    assert.equal(refusal !== null, true, 'a second lock namespace root must refuse while the first root owns the socket lock');
    assert.match(String(refusal && refusal.message), /already in progress/);

    // Retained-root facet: the first root's lock must not be disturbed.
    assert.equal(fs.existsSync(first.lockPath), true, 'first lock directory must survive the refused contender');
    assert.equal(fs.readFileSync(ownerPath, 'utf8'), ownerBefore, 'first owner marker must be untouched');
  } finally {
    releaseQuietly(first.release);
  }
});

test('a dead regular-file lock is preserved instead of deleted', { todo: 'D2 unsupported lock preservation pending' }, t => {
  const socket = claudeSocket(privateSocketDir(t));
  const home = privateHome(t);
  t.mock.method(os, 'homedir', () => home);

  const first = acquireSocketLockWithPath(t, socket);
  const lockPath = first.lockPath;
  first.release();

  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  const ownerBytes = JSON.stringify({ pid: DEAD_PID, identity: DEAD_IDENTITY, generation: randomUUID() });
  fs.writeFileSync(lockPath, ownerBytes, { mode: 0o600 });
  const before = fs.lstatSync(lockPath, { bigint: true });

  const restoreKill = stubDeadProcessKill(DEAD_PID);
  let contender = null;
  let refusal = null;
  try {
    try { contender = acquireSocketLock(socket); } catch (error) { refusal = error; }
  } finally {
    restoreKill();
  }
  releaseQuietly(contender);

  assert.equal(refusal !== null, true, 'a dead regular-file lock must refuse a contender');
  assert.match(String(refusal && refusal.message), /already in progress/);

  t.after(() => fs.rmSync(path.dirname(lockPath), { recursive: true, force: true }));
  try {
    const after = fs.lstatSync(lockPath, { bigint: true });
    assert.equal(after.isFile(), true, 'lock path must remain a regular file');
    assert.equal(after.ino, before.ino, 'lock file inode must be preserved');
    assert.equal(fs.readFileSync(lockPath, 'utf8'), ownerBytes, 'lock file bytes must be preserved');
  } catch (error) {
    if (error.code === 'ENOENT') assert.fail('dead regular-file lock was deleted by a contender');
    throw error;
  }
});

test('a dead transition claim does not spuriously refuse the first lock acquire', { todo: 'F10 claim mutates directory generation pending' }, t => {
  const socket = claudeSocket(privateSocketDir(t));
  const home = privateHome(t);
  t.mock.method(os, 'homedir', () => home);

  const seed = acquireSocketLockWithPath(t, socket);
  const lockPath = seed.lockPath;
  seed.release();

  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  fs.mkdirSync(lockPath, { mode: 0o700 });
  const transitionPath = path.join(lockPath, `.transition-${DEAD_PID}-${Buffer.from(DEAD_IDENTITY).toString('base64url')}`);
  fs.mkdirSync(transitionPath, { mode: 0o700 });
  fs.writeFileSync(path.join(transitionPath, 'claim'), JSON.stringify({ pid: DEAD_PID, identity: DEAD_IDENTITY, generation: randomUUID() }), { mode: 0o600 });
  assert.equal(fs.existsSync(path.join(lockPath, 'owner')), false, 'fixture lock must have no owner marker');

  const restoreKill = stubDeadProcessKill(DEAD_PID);
  let first = null;
  try {
    assert.doesNotThrow(() => { first = acquireSocketLock(socket); }, 'a dead transition claim must not refuse the first acquire');
    assert.throws(() => acquireSocketLock(socket), /already in progress/);
  } finally {
    restoreKill();
    releaseQuietly(first);
  }
});

test('stale socket unlink preserves a socket whose generation changed', async t => {
  const dir = privateSocketDir(t);
  const controlSocket = path.join(dir, 'control.sock');
  const observedSocket = path.join(dir, 'observed.sock');
  const controlServer = net.createServer(connection => connection.destroy());
  const observedServer = net.createServer(connection => connection.destroy());
  await new Promise((resolve, reject) => {
    controlServer.once('error', reject);
    controlServer.listen(controlSocket, resolve);
  });
  await new Promise((resolve, reject) => {
    observedServer.once('error', reject);
    observedServer.listen(observedSocket, resolve);
  });
  t.after(async () => {
    for (const server of [controlServer, observedServer]) {
      if (server.listening) await new Promise(resolve => server.close(resolve));
    }
  });

  // Positive control: an unchanged identity really does remove the socket.
  const controlIdentity = socketPathIdentity(controlSocket);
  assert.ok(controlIdentity && typeof controlIdentity.ctimeNs === 'bigint', 'control socket identity must be captured');
  unlinkSocketIfOwned(controlSocket, controlIdentity);
  assert.equal(fs.existsSync(controlSocket), false, 'matching identity must remove the socket');

  const expectedIdentity = socketPathIdentity(observedSocket);
  assert.ok(expectedIdentity && typeof expectedIdentity.ctimeNs === 'bigint', 'observed socket identity must be captured');

  const originalLstat = fs.lstatSync;
  let shimCalls = 0;
  t.mock.method(fs, 'lstatSync', (target, ...args) => {
    const stats = originalLstat(target, ...args);
    if (target === observedSocket && args.length > 0 && args[0] && args[0].bigint) {
      shimCalls += 1;
      return { dev: stats.dev, ino: stats.ino, ctimeNs: stats.ctimeNs + 1n };
    }
    return stats;
  });

  unlinkSocketIfOwned(observedSocket, expectedIdentity);
  assert.ok(shimCalls > 0, 'lstat shim must be exercised by the ownership comparison');
  assert.equal(fs.existsSync(observedSocket), true, 'a changed socket generation must be preserved');
  assert.equal(originalLstat(observedSocket).isSocket(), true, 'preserved path must remain the live socket');
});

test('release refuses an owner marker whose generation changed in place', t => {
  const socket = claudeSocket(privateSocketDir(t));
  const home = privateHome(t);
  t.mock.method(os, 'homedir', () => home);

  const { release, lockPath } = acquireSocketLockWithPath(t, socket);
  t.after(() => fs.rmSync(lockPath, { recursive: true, force: true }));
  const ownerPath = path.join(lockPath, 'owner');
  const beforeOwner = JSON.parse(fs.readFileSync(ownerPath, 'utf8'));
  const beforeInode = fs.lstatSync(ownerPath, { bigint: true }).ino;

  // Rewrite only the generation, in place, so dev/ino stay identical.
  const freshGeneration = randomUUID();
  const mutated = JSON.stringify({ pid: beforeOwner.pid, identity: beforeOwner.identity, generation: freshGeneration });
  const descriptor = fs.openSync(ownerPath, 'r+');
  try {
    fs.writeSync(descriptor, mutated, 0, 'utf8');
    fs.ftruncateSync(descriptor, Buffer.byteLength(mutated));
  } finally {
    fs.closeSync(descriptor);
  }
  const mutatedBytes = fs.readFileSync(ownerPath, 'utf8');
  assert.equal(JSON.parse(mutatedBytes).generation, freshGeneration, 'fixture must change only the generation');
  assert.equal(fs.lstatSync(ownerPath, { bigint: true }).ino, beforeInode, 'generation rewrite must keep the same inode');

  let releaseError = null;
  try { release(); } catch (error) { releaseError = error; }
  assert.ok(releaseError, 'release must refuse a changed owner generation');
  assert.match(String(releaseError && releaseError.message), /lock owner changed before release/);
  assert.equal(fs.readFileSync(ownerPath, 'utf8'), mutatedBytes, 'changed owner marker must remain untouched');
});
