'use strict';

// CLI startup behavior through a disposable child process and real SQLite state.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { SurfaceState } = require('../src/state');

async function runCliStartup(mode, t) {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'intake-cli-startup-'));
  const stateDir = path.join(fixtureDir, 'state');
  const db = path.join(stateDir, 'surface.sqlite');
  const secretFile = path.join(fixtureDir, 'discord.env');
  const preload = path.join(fixtureDir, 'startup-preload.cjs');
  const eventFile = path.join(fixtureDir, 'events.ndjson');
  const repoRoot = path.resolve(__dirname, '..');
  const cliPath = path.join(repoRoot, 'src/cli.js');
  let child = null;
  const events = () => fs.existsSync(eventFile)
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
  const waitForExit = processRef => {
    if (!processRef || processRef.exitCode !== null || processRef.signalCode !== null) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`child process ${processRef.pid} did not exit during cleanup`)), 5000);
      processRef.once('error', error => { clearTimeout(timer); reject(error); });
      processRef.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  };

  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(secretFile, 'DISCORD_TOKEN=fixture-token\n', { mode: 0o600 });
  fs.writeFileSync(eventFile, '', { mode: 0o600 });
  const state = new SurfaceState(db);
  state.setConfig({ operatorId: 'operator', guildId: 'guild', secretFile });
  if (mode === 'mixed') {
    state.bind({ channelId: '1000', guildId: 'guild', provider: 'codex',
      nativeId: '11111111-1111-1111-1111-111111111111', workspace: fixtureDir });
    state.setIntakeBaseline('1000', '100', 'fixture');
    state.markIntakeBoundary('1000', 'ready');
  }
  state.bind({ channelId: '3000', guildId: 'guild', provider: 'codex',
    nativeId: '33333333-3333-4333-8333-333333333333', workspace: fixtureDir });
  state.setIntakeBaseline('3000', '100', 'fixture');
  state.markIntakeBoundary('3000', 'gap', 'explicit uncovered history', '101', '102');
  assert.equal(state.acceptDiscordMessage({ id: '102', guildId: 'guild', channelId: '3000',
    authorId: 'operator', isBot: false, content: 'held startup input', attachments: [] }, { ready: false }).accepted, true);
  state.close();

  const preloadSource = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const Module = require('node:module');
const eventsPath = __EVENTS__;
function record(value) { fs.appendFileSync(eventsPath, JSON.stringify(value) + '\n', { mode: 0o600 }); }
class FixtureClient extends EventEmitter {
  constructor() {
    super();
    this.user = { id: 'fixture-bot' };
    this.channels = { fetch: async channelId => { record({ phase: 'channel-fetch', channelId }); return { id: channelId }; } };
  }
  async destroy() { record({ phase: 'client-destroy' }); }
}
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'discord.js') return { Client: FixtureClient, GatewayIntentBits: { Guilds: 1, GuildMessages: 2, MessageContent: 4 } };
  return originalLoad.apply(this, arguments);
};
const discordPath = path.join(process.env.DISCORD_SURFACE_ROOT, 'src', 'discord.js');
const { DiscordGateway } = require(discordPath);
DiscordGateway.prototype.start = async function() {
  this.ready = process.env.DISCORD_SURFACE_START_READY === '1';
  this.transportReady = true;
  this.started = true;
  record({ phase: 'gateway-started', ready: this.ready, transportReady: this.transportReady });
};
const originalReconcile = DiscordGateway.prototype.reconcilePending;
DiscordGateway.prototype.reconcilePending = async function(...args) {
  record({ phase: 'reconcile-call', options: args[1] || null });
  const result = await originalReconcile.apply(this, args);
  record({ phase: 'reconcile-finished', candidates: result.length });
  return result;
};
const originalStop = DiscordGateway.prototype.stop;
DiscordGateway.prototype.stop = async function(...args) {
  const result = await originalStop.apply(this, args);
  record({ phase: 'gateway-stopped' });
  return result;
};
setInterval(() => {}, 1000);
setTimeout(() => process.exit(99), 15000);
`.replace('__EVENTS__', JSON.stringify(eventFile));
  fs.writeFileSync(preload, preloadSource, { mode: 0o600 });

  t.after(async () => {
    const cleanupErrors = [];
    if (child && child.exitCode === null && child.signalCode === null) {
      try { child.kill('SIGTERM'); } catch (error) { cleanupErrors.push(error); }
    }
    try { await waitForExit(child); }
    catch (error) {
      cleanupErrors.push(error);
      if (child && child.exitCode === null && child.signalCode === null) {
        try { child.kill('SIGKILL'); } catch (killError) { cleanupErrors.push(killError); }
        try { await waitForExit(child); } catch (forcedError) { cleanupErrors.push(forcedError); }
      }
    }
    try { fs.rmSync(fixtureDir, { recursive: true, force: true }); }
    catch (error) { cleanupErrors.push(error); }
    if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'CLI startup fixture cleanup failed');
  });

  child = spawn(process.execPath, [cliPath, 'run', '--state-dir', stateDir, '--db', db], {
    cwd: repoRoot,
    env: { ...process.env, NODE_OPTIONS: `--require=${preload}`, DISCORD_SURFACE_ROOT: repoRoot,
      DISCORD_SURFACE_START_READY: mode === 'mixed' ? '1' : '0', DISCORD_SURFACE_LOCK_HELD: '1' },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += chunk; });
  await waitFor(() => events().some(event => event.phase === 'reconcile-finished') ||
    child.exitCode !== null || stderr.includes('Discord gateway is not ready for recovery'),
    `${mode} CLI startup reconciliation`);
  assert.ok(events().some(event => event.phase === 'reconcile-finished'),
    `${mode} CLI did not finish startup reconciliation: ${stderr}`);
  const reconcile = events().find(event => event.phase === 'reconcile-call');
  assert.equal(events().some(event => event.phase === 'channel-fetch'), false,
    `${mode} startup reconciliation must not fetch the held route`);
  assert.deepEqual(reconcile?.options, { allowPaused: true, readyOnly: true });
  const persisted = new SurfaceState(db);
  try {
    assert.equal(persisted.getMessage('102').state, 'accepted');
    assert.equal(persisted.getIntakeWatermark('3000').state, 'gap');
  } finally { persisted.close(); }
}

test('R2 CLI: all-held runtime completes startup reconciliation without losing custody', async t => {
  await runCliStartup('all-held', t);
});

test('R2 CLI: mixed runtime reconciles only ready routes', async t => {
  await runCliStartup('mixed', t);
});
