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
const { CLAUDE_ID } = require('./surface-fixtures');

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

// Scoped cleanup/sentinel: deletes only this lock object and asserts the shared
// namespace root survived with the same identity and was never an rmdir target.
function guardSharedNamespace(t, lockPath) {
  const namespacePath = path.dirname(lockPath);
  const before = fs.lstatSync(namespacePath, { bigint: true });
  const rmdirs = [];
  const originalRmdir = fs.rmdirSync;
  t.mock.method(fs, 'rmdirSync', (target, ...args) => {
    rmdirs.push(String(target));
    return originalRmdir(target, ...args);
  });
  t.after(() => {
    fs.rmSync(lockPath, { recursive: true, force: true });
    const after = fs.lstatSync(namespacePath, { bigint: true });
    assert.equal(after.isDirectory(), true, 'shared namespace root must remain a directory');
    assert.equal(after.dev, before.dev, 'cleanup must not replace the shared namespace root');
    assert.equal(after.ino, before.ino, 'cleanup must not recursively delete the shared namespace root');
    assert.equal(rmdirs.includes(namespacePath), false,
      'the shared namespace root must never be an rmdir target');
  });
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

function seedDeadTransition(lockPath) {
  fs.mkdirSync(lockPath, { mode: 0o700 });
  const transitionPath = path.join(lockPath, `.transition-${DEAD_PID}-${Buffer.from(DEAD_IDENTITY).toString('base64url')}`);
  fs.mkdirSync(transitionPath, { mode: 0o700 });
  fs.writeFileSync(path.join(transitionPath, 'claim'),
    JSON.stringify({ pid: DEAD_PID, identity: DEAD_IDENTITY, generation: randomUUID() }), { mode: 0o600 });
  return transitionPath;
}

test('the fixed UID namespace keeps one lock across HOME and TMPDIR changes', t => {
  const socket = claudeSocket(privateSocketDir(t));
  const first = acquireSocketLockWithPath(t, socket);
  const lockPath = first.lockPath;
  const namespacePath = path.dirname(lockPath);
  guardSharedNamespace(t, lockPath);

  assert.equal(path.dirname(namespacePath), fs.realpathSync('/tmp'));
  assert.match(path.basename(namespacePath), new RegExp(`^\\.discord-surface-locks-${process.getuid()}-coordination`));

  // Changed HOME/TMPDIR must not select a different lock: the contender still sees this one.
  const bogus = path.join(fs.realpathSync('/tmp'), `dss-bogus-${randomUUID()}`);
  t.mock.method(os, 'homedir', () => bogus);
  t.mock.method(os, 'tmpdir', () => bogus);
  let refusal = null;
  try { acquireSocketLock(socket); } catch (error) { refusal = error; }
  assert.ok(refusal, 'a second contender must refuse while the first lock is held');
  assert.match(String(refusal && refusal.message), /already in progress/);

  first.release();
  assert.equal(fs.existsSync(lockPath), false, 'release must remove the lock object');

  // Plain retention assertion: the namespace directory itself must survive release.
  assert.equal(fs.existsSync(namespacePath), true, 'namespace directory must be retained after release');
  assert.equal(fs.lstatSync(namespacePath).isDirectory(), true, 'namespace path must remain a directory');
});

test('a dead regular-file lock is preserved instead of deleted', t => {
  const socket = claudeSocket(privateSocketDir(t));
  const seed = acquireSocketLockWithPath(t, socket);
  const lockPath = seed.lockPath;
  guardSharedNamespace(t, lockPath);
  seed.release();

  const ownerBytes = JSON.stringify({ pid: DEAD_PID, identity: DEAD_IDENTITY, generation: randomUUID() });
  fs.writeFileSync(lockPath, ownerBytes, { mode: 0o600 });
  const before = fs.lstatSync(lockPath, { bigint: true });
  const movedSources = [];
  const originalRename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (source, ...rest) => {
    if (String(source) === lockPath) movedSources.push(String(rest[0]));
    return originalRename(source, ...rest);
  });

  const restoreKill = stubDeadProcessKill(DEAD_PID);
  let contender = null;
  let refusal = null;
  try {
    try { contender = acquireSocketLock(socket); } catch (error) { refusal = error; }
  } finally {
    restoreKill();
  }
  releaseQuietly(contender);

  assert.ok(refusal, 'a dead regular-file lock must refuse a contender');
  assert.match(String(refusal && refusal.message), /already in progress/);
  const after = fs.lstatSync(lockPath, { bigint: true });
  assert.equal(after.isFile(), true, 'lock path must remain a regular file');
  assert.equal(after.ino, before.ino, 'lock file inode must be preserved');
  assert.equal(fs.readFileSync(lockPath, 'utf8'), ownerBytes, 'lock file bytes must be preserved');
  assert.deepEqual(movedSources, [], 'lock object must never be renamed');

  // A replacement object appearing at the path afterward is still refused and preserved.
  fs.writeFileSync(lockPath, 'replacement-object', { mode: 0o600 });
  const replacement = fs.lstatSync(lockPath, { bigint: true });
  assert.throws(() => acquireSocketLock(socket), /already in progress/);
  assert.equal(fs.readFileSync(lockPath, 'utf8'), 'replacement-object');
  assert.equal(fs.lstatSync(lockPath, { bigint: true }).ino, replacement.ino);
});

test('a symlink at the canonical lock path is refused untouched', t => {
  const socket = claudeSocket(privateSocketDir(t));
  const seed = acquireSocketLockWithPath(t, socket);
  const lockPath = seed.lockPath;
  guardSharedNamespace(t, lockPath);
  seed.release();

  const target = path.join(path.dirname(lockPath), `missing-target-${randomUUID()}`);
  fs.symlinkSync(target, lockPath);
  const before = fs.lstatSync(lockPath, { bigint: true });
  assert.equal(before.isSymbolicLink(), true, 'fixture must place a symlink at the lock path');

  assert.throws(() => acquireSocketLock(socket), /already in progress/);
  const after = fs.lstatSync(lockPath, { bigint: true });
  assert.equal(after.isSymbolicLink(), true, 'lock symlink must be preserved');
  assert.equal(after.ino, before.ino, 'lock symlink inode must be preserved');
  assert.equal(fs.readlinkSync(lockPath), target, 'lock symlink target must be preserved');
});

test('a dead transition claim does not spuriously refuse the first lock acquire', t => {
  const socket = claudeSocket(privateSocketDir(t));
  const seed = acquireSocketLockWithPath(t, socket);
  const lockPath = seed.lockPath;
  guardSharedNamespace(t, lockPath);
  seed.release();
  const transitionPath = seedDeadTransition(lockPath);
  assert.equal(fs.existsSync(path.join(lockPath, 'owner')), false, 'fixture lock must have no owner marker');

  const restoreKill = stubDeadProcessKill(DEAD_PID);
  let first = null;
  try {
    assert.doesNotThrow(() => { first = acquireSocketLock(socket); }, 'a dead transition claim must not refuse the first acquire');
    assert.equal(fs.existsSync(transitionPath), false, 'the dead transition must be removed by the winner');
    assert.throws(() => acquireSocketLock(socket), /already in progress/, 'a concurrent second acquisition must refuse while the winner holds');
  } finally {
    restoreKill();
    releaseQuietly(first);
  }
  assert.equal(fs.existsSync(lockPath), false, 'release must remove the lock object');
});

test('a transition race that replaces the lock directory refuses and preserves it', t => {
  const socket = claudeSocket(privateSocketDir(t));
  const seed = acquireSocketLockWithPath(t, socket);
  const lockPath = seed.lockPath;
  guardSharedNamespace(t, lockPath);
  seed.release();
  seedDeadTransition(lockPath);

  const currentTransition = `.transition-${process.pid}-`;
  const originalLstat = fs.lstatSync;
  let replacement = null;
  t.mock.method(fs, 'lstatSync', (target, ...args) => {
    const isPostClaimRead = !replacement && target === lockPath && args.length > 0 && args[0] && args[0].bigint &&
      fs.readdirSync(lockPath).some(entry => entry.startsWith(currentTransition));
    if (isPostClaimRead) {
      // Race window: the claim is published, then the lock directory is swapped
      // out before the post-claim identity read.
      fs.rmSync(lockPath, { recursive: true, force: true });
      fs.mkdirSync(lockPath, { mode: 0o700 });
      replacement = originalLstat(lockPath, { bigint: true });
    }
    return originalLstat(target, ...args);
  });

  const restoreKill = stubDeadProcessKill(DEAD_PID);
  try {
    assert.throws(() => acquireSocketLock(socket), /already in progress/);
  } finally {
    restoreKill();
  }

  assert.ok(replacement, 'the replacement-directory race must have fired');
  const observed = fs.lstatSync(lockPath, { bigint: true });
  assert.equal(observed.dev, replacement.dev, 'replacement directory device must be preserved');
  assert.equal(observed.ino, replacement.ino, 'replacement directory identity must be preserved');
  assert.deepEqual(fs.readdirSync(lockPath), [], 'replacement directory must be left empty');
});

test('a transition race that installs a new owner refuses and preserves it', t => {
  const socket = claudeSocket(privateSocketDir(t));
  const seed = acquireSocketLockWithPath(t, socket);
  const lockPath = seed.lockPath;
  guardSharedNamespace(t, lockPath);
  seed.release();
  seedDeadTransition(lockPath);

  const ownerPath = path.join(lockPath, 'owner');
  const ownerBytes = JSON.stringify({ pid: process.pid, generation: randomUUID() });
  const originalMkdir = fs.mkdirSync;
  let installed = false;
  t.mock.method(fs, 'mkdirSync', (target, ...args) => {
    const result = originalMkdir(target, ...args);
    if (!installed && typeof target === 'string' && path.dirname(target) === lockPath &&
      path.basename(target).startsWith('.transition-')) {
      // Race window: a new owner appears after the transition claim.
      installed = true;
      fs.writeFileSync(ownerPath, ownerBytes, { mode: 0o600 });
    }
    return result;
  });

  const restoreKill = stubDeadProcessKill(DEAD_PID);
  try {
    assert.throws(() => acquireSocketLock(socket), /already in progress/);
  } finally {
    restoreKill();
  }

  assert.equal(installed, true, 'the appearing-owner race must have fired');
  assert.equal(fs.readFileSync(ownerPath, 'utf8'), ownerBytes, 'appearing owner record must be preserved');
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
  const seed = acquireSocketLockWithPath(t, socket);
  const lockPath = seed.lockPath;
  const release = seed.release;
  guardSharedNamespace(t, lockPath);
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
