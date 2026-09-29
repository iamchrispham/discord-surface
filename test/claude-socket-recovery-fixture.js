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

// ---------------------------------------------------------------------------
// Suite namespace isolation. Socket-lock acquisition derives its coordination
// root from `os.userInfo().homedir` and `fs.realpathSync('/tmp')`. Every test
// and every spawned child must read the disposable suite roots installed here,
// never the operator's real HOME or the real /tmp coordination namespace.
// ---------------------------------------------------------------------------
const SUITE_TEMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dss-suite-'));
const SUITE_HOME_ROOT = fs.realpathSync(fs.mkdtempSync(path.join(SUITE_TEMP_ROOT, 'home-')));
fs.chmodSync(SUITE_HOME_ROOT, 0o700);
const SUITE_SHARED_TEMP_ROOT = fs.realpathSync(fs.mkdtempSync(path.join(SUITE_TEMP_ROOT, 'shared-temp-')));
fs.chmodSync(SUITE_SHARED_TEMP_ROOT, 0o1777);

const trueUserInfo = os.userInfo;
const trueRealpathSync = fs.realpathSync;
const trueMkdirSync = fs.mkdirSync;
const trueRenameSync = fs.renameSync;
const trueLinkSync = fs.linkSync;
const trueWriteFileSync = fs.writeFileSync;
const trueUnlinkSync = fs.unlinkSync;

const baselineUserInfo = (...args) => ({ ...trueUserInfo(...args), homedir: SUITE_HOME_ROOT });
const baselineRealpathSync = (target, ...options) =>
  (String(target) === '/tmp' ? SUITE_SHARED_TEMP_ROOT : trueRealpathSync(target, ...options));

function installBaselineNamespaceMocks() {
  os.userInfo = baselineUserInfo;
  fs.realpathSync = baselineRealpathSync;
}
// Coordination artifacts (lock namespaces and `direct-home` rendezvous markers)
// accumulate under the suite roots across tests. Because acquisition publishes a
// direct-home marker into the sticky shared root, later tests that mock only the
// home root would resolve `/tmp` through the baseline shim and pick up a stale
// rendezvous. Start every test from a clean suite-owned coordination state.
function resetSuiteCoordinationArtifacts() {
  for (const root of [SUITE_HOME_ROOT, SUITE_SHARED_TEMP_ROOT]) {
    let entries;
    try { entries = fs.readdirSync(root); } catch { continue; }
    for (const entry of entries) {
      if (entry.startsWith('.claude-channel-') || entry.startsWith('.discord-surface-locks-')) {
        fs.rmSync(path.join(root, entry), { recursive: true, force: true });
      }
    }
  }
}
resetSuiteCoordinationArtifacts();
// Active before the first acquisition and before every test's first acquisition.
installBaselineNamespaceMocks();
// Reinstall per test because the negative control below drops the shims to prove
// the guard is real. Per-test `t.after` hooks run *before* node:test restores
// `t.mock.method` shims, so an after-hook reinstall would be clobbered; a global
// beforeEach is what guarantees every other test starts from the baseline.
test.beforeEach(() => {
  resetSuiteCoordinationArtifacts();
  installBaselineNamespaceMocks();
});
test.after(() => {
  os.userInfo = trueUserInfo;
  fs.realpathSync = trueRealpathSync;
  fs.rmSync(SUITE_TEMP_ROOT, { recursive: true, force: true });
});

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
  const realpathSync = fs.realpathSync;
  t.mock.method(os, 'userInfo', () => ({ ...userInfo, homedir: root }));
  t.mock.method(fs, 'realpathSync', (target, ...options) =>
    target === '/tmp' ? root : realpathSync(target, ...options));
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
    const fs = require('node:fs');
    const os = require('node:os');
    const childUserInfo = os.userInfo();
    os.userInfo = () => ({ ...childUserInfo, homedir: process.argv[7] });
    const childRealpathSync = fs.realpathSync;
    fs.realpathSync = (target, ...options) => String(target) === '/tmp'
      ? process.argv[8]
      : childRealpathSync(target, ...options);
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
      state.bind({ channelId: 'claude', guildId: 'guild-1', provider: 'claude', nativeId: CLAUDE_ID, workspace: workspace || created.dir, endpoint: socket }, { intakeCutoff: '100' });
    }
    const channel = new ClaudeChannel({ state, nativeId: CLAUDE_ID, socketPath: socket, mcp: { notification: async () => {} } });
    channel.start().then(() => process.stdout.write('ready')).catch(error => {
      process.stderr.write(String(error));
      process.exit(1);
    });
  `, channelModule, fixturesModule, socket, db || '', workspace || '', stateModule, SUITE_HOME_ROOT, SUITE_SHARED_TEMP_ROOT], { stdio: ['ignore', 'pipe', 'pipe'] });
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

module.exports = {
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
};
