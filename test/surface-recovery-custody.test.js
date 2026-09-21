const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { StaleGenerationError, MESSAGE_STATES } = require('../src/state');
const { observeSubmitted } = require('../src/native');
const { createSurfaceConsumer, DiscordGateway } = require('../src/discord');
const { gatewayProcessStatus, pathsFor, requestGatewayRecovery } = require('../src/cli');
const { CODEX_ID, CLI_PATH, fixture, discordMessage, waitForFile, waitForProcessGone, waitForCondition, providers } = require('./surface-fixtures');

test('simulated: status distinguishes matching, stopped, stale, and unknown Gateway owners', async () => {
  const { dir, db, state } = fixture('gateway-status.sqlite');
  state.close();
  const paths = pathsFor({ 'state-dir': dir, db });
  const status = () => gatewayProcessStatus(paths);
  assert.deepEqual(status(), { state: 'stopped', pid: null, connection: 'unavailable', reason: 'pid-file-missing' });

  const preload = path.join(dir, 'status-gateway-preload.cjs');
  const wakeMarker = path.join(dir, 'gateway-wake');
  fs.writeFileSync(preload, `
const fs = require('node:fs');
const target = require.resolve(${JSON.stringify(path.resolve(__dirname, '../src/discord.js'))});
const loaded = require(target);
class FixtureGateway {
  constructor() { this.ready = false; this.transportReady = false; this.timer = setInterval(() => {}, 1000); }
  async start() { this.ready = true; this.transportReady = true; }
  async recoverTransport() {
    const count = fs.existsSync(${JSON.stringify(wakeMarker)}) ? Number(fs.readFileSync(${JSON.stringify(wakeMarker)}, 'utf8')) : 0;
    fs.writeFileSync(${JSON.stringify(wakeMarker)}, String(count + 1));
    if (count === 0) await new Promise(resolve => setTimeout(resolve, 50));
    return { ready: true };
  }
  async reconcilePending() {}
  async stop() { this.ready = false; this.transportReady = false; clearInterval(this.timer); }
}
require.cache[target].exports = { ...loaded, DiscordGateway: FixtureGateway };
`, { mode: 0o600 });
  const matching = spawn(process.execPath, [CLI_PATH, 'run', '--state-dir', dir, '--db', db], {
    env: { ...process.env, NODE_OPTIONS: `--require=${preload}`, DISCORD_SURFACE_LOCK_HELD: '1' },
    stdio: 'ignore'
  });
  try {
    await waitForFile(paths.pid);
    fs.writeFileSync(paths.pid, JSON.stringify({ pid: matching.pid, guildId: 'guild-1', stateDir: dir, db, command: 'run', startedAt: new Date().toISOString() }), { mode: 0o600 });
    const running = status();
    assert.equal(running.state, 'running');
    assert.equal(running.pid, matching.pid);
    assert.equal(running.connection, 'unverified-live');
    const printed = spawnSync(process.execPath, [CLI_PATH, 'status', '--state-dir', dir, '--db', db], { encoding: 'utf8' });
    assert.equal(printed.status, 0, printed.stderr);
    assert.equal(JSON.parse(printed.stdout).gateway.state, 'running');
    assert.equal(fs.existsSync(paths.pid), true);
    fs.writeFileSync(paths.pid, JSON.stringify({
      pid: matching.pid,
      guildId: 'guild-1',
      stateDir: dir,
      db,
      command: 'run',
      startedAt: new Date().toISOString(),
      capabilities: ['ordinary-bind-wake-v1']
    }), { mode: 0o600 });
    assert.deepEqual(requestGatewayRecovery(paths), {
      requested: true,
      pid: matching.pid,
      signal: 'SIGUSR2'
    });
    await waitForCondition(() => fs.existsSync(wakeMarker) && fs.readFileSync(wakeMarker, 'utf8') === '1');
    assert.deepEqual(requestGatewayRecovery(paths), {
      requested: true,
      pid: matching.pid,
      signal: 'SIGUSR2'
    });
    await waitForCondition(() => fs.existsSync(wakeMarker) && fs.readFileSync(wakeMarker, 'utf8') === '2');
    assert.deepEqual(requestGatewayRecovery(paths, { expectedPid: matching.pid + 1 }), {
      requested: false,
      pid: matching.pid,
      state: 'running',
      reason: 'gateway-changed'
    });

    fs.writeFileSync(paths.pid, JSON.stringify({ pid: matching.pid, guildId: 'guild-1', stateDir: dir, db, command: 'run', startedAt: new Date().toISOString() }), { mode: 0o600 });
    assert.deepEqual(requestGatewayRecovery(paths), {
      requested: false,
      pid: matching.pid,
      state: 'running',
      reason: 'gateway-wake-unsupported',
      capability: 'ordinary-bind-wake-v1'
    });
    assert.equal(fs.readFileSync(wakeMarker, 'utf8'), '2');
    assert.doesNotThrow(() => process.kill(matching.pid, 0));
  } finally {
    matching.kill('SIGTERM');
    await waitForProcessGone(matching.pid);
    assert.equal(fs.existsSync(paths.pid), false);
  }

  fs.writeFileSync(paths.pid, JSON.stringify({ pid: matching.pid, guildId: 'guild-1', stateDir: dir, command: 'run', startedAt: new Date().toISOString() }), { mode: 0o600 });
  const stale = status();
  assert.equal(stale.state, 'stale');
  assert.equal(stale.pid, matching.pid);
  assert.equal(stale.connection, 'unavailable');

  const wrong = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', CLI_PATH, 'run', '--state-dir', dir], { stdio: 'ignore' });
  try {
    fs.writeFileSync(paths.pid, JSON.stringify({ pid: wrong.pid, guildId: 'guild-1', stateDir: dir, command: 'run', startedAt: new Date().toISOString() }), { mode: 0o600 });
    assert.deepEqual(status(), { state: 'unknown', pid: wrong.pid, connection: 'unknown', reason: 'pid-owner-mismatch' });
  } finally {
    wrong.kill('SIGTERM');
    await waitForProcessGone(wrong.pid);
  }

  const siblingDir = `${dir}-sibling`;
  const sibling = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', CLI_PATH, 'run', '--state-dir', siblingDir], { stdio: 'ignore' });
  try {
    fs.writeFileSync(paths.pid, JSON.stringify({ pid: sibling.pid, guildId: 'guild-1', stateDir: dir, command: 'run', startedAt: new Date().toISOString() }), { mode: 0o600 });
    assert.deepEqual(status(), { state: 'unknown', pid: sibling.pid, connection: 'unknown', reason: 'pid-owner-mismatch' });
  } finally {
    sibling.kill('SIGTERM');
    await waitForProcessGone(sibling.pid);
  }

  fs.writeFileSync(paths.pid, '{not-json', { mode: 0o600 });
  assert.deepEqual(status(), { state: 'unknown', pid: null, connection: 'unknown', reason: 'pid-file-corrupt' });
  fs.writeFileSync(paths.pid, JSON.stringify({ pid: 'nope', stateDir: dir, command: 'run' }), { mode: 0o600 });
  assert.deepEqual(status(), { state: 'unknown', pid: null, connection: 'unknown', reason: 'pid-file-invalid' });
  fs.unlinkSync(paths.pid);
  fs.unlinkSync(preload);
});

test('simulated: status readiness labels live permission and quota gates as unverified', () => {
  const { dir, state } = fixture();
  const readiness = state.getReadiness();
  assert.equal(readiness.configured, true);
  assert.equal(readiness.limits.permission, 'unverified-live');
  assert.equal(readiness.limits.nativeApproval, 'unverified-live');
  assert.equal(readiness.limits.quota, 'unverified-live');
  assert.equal(readiness.limits.billing, 'unverified-live');
  assert.equal(readiness.limits.connectionBackfill, 'pending');
  state.close();
});

test('simulated: ambiguous network reply failure is unknown and is never retried by the consumer', async () => {
  const { dir, state } = fixture();
  state.bind({ channelId: 'channel-codex', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir });
  let sends = 0;
  const consumer = createSurfaceConsumer({
    state,
    providers: providers({ calls: { codex: 0, claude: 0 } }),
    sendReply: async () => { sends += 1; const error = new Error('connection reset after send'); error.code = 'ECONNRESET'; throw error; }
  });
  const first = await consumer.handleMessage(discordMessage({ id: 'reply-unknown', channelId: 'channel-codex' }));
  const second = await consumer.handleMessage(discordMessage({ id: 'reply-unknown', channelId: 'channel-codex' }));
  assert.equal(first.message.state, MESSAGE_STATES.REPLY_UNKNOWN);
  assert.equal(second.duplicate, true);
  assert.equal(sends, 1);
  state.close();
});

test('simulated: Discord permission denial is definite and preserves reply custody', async () => {
  const { dir, state } = fixture();
  state.bind({ channelId: 'channel-codex', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir });
  const consumer = createSurfaceConsumer({
    state,
    providers: providers({ calls: { codex: 0, claude: 0 } }),
    sendReply: async () => { const error = new Error('missing send permission'); error.status = 403; throw error; }
  });
  const result = await consumer.handleMessage(discordMessage({ id: 'reply-permission', channelId: 'channel-codex' }));
  assert.equal(result.message.state, MESSAGE_STATES.REPLY_FAILED);
  assert.equal(state.getMessage('reply-permission').replyText, '4');
  assert.ok(state.listReceipts().some(receipt => receipt.kind === 'reply-failed'));
  state.close();
});

test('simulated: recovery keeps uncertain dispatch explicit and resumes only reconciled custody', () => {
  const { dir, state } = fixture();
  state.bind({ channelId: 'channel-codex', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir });
  state.acceptDiscordMessage({ id: 'uncertain-recovery', guildId: 'guild-1', channelId: 'channel-codex', authorId: 'operator-1', isBot: false, content: 'x' });
  state.claimDispatch('uncertain-recovery');
  state.recoverAfterRestart();
  assert.equal(state.recoveryCandidates().length, 0);
  assert.equal(state.getMessage('uncertain-recovery').state, MESSAGE_STATES.UNCERTAIN);
  state.reconcileUncertain('uncertain-recovery', 'submitted');
  assert.equal(state.recoveryCandidates()[0].state, MESSAGE_STATES.SUBMITTED);
  assert.ok(state.listReceipts().some(receipt => receipt.kind === 'uncertain-reconciled-submitted'));
  state.close();
});

test('simulated: gateway stop surfaces a native client stop failure and can be retried', async () => {
  const { state } = fixture();
  let destroys = 0;
  const client = {
    on() {},
    off() {},
    async destroy() { destroys += 1; if (destroys === 1) throw new Error('stop failed'); }
  };
  const gateway = new DiscordGateway({ state, client });
  await assert.rejects(() => gateway.stop(), /stop failed/);
  await gateway.stop();
  assert.equal(destroys, 2);
  state.close();
});

test('simulated: native observation holds scan cursor until reply custody commits', async () => {
  const { dir, state } = fixture();
  state.bind({ channelId: 'channel-codex', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir });
  state.acceptDiscordMessage({ id: 'cursor-custody', guildId: 'guild-1', channelId: 'channel-codex', authorId: 'operator-1', isBot: false, content: 'x' });
  state.claimDispatch('cursor-custody');
  state.markSubmitted('cursor-custody');
  const cursor = { file: '/tmp/session.jsonl', offset: 341, since: 1 };
  const result = await observeSubmitted(state, state.getMessage('cursor-custody'), {
    async observe(_message, _outcome, options) {
      options.onCursor(cursor);
      return { text: 'durable answer' };
    }
  });
  assert.equal(result.message.state, MESSAGE_STATES.REPLY_READY);
  assert.deepEqual(state.getMessage('cursor-custody').observerCursor, cursor);

  state.acceptDiscordMessage({ id: 'cursor-crash', guildId: 'guild-1', channelId: 'channel-codex', authorId: 'operator-1', isBot: false, content: 'y' });
  state.claimDispatch('cursor-crash');
  state.markSubmitted('cursor-crash', { file: '/tmp/session.jsonl', offset: 12 }, '[[discord-surface:cursor-crash]]');
  const crashed = await observeSubmitted(state, state.getMessage('cursor-crash'), {
    async observe(_message, _outcome, options) {
      options.onCursor({ file: '/tmp/session.jsonl', offset: 99 });
      throw new Error('observer crashed after scanning');
    }
  });
  assert.equal(crashed.message.state, MESSAGE_STATES.SUBMITTED);
  assert.equal(state.getMessage('cursor-crash').observerCursor.offset, 12);
  state.close();
});

test('simulated: provider identity fences same-UUID native replies', () => {
  const { dir, state } = fixture();
  state.bind({ channelId: 'channel-codex', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir });
  state.bind({ channelId: 'channel-claude', guildId: 'guild-1', provider: 'claude', nativeId: CODEX_ID, workspace: dir, endpoint: path.join(dir, 'claude.sock') });
  state.acceptDiscordMessage({ id: 'provider-fence', guildId: 'guild-1', channelId: 'channel-codex', authorId: 'operator-1', isBot: false, content: 'x' });
  state.claimDispatch('provider-fence');
  state.markSubmitted('provider-fence');
  assert.throws(() => state.recordNativeReply({ provider: 'claude', messageId: 'provider-fence', nativeId: CODEX_ID, generation: 1, text: 'wrong owner' }), StaleGenerationError);
  assert.equal(state.getMessage('provider-fence').state, MESSAGE_STATES.SUBMITTED);
  state.recordNativeReply({ provider: 'codex', messageId: 'provider-fence', nativeId: CODEX_ID, generation: 1, text: 'right owner' });
  assert.equal(state.getMessage('provider-fence').state, MESSAGE_STATES.REPLY_READY);
  state.close();
});
