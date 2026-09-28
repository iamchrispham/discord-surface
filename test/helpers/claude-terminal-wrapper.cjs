'use strict';

// Owns the common bounded public-wrapper child setup (real cli.claudeChannel /
// cli.claudeMonitor, real disposable SurfaceState) and its IPC observations.
// Children record every observation over the fork IPC channel, never through
// an observations file or log-text matching.

const fs = require('node:fs');
const path = require('node:path');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const { shortTempRoot } = require('./claude-terminal-quarantine.cjs');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const NATIVE_ID = '79e3da8e-94b4-4aff-8f88-b45b3a451dd1';
const DEFAULT_DEADLINE_MS = 10000;

function channelShimSource(failFirstStop) {
  return `
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
    ${failFirstStop ? `if (stopCalls === 1) throw new Error('retained teardown');` : ''}
  }
}
const channelShim = require.resolve(path.join(repo, 'src/claude-channel'));
require.cache[channelShim] = { id: channelShim, filename: channelShim, loaded: true, exports: { ClaudeChannel: FixtureChannel } };
`;
}

function monitorShimSource(failFirstStop) {
  return `
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
    ${failFirstStop ? `if (stopCalls === 1) throw new Error('retained teardown');` : ''}
  }
}
const monitorShim = require.resolve(path.join(repo, 'src/claude-monitor'));
require.cache[monitorShim] = { id: monitorShim, filename: monitorShim, loaded: true, exports: { createClaudeMonitor: options => new FixtureMonitor(options) } };
`;
}

// Builds the child source for one mode. Setup (state/db/binding) and the IPC/
// deadline framework are shared; only the transport shim and the close trigger
// (an IPC command for the channel, real signals for the Monitor) differ.
function childSource({ mode, failFirstStop, revokeReadiness, deadlineMs }) {
  return `'use strict';
const path = require('node:path');
const repo = ${JSON.stringify(REPO_ROOT)};
const dir = process.argv[2];
let deadline = setTimeout(() => { process.send({ phase: 'deadline' }); process.exit(2); }, ${deadlineMs});
const settle = () => { clearTimeout(deadline); process.exit(process.exitCode ?? 0); };
const stateMod = require(path.join(repo, 'src/state'));
const originalClose = stateMod.SurfaceState.prototype.close;
let stateCloses = 0;
stateMod.SurfaceState.prototype.close = function (...args) {
  stateCloses += 1;
  return originalClose.apply(this, args);
};
let stopCalls = 0;
let readinessRevokeCalls = 0;
${revokeReadiness ? `stateMod.SurfaceState.prototype.setBindingReadiness = function () { readinessRevokeCalls += 1; throw new Error('fixture-readiness-revoke'); };` : ''}
${mode === 'channel' ? channelShimSource(failFirstStop) : monitorShimSource(failFirstStop)}
const { SurfaceState } = stateMod;
const db = path.join(dir, 'surface.sqlite');
const socket = path.join(dir, 'claude.sock');
const nativeId = ${JSON.stringify(NATIVE_ID)};
const state = new SurfaceState(db);
state.setConfig({ operatorId: 'operator', guildId: 'guild', secretFile: path.join(dir, 'discord.env') });
state.bindOrdinaryClaude({ channelId: 'claude-channel', guildId: 'guild', provider: 'claude', nativeId, workspace: dir, endpoint: socket },
  { sessionId: nativeId, threadId: nativeId, harness: 'claude-code' }, '100');
state.close();
stateCloses = 0;
const cli = require(path.join(repo, 'src/cli.js'));
let closeAttempts = 0;
const snapshot = phase => process.send({ phase, stopCalls, stateCloses, readinessRevokeCalls, exitCode: process.exitCode ?? 0 });
process.on('message', message => {
  if (message.cmd === 'close' && typeof captured !== 'undefined' && captured) {
    closeAttempts += 1;
    const label = closeAttempts === 1 ? 'after-first' : 'after-second';
    captured.onTransportClose();
    setImmediate(() => snapshot(label));
  }
  if (message.cmd === 'finish') settle();
});
(async () => {
  await cli.${mode === 'channel' ? 'claudeChannel' : 'claudeMonitor'}({ 'state-dir': dir, db, 'native-id': nativeId, socket });
  process.send({ phase: 'started' });
  if (${mode === 'monitor'}) {
    const onSignal = () => {
      closeAttempts += 1;
      const label = closeAttempts === 1 ? 'after-first' : 'after-second';
      setImmediate(() => { snapshot(label); if (stateCloses >= 1) settle(); });
    };
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
  }
})().catch(error => { process.send({ phase: 'error', error: String(error && error.message) }); process.exit(3); });
`;
}

// Starts one bounded wrapper child over fork IPC. `t` needs only an `after(fn)`
// registration method (a real node:test context or an equivalent duck type).
function startWrapperChild(t, { mode, failFirstStop = false, revokeReadiness = false, deadlineMs = DEFAULT_DEADLINE_MS } = {}) {
  const dir = shortTempRoot(t);
  const script = path.join(dir, 'wrapper-child.cjs');
  fs.writeFileSync(script, childSource({ mode, failFirstStop, revokeReadiness, deadlineMs }), { mode: 0o600 });
  const child = fork(script, [dir], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  child.stderr.setEncoding('utf8');
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const events = [];
  const waiters = [];
  child.on('message', message => {
    events.push(message);
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      if (waiters[i].phase === message.phase) { waiters[i].resolve(message); waiters.splice(i, 1); }
    }
  });
  const exited = once(child, 'exit').then(([code, signal]) => ({ code, signal }));
  let settled = false;
  exited.then(() => {
    settled = true;
    for (const waiter of waiters.splice(0)) {
      waiter.reject(new Error(`wrapper child exited before phase ${waiter.phase} (stderr=${stderr})`));
    }
  });
  const waitFor = phase => new Promise((resolve, reject) => {
    const already = events.find(entry => entry.phase === phase);
    if (already) return resolve(already);
    if (settled) return reject(new Error(`wrapper child already exited before phase ${phase} (stderr=${stderr})`));
    waiters.push({ phase, resolve, reject });
  });
  const finish = () => {
    if (child.exitCode === null && child.signalCode === null) child.send({ cmd: 'finish' });
    return exited;
  };
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { child, waitFor, exited, finish };
}

module.exports = { startWrapperChild };
