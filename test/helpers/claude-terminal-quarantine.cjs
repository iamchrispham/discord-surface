'use strict';

// Owns isolated roots, real socket-endpoint displacement through the public
// quarantineMismatchedSocket owner, and the dead-owner probe stub shared by
// the terminal custody quarantine scenarios and their safety controls.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const socketOwnership = require('../../src/claude/socket-ownership');
const { prepareSocketAsync } = require('../../src/claude-channel');

// A pid above any real pid_max, so the stubbed process probe never touches a live process.
const DEAD_PID = 2147480001;

function isolatedRoot(t, label) {
  const runnerRoot = process.env.DISCORD_SOCKET_TEST_ROOT;
  const parent = runnerRoot && path.isAbsolute(runnerRoot) ? runnerRoot : os.tmpdir();
  const root = fs.mkdtempSync(path.join(parent, `${label}-`));
  fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

// Endpoint paths are capped at ~90 chars, so socket-bearing tests use a single short
// component directly under the runner root.
function shortTempRoot(t) {
  const runnerRoot = process.env.DISCORD_SOCKET_TEST_ROOT;
  const parent = runnerRoot && path.isAbsolute(runnerRoot) ? runnerRoot : os.tmpdir();
  const root = fs.mkdtempSync(path.join(parent, 'e-'));
  fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

// Pins the coordination namespace to a fresh owner-only root for this test, so the
// suite is isolated under a plain `npm test` run too. Production always considers the
// stable /tmp candidate, which is sticky+world-writable on this host, so redirecting the
// passwd home alone is not enough: /tmp must resolve into the fresh root.
function isolateCoordinationRoot(t) {
  const runnerRoot = process.env.DISCORD_SOCKET_TEST_ROOT;
  const parent = runnerRoot && path.isAbsolute(runnerRoot) ? runnerRoot : os.tmpdir();
  const root = fs.mkdtempSync(path.join(parent, 'dss-ns-'));
  fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const userInfo = os.userInfo();
  t.mock.method(os, 'userInfo', () => ({ ...userInfo, homedir: root }));
  const realRealpath = fs.realpathSync;
  t.mock.method(fs, 'realpathSync', (target, ...args) => realRealpath(String(target) === '/tmp' ? root : target, ...args));
  return root;
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

// Builds the endpoint (regular file or symlink) plus its target/unrelated siblings,
// with no quarantine created yet.
function makeEndpointFixture(t, kind) {
  const dir = shortTempRoot(t);
  const endpoint = path.join(dir, 'claude.sock');
  const target = path.join(dir, 'target.txt');
  const unrelated = path.join(dir, 'unrelated.txt');
  fs.writeFileSync(unrelated, 'unrelated-bytes', { mode: 0o600 });
  let originalBytes = null;
  let originalLinkTarget = null;
  if (kind === 'file') {
    originalBytes = 'original-replacement-bytes';
    fs.writeFileSync(endpoint, originalBytes, { mode: 0o600 });
  } else {
    fs.writeFileSync(target, 'target-bytes', { mode: 0o600 });
    fs.symlinkSync(target, endpoint);
    originalLinkTarget = target;
  }
  return { dir, endpoint, target, unrelated, originalBytes, originalLinkTarget };
}

// Displaces the fixture endpoint through the REAL public quarantine owner. A
// definitely-different expected identity forces the real displacement path.
function quarantineNow(fixture) {
  const quarantine = socketOwnership.quarantineMismatchedSocket(fixture.endpoint, {
    dev: 0n, ino: 0n, ctimeNs: 0n, birthtimeNs: 0n
  });
  assertOk(quarantine && typeof quarantine.restore === 'function',
    'quarantineMismatchedSocket must displace the non-socket replacement');
  const quarantineDirs = fs.readdirSync(fixture.dir).filter(entry => entry.startsWith('.stale-'));
  assertOk(quarantineDirs.length === 1, 'exactly one authenticated quarantine must exist');
  const quarantineDir = path.join(fixture.dir, quarantineDirs[0]);
  return { quarantine, quarantineDir, ownerPath: path.join(quarantineDir, 'owner') };
}

function assertOk(condition, message) {
  if (!condition) throw new Error(message);
}

// Displace a non-socket endpoint through the real public quarantine owner, then
// interrupt before its returned restore() runs. The authenticated private quarantine
// is kept intact; only the owner record becomes a known dead PID, so the orphan
// reader must exercise its real reclamation path.
function displaceReplacement(t, kind) {
  const fixture = makeEndpointFixture(t, kind);
  const { quarantine, quarantineDir, ownerPath } = quarantineNow(fixture);
  assertOk(fs.existsSync(fixture.endpoint) === false,
    'the replacement must be moved into quarantine before restore');
  const owner = JSON.parse(fs.readFileSync(ownerPath, 'utf8'));
  // Hand-edit only the owner record: a dead PID with a valid generation.
  fs.writeFileSync(ownerPath, JSON.stringify({
    pid: DEAD_PID,
    identity: owner.identity,
    generation: owner.generation || randomUUID()
  }), { mode: 0o600 });
  return {
    ...fixture,
    quarantineDir,
    ownerPath,
    // The captured restore is deliberately never invoked: this simulates interruption.
    restore: quarantine.restore
  };
}

async function prepareWithDeadOwner(displaced) {
  const restoreKill = stubDeadProcessKill(DEAD_PID);
  try {
    let error = null;
    try { await prepareSocketAsync(displaced.endpoint); } catch (caught) { error = caught; }
    return error;
  } finally {
    restoreKill();
  }
}

module.exports = {
  DEAD_PID,
  isolatedRoot,
  shortTempRoot,
  isolateCoordinationRoot,
  stubDeadProcessKill,
  makeEndpointFixture,
  quarantineNow,
  displaceReplacement,
  prepareWithDeadOwner
};
