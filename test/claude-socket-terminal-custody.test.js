'use strict';

// Terminal custody fixtures for the three unfixed PR104 defects. Fixture-only:
// this suite asserts the CORRECT behavior at unchanged production owners, so the
// red rows turn green when the real mechanisms are repaired.
//
// Runner contract:
//   DISCORD_SOCKET_TEST_ROOT=<fresh dir> \
//   NODE_OPTIONS=--require=<artifact>/hermetic-preload.cjs \
//   node --test --test-concurrency=1 test/claude-socket-terminal-custody.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const socketOwnership = require('../src/claude/socket-ownership');
const { prepareSocketAsync } = require('../src/claude-channel');

const REPO_ROOT = path.resolve(__dirname, '..');
const SOCKET_OWNERSHIP_MODULE = path.resolve(__dirname, '../src/claude/socket-ownership');
const CHILD_DEADLINE_MS = 5000;
const GATE_TIMEOUT_MS = 4000;
// A pid above any real pid_max, so the stubbed process probe never touches a live process.
const DEAD_PID = 2147480001;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Parent-side isolation root. Prefer the runner's hermetic root so nothing lands in
// the real temporary directory; fall back to os.tmpdir() only for a direct run.
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
// suite is isolated under a plain `npm test` run too (the hermetic preload does not
// set DISCORD_SOCKET_TEST_ROOT for the registered npm script). Production also always
// considers the stable /tmp candidate, which is sticky+world-writable on this host, so
// redirecting the passwd home alone is not enough: /tmp must resolve into the fresh root.
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

function ownerNameFor(owner) {
  return owner === undefined ? 'shared' : String(owner);
}

// The deterministic rendezvous component the production reader builds for this root.
// Mirrors the sibling fixtures' name computation rather than importing production internals.
function rendezvousNameFor(root) {
  const owner = process.geteuid?.() ?? process.getuid?.();
  const componentPrefix = `.discord-surface-locks-${ownerNameFor(owner)}-coordination`;
  const minimumComponentLength = 90 + 1 - root.length - path.sep.length;
  return componentPrefix.length >= minimumComponentLength
    ? componentPrefix
    : `${componentPrefix}${'x'.repeat(minimumComponentLength - componentPrefix.length)}`;
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

// Runs one bounded child that calls the REAL src/cli.js wrapper with fixture-only
// dependency substitution, then reports its observations as a JSON array. The child
// writes the file as it goes, so a signal-driven exit still leaves evidence.
function runWrapperChild(t, childSource, extraArgs = [], { timeoutMs = 9000 } = {}) {
  const dir = shortTempRoot(t);
  const script = path.join(dir, 'wrapper-child.cjs');
  const outFile = path.join(dir, 'observations.json');
  fs.writeFileSync(script, childSource, { mode: 0o600 });
  const child = spawn(process.execPath,
    [script, REPO_ROOT, dir, outFile, ...extraArgs],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const exited = once(child, 'exit').then(([code, signal]) => ({ code, signal }));
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const reads = () => {
    try { return JSON.parse(fs.readFileSync(outFile, 'utf8')); } catch { return []; }
  };
  const waitForPhase = async (phase, deadlineMs = timeoutMs) => {
    const deadline = Date.now() + deadlineMs;
    while (Date.now() < deadline) {
      if (reads().some(entry => entry.phase === phase)) return true;
      await sleep(5);
    }
    return false;
  };
  return { child, exited, reads, waitForPhase, stderr: () => stderr, dir, outFile };
}

// Builds a child that exercises the real claudeChannel wrapper. The fixture-only
// substitution replaces only the ClaudeChannel constructor and counts the real
// SurfaceState.close, so the observed retry/close behavior is the production wrapper's.
function channelWrapperChildSource({ failFirstStop, revokeReadiness }) {
  return `'use strict';
const fs = require('node:fs');
const path = require('node:path');
const repo = process.argv[2];
const dir = process.argv[3];
const outFile = process.argv[4];
const observations = [];
const note = value => { observations.push(value); fs.writeFileSync(outFile, JSON.stringify(observations)); };
const deadline = setTimeout(() => { note({ phase: 'deadline' }); process.exit(2); }, ${CHILD_DEADLINE_MS});
deadline.unref();
const reported = [];
const realStderrWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = (chunk, ...args) => { reported.push(String(chunk)); return realStderrWrite(chunk, ...args); };
const stateMod = require(path.join(repo, 'src/state'));
const originalClose = stateMod.SurfaceState.prototype.close;
let stateCloses = 0;
stateMod.SurfaceState.prototype.close = function (...args) {
  stateCloses += 1;
  note({ phase: 'state-close', stateCloses });
  return originalClose.apply(this, args);
};
let stopCalls = 0;
let captured = null;
class FixtureChannel {
  constructor(options) {
    captured = options;
    const binding = options.state.findNativeBinding(options.nativeId, 'claude');
    this.bindingIdentity = {
      channelId: binding.channelId, guildId: binding.guildId,
      provider: 'claude', nativeId: options.nativeId, workspace: binding.workspace,
      endpoint: options.socketPath, generation: binding.generation
    };
  }
  async start() {}
  async stop() {
    stopCalls += 1;
    note({ phase: 'stop-attempt', stopCalls });
    ${failFirstStop ? `if (stopCalls === 1) throw new Error('retained teardown');` : ''}
  }
}
const channelShim = require.resolve(path.join(repo, 'src/claude-channel'));
require.cache[channelShim] = { id: channelShim, filename: channelShim, loaded: true, exports: { ClaudeChannel: FixtureChannel } };
const REVOKE_MARKER = 'fixture-readiness-revoke-9f3a';
${revokeReadiness ? `stateMod.SurfaceState.prototype.setBindingReadiness = function () { throw new Error(REVOKE_MARKER); };` : ''}
const { SurfaceState } = stateMod;
const db = path.join(dir, 'surface.sqlite');
const socket = path.join(dir, 'claude.sock');
const nativeId = '79e3da8e-94b4-4aff-8f88-b45b3a451dd1';
const state = new SurfaceState(db);
state.setConfig({ operatorId: 'operator', guildId: 'guild', secretFile: path.join(dir, 'discord.env') });
state.bindOrdinaryClaude({ channelId: 'claude-channel', guildId: 'guild', provider: 'claude', nativeId, workspace: dir, endpoint: socket },
  { sessionId: nativeId, threadId: nativeId, harness: 'claude-code' });
state.close();
stateCloses = 0;
const cli = require(path.join(repo, 'src/cli.js'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
  // Drop the setup-time close observation: only the wrapper's own teardown counts.
  observations.length = 0;
  await cli.claudeChannel({ 'state-dir': dir, db, 'native-id': nativeId, socket });
  note({ phase: 'started', stopCalls, stateCloses });
  captured.onTransportClose();
  await sleep(150);
  note({
    phase: 'after-first',
    stopCalls,
    stateCloses,
    readinessReported: reported.some(line => line.includes(REVOKE_MARKER)),
    exitCode: process.exitCode ?? 0
  });
  captured.onTransportClose();
  await sleep(150);
  note({
    phase: 'after-second',
    stopCalls,
    stateCloses,
    readinessReported: reported.some(line => line.includes(REVOKE_MARKER)),
    exitCode: process.exitCode ?? 0
  });
  process.exit(0);
})().catch(error => { note({ phase: 'error', error: String(error && error.message) }); process.exit(3); });
`;
}

// Builds a child that exercises the real claudeMonitor wrapper. The parent drives
// the real SIGINT then SIGTERM handlers; the child records each stop attempt and
// state close as it happens.
function monitorWrapperChildSource({ failFirstStop }) {
  return `'use strict';
const fs = require('node:fs');
const path = require('node:path');
const repo = process.argv[2];
const dir = process.argv[3];
const outFile = process.argv[4];
const observations = [];
const note = value => { observations.push(value); fs.writeFileSync(outFile, JSON.stringify(observations)); };
const reported = [];
const realStderrWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = (chunk, ...args) => { reported.push(String(chunk)); return realStderrWrite(chunk, ...args); };
const stateMod = require(path.join(repo, 'src/state'));
const originalClose = stateMod.SurfaceState.prototype.close;
let stateCloses = 0;
stateMod.SurfaceState.prototype.close = function (...args) {
  stateCloses += 1;
  note({ phase: 'state-close', stateCloses });
  return originalClose.apply(this, args);
};
let stopCalls = 0;
class FixtureMonitor {
  constructor(options) {
    this.bindingIdentity = {
      channelId: 'claude-channel', guildId: 'guild', provider: 'claude', nativeId: options.nativeId,
      workspace: dir, endpoint: options.socketPath, generation: 1
    };
  }
  async start() {}
  async stop() {
    stopCalls += 1;
    note({ phase: 'stop-attempt', stopCalls });
    ${failFirstStop ? `if (stopCalls === 1) throw new Error('retained teardown');` : ''}
  }
}
const monitorShim = require.resolve(path.join(repo, 'src/claude-monitor'));
require.cache[monitorShim] = { id: monitorShim, filename: monitorShim, loaded: true, exports: { createClaudeMonitor: options => new FixtureMonitor(options) } };
const { SurfaceState } = stateMod;
const db = path.join(dir, 'surface.sqlite');
const socket = path.join(dir, 'claude.sock');
const nativeId = '79e3da8e-94b4-4aff-8f88-b45b3a451dd1';
const state = new SurfaceState(db);
state.setConfig({ operatorId: 'operator', guildId: 'guild', secretFile: path.join(dir, 'discord.env') });
state.bindOrdinaryClaude({ channelId: 'claude-channel', guildId: 'guild', provider: 'claude', nativeId, workspace: dir, endpoint: socket },
  { sessionId: nativeId, threadId: nativeId, harness: 'claude-code' });
state.close();
stateCloses = 0;
const cli = require(path.join(repo, 'src/cli.js'));
setInterval(() => {}, 200);
(async () => {
  // Drop the setup-time close observation: only the wrapper's own teardown counts.
  observations.length = 0;
  await cli.claudeMonitor({ 'state-dir': dir, db, 'native-id': nativeId, socket });
  note({ phase: 'started', stopCalls, stateCloses });
  process.stdin.resume();
})().catch(error => { note({ phase: 'error', error: String(error && error.message) }); process.exit(3); });
`;
}

// Reads the last observation with a phase, or undefined.
function lastPhase(observations, phase) {
  return [...observations].reverse().find(entry => entry.phase === phase);
}

test('delayed same-user election contender keeps the first committed namespace', { timeout: 8000 }, async t => {
  const sharedRoot = isolatedRoot(t, 't1-election');
  // The fallback rendezvous only engages under a sticky, shared temp root.
  fs.chmodSync(sharedRoot, 0o1777);
  const missingHome = path.join(sharedRoot, 'missing-home');
  const gateDir = fs.mkdtempSync(path.join(sharedRoot, 'gate-'));
  fs.chmodSync(gateDir, 0o700);
  const rendezvousName = rendezvousNameFor(sharedRoot);
  const electionPrefix = path.join(sharedRoot, `${rendezvousName}-fallback-election-`);

  // Three deterministic rendezvous directories plus the canonical election marker,
  // simulated as foreign-owned (uid 0) through the child's lstat view. Real
  // filesystem entries only: no real chown.
  for (const name of [rendezvousName, `${rendezvousName}-shared`, `${rendezvousName}-election`]) {
    fs.mkdirSync(path.join(sharedRoot, name), { mode: 0o700 });
  }
  fs.writeFileSync(path.join(sharedRoot, `${rendezvousName}-fallback-election`),
    `${rendezvousName}-random-foreign\n`, { mode: 0o600 });

  const childScript = path.join(sharedRoot, 'contender.cjs');
  fs.writeFileSync(childScript, `'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const [role, modulePath, root, rendezvousName, missingHome, gateDir, markerName] = process.argv.slice(2);
const electionPrefix = path.join(root, rendezvousName + '-fallback-election-');
const foreign = new Set([
  path.join(root, rendezvousName),
  path.join(root, rendezvousName + '-shared'),
  path.join(root, rendezvousName + '-election'),
  path.join(root, rendezvousName + '-fallback-election')
]);
const userInfo = os.userInfo();
os.userInfo = () => ({ ...userInfo, homedir: missingHome });
const realRealpath = fs.realpathSync;
fs.realpathSync = (target, ...args) => String(target) === '/tmp' ? root : realRealpath(target, ...args);
const realLstat = fs.lstatSync;
fs.lstatSync = (target, ...args) => {
  const stats = realLstat(target, ...args);
  if (foreign.has(String(target)) && !(args[0] && args[0].bigint)) {
    return Object.assign(Object.create(Object.getPrototypeOf(stats)), stats, { uid: 0 });
  }
  return stats;
};
const deadline = setTimeout(() => { process.stderr.write('child deadline\\n'); process.exit(2); }, ${CHILD_DEADLINE_MS});
deadline.unref();
function waitFor(file, ms) {
  const end = Date.now() + ms;
  const buffer = new Int32Array(new SharedArrayBuffer(4));
  while (!fs.existsSync(file)) {
    if (Date.now() > end) throw new Error('gate timeout ' + file);
    Atomics.wait(buffer, 0, 0, 5);
  }
}
// Deterministic election-marker ordering: park the delayed contender at its real
// election link until the first contender has committed, then give each a known
// marker filename so the delayed contender's marker is lexicographically earlier.
const realLink = fs.linkSync;
const realRenameFile = fs.renameSync;
let published = false;
fs.linkSync = (source, destination) => {
  const target = String(destination);
  if (target.startsWith(electionPrefix)) {
    if (!published) {
      published = true;
      if (role === 'late') {
        fs.writeFileSync(path.join(gateDir, 'late-ready'), '1', { mode: 0o600 });
        waitFor(path.join(gateDir, 'go'), ${GATE_TIMEOUT_MS});
      }
      realLink(source, destination);
      if (path.basename(target) !== markerName) realRenameFile(target, electionPrefix + markerName);
      return;
    }
  }
  return realLink(source, destination);
};
const socketOwnership = require(modulePath);
const socket = path.join(root, role + '.sock');
let namespace = null;
try {
  let lockPath;
  const realRename = fs.renameSync;
  fs.renameSync = (source, destination) => {
    if (path.basename(String(source)).startsWith('.staging-')) lockPath = destination;
    return realRename(source, destination);
  };
  const release = socketOwnership.acquireSocketLock(socket);
  namespace = lockPath ? path.dirname(lockPath) : null;
  process.stdout.write('RESULT ' + JSON.stringify({ role, ok: true, namespace }) + '\\n');
  if (role === 'early') {
    fs.writeFileSync(path.join(gateDir, 'early-committed'), '1', { mode: 0o600 });
    waitFor(path.join(gateDir, 'early-release'), 6000);
  }
  release();
} catch (error) {
  process.stdout.write('RESULT ' + JSON.stringify({ role, ok: false, namespace: null, error: String(error && error.message) }) + '\\n');
}
process.exit(0);
`, { mode: 0o600 });

  // The delayed contender's marker is lexicographically EARLIER than the first
  // contender's, so a mutable lexicographic election lets it replace the winner.
  const earlyMarker = 'ffffffff-ffff-4000-8000-000000000002';
  const lateMarker = '00000000-0000-4000-8000-000000000002';
  // The contenders install their own process-wide mocks; strip the runner preload so
  // it cannot double-apply over the shared-election wiring.
  const childEnv = { ...process.env, DISCORD_SOCKET_TEST_ROOT: sharedRoot };
  delete childEnv.NODE_OPTIONS;

  const children = [];
  const spawnContender = (role, markerName) => {
    const child = spawn(process.execPath, [childScript, role, SOCKET_OWNERSHIP_MODULE, sharedRoot, rendezvousName, missingHome, gateDir, markerName], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: childEnv
    });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const exited = once(child, 'exit').then(([code, signal]) => ({ code, signal }));
    children.push(child);
    return { child, exited, stdout: () => stdout, stderr: () => stderr };
  };
  t.after(() => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    fs.rmSync(sharedRoot, { recursive: true, force: true });
  });

  const parseResult = output => {
    const match = output.match(/RESULT (\{.*\})/);
    if (!match) return null;
    return JSON.parse(match[1]);
  };

  const late = spawnContender('late', lateMarker);
  const lateDeadline = Date.now() + GATE_TIMEOUT_MS;
  while (!fs.existsSync(path.join(gateDir, 'late-ready')) && Date.now() < lateDeadline) await sleep(5);
  assert.equal(fs.existsSync(path.join(gateDir, 'late-ready')), true,
    'the delayed contender must reach its election publish before the first contender runs');

  const early = spawnContender('early', earlyMarker);
  const earlyDeadline = Date.now() + GATE_TIMEOUT_MS;
  while (!fs.existsSync(path.join(gateDir, 'early-committed')) && Date.now() < earlyDeadline) await sleep(5);
  assert.equal(fs.existsSync(path.join(gateDir, 'early-committed')), true,
    'the first contender must commit a namespace before the delayed contender is released');

  const earlyResult = parseResult(early.stdout());
  assert.ok(earlyResult && earlyResult.ok && earlyResult.namespace,
    `first contender must acquire its lock (stdout=${early.stdout()} stderr=${early.stderr()})`);

  // Release the delayed contender only after the first has committed and still holds its lock.
  fs.writeFileSync(path.join(gateDir, 'go'), '1', { mode: 0o600 });
  const lateOutcome = await late.exited;
  const lateResult = parseResult(late.stdout());

  assert.ok(lateResult && lateResult.ok === true,
    `delayed contender must also acquire a lock (exit=${lateOutcome.code} stdout=${late.stdout()} stderr=${late.stderr()})`);
  assert.equal(lateResult.namespace, earlyResult.namespace,
    'the delayed contender must keep the first committed namespace, not change the winner');
  assert.ok(typeof lateResult.namespace === 'string' &&
    path.basename(path.dirname(lateResult.namespace)).startsWith('.claude-channel-'),
    'the coordinated namespace must live under an owner-controlled private root');

  fs.writeFileSync(path.join(gateDir, 'early-release'), '1', { mode: 0o600 });
  await early.exited;
});

// Displace a non-socket endpoint through the REAL public quarantine owner, then
// interrupt before its returned restore() runs. The authenticated private quarantine
// is kept intact; only the owner record becomes a known dead PID, so the orphan
// reader must exercise its real reclamation path.
function displaceReplacement(t, kind) {
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

  // A definitely-different expected identity forces the real displacement path.
  const quarantine = socketOwnership.quarantineMismatchedSocket(endpoint, {
    dev: 0n, ino: 0n, ctimeNs: 0n, birthtimeNs: 0n
  });
  assert.ok(quarantine && typeof quarantine.restore === 'function',
    'quarantineMismatchedSocket must displace the non-socket replacement');
  assert.equal(fs.existsSync(endpoint), false, 'the replacement must be moved into quarantine before restore');

  const quarantineDirs = fs.readdirSync(dir).filter(entry => entry.startsWith('.stale-'));
  assert.equal(quarantineDirs.length, 1, 'exactly one authenticated quarantine must exist');
  const quarantineDir = path.join(dir, quarantineDirs[0]);
  const ownerPath = path.join(quarantineDir, 'owner');
  const owner = JSON.parse(fs.readFileSync(ownerPath, 'utf8'));
  // Hand-edit only the owner record: a dead PID with a valid generation, as the
  // existing sibling fixture does for dead-owner cases.
  fs.writeFileSync(ownerPath, JSON.stringify({
    pid: DEAD_PID,
    identity: owner.identity,
    generation: owner.generation || randomUUID()
  }), { mode: 0o600 });

  return {
    dir, endpoint, target, unrelated, quarantineDir,
    originalBytes, originalLinkTarget,
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

test('orphan quarantine restores the displaced regular file before startup', { timeout: 6000 }, async t => {
  isolateCoordinationRoot(t);
  const displaced = displaceReplacement(t, 'file');

  const error = await prepareWithDeadOwner(displaced);

  // Correct behavior: the orphan reader recognizes the authenticated non-socket
  // quarantine, restores the original regular file, clears the quarantine, and then
  // startup refuses because the endpoint is not a socket.
  assert.equal(fs.existsSync(displaced.endpoint), true,
    'the displaced regular file must be restored at the endpoint before startup');
  assert.equal(fs.lstatSync(displaced.endpoint).isFile(), true,
    'the restored endpoint must be the original regular file, not a listener');
  assert.equal(fs.lstatSync(displaced.endpoint).isSocket(), false,
    'no listener/socket may exist at the endpoint');
  assert.equal(fs.readFileSync(displaced.endpoint, 'utf8'), displaced.originalBytes,
    'the original regular-file bytes must be preserved');
  assert.equal(fs.existsSync(displaced.quarantineDir), false,
    'the authenticated orphan quarantine must be cleared after restore');
  assert.ok(error, 'startup must refuse a non-socket endpoint');
  assert.match(String(error && error.message), /not a socket/);
  assert.equal(fs.readFileSync(displaced.unrelated, 'utf8'), 'unrelated-bytes',
    'unrelated files in the root must be untouched');

  // Positive checks inside the same test: none of these should be reclaimed.
  // 1. A live-owner authenticated quarantine is never reclaimed.
  const liveDir = shortTempRoot(t);
  const liveEndpoint = path.join(liveDir, 'claude.sock');
  fs.writeFileSync(liveEndpoint, 'live-original', { mode: 0o600 });
  const liveQuarantine = socketOwnership.quarantineMismatchedSocket(liveEndpoint, {
    dev: 0n, ino: 0n, ctimeNs: 0n, birthtimeNs: 0n
  });
  assert.ok(liveQuarantine, 'live-owner displacement must still create a quarantine');
  const liveQuarantineDir = path.join(liveDir, fs.readdirSync(liveDir).find(entry => entry.startsWith('.stale-')));
  await assert.doesNotReject(() => prepareSocketAsync(liveEndpoint),
    'a live-owner quarantine must not block startup at an absent endpoint');
  assert.equal(fs.existsSync(liveQuarantineDir), true,
    'a live-owner quarantine must never be reclaimed');
  assert.equal(liveQuarantine.restore(), true, 'the live-owner quarantine remains restorable');
  assert.equal(fs.readFileSync(liveEndpoint, 'utf8'), 'live-original');

  // 2. An unauthenticated .stale-* entry is never removed during preparation.
  const unauthDir = shortTempRoot(t);
  const unauthEndpoint = path.join(unauthDir, 'claude.sock');
  const unauthQuarantine = path.join(unauthDir, `.stale-${DEAD_PID}-unknown-${randomUUID()}`);
  fs.mkdirSync(unauthQuarantine, { mode: 0o700 });
  fs.writeFileSync(path.join(unauthQuarantine, 'do-not-delete'), 'retained', { mode: 0o600 });
  await assert.doesNotReject(() => prepareSocketAsync(unauthEndpoint));
  assert.equal(fs.readFileSync(path.join(unauthQuarantine, 'do-not-delete'), 'utf8'), 'retained',
    'an unauthenticated quarantine entry must be preserved');

  // 3. A fresh, non-quarantined endpoint replacement is never overwritten.
  const replacementDir = shortTempRoot(t);
  const replacementEndpoint = path.join(replacementDir, 'claude.sock');
  fs.writeFileSync(replacementEndpoint, 'replacement-untouched', { mode: 0o600 });
  await assert.rejects(() => prepareSocketAsync(replacementEndpoint), /not a socket/);
  assert.equal(fs.readFileSync(replacementEndpoint, 'utf8'), 'replacement-untouched',
    'an existing non-quarantine replacement must never be overwritten');
});

test('orphan quarantine restores the displaced symlink before startup', { timeout: 6000 }, async t => {
  isolateCoordinationRoot(t);
  const displaced = displaceReplacement(t, 'symlink');

  const error = await prepareWithDeadOwner(displaced);

  // Correct behavior: the original symlink object (not merely its target) is
  // restored, the quarantine is cleared, and startup refuses the non-socket endpoint.
  const restored = (() => {
    try { return fs.lstatSync(displaced.endpoint); } catch { return null; }
  })();
  assert.ok(restored, 'the displaced symlink must be restored at the endpoint before startup');
  assert.equal(restored.isSymbolicLink(), true, 'the restored endpoint must be the original symlink object');
  assert.equal(restored.isSocket(), false, 'no listener/socket may exist at the endpoint');
  assert.equal(fs.readlinkSync(displaced.endpoint), displaced.originalLinkTarget,
    'the original symlink target must be preserved');
  assert.equal(fs.existsSync(displaced.quarantineDir), false,
    'the authenticated orphan quarantine must be cleared after restore');
  assert.ok(error, 'startup must refuse a non-socket endpoint');
  assert.match(String(error && error.message), /not a socket/);
  assert.equal(fs.readFileSync(displaced.unrelated, 'utf8'), 'unrelated-bytes',
    'unrelated files in the root must be untouched');
});

test('public Claude channel retries retained teardown without closing state early', { timeout: 6000 }, async t => {
  const harness = runWrapperChild(t, channelWrapperChildSource({ failFirstStop: true, revokeReadiness: false }));
  assert.equal(await harness.waitForPhase('started'), true,
    `the real claudeChannel wrapper must start (stderr=${harness.stderr()})`);

  // First close: transport.stop() rejects and retains ownership, so the wrapper must
  // NOT close the state store yet.
  assert.equal(await harness.waitForPhase('after-first'), true,
    `the first close attempt must settle (stderr=${harness.stderr()})`);
  const first = lastPhase(harness.reads(), 'after-first');
  assert.equal(first.stopCalls, 1, 'the first close must attempt transport teardown');
  assert.equal(first.stateCloses, 0,
    'a retained teardown must not close the state store after the first failed attempt');

  // Second close: the wrapper must retry transport.stop() rather than reuse the
  // cached rejected promise.
  assert.equal(await harness.waitForPhase('after-second'), true,
    `the second close attempt must settle (stderr=${harness.stderr()})`);
  const second = lastPhase(harness.reads(), 'after-second');
  assert.equal(second.stopCalls, 2,
    'the second close attempt must call transport.stop() again, not reuse the rejected promise');
  assert.equal(second.stateCloses, 1,
    'the successful teardown must close the state store exactly once');

  const outcome = await harness.exited;
  assert.equal(outcome.code, 0, `wrapper child must exit cleanly (stderr=${harness.stderr()})`);
});

test('public Claude Monitor retries retained teardown without closing state early', { timeout: 6000 }, async t => {
  const harness = runWrapperChild(t, monitorWrapperChildSource({ failFirstStop: true }));
  assert.equal(await harness.waitForPhase('started'), true,
    `the real claudeMonitor wrapper must start (stderr=${harness.stderr()})`);

  // Real SIGINT triggers the wrapper's own stop path; the first attempt rejects and
  // must retain both the transport and the state store.
  harness.child.kill('SIGINT');
  const firstDeadline = Date.now() + 4000;
  while (!lastPhase(harness.reads(), 'state-close') && Date.now() < firstDeadline) await sleep(5);
  const firstCloses = harness.reads().filter(entry => entry.phase === 'state-close').length;
  assert.equal(firstCloses, 0,
    'a retained teardown after SIGINT must not close the state store');
  const stopAttemptsAfterSignal = harness.reads().filter(entry => entry.phase === 'stop-attempt').length;
  assert.equal(stopAttemptsAfterSignal, 1, 'SIGINT must attempt transport teardown once');

  // Real SIGTERM must retry transport.stop(), not replay the cached rejected promise.
  harness.child.kill('SIGTERM');
  const secondDeadline = Date.now() + 4000;
  while (harness.reads().filter(entry => entry.phase === 'stop-attempt').length < 2 && Date.now() < secondDeadline) await sleep(5);
  const second = lastPhase(harness.reads(), 'stop-attempt');
  assert.equal(second && second.stopCalls, 2,
    'SIGTERM must call transport.stop() again after the retained failure');
  const closeDeadline = Date.now() + 4000;
  while (harness.reads().filter(entry => entry.phase === 'state-close').length < 1 && Date.now() < closeDeadline) await sleep(5);
  assert.equal(harness.reads().filter(entry => entry.phase === 'state-close').length, 1,
    'the successful teardown must close the state store exactly once');
  if (harness.child.exitCode === null && harness.child.signalCode === null) harness.child.kill('SIGKILL');
  await harness.exited;
});

test('public listener teardown still runs after readiness revoke fails', { timeout: 6000 }, async t => {
  const harness = runWrapperChild(t, channelWrapperChildSource({ failFirstStop: false, revokeReadiness: true }));
  assert.equal(await harness.waitForPhase('started'), true,
    `the real claudeChannel wrapper must start (stderr=${harness.stderr()})`);

  assert.equal(await harness.waitForPhase('after-first'), true,
    `the close attempt must settle (stderr=${harness.stderr()})`);
  const observed = lastPhase(harness.reads(), 'after-first');
  // Positive control: today the wrapper's finally semantics already run the transport
  // stop even though the readiness revoke threw, and the error still surfaces.
  assert.equal(observed.stopCalls, 1,
    'transport teardown must still run when the readiness revoke throws');
  assert.equal(observed.stateCloses, 1,
    'the state store must be closed once after the teardown');
  assert.equal(observed.readinessReported, true,
    'the readiness revoke failure must still be reported, not swallowed');
  assert.equal(observed.exitCode, 1,
    'a reported stop failure must be reflected in the process exit code');

  const outcome = await harness.exited;
  assert.equal(outcome.code, 0, `wrapper child must exit through its own path (stderr=${harness.stderr()})`);
});
