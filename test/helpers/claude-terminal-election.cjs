'use strict';

// Owns the two-child filesystem election witness for the delayed same-user
// contender scenario, and its bounded event gates. Both contenders call the
// real acquireSocketLock; only the surrounding foreign-namespace race is
// simulated.

const fs = require('node:fs');
const path = require('node:path');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const { isolatedRoot } = require('./claude-terminal-quarantine.cjs');

const SOCKET_OWNERSHIP_MODULE = path.resolve(__dirname, '../../src/claude/socket-ownership');
const CHILD_DEADLINE_MS = 10000;
const GATE_TIMEOUT_MS = 4000;

function waitForFileAsync(dir, name, boundMs) {
  const target = path.join(dir, name);
  if (fs.existsSync(target)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let watcher;
    let settled = false;
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { watcher?.close(); } catch (closeError) { reject(error || closeError); return; }
      if (error) reject(error);
      else resolve();
    };
    const onEvent = () => {
      if (watcher && fs.existsSync(target)) finish();
    };
    const timer = setTimeout(() => {
      if (fs.existsSync(target)) finish();
      else finish(new Error('gate timeout ' + target));
    }, boundMs);
    try {
      watcher = fs.watch(dir, onEvent);
    } catch (error) {
      finish(error);
      return;
    }
    watcher.on('error', error => finish(error));
    onEvent();
  });
}

function ownerNameFor(owner) {
  return owner === undefined ? 'shared' : String(owner);
}

// The deterministic rendezvous component the production reader builds for this root.
function rendezvousNameFor(root) {
  const owner = process.geteuid?.() ?? process.getuid?.();
  const componentPrefix = `.discord-surface-locks-${ownerNameFor(owner)}-coordination`;
  const minimumComponentLength = 90 + 1 - root.length - path.sep.length;
  return componentPrefix.length >= minimumComponentLength
    ? componentPrefix
    : `${componentPrefix}${'x'.repeat(minimumComponentLength - componentPrefix.length)}`;
}

// A worker thread arms an fs.watch on the gate directory and notifies a shared
// integer through Atomics once the named gate file appears (or its own bounded
// fallback timer fires). The main thread's Atomics.wait is the only blocking
// primitive; nothing polls the filesystem in a loop.
const GATE_WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs');
const path = require('node:path');
const target = path.join(workerData.gateDir, workerData.fileName);
const flags = new Int32Array(workerData.sab);
let done = false;
let watcher = null;
const finish = () => {
  if (done) return;
  done = true;
  Atomics.store(flags, 0, 1);
  Atomics.notify(flags, 0);
  clearTimeout(fallback);
  try { watcher && watcher.close(); } catch {}
  try { parentPort.close(); } catch {}
};
const fallback = setTimeout(finish, workerData.boundMs);
try {
  watcher = fs.watch(workerData.gateDir, () => { if (!done && fs.existsSync(target)) finish(); });
} catch {}
// Close the registration race: the target may already exist before the watcher armed.
if (fs.existsSync(target)) finish();
parentPort.postMessage('armed');
`;

function contenderSource() {
  return `'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const GATE_WORKER_SOURCE = ${JSON.stringify(GATE_WORKER_SOURCE)};
async function armGateWorker(gateDir, fileName, boundMs) {
  const sab = new SharedArrayBuffer(4);
  const flags = new Int32Array(sab);
  const worker = new Worker(GATE_WORKER_SOURCE, { eval: true, workerData: { gateDir, fileName, sab, boundMs } });
  await new Promise(resolve => worker.once('message', resolve));
  return { park: () => { Atomics.wait(flags, 0, 0, boundMs); }, dispose: () => worker.terminate() };
}
${waitForFileAsync.toString()}
const [role, modulePath, root, rendezvousName, missingHome, gateDir, markerName] = process.argv.slice(2);
const electionPrefix = path.join(root, rendezvousName + '-fallback-election-');
const foreign = new Set([
  path.join(root, rendezvousName),
  path.join(root, rendezvousName + '-shared'),
  path.join(root, rendezvousName + '-election'),
  path.join(root, rendezvousName + '-fallback-election')
]);
const deadline = setTimeout(() => { process.send({ event: 'error', error: 'child deadline' }); process.exit(2); }, ${CHILD_DEADLINE_MS});
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
let parkGate = null;
const realLink = fs.linkSync;
const realRenameFile = fs.renameSync;
let published = false;
fs.linkSync = (source, destination) => {
  const target = String(destination);
  if (target.startsWith(electionPrefix)) {
    if (!published) {
      published = true;
      if (role === 'late' && parkGate) parkGate.park();
      realLink(source, destination);
      if (path.basename(target) !== markerName) realRenameFile(target, electionPrefix + markerName);
      return;
    }
  }
  return realLink(source, destination);
};
const socketOwnership = require(modulePath);
const socket = path.join(root, role + '.sock');
(async () => {
  if (role === 'late') {
    parkGate = await armGateWorker(gateDir, 'go', ${GATE_TIMEOUT_MS});
    process.send({ event: 'parked' });
  }
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
    if (role === 'early') {
      process.send({ event: 'committed', namespace });
      await waitForFileAsync(gateDir, 'early-release', 6000);
    }
    release();
    process.send({ event: 'result', ok: true, namespace });
  } catch (error) {
    process.send({ event: 'result', ok: false, namespace: null, error: String(error && error.message) });
  } finally {
    if (parkGate) parkGate.dispose();
    clearTimeout(deadline);
  }
})();
`;
}

function spawnContender(childScript, role, sharedRoot, rendezvousName, missingHome, gateDir, markerName) {
  const childEnv = { ...process.env, DISCORD_SOCKET_TEST_ROOT: sharedRoot };
  // The contender installs its own process-wide isolation; strip the runner preload so
  // it cannot double-apply over the shared-election wiring.
  delete childEnv.NODE_OPTIONS;
  const child = fork(childScript,
    [role, SOCKET_OWNERSHIP_MODULE, sharedRoot, rendezvousName, missingHome, gateDir, markerName],
    { env: childEnv, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const events = [];
  const waiters = [];
  child.on('message', message => {
    events.push(message);
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      if (waiters[i].predicate(message)) { waiters[i].resolve(message); waiters.splice(i, 1); }
    }
  });
  const exited = once(child, 'exit').then(([code, signal]) => ({ code, signal }));
  const waitForEvent = predicate => new Promise(resolve => {
    const already = events.find(predicate);
    if (already) return resolve(already);
    waiters.push({ predicate, resolve });
  });
  return { child, exited, waitForEvent };
}

// Runs the two same-UID contenders against a deterministic foreign rendezvous
// namespace and returns each contender's real acquireSocketLock outcome.
async function runElectionContenders(t) {
  const sharedRoot = isolatedRoot(t, 't1-election');
  // The fallback rendezvous only engages under a sticky, shared temp root.
  fs.chmodSync(sharedRoot, 0o1777);
  const missingHome = path.join(sharedRoot, 'missing-home');
  const gateDir = fs.mkdtempSync(path.join(sharedRoot, 'gate-'));
  fs.chmodSync(gateDir, 0o700);
  const rendezvousName = rendezvousNameFor(sharedRoot);

  for (const name of [rendezvousName, `${rendezvousName}-shared`, `${rendezvousName}-election`]) {
    fs.mkdirSync(path.join(sharedRoot, name), { mode: 0o700 });
  }
  fs.writeFileSync(path.join(sharedRoot, `${rendezvousName}-fallback-election`),
    `${rendezvousName}-random-foreign\n`, { mode: 0o600 });

  const childScript = path.join(sharedRoot, 'contender.cjs');
  fs.writeFileSync(childScript, contenderSource(), { mode: 0o600 });

  // The delayed contender's marker is lexicographically EARLIER than the first
  // contender's, so a mutable lexicographic election lets it replace the winner.
  const earlyMarker = 'ffffffff-ffff-4000-8000-000000000002';
  const lateMarker = '00000000-0000-4000-8000-000000000002';

  const children = [];
  const exitedPromises = [];
  const spawn = (role, markerName) => {
    const contender = spawnContender(childScript, role, sharedRoot, rendezvousName, missingHome, gateDir, markerName);
    children.push(contender.child);
    exitedPromises.push(contender.exited);
    return contender;
  };
  t.after(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    // Reuse the exit listeners registered at spawn time: a child that already
    // exited will never re-emit 'exit', so a fresh once() here would hang.
    await Promise.allSettled(exitedPromises);
    fs.rmSync(sharedRoot, { recursive: true, force: true });
  });

  const late = spawn('late', lateMarker);
  await late.waitForEvent(message => message.event === 'parked');

  const early = spawn('early', earlyMarker);
  const earlyCommitted = await early.waitForEvent(message => message.event === 'committed');

  fs.writeFileSync(path.join(gateDir, 'go'), '1', { mode: 0o600 });
  const lateResult = await late.waitForEvent(message => message.event === 'result');

  fs.writeFileSync(path.join(gateDir, 'early-release'), '1', { mode: 0o600 });
  const earlyResult = await early.waitForEvent(message => message.event === 'result');

  await Promise.all([late.exited, early.exited]);
  return { sharedRoot, earlyResult: { ...earlyCommitted, ...earlyResult }, lateResult };
}

module.exports = { runElectionContenders, waitForFileAsync };
