const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const test = require('node:test');
const { attachOrdinaryListener } = require('../../src/cli');
const { ClaudeChannel } = require('../../src/claude-channel');
const { DiscordGateway } = require('../../src/discord');
const { READINESS, SurfaceState } = require('../../src/state');
const { CLI_PATH, CLAUDE, fixture, waitFor } = require('./fixture.cjs');
const { readinessReceipts } = require('./channel-fixture.cjs');

test('old ordinary Claude Monitor stop cannot revoke a successor generation', async t => {
  const f = fixture(t);
  f.state.close();
  const child = spawn(process.execPath, [CLI_PATH, 'claude-monitor', '--state-dir', f.dir, '--db', f.db, '--native-id', CLAUDE, '--socket', f.socketPath], {
    stdio: ['ignore', 'pipe', 'pipe']
  });
  t.after(async () => {
    if (child.exitCode === null) child.kill('SIGTERM');
  });
  const observed = new SurfaceState(f.db);
  await waitFor(() => fs.existsSync(f.socketPath));
  const before = observed.getBinding(f.binding.channelId);
  assert.equal(before.readiness, READINESS.PENDING);
  const successorState = new SurfaceState(f.db);
  successorState.unbind(f.binding.channelId);
  const successor = successorState.rebindOrdinaryClaude({
    channelId: f.binding.channelId, guildId: 'guild', provider: 'claude', nativeId: CLAUDE, workspace: f.dir, endpoint: f.socketPath
  }, { sessionId: CLAUDE, threadId: CLAUDE, harness: 'claude-code' });
  successorState.close();
  assert.equal(successor.generation, 2);
  assert.equal(successor.readiness, READINESS.PENDING);
  child.kill('SIGTERM');
  await new Promise((resolve, reject) => {
    child.once('close', resolve);
    child.once('error', reject);
  });
  await waitFor(() => observed.getBinding(f.binding.channelId)?.generation === 2);
  assert.equal(observed.getBinding(f.binding.channelId).readiness, READINESS.PENDING);
  observed.close();
});

test('ordinary Claude Monitor startup preserves unrelated recovery-unavailable state', async t => {
  const f = fixture(t);
  f.state.markIntakeBoundary(f.binding.channelId, 'unavailable', 'prior recovery failure', null, null, f.binding);
  f.state.close();
  const child = spawn(process.execPath, [CLI_PATH, 'claude-monitor', '--state-dir', f.dir, '--db', f.db, '--native-id', CLAUDE, '--socket', f.socketPath], {
    stdio: ['ignore', 'pipe', 'pipe']
  });
  t.after(async () => {
    if (child.exitCode === null) child.kill('SIGTERM');
  });
  const observed = new SurfaceState(f.db);
  await waitFor(() => fs.existsSync(f.socketPath));
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(observed.getBinding(f.binding.channelId).readiness, READINESS.UNAVAILABLE);
  assert.equal(observed.getIntakeWatermark(f.binding.channelId).state, READINESS.UNAVAILABLE);
  child.kill('SIGTERM');
  await new Promise((resolve, reject) => {
    child.once('close', resolve);
    child.once('error', reject);
  });
  observed.close();
});

for (const terminalState of [READINESS.UNAVAILABLE, READINESS.GAP]) {
  test(`ordinary Claude channel does not promote an unresolved ${terminalState} intake boundary when Gateway wake fails`, t => {
    const f = fixture(t);
    const detail = `prior ${terminalState} recovery failure`;
    f.state.markIntakeBoundary(f.binding.channelId, terminalState, detail, null, null, f.binding);
    const stderr = [];
    const identity = {
      channelId: f.binding.channelId, guildId: f.binding.guildId, provider: f.binding.provider,
      nativeId: f.binding.nativeId, workspace: f.binding.workspace, endpoint: f.binding.endpoint,
      generation: f.binding.generation
    };
    const wake = attachOrdinaryListener({
      state: f.state,
      paths: { stateDir: f.dir, db: f.db },
      startupBinding: f.binding,
      identity,
      label: 'Claude channel',
      requestRecovery: () => ({ requested: false, reason: 'gateway-not-running' }),
      stderr: { write(chunk) { stderr.push(String(chunk)); } }
    });
    assert.deepEqual(wake, { requested: false, reason: 'gateway-not-running' });
    assert.equal(f.state.getBinding(f.binding.channelId).readiness, terminalState);
    const watermark = f.state.getIntakeWatermark(f.binding.channelId);
    assert.equal(watermark.state, terminalState);
    assert.equal(watermark.detail, detail);
    assert.match(stderr.join(''), /Claude channel startup could not wake Gateway/);
  });
}

test('ordinary Claude channel attach fails when the running Gateway cannot be woken', t => {
  const f = fixture(t);
  // Held intake from an endpoint failure, so the attach reconciles to pending before it learns
  // the wake is unsupported. The throw must not leave that pending behind.
  f.state.markIntakeBoundary(f.binding.channelId, 'unavailable', 'Claude endpoint unavailable before event write: connect ENOENT', null, null, f.binding);
  assert.equal(f.state.getBinding(f.binding.channelId).readiness, READINESS.UNAVAILABLE);
  const identity = {
    channelId: f.binding.channelId, guildId: f.binding.guildId, provider: f.binding.provider,
    nativeId: f.binding.nativeId, workspace: f.binding.workspace, endpoint: f.binding.endpoint,
    generation: f.binding.generation
  };
  assert.throws(() => attachOrdinaryListener({
    state: f.state,
    paths: { stateDir: f.dir, db: f.db },
    startupBinding: f.binding,
    identity,
    label: 'Claude channel',
    requestRecovery: () => ({ requested: false, reason: 'gateway-wake-unsupported', capability: 'ordinary-bind-wake-v1' }),
    stderr: { write() {} }
  }), /Claude channel startup could not wake Gateway \(gateway-wake-unsupported\)/);
  assert.equal(f.state.getBinding(f.binding.channelId).readiness, READINESS.UNAVAILABLE);
  assert.equal(readinessReceipts(f.state, f.binding.channelId).at(-1).detail, 'Claude channel unavailable');
});

test('Claude transport close runs the listener revoke before releasing its socket', async t => {
  const f = fixture(t);
  const events = [];
  const mcp = { notification: async () => {}, close: async () => {} };
  const channel = new ClaudeChannel({
    state: f.state, nativeId: CLAUDE, socketPath: f.socketPath, mcp,
    beforeTransportClose: () => events.push({ phase: 'before', socket: fs.existsSync(f.socketPath) }),
    onTransportClose: () => events.push({ phase: 'after', socket: fs.existsSync(f.socketPath) })
  });
  await channel.start();
  mcp.onclose();
  await waitFor(() => events.length === 2);
  assert.deepEqual(events, [
    { phase: 'before', socket: true },
    { phase: 'after', socket: false }
  ]);
});

test('ordinary Claude Monitor startup reopens an endpoint-unavailable recovery watermark', async t => {
  const f = fixture(t);
  f.state.markIntakeBoundary(f.binding.channelId, 'unavailable', 'Claude endpoint unavailable before event write: connect ENOENT', null, null, f.binding);
  f.state.close();
  const child = spawn(process.execPath, [CLI_PATH, 'claude-monitor', '--state-dir', f.dir, '--db', f.db, '--native-id', CLAUDE, '--socket', f.socketPath], {
    stdio: ['ignore', 'pipe', 'pipe']
  });
  t.after(async () => {
    if (child.exitCode === null) child.kill('SIGTERM');
  });
  const observed = new SurfaceState(f.db);
  await waitFor(() => fs.existsSync(f.socketPath) && observed.getIntakeWatermark(f.binding.channelId)?.state === READINESS.PENDING);
  assert.equal(observed.getBinding(f.binding.channelId).readiness, READINESS.PENDING);
  assert.equal(observed.getIntakeWatermark(f.binding.channelId).state, READINESS.PENDING);
  child.kill('SIGTERM');
  await new Promise((resolve, reject) => {
    child.once('close', resolve);
    child.once('error', reject);
  });
  observed.close();
});

for (const terminalState of [READINESS.UNAVAILABLE, READINESS.GAP]) {
  test(`ordinary Claude recovery restores durable ${terminalState} readiness`, async t => {
    const f = fixture(t);
    const detail = `prior ${terminalState} recovery failure`;
    f.state.markIntakeBoundary(f.binding.channelId, terminalState, detail, null, null, f.binding);
    const gateway = new DiscordGateway({
      state: f.state,
      client: { user: { id: 'bot' }, on() {}, off() {}, async destroy() {} },
      providers: { claude: { async dispatch() { throw new Error('must stay held'); } } }
    });
    const result = await gateway.recoverTransport(`terminal-${terminalState}`, 0);
    assert.deepEqual(result, { ready: false, state: terminalState });
    assert.equal(f.state.getBinding(f.binding.channelId).readiness, terminalState);
    assert.equal(f.state.getIntakeWatermark(f.binding.channelId).state, terminalState);
    assert.equal(f.state.getIntakeWatermark(f.binding.channelId).detail, detail);
    assert.equal(gateway.recoveryPromise, null);
    assert.equal(gateway.recoveryController, null);
    const accepted = f.state.acceptDiscordMessage({
      id: `held-${terminalState}`, guildId: 'guild', channelId: f.binding.channelId,
      authorId: 'operator', isBot: false, content: `hold during ${terminalState}`
    }, { ready: false });
    assert.equal(accepted.accepted, true);
    assert.equal(f.state.claimDispatch(accepted.message.id).reason, 'binding-not-ready');
    await gateway.stop();
  });
}
