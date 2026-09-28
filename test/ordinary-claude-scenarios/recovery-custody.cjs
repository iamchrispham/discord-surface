const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const test = require('node:test');
const { createClaudeMonitor, createMonitorMcp } = require('../../src/claude-monitor');
const { DiscordGateway } = require('../../src/discord');
const { ClaudeProvider, probeClaudeChannel, waitForReply } = require('../../src/native');
const { MESSAGE_STATES, READINESS, SurfaceState } = require('../../src/state');
const { CLAUDE, CLI_PATH, fixture, waitFor } = require('./fixture.cjs');

test('ordinary Claude bind-time endpoint failure keeps an endpoint watermark', async t => {
  const f = fixture(t);
  const channel = { id: f.binding.channelId, guildId: 'guild' };
  let preflightCalls = 0;
  const gateway = new DiscordGateway({
    state: f.state,
    client: { user: { id: 'bot' }, channels: { fetch: async () => channel }, on() {}, off() {}, async destroy() {} },
    providers: { claude: { async dispatch() { throw new Error('must stay held'); } } },
    recoveryOptions: {
      ordinaryNativePreflight: async () => { preflightCalls += 1; throw new Error('connect ENOENT'); }
    }
  });
  const result = await gateway.recoverTransport('ordinary-bind', 0);
  assert.equal(preflightCalls, 1);
  assert.equal(result.ready, false);
  assert.equal(result.state, READINESS.UNAVAILABLE);
  assert.equal(f.state.getBinding(f.binding.channelId).readiness, READINESS.UNAVAILABLE);
  assert.match(f.state.getIntakeWatermark(f.binding.channelId).detail, /^Claude endpoint unavailable before event write: connect ENOENT/);
  await gateway.stop();
});

test('ordinary Claude recovery cannot restore a stale terminal binding', async t => {
  const f = fixture(t);
  f.state.markIntakeBoundary(f.binding.channelId, READINESS.UNAVAILABLE, 'prior unavailable recovery failure', null, null, f.binding);
  const originalGetIntakeWatermark = f.state.getIntakeWatermark.bind(f.state);
  let successor = null;
  f.state.getIntakeWatermark = channelId => {
    const watermark = originalGetIntakeWatermark(channelId);
    if (!successor && channelId === f.binding.channelId) {
      f.state.unbind(f.binding.channelId);
      successor = f.state.rebindOrdinaryClaude({
        channelId: f.binding.channelId, guildId: 'guild', provider: 'claude', nativeId: CLAUDE,
        workspace: f.dir, endpoint: f.socketPath
      }, { sessionId: CLAUDE, threadId: CLAUDE, harness: 'claude-code' });
    }
    return watermark;
  };
  const gateway = new DiscordGateway({
    state: f.state,
    client: { user: { id: 'bot' }, on() {}, off() {}, async destroy() {} },
    providers: { claude: { async dispatch() { throw new Error('must stay held'); } } }
  });
  const result = await gateway.recoverTransport('stale-terminal', 0);
  f.state.getIntakeWatermark = originalGetIntakeWatermark;
  assert.deepEqual(result, { ready: false, state: READINESS.UNAVAILABLE });
  assert.equal(successor.generation, 2);
  assert.equal(f.state.getBinding(f.binding.channelId).generation, 2);
  assert.equal(f.state.getBinding(f.binding.channelId).readiness, READINESS.PENDING);
  assert.equal(f.state.getIntakeWatermark(f.binding.channelId).state, READINESS.UNAVAILABLE);
  await gateway.stop();
});

test('ordinary Claude pre-write endpoint loss demotes only matching binding and holds later intake', async t => {
  const f = fixture(t);
  const channel = {
    id: f.binding.channelId,
    guildId: 'guild',
    permissionsFor: () => ({ has: () => true }),
    async send() { return { id: 'receipt' }; }
  };
  const gateway = new DiscordGateway({
    state: f.state,
    client: { user: { id: 'bot' }, channels: { fetch: async () => channel }, on() {}, off() {}, async destroy() {} },
    fetchHistory: async () => [],
    providers: { claude: new ClaudeProvider({ waitForReply: (id, options) => waitForReply(f.state, id, options) }) }
  });
  gateway.historyPermission = () => ({ known: true, allowed: true });
  const monitor = createClaudeMonitor({ state: f.state, nativeId: CLAUDE, socketPath: f.socketPath, stateDir: f.dir, dbPath: f.db });
  await monitor.start();
  const recovery = await gateway.recoverTransport('monitor-ready', 0);
  assert.equal(recovery.ready, true);
  assert.equal(f.state.getBinding(f.binding.channelId).readiness, READINESS.READY);
  await new Promise((resolve, reject) => monitor.server.close(error => error ? reject(error) : resolve()));
  try { fs.unlinkSync(f.socketPath); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const result = await gateway.consumer.handleMessage({
    id: 'endpoint-loss', guildId: 'guild', channelId: f.binding.channelId, content: 'lost endpoint',
    author: { id: 'operator', bot: false }, channel
  });
  assert.equal(result.status, 'not_submitted');
  assert.equal(f.state.getMessage('endpoint-loss').state, MESSAGE_STATES.ACCEPTED);
  await waitFor(() => f.state.getBinding(f.binding.channelId)?.readiness === READINESS.UNAVAILABLE);
  assert.equal(gateway.ready, false);
  const held = await gateway.consumer.intakeMessage({
    id: 'endpoint-loss-held', guildId: 'guild', channelId: f.binding.channelId, content: 'hold after loss',
    author: { id: 'operator', bot: false }, channel
  }, false, null, null, true);
  assert.equal(held.accepted, true);
  assert.equal(f.state.claimDispatch('endpoint-loss-held').reason, 'binding-not-ready');
  assert.equal(f.state.getMessage('endpoint-loss-held').state, MESSAGE_STATES.ACCEPTED);
  await gateway.stop();
  try { await monitor.stop(); } catch {}
});

test('ordinary Claude Monitor leaves readiness promotion to Gateway and revokes it on stop', async t => {
  const f = fixture(t);
  f.state.close();
  const child = spawn(process.execPath, [CLI_PATH, 'claude-monitor', '--state-dir', f.dir, '--db', f.db, '--native-id', CLAUDE, '--socket', f.socketPath], {
    stdio: ['ignore', 'pipe', 'pipe']
  });
  t.after(async () => {
    if (child.exitCode === null) child.kill('SIGTERM');
  });
  const observed = new SurfaceState(f.db);
  await waitFor(async () => {
    try {
      const identity = await probeClaudeChannel(f.socketPath, { nativeId: CLAUDE, generation: f.binding.generation, workspace: f.dir, endpoint: f.socketPath }, { timeoutMs: 100 });
      return identity.channelReady === true;
    } catch { return false; }
  });
  assert.equal(observed.getBinding(f.binding.channelId).readiness, READINESS.PENDING);
  child.kill('SIGTERM');
  await new Promise((resolve, reject) => {
    child.once('close', resolve);
    child.once('error', reject);
  });
  await waitFor(() => observed.getBinding(f.binding.channelId)?.readiness === READINESS.UNAVAILABLE);
  assert.equal(fs.existsSync(f.socketPath), false);
  observed.close();
});

test('Claude Monitor releases settled dedupe after native reply becomes terminal', async t => {
  const f = fixture(t);
  const stdout = new EventEmitter();
  const events = [];
  let prune;
  const timer = { unref() {} };
  t.mock.method(global, 'setInterval', callback => {
    prune = callback;
    return timer;
  });
  t.mock.method(global, 'clearInterval', value => assert.equal(value, timer));
  stdout.write = (chunk, callback) => {
    events.push(JSON.parse(String(chunk)));
    callback?.();
    return true;
  };
  const monitor = createMonitorMcp({ state: f.state, stateDir: f.dir, dbPath: f.db, stdout });
  f.state.setBindingReadiness(f.binding.channelId, READINESS.READY, 'test Monitor ready', f.binding);
  const intake = f.state.acceptDiscordMessage({
    id: 'ordinary-claude-dedupe-release', guildId: 'guild', channelId: f.binding.channelId,
    authorId: 'operator', isBot: false, content: 'answer this'
  });
  assert.equal(f.state.claimDispatch(intake.message.id).claimed, true);
  f.state.markSubmitted(intake.message.id);
  const event = {
    method: 'notifications/claude/channel',
    params: { content: 'answer this', meta: { messageId: intake.message.id, nativeId: CLAUDE, generation: '1' } }
  };
  await monitor.notification(event);
  assert.equal(events.length, 1);
  f.state.recordNativeReply({ provider: 'claude', messageId: intake.message.id, nativeId: CLAUDE, generation: 1, text: 'done' });
  prune();
  await monitor.notification(event);
  assert.equal(events.length, 2);
  await monitor.close();
});
