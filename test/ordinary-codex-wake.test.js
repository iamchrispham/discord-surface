const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { gatewayProcessStatus, GATEWAY_CAPABILITIES, createBindingWakeController, ordinaryBind, pathsFor, requestGatewayRecovery } = require('../src/cli');
const { SurfaceState, PROVIDERS, READINESS } = require('../src/state');
const { RECOVERY_POLICIES } = require('../src/discord');
const { fixture: recoveryFixture } = require('./helpers/intake-recovery-fixture');
const { ChannelType } = require('discord.js');

const CODEX = '9caa5d21-2169-429d-918b-5f08651b5dbd';

function deferred() {
  let resolve;
  const promise = new Promise(finish => { resolve = finish; });
  return { promise, resolve };
}

test('ordinary binding wake reaches runtime recovery and refuses disabled wake capability', async t => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinary-registered-wake-'));
  const stateDir = path.join(fixtureDir, 'state');
  const workspace = path.join(fixtureDir, 'workspace');
  const codexHome = path.join(fixtureDir, 'codex-home');
  const sessionRoot = path.join(codexHome, 'sessions');
  const db = path.join(stateDir, 'surface.sqlite');
  const secretFile = path.join(fixtureDir, 'discord.env');
  const transcriptFile = path.join(sessionRoot, `${CODEX}.jsonl`);
  const preload = path.join(fixtureDir, 'gateway-preload.cjs');
  const eventFile = path.join(fixtureDir, 'events.ndjson');
  const releaseHistory = path.join(fixtureDir, 'release-history');
  const archiveRoot = path.resolve(__dirname, '..');
  const paths = pathsFor({ 'state-dir': stateDir, db });
  let child = null;
  let state = null;
  const writeEvent = value => {
    fs.appendFileSync(eventFile, `${JSON.stringify({ at: new Date().toISOString(), source: 'parent', ...value })}\n`, { mode: 0o600 });
  };
  const readEvents = () => fs.existsSync(eventFile)
    ? fs.readFileSync(eventFile, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
    : [];
  const waitFor = async (predicate, label, timeoutMs = 7000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error(`${label} exceeded ${timeoutMs}ms guard`);
  };
  const waitForEvent = async (predicate, label) => {
    await waitFor(() => readEvents().some(predicate), label);
    return readEvents().find(predicate);
  };
  const waitForExit = processRef => {
    if (!processRef || processRef.exitCode !== null || processRef.signalCode !== null) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`child process ${processRef.pid} did not exit during cleanup`)), 5000);
      processRef.once('error', error => { clearTimeout(timer); reject(error); });
      processRef.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  };

  for (const directory of [stateDir, workspace, sessionRoot]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(secretFile, 'DISCORD_TOKEN=fixture-token\n', { mode: 0o600 });
  fs.writeFileSync(transcriptFile, `${JSON.stringify({ type: 'session_meta', payload: { session_id: CODEX, id: CODEX, cwd: workspace } })}\n`, { mode: 0o600 });
  fs.writeFileSync(eventFile, '', { mode: 0o600 });
  const preloadSource = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const Module = require('node:module');
const eventsPath = __EVENTS__;
const releasePath = __RELEASE__;
const channelId = __CHANNEL__;
const archive = __ARCHIVE__;
function record(value) { fs.appendFileSync(eventsPath, JSON.stringify({ at: new Date().toISOString(), ...value }) + '\n', { mode: 0o600 }); }
function waitForRelease() { return new Promise(resolve => { const poll = () => fs.existsSync(releasePath) ? resolve() : setTimeout(poll, 5); poll(); }); }
const channel = {
  id: channelId,
  guildId: 'guild',
  topic: '',
  isTextBased: () => true,
  isThread: () => false,
  permissionsFor: () => ({ has: () => true }),
  messages: {
    async fetch(options) {
      record({ phase: 'history-fetch', options: options ? { limit: options.limit || null, after: options.after || null } : null });
      if (typeof options === 'string') return { id: options, async react(reaction) { record({ phase: 'message-react', reaction }); } };
      if (!fs.existsSync(releasePath)) { record({ phase: 'history-hold' }); await waitForRelease(); record({ phase: 'history-released' }); }
      return [{ id: '200', guildId: 'guild', channelId, author: { id: 'operator', bot: false }, content: 'held ordinary wake input', attachments: [],
        async react(reaction) { record({ phase: 'message-react', reaction }); } }];
    }
  },
  async send(payload) { record({ phase: 'channel-send', content: payload?.content || null }); return { id: 'fixture-discord-message' }; }
};
class FixtureClient extends EventEmitter {
  constructor() { super(); this.user = { id: 'fixture-bot' }; this.channels = { fetch: async requested => { record({ phase: 'channel-fetch', channelId: requested }); return requested === channelId ? channel : null; } }; }
  async login() { record({ phase: 'client-login' }); }
  async destroy() { record({ phase: 'client-destroy' }); }
}
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'discord.js') return { Client: FixtureClient, GatewayIntentBits: { Guilds: 1, GuildMessages: 2, MessageContent: 4 }, PermissionFlagsBits: { ViewChannel: 'ViewChannel', ReadMessageHistory: 'ReadMessageHistory', SendMessages: 'SendMessages' } };
  return originalLoad.apply(this, arguments);
};
const nativePath = path.join(archive, 'src', 'native.js');
const native = require(nativePath);
class FixtureCodexProvider {
  async dispatch(message) { record({ phase: 'provider-dispatch', messageId: message.id, nativeId: message.nativeId, sessionRoot: message.sessionRoot || null }); return { status: 'submitted', cursor: null }; }
  async observe(message) { record({ phase: 'provider-observe', messageId: message.id, nativeId: message.nativeId }); return { text: 'fixture ordinary wake reply' }; }
}
require.cache[require.resolve(nativePath)].exports = { ...native, CodexProvider: FixtureCodexProvider };
const discordPath = path.join(archive, 'src', 'discord.js');
const discord = require(discordPath);
const Gateway = discord.DiscordGateway;
const originalStart = Gateway.prototype.start;
Gateway.prototype.start = async function(...args) { const result = await originalStart.apply(this, args); record({ phase: 'gateway-started', ready: this.ready, transportReady: this.transportReady }); return result; };
const originalRecover = Gateway.prototype.recoverTransport;
Gateway.prototype.recoverTransport = async function(reason, ...args) { record({ phase: 'recover-start', reason, ready: this.ready, transportReady: this.transportReady }); const result = await originalRecover.call(this, reason, ...args); record({ phase: 'recover-finish', reason, result, ready: this.ready, transportReady: this.transportReady }); return result; };
const originalReconcile = Gateway.prototype.reconcilePending;
Gateway.prototype.reconcilePending = async function(...args) { record({ phase: 'reconcile-start', before: args[0] || null }); const result = await originalReconcile.apply(this, args); record({ phase: 'reconcile-finish', candidates: Array.isArray(result) ? result.length : null }); return result; };
const originalStop = Gateway.prototype.stop;
Gateway.prototype.stop = async function(...args) { const result = await originalStop.apply(this, args); record({ phase: 'gateway-stopped', ready: this.ready, transportReady: this.transportReady }); return result; };
setInterval(() => {}, 1000);
`.replaceAll('__EVENTS__', JSON.stringify(eventFile))
  .replaceAll('__RELEASE__', JSON.stringify(releaseHistory))
  .replaceAll('__CHANNEL__', JSON.stringify('ordinary-registered-wake'))
  .replaceAll('__ARCHIVE__', JSON.stringify(archiveRoot));
  fs.writeFileSync(preload, preloadSource, { mode: 0o600 });

  t.after(async () => {
    const cleanupErrors = [];
    try {
      if (state) state.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
    state = null;
    try {
      if (child && child.exitCode === null && child.signalCode === null) {
        if (!fs.existsSync(releaseHistory)) fs.writeFileSync(releaseHistory, 'cleanup-release\n', { mode: 0o600 });
        try { child.kill('SIGTERM'); } catch (error) { cleanupErrors.push(error); }
      }
      try {
        await waitForExit(child);
      } catch (error) {
        cleanupErrors.push(error);
        if (child && child.exitCode === null && child.signalCode === null) {
          try { child.kill('SIGKILL'); } catch (killError) { cleanupErrors.push(killError); }
          try { await waitForExit(child); } catch (forcedError) { cleanupErrors.push(forcedError); }
        }
      }
      try { assert.ok(!child || child.exitCode !== null || child.signalCode !== null); }
      catch (error) { cleanupErrors.push(error); }
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      fs.rmSync(fixtureDir, { recursive: true, force: true });
      assert.equal(fs.existsSync(fixtureDir), false);
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'ordinary wake fixture cleanup failed');
  });

  state = new SurfaceState(db);
  state.setConfig({ operatorId: 'operator', guildId: 'guild', secretFile });
  state.close();
  state = null;
  const cliPath = path.resolve(__dirname, '../src/cli.js');
  child = spawn(process.execPath, [cliPath, 'run', '--state-dir', stateDir, '--db', db], {
    cwd: archiveRoot,
    env: { ...process.env, NODE_OPTIONS: `--require=${preload}`, CODEX_HOME: codexHome, DISCORD_SURFACE_LOCK_HELD: '1' },
    stdio: ['ignore', 'ignore', 'ignore']
  });
  await waitFor(() => fs.existsSync(paths.pid), 'runtime pid file');
  await waitForEvent(event => event.phase === 'gateway-started' && event.ready === true && event.transportReady === true, 'Gateway transport-ready startup');
  const running = gatewayProcessStatus(paths);
  assert.equal(running.state, 'running');
  assert.equal(running.pid, child.pid);

  const pidRecord = JSON.parse(fs.readFileSync(paths.pid, 'utf8'));
  const recoveryCountBeforeDisabled = readEvents().filter(event => event.phase === 'recover-start' && event.reason === 'ordinary-bind').length;
  fs.writeFileSync(paths.pid, JSON.stringify({ ...pidRecord, capabilities: [] }), { mode: 0o600 });
  let disabledKillCalls = 0;
  const disabledResult = requestGatewayRecovery(paths, { kill: () => { disabledKillCalls += 1; } });
  await new Promise(resolve => setImmediate(resolve));
  const recoveryCountAfterDisabled = readEvents().filter(event => event.phase === 'recover-start' && event.reason === 'ordinary-bind').length;
  assert.deepEqual(disabledResult, { requested: false, pid: child.pid, state: 'running', reason: 'gateway-wake-unsupported', capability: GATEWAY_CAPABILITIES.ordinaryBindWake });
  assert.equal(disabledKillCalls, 0);
  assert.equal(recoveryCountAfterDisabled, recoveryCountBeforeDisabled);
  fs.writeFileSync(paths.pid, JSON.stringify(pidRecord), { mode: 0o600 });

  let signalRequested = null;
  let signalDelivered = null;
  const captureWakeSignal = (pid, signal) => {
    signalRequested = { pid, signal };
    writeEvent({ phase: 'signal-requested', pid, signal });
  };
  const bindChannel = {
    id: 'ordinary-registered-wake',
    guildId: 'guild',
    name: 'ordinary-registered-wake',
    isTextBased: () => true,
    isThread: () => false,
    messages: { fetch: async () => new Map([['100', { id: '100' }]]) },
    async send() { return { id: '100', async delete() {} }; }
  };
  class BindClient {
    constructor() { this.guilds = { fetch: async () => ({ channels: { fetch: async selection => selection ? bindChannel : new Map([[bindChannel.id, bindChannel]]) } }) }; }
    async login() {}
    async destroy() {}
  }
  const bindResult = await ordinaryBind({ 'state-dir': stateDir, db, channel: '#ordinary-registered-wake', workspace, 'session-root': sessionRoot }, {
    environment: { CODEX_SESSION_ID: CODEX, CODEX_THREAD_ID: CODEX, PWD: workspace },
    requireInstalled: () => ({ Client: BindClient, GatewayIntentBits: { Guilds: 1 } }),
    readSecret: () => 'fixture-token',
    validateCodexSessionIdentity: () => ({ file: transcriptFile, sessionId: CODEX, threadId: CODEX, workspace }),
    gatewayProcessStatus: candidate => gatewayProcessStatus(candidate),
    killProcess: captureWakeSignal,
    print: () => {}
  });
  assert.equal(bindResult.reused, false);
  assert.equal(bindResult.nativeProof.status, 'verified');
  assert.deepEqual(signalRequested, { pid: child.pid, signal: 'SIGUSR2' });
  assert.equal(bindResult.gatewayWake.requested, true);

  state = new SurfaceState(db);
  const accepted = state.acceptDiscordMessage({
    id: '200', guildId: 'guild', channelId: 'ordinary-registered-wake', authorId: 'operator', isBot: false,
    content: 'held ordinary wake input', attachments: []
  }, { ready: false });
  assert.equal(accepted.accepted, true);
  const beforeWake = {
    bindingReadiness: state.getBinding('ordinary-registered-wake').readiness,
    watermarkState: state.getIntakeWatermark('ordinary-registered-wake').state,
    messageState: state.getMessage('200').state
  };
  assert.equal(beforeWake.bindingReadiness, READINESS.PENDING);
  assert.equal(beforeWake.messageState, 'accepted');
  state.close();
  state = null;
  signalDelivered = signalRequested;
  writeEvent({ phase: 'signal-delivered', ...signalDelivered });
  process.kill(signalDelivered.pid, signalDelivered.signal);

  await waitForEvent(event => event.phase === 'signal-delivered', 'actual SIGUSR2 delivery');
  await waitForEvent(event => event.phase === 'history-hold', 'ordinary-bind recovery history hold');
  assert.doesNotThrow(() => process.kill(child.pid, 0));
  fs.writeFileSync(releaseHistory, 'release\n', { mode: 0o600 });
  writeEvent({ phase: 'history-release-written' });
  await waitForEvent(event => event.phase === 'recover-finish' && event.reason === 'ordinary-bind' && event.result?.ready === true, 'ordinary-bind recovery completion');
  const recoveryFinishIndex = readEvents().findIndex(event => event.phase === 'recover-finish' && event.reason === 'ordinary-bind' && event.result?.ready === true);
  await waitFor(() => readEvents().some((event, index) => index > recoveryFinishIndex && event.phase === 'reconcile-finish'), 'ordinary-bind reconcile completion');
  await waitForEvent(event => event.phase === 'provider-dispatch' && event.messageId === '200', 'held message dispatch');
  await waitForEvent(event => event.phase === 'provider-observe' && event.messageId === '200', 'held message observation');

  state = new SurfaceState(db);
  await waitFor(() => state.getMessage('200')?.state === 'replied', 'held message delivery');
  const finalBinding = state.getBinding('ordinary-registered-wake');
  const finalWatermark = state.getIntakeWatermark('ordinary-registered-wake');
  const finalMessage = state.getMessage('200');
  const finalStatus = gatewayProcessStatus(paths);
  assert.equal(signalDelivered?.pid, child.pid);
  assert.equal(signalDelivered?.signal, 'SIGUSR2');
  assert.equal(bindResult.gatewayWake.requested, true);
  assert.equal(finalBinding.readiness, READINESS.READY);
  assert.equal(finalWatermark.state, READINESS.READY);
  assert.equal(finalMessage.state, 'replied');
  assert.equal(finalStatus.state, 'running');
});

test('ready completion wake does not demote an unrelated healthy route', { timeout: 5000 }, async t => {
  const f = recoveryFixture(t);
  f.gateway.ready = true;
  f.gateway.transportReady = true;
  const changes = [];
  const original = f.state.setBindingReadiness.bind(f.state);
  t.mock.method(f.state, 'setBindingReadiness', (...args) => {
    changes.push({ channelId: args[0], readiness: args[1] });
    return original(...args);
  });
  const wake = createBindingWakeController({
    getGateway: () => f.gateway,
    isReady: () => f.gateway.ready,
    isTransportReady: () => f.gateway.transportReady,
    isStopping: () => f.gateway.stopping
  });
  wake.request();
  await wake.wait();
  assert.equal(f.state.getBinding('1000').readiness, 'ready');
  assert.equal(f.boundary('2000').state, 'ready');
  assert.equal(changes.some(change => change.channelId === '1000' && change.readiness === 'recovering'), false,
    'completion-only wake must not temporarily hold a healthy route');
});

test('scoped completion wake keeps a healthy route live during selected recovery', { timeout: 5000 }, async t => {
  const f = recoveryFixture(t);
  f.gateway.ready = true;
  f.gateway.transportReady = true;
  f.enableDelivery();
  const secondParent = {
    id: '3000', guildId: 'guild', type: ChannelType.GuildText, parentId: null, isThread: () => false,
    permissionsFor: () => ({ has: () => true }),
    async send() { return { id: 'reply-3000' }; },
    messages: { async fetch() { return { async react() {} }; } }
  };
  f.channels.set('3000', secondParent);
  f.history.set('3000', []);
  f.state.bind({
    channelId: '3000', guildId: 'guild', provider: PROVIDERS.CODEX,
    nativeId: '22222222-2222-2222-2222-222222222222', workspace: f.state.getBinding('1000').workspace,
    readiness: READINESS.PENDING
  }, { intakeCutoff: '100' });
  f.state.setIntakeBaseline('3000', '100', 'fixture second parent');
  const entered = deferred();
  const release = deferred();
  const originalFetchHistory = f.gateway.fetchHistory.bind(f.gateway);
  f.gateway.fetchHistory = async (channel, options) => {
    if (channel.id === '3000') {
      entered.resolve();
      await release.promise;
    }
    return originalFetchHistory(channel, options);
  };
  const wake = completionWake(f);
  wake.request();
  await entered.promise;
  f.gateway.boundMessage(f.message('101', '1000'));
  await Promise.all([...f.gateway.inFlight]);
  await f.gateway.consumer.waitForNativeWork();
  assert.equal(f.state.getMessage('101').state, 'replied',
    'a healthy route must dispatch while the selected route recovers');
  release.resolve();
  await wake.wait();
  assert.equal(f.state.getBinding('3000').readiness, READINESS.READY);
});

test('empty unresolved recovery stays paused after a disconnect', { timeout: 5000 }, async t => {
  const f = recoveryFixture(t);
  f.gateway.ready = true;
  f.gateway.transportReady = true;
  const recovery = f.gateway.recoverTransport('ordinary-bind', f.gateway.lifecycleEpoch, null, null, {
    recoveryPolicy: RECOVERY_POLICIES.UNRESOLVED
  });
  f.gateway.pauseConnection('fixture disconnect');
  const result = await recovery;
  assert.equal(result.state, 'stopped');
  assert.equal(f.gateway.ready, false);
  assert.equal(f.gateway.transportReady, false);
});

test('a pending route is still recovered by the public binding wake', { timeout: 5000 }, async t => {
  const f = recoveryFixture(t);
  f.gateway.ready = true;
  f.gateway.transportReady = true;
  f.state.setBindingReadiness('1000', 'pending', 'fixture pending', f.state.getBinding('1000'));
  const wake = createBindingWakeController({
    getGateway: () => f.gateway,
    isReady: () => f.gateway.ready,
    isTransportReady: () => f.gateway.transportReady,
    isStopping: () => f.gateway.stopping
  });
  wake.request();
  await wake.wait();
  assert.equal(f.state.getBinding('1000').readiness, 'ready');
  assert.equal(f.boundary('2000').state, 'ready');
  assert.ok(f.calls.some(call => call.id === '1000' && call.kind === 'history'));
});

function observeReadiness(f, t) {
  const changes = [];
  const original = f.state.setBindingReadiness.bind(f.state);
  t.mock.method(f.state, 'setBindingReadiness', (...args) => {
    changes.push({ channelId: args[0], readiness: args[1] });
    return original(...args);
  });
  return changes;
}

function completionWake(f) {
  return createBindingWakeController({
    getGateway: () => f.gateway,
    isReady: () => f.gateway.ready,
    isTransportReady: () => f.gateway.transportReady,
    isStopping: () => f.gateway.stopping
  });
}

test('ordinary-bind wake recovers a pending child without touching its ready parent', { timeout: 5000 }, async t => {
  const f = recoveryFixture(t);
  f.gateway.ready = true;
  f.gateway.transportReady = true;
  f.state.markThreadBoundary('2000', 'pending', 'fixture pending child');
  const changes = observeReadiness(f, t);
  const wake = completionWake(f);
  wake.request();
  await wake.wait();
  assert.equal(f.state.getThreadEnrollment('2000').state, 'ready');
  assert.ok(f.calls.some(call => call.id === '2000' && call.kind === 'history'),
    'the pending child must be recovered');
  assert.equal(f.calls.some(call => call.id === '1000'), false,
    'the ready parent must not be re-fetched by a completion wake');
  assert.equal(changes.some(change => change.channelId === '1000'), false,
    'the ready parent must not be demoted by a completion wake');
  assert.equal(f.state.getBinding('1000').readiness, 'ready');
});

test('ordinary-bind wake recovers only a pending second parent beside ready parent and child', { timeout: 5000 }, async t => {
  const f = recoveryFixture(t);
  f.gateway.ready = true;
  f.gateway.transportReady = true;
  const secondParent = {
    id: '3000', guildId: 'guild', type: ChannelType.GuildText, parentId: null, isThread: () => false,
    permissionsFor: () => ({ has: () => true }),
    async send() { return { id: 'reply-3000' }; },
    messages: { async fetch() { return { async react() {} }; } }
  };
  f.channels.set('3000', secondParent);
  f.history.set('3000', []);
  f.state.bind({
    channelId: '3000', guildId: 'guild', provider: PROVIDERS.CODEX,
    nativeId: '22222222-2222-2222-2222-222222222222', workspace: f.state.getBinding('1000').workspace,
    readiness: 'pending'
  }, { intakeCutoff: '100' });
  f.state.setIntakeBaseline('3000', '100', 'fixture second parent');
  const changes = observeReadiness(f, t);
  const wake = completionWake(f);
  wake.request();
  await wake.wait();
  assert.equal(f.state.getBinding('3000').readiness, 'ready');
  assert.equal(f.state.getIntakeWatermark('3000').state, 'ready');
  assert.ok(f.calls.some(call => call.id === '3000' && call.kind === 'history'),
    'the pending second parent must be recovered');
  assert.equal(f.calls.some(call => call.id === '1000'), false,
    'the ready first parent must not be re-fetched');
  assert.equal(f.calls.some(call => call.id === '2000'), false,
    'the ready enrolled child must not be re-fetched');
  assert.deepEqual(changes, [{ channelId: '3000', readiness: 'recovering' }]);
});

test('startup recovery still performs a full fresh pass over ready routes', { timeout: 5000 }, async t => {
  const f = recoveryFixture(t);
  f.gateway.ready = true;
  f.gateway.transportReady = true;
  const wake = completionWake(f);
  wake.request();
  await wake.wait();
  assert.deepEqual(f.calls, [], 'a completion wake must not re-fetch already-ready routes');
  const result = await f.gateway.recoverTransport('startup');
  assert.equal(result.ready, true);
  assert.ok(f.calls.some(call => call.id === '1000' && call.kind === 'history'),
    'startup must refresh the ready parent');
  assert.ok(f.calls.some(call => call.id === '2000' && call.kind === 'history'),
    'startup must refresh the ready enrolled child');
});

test('reconnect recovery still performs a full fresh pass over ready routes', { timeout: 5000 }, async t => {
  const f = recoveryFixture(t);
  f.gateway.ready = true;
  f.gateway.transportReady = true;
  await f.reopen();
  const result = await f.gateway.recoverTransport('reconnect');
  assert.equal(result.ready, true);
  assert.ok(f.calls.some(call => call.id === '1000' && call.kind === 'history'),
    'reconnect must refresh the ready parent');
  assert.ok(f.calls.some(call => call.id === '2000' && call.kind === 'history'),
    'reconnect must refresh the ready enrolled child');
  assert.equal(f.state.getBinding('1000').readiness, 'ready');
  assert.equal(f.state.getThreadEnrollment('2000').state, 'ready');
});

test('explicit ordinary-bind scope still recovers an already-ready parent', { timeout: 5000 }, async t => {
  const f = recoveryFixture(t);
  f.gateway.ready = true;
  f.gateway.transportReady = true;
  const changes = observeReadiness(f, t);
  const result = await f.gateway.recoverTransport('ordinary-bind', f.gateway.lifecycleEpoch, new Set(['1000']));
  assert.equal(result.ready, true);
  assert.ok(f.calls.some(call => call.id === '1000' && call.kind === 'history'),
    'an explicit scope must still recover the ready parent');
  assert.ok(changes.some(change => change.channelId === '1000' && change.readiness === 'recovering'),
    'an explicit scope must re-run the readiness transition');
  assert.equal(f.state.getBinding('1000').readiness, 'ready');
});

test('ordinary-bind wake recovers a ready parent whose watermark is unknown', { timeout: 5000 }, async t => {
  const f = recoveryFixture(t);
  f.gateway.ready = true;
  f.gateway.transportReady = true;
  f.state.db.prepare('DELETE FROM intake_watermarks WHERE channel_id=?').run('1000');
  assert.equal(f.state.getIntakeWatermark('1000'), null);
  const changes = observeReadiness(f, t);
  const wake = completionWake(f);
  wake.request();
  await wake.wait();
  assert.ok(f.calls.some(call => call.id === '1000' && call.kind === 'channel'),
    'an unknown watermark must still be selected for recovery');
  assert.ok(changes.some(change => change.channelId === '1000' && change.readiness === 'recovering'),
    'an unknown watermark must re-run the readiness transition');
  assert.equal(f.state.getIntakeWatermark('1000').state, 'pending',
    'an unknown watermark without a qualified cursor must be held pending, not silently ready');
  assert.equal(f.calls.some(call => call.id === '2000'), false,
    'the ready enrolled child must not be re-fetched once its parent is held');
});
