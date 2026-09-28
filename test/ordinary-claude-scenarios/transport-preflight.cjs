const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { ordinaryClaudeBind } = require('../../src/cli');
const { createClaudeMonitor } = require('../../src/claude-monitor');
const { runDirectPost } = require('../../src/direct-post');
const { ClaudeProvider, dispatchAndObserve, postUnixJson, waitForReply } = require('../../src/native');
const { GATEWAY_CAPABILITIES } = require('../../src/ordinary-bind/constants');
const { MESSAGE_STATES, READINESS, StaleGenerationError } = require('../../src/state');
const { CLAUDE, fakeClient, fixture, waitFor } = require('./fixture.cjs');

test('real ClaudeProvider and Claude Monitor path preserves exact reply custody', async t => {
  const f = fixture(t);
  const stdout = new EventEmitter();
  const events = [];
  stdout.write = (chunk, callback) => {
    events.push(JSON.parse(String(chunk)));
    callback?.();
    return true;
  };
  const monitor = createClaudeMonitor({ state: f.state, nativeId: CLAUDE, socketPath: f.socketPath, stateDir: f.dir, dbPath: f.db, stdout });
  await monitor.start();
  f.state.setBindingReadiness(f.binding.channelId, READINESS.READY, 'test Monitor ready', f.binding);
  const intake = f.state.acceptDiscordMessage({
    id: 'ordinary-claude-event', guildId: 'guild', channelId: f.binding.channelId,
    authorId: 'operator', isBot: false, content: 'answer this'
  });
  assert.equal(intake.accepted, true);
  const provider = new ClaudeProvider({ waitForReply: (id, options) => waitForReply(f.state, id, options) });
  const work = dispatchAndObserve(f.state, intake.message.id, { claude: provider }, { timeoutMs: 3000, pollMs: 5 });
  await waitFor(() => events.length === 1);
  const pointer = events[0];
  const payload = JSON.parse(fs.readFileSync(pointer.payloadPath, 'utf8'));
  assert.equal(payload.meta.nativeId, CLAUDE);
  assert.equal(payload.meta.messageId, intake.message.id);
  const duplicate = await postUnixJson(f.socketPath, { nativeId: CLAUDE, messageId: intake.message.id, generation: 1, content: 'duplicate' });
  assert.equal(duplicate.statusCode, 202);
  f.state.recordNativeReply({ provider: 'claude', messageId: intake.message.id, nativeId: CLAUDE, generation: 1, text: 'Claude answer' });
  const result = await work;
  assert.equal(result.message.state, MESSAGE_STATES.REPLY_READY);
  assert.equal(f.state.getMessage(intake.message.id).replyText, 'Claude answer');
  await monitor.stop();
});

test('Claude Monitor stdout failure stops transport and detaches listeners', async t => {
  const errorFixture = fixture(t);
  const closeFixture = fixture(t);
  const errorStdout = new EventEmitter();
  const closeStdout = new EventEmitter();
  errorStdout.write = (_chunk, callback) => { callback?.(); return true; };
  closeStdout.write = (_chunk, callback) => { callback?.(); return true; };
  let errorTransportCloses = 0;
  let closeTransportCloses = 0;
  const errorMonitor = createClaudeMonitor({
    state: errorFixture.state, nativeId: CLAUDE, socketPath: errorFixture.socketPath,
    stateDir: errorFixture.dir, dbPath: errorFixture.db, stdout: errorStdout,
    onTransportClose: () => { errorTransportCloses += 1; }
  });
  const closeMonitor = createClaudeMonitor({
    state: closeFixture.state, nativeId: CLAUDE, socketPath: closeFixture.socketPath,
    stateDir: closeFixture.dir, dbPath: closeFixture.db, stdout: closeStdout,
    onTransportClose: () => { closeTransportCloses += 1; }
  });
  t.after(async () => {
    await errorMonitor.stop().catch(() => {});
    await closeMonitor.stop().catch(() => {});
  });

  await Promise.all([errorMonitor.start(), closeMonitor.start()]);
  assert.equal(errorStdout.listenerCount('error'), 1);
  assert.equal(errorStdout.listenerCount('close'), 1);
  assert.equal(closeStdout.listenerCount('error'), 1);
  assert.equal(closeStdout.listenerCount('close'), 1);

  assert.doesNotThrow(() => errorStdout.emit('error', new Error('stdout failed')));
  assert.doesNotThrow(() => closeStdout.emit('close'));
  await waitFor(() => !errorMonitor.started && !closeMonitor.started);

  assert.equal(errorMonitor.ready, false);
  assert.equal(closeMonitor.ready, false);
  assert.equal(errorTransportCloses, 1);
  assert.equal(closeTransportCloses, 1);
  assert.equal(errorStdout.listenerCount('error'), 0);
  assert.equal(errorStdout.listenerCount('close'), 0);
  assert.equal(closeStdout.listenerCount('error'), 0);
  assert.equal(closeStdout.listenerCount('close'), 0);
  assert.equal(fs.existsSync(errorFixture.socketPath), false);
  assert.equal(fs.existsSync(closeFixture.socketPath), false);
});

test('ordinary Claude post preserves dedupe and stale generation custody', async t => {
  const f = fixture(t);
  const textFile = path.join(f.dir, 'milestone.txt');
  fs.writeFileSync(textFile, 'ordinary Claude milestone');
  let calls = 0;
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ id: `milestone-${++calls}` }) });
  const first = await runDirectPost({ state: f.state, token: 'fixture', nativeId: CLAUDE, generation: 1, channelId: f.binding.channelId,
    provider: 'claude', ordinary: true, textFile, dedupeKey: 'ordinary-claude-milestone', fetchImpl });
  const duplicate = await runDirectPost({ state: f.state, token: 'fixture', nativeId: CLAUDE, generation: 1, channelId: f.binding.channelId,
    provider: 'claude', ordinary: true, textFile, dedupeKey: 'ordinary-claude-milestone', fetchImpl });
  assert.equal(first.status, 'sent');
  assert.equal(duplicate.duplicate, true);
  assert.equal(calls, 1);
  f.state.unbind(f.binding.channelId);
  const rebound = f.state.rebindOrdinaryClaude({ channelId: f.binding.channelId, guildId: 'guild', provider: 'claude', nativeId: CLAUDE, workspace: f.dir, endpoint: f.socketPath },
    { sessionId: CLAUDE, threadId: CLAUDE, harness: 'claude-code' });
  assert.equal(rebound.generation, 2);
  await assert.rejects(() => runDirectPost({ state: f.state, token: 'fixture', nativeId: CLAUDE, generation: 1, channelId: f.binding.channelId,
    provider: 'claude', ordinary: true, textFile, dedupeKey: 'stale-claude', fetchImpl }), error => error instanceof StaleGenerationError);
});

test('Monitor construction failure releases allocated timers and listeners', t => {
  const timers = new Set();
  t.mock.method(global, 'setInterval', () => {
    const timer = { unref() {} };
    timers.add(timer);
    return timer;
  });
  t.mock.method(global, 'clearInterval', timer => timers.delete(timer));
  const stdout = new EventEmitter();
  stdout.write = () => true;
  assert.throws(() => createClaudeMonitor({
    state: { findNativeBinding: () => null },
    nativeId: CLAUDE,
    socketPath: '/tmp/monitor-construction-failure.sock',
    stateDir: '/tmp/monitor-construction-failure',
    stdout
  }), /pre-bound, opted-in/);
  assert.equal(timers.size, 0);
  assert.equal(stdout.listenerCount('error'), 0);
  assert.equal(stdout.listenerCount('close'), 0);
});

test('ordinary Claude preflight rereads Gateway after binding mutation', async t => {
  const f = fixture(t, { bind: false });
  const channel = { id: 'claude-channel', guildId: 'guild', name: 'dev', isTextBased: () => true };
  let reads = 0;
  const supportedCapabilities = [
    GATEWAY_CAPABILITIES.ordinaryBindWake,
    GATEWAY_CAPABILITIES.runtimeBindLock,
    GATEWAY_CAPABILITIES.ordinaryClaudeBind
  ];
  await assert.rejects(() => ordinaryClaudeBind({
    'state-dir': f.dir, channel: '#dev', transcript: f.session.file, socket: f.socketPath
  }, {
    resolveClaudeCaller: () => ({ sessionId: CLAUDE, harness: 'claude-code' }),
    requireInstalled: () => ({ Client: fakeClient(channel), GatewayIntentBits: { Guilds: 1 } }),
    readSecret: () => 'fixture-token',
    gatewayProcessStatus: () => (++reads < 3
      ? { state: 'running', pid: 4242, capabilities: supportedCapabilities }
      : { state: 'running', pid: 4243, capabilities: [GATEWAY_CAPABILITIES.ordinaryBindWake, GATEWAY_CAPABILITIES.runtimeBindLock] }),
    environment: { DISCORD_SURFACE_ORDINARY_CLAUDE_RUNTIME_PID: '4242' },
    killProcess: () => {},
    print: () => {}
  }), /running Gateway changed while binding ordinary Claude session/);
  const binding = f.state.getBinding(channel.id);
  assert.ok(binding);
  assert.equal(f.state.hasOrdinaryPreflight(binding), false);
});

test('ordinary Claude bind pins recovery wake to the selected Gateway', async t => {
  const f = fixture(t, { bind: false });
  const channel = { id: 'claude-channel', guildId: 'guild', name: 'dev', isTextBased: () => true };
  const selected = {
    state: 'running', pid: 4242,
    capabilities: [GATEWAY_CAPABILITIES.ordinaryBindWake, GATEWAY_CAPABILITIES.runtimeBindLock, GATEWAY_CAPABILITIES.ordinaryClaudeBind]
  };
  const replacement = { state: 'running', pid: 4243, capabilities: [] };
  let reads = 0;
  const wakeSignals = [];
  const result = await ordinaryClaudeBind({
    'state-dir': f.dir, channel: '#dev', transcript: f.session.file, socket: f.socketPath
  }, {
    resolveClaudeCaller: () => ({ sessionId: CLAUDE, harness: 'claude-code' }),
    requireInstalled: () => ({ Client: fakeClient(channel), GatewayIntentBits: { Guilds: 1 } }),
    readSecret: () => 'fixture-token',
    validateClaudeSessionIdentity: () => ({ file: f.session.file, sessionId: CLAUDE, threadId: CLAUDE, workspace: f.dir }),
    gatewayProcessStatus: () => (++reads < 4 ? selected : replacement),
    environment: { DISCORD_SURFACE_ORDINARY_CLAUDE_RUNTIME_PID: String(selected.pid) },
    killProcess: (pid, signal) => wakeSignals.push({ pid, signal }),
    print: () => {}
  });
  assert.deepEqual(result.gatewayWake, { requested: false, pid: replacement.pid, state: 'running', reason: 'gateway-changed' });
  assert.deepEqual(wakeSignals, []);
});
