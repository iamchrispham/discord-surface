'use strict';

// issue108 regression fixtures: public startup / recovery isolation.
//
// R1-R4 cover mixed/all-held startup and active/between-page deadlines. The
// controls pin reconnect, true page/message bounds, and startup stop/failure.
// Production src/ and dist/ are read-only; behavior runs through public entrypoints.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { SurfaceState } = require('../src/state');
const { fixture } = require('./helpers/intake-recovery-fixture');
const { recoverThread } = require('../src/discord/thread-enrollment');
const { waitForRecoveryOperation } = require('../src/discord');

const CASES = { timeout: 8000 };
const LEGACY_TIMEOUT_DETAIL = 'ordinary-bind recovery exceeded 30000ms';

function deferred() {
  let resolve;
  const promise = new Promise(finish => { resolve = finish; });
  return { promise, resolve };
}

function operatorMessage(f, id, channelId) {
  return { ...f.message(id, channelId), authorId: 'operator', isBot: false, attachments: [] };
}

// Bind a second public route and hold it on an explicit gap. The helper's
// boundary()/cursor() accessors only understand channel 1000 and the enrolled
// thread 2000, so the second channel is read with state.getIntakeWatermark().
function addHeldRoute(f) {
  const base = f.state.getBinding('1000');
  f.state.bind({ channelId: '3000', guildId: 'guild', provider: 'codex',
    nativeId: '33333333-3333-4333-8333-333333333333', workspace: base.workspace });
  f.state.setIntakeBaseline('3000', '100', 'fixture');
  f.state.markIntakeBoundary('3000', 'ready');
  f.channels.set('3000', { ...f.channels.get('1000'), id: '3000' });
  f.history.set('3000', []);
}

// Healthy route 1000 carrying accepted custody 101 plus real history, alongside
// route 3000 held on a genuine gap with accepted custody 102.
function prepareMixedFixture(f) {
  addHeldRoute(f);
  f.state.markIntakeBoundary('3000', 'gap', 'explicit uncovered history', '101', '102');
  assert.equal(f.state.acceptDiscordMessage(operatorMessage(f, '102', '3000'), { ready: false }).accepted, true);
  assert.equal(f.state.acceptDiscordMessage(operatorMessage(f, '101', '1000')).accepted, true);
  f.history.set('1000', [f.message('101', '1000')]);
}

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

test('R1: mixed healthy/gap public startup connects and dispatches only the healthy row', CASES, async t => {
    const f = fixture(t);
    prepareMixedFixture(f);
    f.enableDelivery();

    await f.gateway.start(f.secret);
    assert.equal(f.gateway.started, true);
    assert.equal(f.gateway.transportReady, true);
    assert.equal(f.gateway.ready, true);

    await f.gateway.reconcilePending(undefined, { readyOnly: true });
    await f.gateway.consumer.waitForNativeWork();

    assert.equal(f.state.getMessage('101').state, 'replied');
    assert.equal(f.dispatched.filter(message => message.id === '101').length, 1);
    assert.equal(f.dispatched.length, 1, 'only the healthy route may dispatch');
    assert.equal(f.boundary('1000').state, 'ready');
    const held = f.state.getIntakeWatermark('3000');
    assert.equal(held.state, 'gap');
    assert.equal(held.gap_to, '102');
    assert.equal(f.state.getMessage('102').state, 'accepted');
  });

test('G1: reconnect serves the healthy row once and preserves the held route', CASES, async t => {
  const f = fixture(t);
  prepareMixedFixture(f);
  f.enableDelivery();

  const result = await f.gateway.beginReconnectRecovery('fixture');
  assert.equal(result.ready, false);
  assert.equal(result.state, 'gap');
  await f.gateway.reconcilePending(undefined, { readyOnly: true });
  await f.gateway.consumer.waitForNativeWork();

  assert.equal(f.dispatched.filter(message => message.id === '101').length, 1);
  assert.equal(f.dispatched.length, 1, 'the held route must not dispatch');
  assert.equal(f.boundary('1000').state, 'ready');
  const held = f.state.getIntakeWatermark('3000');
  assert.equal(held.state, 'gap');
  assert.equal(held.gap_to, '102');
  assert.equal(f.state.getMessage('102').state, 'accepted');
});

test('R2: all-held public startup connects without a ready route', CASES, async t => {
    const f = fixture(t);
    f.state.markIntakeBoundary('1000', 'gap', 'explicit uncovered history', '101', '102');
    assert.equal(f.state.acceptDiscordMessage(operatorMessage(f, '101', '1000'), { ready: false }).accepted, true);
    f.enableDelivery();

    await f.gateway.start(f.secret);
    assert.equal(f.gateway.started, true);
    assert.equal(f.gateway.transportReady, true);
    assert.equal(f.gateway.ready, false);
    await f.gateway.reconcilePending(new Date().toISOString(), { allowPaused: true, readyOnly: true });
    assert.equal(f.dispatched.length, 0);
    assert.equal(f.state.getMessage('101').state, 'accepted');
    assert.equal(f.boundary('1000').state, 'gap');
    assert.equal(f.boundary('1000').gap_to, '102');
  });

test('R3: active history deadline stays retryable and a later pass recovers custody', CASES, async t => {
    const f = fixture(t);
    assert.equal(f.state.acceptDiscordMessage(operatorMessage(f, '101', '1000')).accepted, true);
    f.history.set('1000', [f.message('101', '1000')]);
    const realFetchHistory = f.gateway.fetchHistory;
    const realTimeoutMs = f.gateway.recoveryTimeoutMs;
    f.gateway.recoveryTimeoutMs = 30;
    f.gateway.fetchHistory = () => new Promise(() => {});

    let held;
    try {
      const first = await f.gateway.recoverTransport('ordinary-bind');
      assert.equal(first.ready, false);
      assert.equal(f.state.getMessage('101').state, 'accepted');
      held = f.boundary('1000');
    } finally {
      f.gateway.fetchHistory = realFetchHistory;
      f.gateway.recoveryTimeoutMs = realTimeoutMs;
    }

    // The failed hold assertion comes BEFORE the second invocation on purpose.
    assert.equal(held.state, 'unavailable');
    assert.match(held.detail, /^Discord recovery deadline: /);

    const recovered = await f.gateway.recoverTransport('startup');
    assert.equal(recovered.ready, true, JSON.stringify(recovered));
    assert.equal(f.boundary('1000').state, 'ready');
    f.enableDelivery();
    await f.gateway.reconcilePending();
    await f.gateway.consumer.waitForNativeWork();
    assert.equal(f.state.getMessage('101').state, 'replied');
    assert.equal(f.dispatched.filter(message => message.id === '101').length, 1);
  });

test('R4: deadline between full pages stays retryable after one real admission', CASES, async t => {
    const f = fixture(t);
    f.history.set('1000', [f.message('101', '1000')]);
    const realNow = Date.now;
    const realIntake = f.gateway.consumer.intakeMessage;
    let advanced = false;
    f.gateway.consumer.intakeMessage = async function (...args) {
      const result = await realIntake.apply(f.gateway.consumer, args);
      if (!advanced && args[0]?.id === '101') {
        advanced = true;
        Date.now = () => realNow() + 120000;
      }
      return result;
    };

    let result;
    try {
      result = await f.recover();
    } finally {
      Date.now = realNow;
      f.gateway.consumer.intakeMessage = realIntake;
    }

    assert.equal(result.ready, false);
    assert.equal(advanced, true, 'fixture must admit one real custody row before the deadline');
    assert.equal(f.state.getMessage('101').state, 'accepted');
    assert.equal(f.cursor('1000'), '101');
    const boundary = f.boundary('1000');
    assert.equal(boundary.state, 'unavailable');
    assert.match(boundary.detail, /^Discord recovery deadline: /);
    assert.doesNotMatch(String(boundary.detail || ''), /history (page|message) bound/);
    assert.equal(f.dispatched.length, 0);

    const recovered = await f.gateway.recoverTransport('startup');
    assert.equal(recovered.ready, true, JSON.stringify(recovered));
    assert.equal(f.boundary('1000').state, 'ready');
    f.enableDelivery();
    await f.gateway.reconcilePending();
    await f.gateway.consumer.waitForNativeWork();
    assert.equal(f.state.getMessage('101').state, 'replied');
    assert.equal(f.dispatched.filter(message => message.id === '101').length, 1);
  });

for (const adopted of [true, false]) {
  test(`R5: ${adopted ? 'adopted' : 'pre-adoption'} child deadline after fetch attempt is retryable`, CASES, async t => {
    const f = fixture(t, { adoptThread: adopted });
    const message = operatorMessage(f, '101', '2000');
    f.history.set('2000', [f.message('101', '2000')]);
    if (adopted) assert.equal(f.state.acceptDiscordMessage(message).accepted, true);

    const originalFetch = f.gateway.client.channels.fetch;
    f.gateway.client.channels.fetch = id => id === '2000'
      ? new Promise(() => {})
      : originalFetch.call(f.gateway.client.channels, id);
    try {
      const first = await recoverThread(f.gateway, f.boundary('2000'), new AbortController().signal,
        f.gateway.lifecycleEpoch, waitForRecoveryOperation, false, Date.now() + 50);
      assert.equal(first, false);
    } finally {
      f.gateway.client.channels.fetch = originalFetch;
    }

    const held = f.boundary('2000');
    assert.equal(held.state, 'unavailable');
    assert.match(held.detail, /^Discord recovery deadline: /);
    assert.equal(f.dispatched.length, 0);

    const recovered = await f.gateway.recoverTransport('restart');
    assert.equal(recovered.ready, true, JSON.stringify(recovered));
    assert.equal(f.boundary('2000').state, 'ready');
    if (adopted) {
      f.enableDelivery();
      await f.gateway.reconcilePending(undefined, { readyOnly: true });
      await f.gateway.consumer.waitForNativeWork();
      assert.equal(f.state.getMessage('101').state, 'replied');
      assert.equal(f.dispatched.filter(item => item.id === '101').length, 1);
    } else {
      assert.equal(f.dispatched.length, 0);
    }
  });
}

test('R6: child deadline before first fetch keeps the existing pending boundary', CASES, async t => {
  const f = fixture(t, { adoptThread: false });
  const callsBefore = f.calls.length;
  const result = await recoverThread(f.gateway, f.boundary('2000'), new AbortController().signal,
    f.gateway.lifecycleEpoch, waitForRecoveryOperation, false, Date.now() - 1);

  assert.equal(result, false);
  assert.equal(f.boundary('2000').state, 'pending');
  assert.equal(f.boundary('2000').detail, 'Thread history recovery pending before first fetch');
  assert.equal(f.calls.length, callsBefore);
});

test('R7: old timeout gap with a confirmed cursor retries after database reopen', CASES, async t => {
  const f = fixture(t);
  const owner = f.state.getBinding('1000');
  f.state.markIntakeBoundary('1000', 'gap', LEGACY_TIMEOUT_DETAIL, null, null, owner);
  assert.equal(f.state.getIntakeWatermark('1000').recovered_through_id, '100');
  assert.equal(f.state.acceptDiscordMessage(operatorMessage(f, '101', '1000'), { ready: false }).accepted, true);
  f.history.set('1000', [f.message('101', '1000')]);
  await f.reopen();

  const reopenedOwner = f.state.getBinding('1000');
  assert.deepEqual(
    [reopenedOwner.provider, reopenedOwner.nativeId, reopenedOwner.generation],
    [owner.provider, owner.nativeId, owner.generation]
  );
  f.enableDelivery();
  const result = await f.recover();
  assert.equal(result.ready, true, JSON.stringify(result));
  assert.equal(f.boundary('1000').state, 'ready');
  await f.gateway.reconcilePending(undefined, { readyOnly: true });
  await f.gateway.consumer.waitForNativeWork();
  assert.equal(f.state.getMessage('101').state, 'replied');
  assert.equal(f.dispatched.filter(message => message.id === '101').length, 1);
  assert.equal(f.dispatched[0].generation, owner.generation);
});

const LEGACY_NEGATIVE_CONTROLS = [
  { name: 'page-bound detail', detail: 'history page bound 100 reached', gapFrom: '100', gapTo: '101' },
  { name: 'near-match timeout detail', detail: 'ordinary-bind recovery exceeded 30001ms', gapFrom: null, gapTo: null },
  { name: 'legacy detail with coverage bounds', detail: LEGACY_TIMEOUT_DETAIL, gapFrom: '100', gapTo: '101' },
  { name: 'legacy detail without a confirmed cursor', detail: LEGACY_TIMEOUT_DETAIL, gapFrom: null, gapTo: null, clearCursor: true }
];

for (const control of LEGACY_NEGATIVE_CONTROLS) {
  test(`G6: ${control.name} stays held without history fetch or dispatch`, CASES, async t => {
    const f = fixture(t);
    const owner = f.state.getBinding('1000');
    if (control.clearCursor) {
      f.state.db.prepare('UPDATE intake_watermarks SET recovered_through_id=NULL WHERE channel_id=?').run('1000');
    }
    f.state.markIntakeBoundary('1000', 'gap', control.detail, control.gapFrom, control.gapTo, owner);
    assert.equal(f.state.acceptDiscordMessage(operatorMessage(f, '101', '1000'), { ready: false }).accepted, true);
    f.history.set('1000', [f.message('101', '1000')]);
    f.enableDelivery();
    await f.reopen();

    const result = await f.recover();
    assert.equal(result.ready, false);
    assert.equal(result.state, 'gap');
    assert.equal(f.boundary('1000').state, 'gap');
    assert.equal(f.boundary('1000').detail, control.detail);
    assert.equal(f.calls.filter(call => call.kind === 'history' && call.id === '1000').length, 0);
    assert.equal(f.dispatched.length, 0);
    assert.equal(f.state.getMessage('101').state, 'accepted');
  });
}

test('deadline policy inventory has no direct deadline-to-gap decision outside its classifier', () => {
  const sourceRoot = path.join(__dirname, '../src');
  const files = ['discord.js', 'discord/thread-enrollment.ts'];
  const offenders = [];
  for (const relative of files) {
    const lines = fs.readFileSync(path.join(sourceRoot, relative), 'utf8').split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      if (!/\b(?:DEADLINE|deadlineReached)\b/.test(lines[index])) continue;
      const window = lines.slice(index, index + 4).join('\n');
      if (/\b(?:READINESS\.GAP|THREAD_STATES\.GAP)\b|\?\s*['"]gap['"]/.test(window)) {
        offenders.push(`${relative}:${index + 1}`);
      }
    }
  }
  assert.deepEqual(offenders, [], 'new deadline decisions must use the shared recovery classifier');
});

test('G2: page-bound exhaustion still records a gap', CASES, async t => {
  const f = fixture(t);
  f.gateway.historyMaxPages = 1;
  f.history.set('1000', [f.message('101', '1000'), f.message('102', '1000')]);

  const result = await f.recover();
  assert.equal(result.ready, false);
  assert.equal(result.state, 'gap');
  const boundary = f.boundary('1000');
  assert.equal(boundary.state, 'gap');
  assert.match(boundary.detail, /history page bound 1 reached/);
  assert.equal(f.cursor('1000'), '101');
  assert.equal(f.state.getMessage('101').state, 'accepted');
});

test('G3: stop during login leaves no started gateway, dispatch or lost custody', CASES, async t => {
  const f = fixture(t);
  assert.equal(f.state.acceptDiscordMessage(operatorMessage(f, '101', '1000')).accepted, true);
  const entered = deferred();
  const release = deferred();
  f.gateway.client.login = async () => { entered.resolve(); await release.promise; };

  const outcome = f.gateway.start(f.secret);
  await entered.promise;
  await f.gateway.stop();
  release.resolve();
  await assert.rejects(outcome, /Discord startup was stopped during login/);

  assert.equal(f.gateway.started, false);
  assert.equal(f.gateway.transportReady, false);
  assert.equal(f.dispatched.length, 0);
  assert.equal(f.state.getMessage('101').state, 'accepted');
});

test('G4: stop during recovery fences a late channel fetch', CASES, async t => {
  const f = fixture(t);
  assert.equal(f.state.acceptDiscordMessage(operatorMessage(f, '101', '1000')).accepted, true);
  const entered = deferred();
  const release = deferred();
  const fetchChannel = f.gateway.client.channels.fetch.bind(f.gateway.client.channels);
  f.gateway.client.channels.fetch = async id => {
    entered.resolve();
    await release.promise;
    return fetchChannel(id);
  };

  const outcome = f.gateway.start(f.secret);
  await entered.promise;
  await f.gateway.stop();
  release.resolve();
  await assert.rejects(outcome, /Discord startup was stopped during recovery/);

  assert.equal(f.gateway.started, false);
  assert.equal(f.gateway.transportReady, false);
  assert.equal(f.dispatched.length, 0);
  assert.equal(f.state.getMessage('101').state, 'accepted');
});

test('G5: login failure leaves no started gateway, dispatch or lost custody', CASES, async t => {
  const f = fixture(t);
  assert.equal(f.state.acceptDiscordMessage(operatorMessage(f, '101', '1000')).accepted, true);
  f.gateway.client.login = async () => { throw new Error('fixture login refused'); };

  await assert.rejects(f.gateway.start(f.secret), /fixture login refused/);

  assert.equal(f.gateway.started, false);
  assert.equal(f.gateway.transportReady, false);
  assert.equal(f.dispatched.length, 0);
  assert.equal(f.state.getMessage('101').state, 'accepted');
});
