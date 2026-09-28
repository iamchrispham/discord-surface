const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { attachOrdinaryListener, detachOrdinaryListener, servedOrdinaryBinding } = require('../../src/cli');
const { READINESS, SurfaceState } = require('../../src/state');
const { CLAUDE, CLI_PATH, fixture, sleep } = require('./fixture.cjs');
const { expectWithin, readinessReceipts, spawnChannel, spawnGateway } = require('./channel-fixture.cjs');

test('ordinary Claude channel startup reopens an endpoint-unavailable watermark, wakes the Gateway, and revokes readiness on stop', async t => {
  const f = fixture(t);
  f.state.markIntakeBoundary(f.binding.channelId, 'unavailable', 'Claude endpoint unavailable before event write: connect ENOENT', null, null, f.binding);
  f.state.close();
  const observed = new SurfaceState(f.db);
  t.after(() => { try { observed.close(); } catch {} });
  const listener = spawnChannel(t, f);
  await expectWithin(() => fs.existsSync(f.socketPath), 'Claude channel socket');
  await expectWithin(() => observed.getIntakeWatermark(f.binding.channelId)?.state === READINESS.PENDING,
    'Claude channel startup reconciling the endpoint-unavailable watermark');
  assert.equal(observed.getBinding(f.binding.channelId).readiness, READINESS.PENDING);
  await expectWithin(() => listener.stderr().includes('could not wake Gateway'),
    'Claude channel startup requesting a Gateway wake');
  assert.match(listener.stderr(), /discord-surface: Claude channel startup could not wake Gateway \(gateway-not-running\)/);

  await listener.terminate();
  assert.equal(observed.getBinding(f.binding.channelId).readiness, READINESS.UNAVAILABLE);
  assert.deepEqual(readinessReceipts(observed, f.binding.channelId).at(-1), {
    channelId: f.binding.channelId, conductorId: null, readiness: READINESS.UNAVAILABLE, detail: 'Claude channel unavailable'
  });
});

test('ordinary Claude channel startup delivers held intake through successful Gateway recovery', async t => {
  const f = fixture(t);
  const messageId = '900401';
  const content = 'deliver through the Claude channel';
  const accepted = f.state.acceptDiscordMessage({
    id: messageId, guildId: 'guild', channelId: f.binding.channelId,
    authorId: 'operator', isBot: false, content, attachments: []
  }, { ready: false });
  assert.equal(accepted.accepted, true);
  assert.equal(f.state.claimDispatch(messageId).reason, 'binding-not-ready');
  f.state.close();

  const gateway = spawnGateway(t, f, { messageId, content });
  await expectWithin(() => fs.existsSync(path.join(f.dir, 'runtime.pid')), 'Gateway runtime pid');
  const listener = spawnChannel(t, f);
  await expectWithin(() => fs.existsSync(f.socketPath), 'Claude channel socket');
  await expectWithin(() => listener.stdout().includes(messageId) && listener.stdout().includes(content), 'held message delivery through Claude channel');
  assert.match(listener.stdout(), new RegExp(messageId));
  assert.match(listener.stdout(), new RegExp(content));
  const observed = new SurfaceState(f.db);
  t.after(() => { try { observed.close(); } catch {} });
  assert.equal(observed.getBinding(f.binding.channelId).readiness, READINESS.READY);
  await listener.terminate();
  await gateway.terminate();
});

test('ordinary Claude channel startup with no held intake still wakes the Gateway and revokes readiness on stop', async t => {
  const f = fixture(t);
  const initialWatermark = f.state.getIntakeWatermark(f.binding.channelId);
  f.state.close();
  const observed = new SurfaceState(f.db);
  t.after(() => { try { observed.close(); } catch {} });
  const listener = spawnChannel(t, f);
  await expectWithin(() => fs.existsSync(f.socketPath), 'Claude channel socket');
  await expectWithin(() => listener.stderr().includes('could not wake Gateway'),
    'Claude channel startup requesting a Gateway wake');
  assert.match(listener.stderr(), /discord-surface: Claude channel startup could not wake Gateway \(gateway-not-running\)/);
  assert.deepEqual(observed.getIntakeWatermark(f.binding.channelId), initialWatermark);

  await listener.terminate();
  assert.equal(observed.getBinding(f.binding.channelId).readiness, READINESS.UNAVAILABLE);
  assert.equal(readinessReceipts(observed, f.binding.channelId).at(-1).detail, 'Claude channel unavailable');
});

test('Claude channel leaves a conductor binding untouched on start and stop', async t => {
  const f = fixture(t, { bind: false });
  const conductor = f.state.bind({
    channelId: 'claude-channel', guildId: 'guild', provider: 'claude', nativeId: CLAUDE,
    workspace: f.dir, endpoint: f.socketPath, conductorId: 'conductor-1', repoKey: 'repo-1'
  }, { intakeCutoff: '100' });
  assert.equal(f.state.isOrdinaryBinding(conductor), false);
  f.state.setBindingReadiness(conductor.channelId, READINESS.READY, 'conductor ready', conductor);
  const initialWatermark = f.state.getIntakeWatermark(conductor.channelId);
  f.state.close();
  const observed = new SurfaceState(f.db);
  t.after(() => { try { observed.close(); } catch {} });
  const before = readinessReceipts(observed, conductor.channelId).length;
  const listener = spawnChannel(t, f);
  await expectWithin(() => fs.existsSync(f.socketPath), 'Claude channel socket');
  await sleep(50);
  assert.equal(observed.getBinding(conductor.channelId).readiness, READINESS.READY);
  assert.equal(listener.stderr().includes('could not wake Gateway (gateway-not-running)'), true);
  assert.deepEqual(observed.getIntakeWatermark(conductor.channelId), initialWatermark);

  await listener.terminate();
  assert.equal(observed.getBinding(conductor.channelId).readiness, READINESS.READY);
  assert.equal(readinessReceipts(observed, conductor.channelId).length, before);
});

test('an ordinary listener refuses to attach when its binding changed during startup', t => {
  const f = fixture(t);
  const identity = {
    channelId: f.binding.channelId, guildId: 'guild', provider: 'claude', nativeId: CLAUDE,
    workspace: f.dir, endpoint: f.socketPath, generation: f.binding.generation
  };
  const startupBinding = servedOrdinaryBinding(f.state, identity);
  assert.ok(startupBinding);
  f.state.unbind(f.binding.channelId);
  f.state.rebindOrdinaryClaude({
    channelId: f.binding.channelId, guildId: 'guild', provider: 'claude', nativeId: CLAUDE, workspace: f.dir, endpoint: f.socketPath
  }, { sessionId: CLAUDE, threadId: CLAUDE, harness: 'claude-code' });
  for (const label of ['Claude channel', 'Claude Monitor']) {
    assert.throws(() => attachOrdinaryListener({
      state: f.state, paths: { stateDir: f.dir, db: f.db }, startupBinding, identity, label,
      requestRecovery: () => { throw new Error('must not wake the Gateway for a changed binding'); },
      stderr: { write() { throw new Error('must not report a wake for a changed binding'); } }
    }), new RegExp(`^Error: ${label} binding changed during startup$`));
  }
  assert.equal(detachOrdinaryListener({ state: f.state, startupBinding, reason: 'Claude channel unavailable' }), false);
  assert.equal(f.state.getBinding(f.binding.channelId).readiness, READINESS.PENDING);
});

test('every CLI listener that serves a Claude binding routes through the ordinary lifecycle owner', () => {
  const source = fs.readFileSync(CLI_PATH, 'utf8');
  const commands = [...source.matchAll(/case '([a-z-]+)': return (\w+)\(args\)/g)].map(match => ({ command: match[1], fn: match[2] }));
  assert.ok(commands.length > 10, 'CLI command table must be readable');
  const constructions = /new ClaudeChannel\(|createClaudeMonitor\(/g;
  const listeners = [];
  let claimed = 0;
  for (const { command, fn } of commands) {
    const start = ['async function', 'function']
      .map(keyword => source.indexOf(`\n${keyword} ${fn}(args`))
      .find(index => index >= 0);
    if (start === undefined) continue;
    const body = source.slice(start, source.indexOf('\n}\n', start));
    const found = body.match(constructions)?.length || 0;
    if (!found) continue;
    claimed += found;
    listeners.push(command);
    assert.match(body, /attachOrdinaryListener\(/, `${command} must attach through the ordinary lifecycle owner`);
    assert.match(body, /detachOrdinaryListener\(/, `${command} must detach through the ordinary lifecycle owner`);
    if (command === 'claude-channel') assert.match(body, /beforeTransportClose: detach/, `${command} must revoke before transport close releases its socket`);
  }
  assert.deepEqual(listeners.sort(), ['claude-channel', 'claude-monitor']);
  // A listener built anywhere but a command function would escape the check above.
  assert.equal(claimed, source.match(constructions)?.length || 0, 'every listener must be built by a CLI command function');
});
