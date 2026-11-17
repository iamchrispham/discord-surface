'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const realChildProcess = require('node:child_process');
const test = require('node:test');
const realRoles = require('./successor-authority/process-identity');

const TEST_SOURCE = path.join(__dirname, 'full-gate-entry.test.js');
const sourceRequire = createRequire(TEST_SOURCE);
const identityStates = new Map();
const ownedDirectories = new Set();
const gitCommands = [];
const forbiddenActions = [];
let nextPid = 76000;
let fakeNow = 1700000000000;
let storageFailure = false;
let timerCallbacks = 0;

function presentIdentity(pid, state = 'gone') {
  const identity = process.platform === 'darwin'
    ? {
      kind: 'present', pid, platform: 'darwin', start_sec: 1700000000,
      start_usec: pid, unique_id: pid + 1000, pid_version: 1, coalition_id: pid + 2000
    }
    : {
      kind: 'present', pid, platform: 'linux', start: String(1700000000 + pid),
      boot_id: '00000000-0000-0000-0000-000000000001', state: 'S'
    };
  identityStates.set(pid, { identity, state });
  return identity;
}

function currentIdentity(pid) {
  const state = identityStates.get(pid);
  if (!state) return { kind: 'unknown', pid };
  return state.state === 'gone' ? { kind: 'absent', pid } : state.identity;
}

function markGone(pid) {
  const state = identityStates.get(pid);
  if (state) state.state = 'gone';
}

const roles = {
  captureIdentity(pid) { return currentIdentity(pid); },
  sameProcessIdentity: realRoles.sameProcessIdentity,
  identityGone: realRoles.identityGone,
  signalOwned(identity) {
    if (!realRoles.completeIdentity(identity, identity?.pid)
        || !realRoles.sameProcessIdentity(identity, currentIdentity(identity.pid))) return false;
    markGone(identity.pid);
    return true;
  },
  rolesFromAdmission() { return null; }
};

const safeProcess = Object.create(process);
const safeEnv = { ...process.env };
delete safeEnv.DISCORD_SURFACE_GATE_SUPERVISOR_PID;
Object.defineProperties(safeProcess, {
  env: { value: safeEnv },
  pid: { value: 91000 },
  getuid: { value: () => (typeof process.getuid === 'function' ? process.getuid() : null) },
  kill: { value: (...args) => { forbiddenActions.push(['process.kill', args]); throw new Error('forbidden process.kill'); } },
  exit: { value: code => { forbiddenActions.push(['process.exit', code]); throw new Error('forbidden process.exit'); } },
  on: { value: () => safeProcess },
  once: { value: () => safeProcess }
});
presentIdentity(safeProcess.pid, 'gone');

function fakeStream() {
  const stream = new EventEmitter();
  stream.readableFlowing = true;
  stream.destroy = () => stream.emit('close');
  stream.pause = () => { stream.readableFlowing = false; };
  stream.resume = () => { stream.readableFlowing = true; };
  return stream;
}

function fakeChild(command, args, options) {
  const pid = nextPid++;
  presentIdentity(pid, 'live');
  const child = new EventEmitter();
  Object.assign(child, {
    pid, command, args, options, exitCode: null, signalCode: null, connected: true,
    stdout: fakeStream(), stderr: fakeStream(),
    send(_message, callback) { if (callback) callback(null); },
    unref() { return child; },
    kill(signal) {
      markGone(pid);
      child.signalCode = signal;
      child.emit('exit', null, signal);
      child.emit('close', null, signal);
      return true;
    },
    closeAfterRecords(code = 98) {
      markGone(pid);
      child.exitCode = code;
      child.emit('exit', code, null);
      child.emit('close', code, null);
    }
  });
  return child;
}

function spawn(command, args, options) { return fakeChild(command, args, options); }
function fork(command, args, options) { return fakeChild(command, args, options); }

function spawnSync(command, args, options = {}) {
  if (command !== 'git') {
    forbiddenActions.push(['spawnSync', command, args]);
    throw new Error('forbidden non-git spawnSync: ' + command);
  }
  const result = realChildProcess.spawnSync(command, args, {
    ...options,
    timeout: Math.min(Number(options.timeout) || 10000, 10000)
  });
  gitCommands.push({ command, args: [...args], status: result.status, signal: result.signal });
  return result;
}

const fsProxy = new Proxy(fs, {
  get(target, property) {
    if (property === 'mkdtempSync') {
      return (prefix, options) => {
        const directory = target.mkdtempSync(prefix, options);
        ownedDirectories.add(directory);
        return directory;
      };
    }
    if (property === 'writeFileSync') {
      return (file, data, options) => {
        if (storageFailure && path.basename(String(file)) === 'cleanup-obligation.json') {
          throw new Error('synthetic obligation write failure');
        }
        return target.writeFileSync(file, data, options);
      };
    }
    return Reflect.get(target, property);
  }
});

const fakeGate = {
  relay() {}, revision() { return JSON.stringify({ snapshot: 'fixture' }); }, noVerdict() { return 98; },
  MESSAGES: {}, NO_VERDICT: 98,
  SUPERVISOR: {
    ENVIRONMENT: 'DISCORD_SURFACE_GATE_SUPERVISOR',
    RECEIPT: 'DISCORD_SURFACE_GATE_SUPERVISOR_RECEIPT',
    TOKEN: 'DISCORD_SURFACE_GATE_SUPERVISOR_TOKEN',
    LINUX_SUBREAPER: 'linux-subreaper-v1'
  }
};
function noopTest() {}
noopTest.skip = noopTest;
noopTest.todo = noopTest;

function customRequire(request) {
  if (request === 'node:fs') return fsProxy;
  if (request === 'node:child_process') return { spawn, fork, spawnSync };
  if (request === 'node:test') return noopTest;
  if (request === './successor-authority/process-identity') return roles;
  if (request === '../scripts/full-gate') return fakeGate;
  if (request === '../scripts/test-gate') return { pythonTestEnvironment() { return {}; } };
  return sourceRequire(request);
}

class FakeDate extends Date {
  constructor(...args) { super(args.length ? args : [fakeNow]); }
  static now() { return fakeNow; }
}

function fakeSetTimeout(callback, delay = 1) {
  timerCallbacks += 1;
  if (timerCallbacks > 1000) throw new Error('fake timer callback budget exceeded');
  fakeNow += Math.max(1, Math.min(Number(delay) || 1, 1000));
  queueMicrotask(callback);
  return { unref() {}, ref() {} };
}

function loadFixture() {
  const source = fs.readFileSync(TEST_SOURCE, 'utf8') + '\n;globalThis.__fixture = fixture;';
  const context = vm.createContext({
    require: customRequire,
    module: { exports: {} },
    exports: {},
    __filename: TEST_SOURCE,
    __dirname,
    process: safeProcess,
    Buffer, console, URL, TextEncoder, TextDecoder, Date: FakeDate,
    setTimeout: fakeSetTimeout,
    clearTimeout() {},
    setInterval() { return { unref() {}, ref() {} }; },
    clearInterval() {},
    setImmediate: callback => queueMicrotask(callback),
    clearImmediate() {},
    queueMicrotask,
    AbortController,
    structuredClone
  });
  new vm.Script(`(function () { ${source}\n })()`, { filename: TEST_SOURCE }).runInContext(context, { timeout: 1000 });
  assert.equal(typeof context.__fixture, 'function', 'actual fixture was not loaded');
  return context.__fixture;
}

function makeAllocation(mode, name) {
  const prefix = mode === 'supervised' && process.platform === 'darwin'
    ? '/private/tmp/dsg-darwin-fixture-check-' + name + '-'
    : path.join(os.tmpdir(), 'discord-gate-fixture-check-' + name + '-');
  const allocation = fs.mkdtempSync(prefix);
  ownedDirectories.add(allocation);
  return allocation;
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
}

async function exercise(fixture, config) {
  const directoriesBefore = new Set(ownedDirectories);
  storageFailure = config.storageFailure === true;
  timerCallbacks = 0;
  fakeNow += 100000;
  const diagnostics = [];
  try {
    let afterCallback;
    const syntheticTest = {
      signal: new AbortController().signal,
      after(callback) { afterCallback = callback; },
      diagnostic(message) { diagnostics.push(String(message)); }
    };
    const f = fixture(syntheticTest);
    ownedDirectories.add(f.scratch);
    const allocation = makeAllocation(config.mode, config.name);
    const extra = {
      FIXTURE_EXPECTED_RETENTION: config.expectedRetention ? '1' : undefined,
      FIXTURE_EXPECTED_RETENTION_REASON: config.reason
    };
    if (config.mode === 'direct') extra.FIXTURE_MANAGER_IDENTITY = path.join(f.scratch, 'manager.json');
    if (config.kind === 'unknown') {
      extra.FIXTURE_LEFTOVER = '1';
      extra.FIXTURE_LEFTOVER_IDENTITY = path.join(f.scratch, 'leftover-identity.json');
      extra.FIXTURE_LEFTOVER_STOPPED = path.join(f.scratch, 'leftover-stopped');
    }
    const run = config.mode === 'supervised' ? f.launchSupervised(extra) : f.launch(extra);
    const bodyPid = nextPid++;
    const bodyIdentity = config.kind === 'unknown'
      ? { kind: 'unknown', pid: bodyPid }
      : presentIdentity(bodyPid, config.kind === 'live' ? 'live' : 'gone');
    writeJson(f.marker, { pid: bodyPid, identity: bodyIdentity, scratch: allocation });
    if (config.mode === 'direct') writeJson(extra.FIXTURE_MANAGER_IDENTITY, { identity: run.identity });
    if (config.kind === 'unknown') {
      writeJson(extra.FIXTURE_LEFTOVER_IDENTITY, { identity: { kind: 'unknown', pid: nextPid++ } });
      fs.writeFileSync(extra.FIXTURE_LEFTOVER_STOPPED, 'term');
    }
    run.child.closeAfterRecords(98);
    const result = await run.done;
    let afterError = null;
    try { await afterCallback(); } catch (error) { afterError = String(error?.message || error); }
    const obligation = path.join(f.scratch, 'cleanup-obligation.json');
    const allocationExists = fs.existsSync(allocation);
    const fixtureRootExists = fs.existsSync(f.scratch);
    const obligationExists = fs.existsSync(obligation);
    let obligationState = null;
    if (obligationExists) obligationState = JSON.parse(fs.readFileSync(obligation, 'utf8'));
    const expected = config.kind === 'expected';
    const observedDecision = afterError ? 'fail' : 'pass';
    const stateMatches = expected
      ? allocationExists && fixtureRootExists && obligationExists && obligationState?.state === 'unresolved'
      : config.storageFailure
        ? allocationExists && fixtureRootExists && !obligationExists
        : allocationExists && fixtureRootExists && obligationExists;
    const expectedDecision = expected ? 'pass' : 'fail';
    const outcome = {
      name: config.name,
      expectedDecision,
      observedDecision,
      oracleMatches: observedDecision === expectedDecision && stateMatches,
      fixtureChildExit: result.code,
      afterError,
      allocationExists,
      fixtureRootExists,
      obligationExists,
      obligationState,
      diagnostics
    };
    assert.deepEqual(forbiddenActions, [], 'forbidden process action observed');
    assert.equal(outcome.oracleMatches, true, JSON.stringify(outcome));
    if (config.storageFailure) assert.equal(obligationExists, false);
    return outcome;
  } finally {
    for (const directory of [...ownedDirectories]
      .filter(directory => !directoriesBefore.has(directory))
      .sort((left, right) => right.length - left.length)) {
      if (fs.existsSync(directory)) fs.rmSync(directory, { recursive: true, force: true });
      ownedDirectories.delete(directory);
    }
    storageFailure = false;
  }
}

const fixture = loadFixture();

test('expected retained allocation passes after drain and durable obligation', { timeout: 30000 }, async () => {
  const result = await exercise(fixture, {
    name: 'expected-retention-drained-stored', kind: 'expected', mode: 'supervised', expectedRetention: true,
    reason: 'outer allocation remains under separate retirement owner'
  });
  assert.equal(result.observedDecision, 'pass');
  assert.equal(result.obligationState.state, 'unresolved');
});

test('unexpected retained allocation fails', { timeout: 30000 }, async () => {
  const result = await exercise(fixture, { name: 'unexpected-retention', kind: 'unexpected', mode: 'supervised' });
  assert.equal(result.observedDecision, 'fail');
  assert.match(result.afterError, /fixture cleanup is unresolved/);
});

test('unknown identity fails', { timeout: 30000 }, async () => {
  const result = await exercise(fixture, {
    name: 'unknown-identity', kind: 'unknown', mode: 'direct', expectedRetention: true,
    reason: 'fixture sidecar identity unresolved'
  });
  assert.equal(result.observedDecision, 'fail');
  assert.match(JSON.stringify(result.obligationState.reasons), /identity-record/);
});

test('live identity fails even with expected retention', { timeout: 30000 }, async () => {
  const result = await exercise(fixture, {
    name: 'live-identity', kind: 'live', mode: 'direct', expectedRetention: true,
    reason: 'fixture actor remains live'
  });
  assert.equal(result.observedDecision, 'fail');
  assert.match(JSON.stringify(result.obligationState.reasons), /actor-drain/);
});

test('obligation storage failure fails without durable claim', { timeout: 30000 }, async () => {
  const result = await exercise(fixture, {
    name: 'obligation-storage-failure', kind: 'storage-failure', mode: 'supervised', expectedRetention: true,
    storageFailure: true, reason: 'outer allocation remains under separate retirement owner'
  });
  assert.equal(result.observedDecision, 'fail');
  assert.equal(result.obligationExists, false);
  assert.match(result.afterError, /synthetic obligation write failure/);
});
