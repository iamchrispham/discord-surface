const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const installed = path.resolve(__dirname, '..');
const test = require('node:test');
const { SurfaceState } = require(path.join(installed, 'src/state'));
const { DiscordGateway } = require(path.join(installed, 'src/discord'));
const { createBindingWakeController } = require(path.join(installed, 'src/cli'));
const { validateCodexSessionIdentityAsync } = require(path.join(installed, 'src/native'));
const { NATIVE_PROOF_PHASES, nativeProofDeadlineDetail } = require(path.join(installed, 'src/discord/native-proof-recovery'));

function boundedRetryFixture(t, nativeId) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-proof-bounded-retry-'));
  const root = path.join(dir, 'sessions');
  const db = path.join(dir, 'surface.sqlite');
  const secret = path.join(dir, 'discord.env');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, `${nativeId}.jsonl`), JSON.stringify({
    type: 'session_meta', payload: { id: nativeId, cwd: dir }
  }) + '\n');
  fs.writeFileSync(secret, 'DISCORD_TOKEN=fixture-token\n', { mode: 0o600 });
  const state = new SurfaceState(db);
  state.setConfig({ operatorId: 'operator', guildId: 'guild', secretFile: secret });
  const binding = state.bindOrdinary({ channelId: '1000', guildId: 'guild', provider: 'codex', nativeId, workspace: dir },
    { sessionId: nativeId, threadId: nativeId });
  state.setIntakeBaseline('1000', '100', 'fixture baseline');
  let failProof = false;
  let preflights = 0;
  const channel = { id: '1000', guildId: 'guild', topic: null, permissionsFor: () => ({ has: () => true }) };
  const gateway = new DiscordGateway({
    state,
    client: {
      user: { id: 'bot' },
      channels: { fetch: async () => channel },
      application: { commands: { async fetch() { return []; }, async create() {} } },
      async login() {}, on() {}, off() {}, async destroy() {}
    },
    fetchHistory: async () => [],
    providers: { codex: { async dispatch() { throw new Error('bounded retry fixture must not dispatch'); } } },
    recoveryOptions: {
      codexSessionRoot: root,
      ordinaryNativePreflight: async (current, options) => {
        preflights += 1;
        const proofOptions = failProof ? { ...options, deadline: Date.now() - 1 } : options;
        return validateCodexSessionIdentityAsync(current.nativeId, current.workspace, root, proofOptions);
      }
    }
  });
  t.after(async () => {
    await gateway.stop();
    state.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return {
    state,
    gateway,
    binding,
    secret,
    setFailProof(value) { failProof = value; },
    get preflights() { return preflights; }
  };
}

test('startup schedules a retry for a native proof deadline marker', { timeout: 5000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-proof-startup-retry-'));
  const root = path.join(dir, 'sessions');
  const db = path.join(dir, 'surface.sqlite');
  const secret = path.join(dir, 'discord.env');
  const nativeId = '22222222-2222-4222-8222-222222222222';
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, `${nativeId}.jsonl`), JSON.stringify({
    type: 'session_meta', payload: { id: nativeId, cwd: dir }
  }) + '\n');
  fs.writeFileSync(secret, 'DISCORD_TOKEN=fixture-token\n', { mode: 0o600 });
  const state = new SurfaceState(db);
  state.setConfig({ operatorId: 'operator', guildId: 'guild', secretFile: secret });
  state.bindOrdinary({ channelId: '1000', guildId: 'guild', provider: 'codex', nativeId, workspace: dir },
    { sessionId: nativeId, threadId: nativeId });
  state.setIntakeBaseline('1000', '100', 'fixture baseline');
  let preflights = 0;
  const channel = {
    id: '1000', guildId: 'guild', topic: null,
    permissionsFor: () => ({ has: () => true })
  };
  const gateway = new DiscordGateway({
    state,
    client: {
      user: { id: 'bot' },
      channels: { fetch: async () => channel },
      application: { commands: { async fetch() { return []; }, async create() {} } },
      async login() {}, on() {}, off() {}, async destroy() {}
    },
    fetchHistory: async () => [],
    providers: { codex: { async dispatch() { throw new Error('startup retry fixture must not dispatch'); } } },
    recoveryOptions: {
      codexSessionRoot: root,
      ordinaryNativePreflight: async (binding, options) => {
        preflights += 1;
        const deadline = preflights === 1 ? Date.now() - 1 : Date.now() + 1000;
        return validateCodexSessionIdentityAsync(binding.nativeId, binding.workspace, root, { ...options, deadline });
      }
    }
  });
  t.after(async () => {
    await gateway.stop();
    state.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await gateway.start(secret);
  assert.equal(gateway.started, true);
  assert.equal(state.getIntakeWatermark('1000').state, 'unavailable');
  const waitDeadline = Date.now() + 3000;
  while (state.getIntakeWatermark('1000').state !== 'ready') {
    if (Date.now() >= waitDeadline) throw new Error('startup native proof retry did not recover');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(preflights, 2);
});

test('scheduled native proof deadline requeues until proof succeeds', { timeout: 5000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-proof-deferred-retry-'));
  const root = path.join(dir, 'sessions');
  const db = path.join(dir, 'surface.sqlite');
  const secret = path.join(dir, 'discord.env');
  const nativeId = '33333333-3333-4333-8333-333333333333';
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, `${nativeId}.jsonl`), JSON.stringify({
    type: 'session_meta', payload: { id: nativeId, cwd: dir }
  }) + '\n');
  fs.writeFileSync(secret, 'DISCORD_TOKEN=fixture-token\n', { mode: 0o600 });
  const state = new SurfaceState(db);
  state.setConfig({ operatorId: 'operator', guildId: 'guild', secretFile: secret });
  const binding = state.bindOrdinary({ channelId: '1000', guildId: 'guild', provider: 'codex', nativeId, workspace: dir },
    { sessionId: nativeId, threadId: nativeId });
  state.setIntakeBaseline('1000', '100', 'fixture baseline');
  state.markIntakeBoundary('1000', 'unavailable',
    nativeProofDeadlineDetail(NATIVE_PROOF_PHASES.PREFLIGHT, Date.now() - 1), null, null, binding);
  let preflights = 0;
  const channel = { id: '1000', guildId: 'guild', topic: null, permissionsFor: () => ({ has: () => true }) };
  const gateway = new DiscordGateway({
    state,
    client: {
      user: { id: 'bot' },
      channels: { fetch: async () => channel },
      application: { commands: { async fetch() { return []; }, async create() {} } },
      async login() {}, on() {}, off() {}, async destroy() {}
    },
    fetchHistory: async () => [],
    providers: { codex: { async dispatch() { throw new Error('deferred retry fixture must not dispatch'); } } },
    recoveryOptions: {
      codexSessionRoot: root,
      ordinaryNativePreflight: async (current, options) => {
        preflights += 1;
        const deadline = failPreflights && preflights < 3 ? Date.now() - 1 : Date.now() + 1000;
        return validateCodexSessionIdentityAsync(current.nativeId, current.workspace, root, { ...options, deadline });
      }
    }
  });
  let failPreflights = false;
  t.after(async () => {
    await gateway.stop();
    state.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await gateway.start(secret);
  failPreflights = true;
  preflights = 0;
  gateway.deferredHandoffRecoveryDelayMs = 0;
  const retryBoundaryClassifier = gateway.isRetryableNativeProofBoundary.bind(gateway);
  let suppressRetryBoundaryClassifier = true;
  gateway.isRetryableNativeProofBoundary = binding => suppressRetryBoundaryClassifier
    ? false
    : retryBoundaryClassifier(binding);
  const wake = createBindingWakeController({
    getGateway: () => gateway,
    isReady: () => gateway.ready,
    isStopping: () => gateway.stopping
  });
  wake.request();
  await wake.wait();
  suppressRetryBoundaryClassifier = false;
  assert.equal(state.getIntakeWatermark('1000').state, 'unavailable');
  const waitDeadline = Date.now() + 3000;
  while (state.getIntakeWatermark('1000').state !== 'ready') {
    if (Date.now() >= waitDeadline) throw new Error('ordinary-bind native proof retry did not recover');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(preflights, 3);
});

test('Claude endpoint recovery schedules a Codex native proof retry', { timeout: 5000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-proof-claude-retry-'));
  const root = path.join(dir, 'sessions');
  const db = path.join(dir, 'surface.sqlite');
  const secret = path.join(dir, 'discord.env');
  const nativeId = '44444444-4444-4444-8444-444444444444';
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, `${nativeId}.jsonl`), JSON.stringify({
    type: 'session_meta', payload: { id: nativeId, cwd: dir }
  }) + '\n');
  fs.writeFileSync(secret, 'DISCORD_TOKEN=fixture-token\n', { mode: 0o600 });
  const state = new SurfaceState(db);
  state.setConfig({ operatorId: 'operator', guildId: 'guild', secretFile: secret });
  state.bindOrdinary({ channelId: '1000', guildId: 'guild', provider: 'codex', nativeId, workspace: dir },
    { sessionId: nativeId, threadId: nativeId });
  state.setIntakeBaseline('1000', '100', 'fixture baseline');
  let failPreflights = false;
  const channel = { id: '1000', guildId: 'guild', topic: null, permissionsFor: () => ({ has: () => true }) };
  const gateway = new DiscordGateway({
    state,
    client: {
      user: { id: 'bot' },
      channels: { fetch: async () => channel },
      application: { commands: { async fetch() { return []; }, async create() {} } },
      async login() {}, on() {}, off() {}, async destroy() {}
    },
    fetchHistory: async () => [],
    providers: { codex: { async dispatch() { throw new Error('Claude retry fixture must not dispatch'); } } },
    recoveryOptions: {
      codexSessionRoot: root,
      ordinaryNativePreflight: async (binding, options) => {
        const deadline = failPreflights ? Date.now() - 1 : Date.now() + 1000;
        return validateCodexSessionIdentityAsync(binding.nativeId, binding.workspace, root, { ...options, deadline });
      }
    }
  });
  t.after(async () => {
    await gateway.stop();
    state.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await gateway.start(secret);
  failPreflights = true;
  gateway.deferredHandoffRecoveryDelayMs = 60_000;
  const result = await gateway.recoverTransport('Claude endpoint unavailable');

  assert.equal(result.state, 'unavailable');
  assert.equal(gateway.deferredHandoffRecoveryChannels.has('1000'), true);
});

test('scheduled native proof retry expires at its owner deadline without making a gap', { timeout: 5000 }, async t => {
  const f = boundedRetryFixture(t, '55555555-5555-4555-8555-555555555555');
  await f.gateway.start(f.secret);
  f.setFailProof(true);
  f.gateway.recoveryTimeoutMs = 60;
  f.gateway.deferredHandoffRecoveryDelayMs = 5;
  f.state.markIntakeBoundary('1000', 'unavailable',
    nativeProofDeadlineDetail(NATIVE_PROOF_PHASES.PREFLIGHT, Date.now() - 1), null, null, f.binding);
  f.gateway.scheduleDeferredHandoffRecovery('1000');

  const waitDeadline = Date.now() + 2000;
  while (f.gateway.deferredHandoffRecoveryDeadlines.has('1000') ||
      f.gateway.deferredHandoffRecoveryChannels.has('1000') || f.gateway.deferredHandoffRecoveryTimer) {
    if (Date.now() >= waitDeadline) throw new Error('bounded native proof retry did not expire');
    await new Promise(resolve => setTimeout(resolve, 10));
  }

  const boundary = f.state.getIntakeWatermark('1000');
  assert.equal(boundary.state, 'unavailable');
  assert.match(boundary.detail, /^Native proof recovery v1: /);
  const detail = JSON.parse(boundary.detail.replace(/^Native proof recovery v1: /, ''));
  assert.equal(detail.phase, NATIVE_PROOF_PHASES.PREFLIGHT);
  assert.ok(detail.deadline <= Date.now());
  assert.equal(f.state.getBinding('1000').readiness, 'unavailable');
  assert.ok(f.preflights > 0);
});

test('an earlier native proof deadline advances the shared recovery timer', { timeout: 5000 }, async t => {
  const f = boundedRetryFixture(t, '99999999-9999-4999-8999-999999999999');
  await f.gateway.start(f.secret);
  f.gateway.deferredHandoffRecoveryDelayMs = 5000;
  f.gateway.scheduleDeferredHandoffRecovery('pending-channel', { pendingGeneration: true });
  const slowTimer = f.gateway.deferredHandoffRecoveryTimer;
  const slowDeadline = f.gateway.deferredHandoffRecoveryTimerDeadline;

  f.gateway.recoveryTimeoutMs = 50;
  f.state.markIntakeBoundary('1000', 'unavailable',
    nativeProofDeadlineDetail(NATIVE_PROOF_PHASES.PREFLIGHT, Date.now() - 1), null, null, f.binding);
  f.gateway.scheduleDeferredHandoffRecovery('1000');

  assert.notEqual(f.gateway.deferredHandoffRecoveryTimer, slowTimer);
  assert.ok(f.gateway.deferredHandoffRecoveryTimerDeadline < slowDeadline);
});

test('a proof retry timer stays before its owner deadline', { timeout: 5000 }, async t => {
  const f = boundedRetryFixture(t, '12121212-1212-4121-8121-121212121212');
  await f.gateway.start(f.secret);
  f.gateway.recoveryTimeoutMs = 50;
  f.gateway.deferredHandoffRecoveryDelayMs = 5000;
  f.state.markIntakeBoundary('1000', 'unavailable',
    nativeProofDeadlineDetail(NATIVE_PROOF_PHASES.PREFLIGHT, Date.now() + 1000), null, null, f.binding);

  f.gateway.scheduleDeferredHandoffRecovery('1000');

  const retry = f.gateway.deferredHandoffRecoveryDeadlines.get('1000');
  assert.ok(retry);
  assert.ok(f.gateway.deferredHandoffRecoveryTimerDeadline < retry.deadline);
});

test('an expired native proof owner keeps its original deadline across a new marker', { timeout: 5000 }, async t => {
  const f = boundedRetryFixture(t, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  await f.gateway.start(f.secret);
  f.gateway.recoveryTimeoutMs = 10;
  f.state.markIntakeBoundary('1000', 'unavailable',
    nativeProofDeadlineDetail(NATIVE_PROOF_PHASES.PREFLIGHT, Date.now() - 1), null, null, f.binding);
  const first = f.gateway.ensureDeferredNativeProofRecovery('1000');
  await new Promise(resolve => setTimeout(resolve, 20));
  f.state.markIntakeBoundary('1000', 'unavailable',
    nativeProofDeadlineDetail(NATIVE_PROOF_PHASES.PREFLIGHT, Date.now() - 2), null, null, f.binding);

  const second = f.gateway.ensureDeferredNativeProofRecovery('1000');
  assert.equal(second.deadline, first.deadline);
  assert.notEqual(second.detail, first.detail);
});

test('ordinary-handoff keeps the native proof reason across transient channel failures', { timeout: 5000 }, async t => {
  const f = boundedRetryFixture(t, '88888888-8888-4888-8888-888888888888');
  await f.gateway.start(f.secret);
  f.setFailProof(true);
  f.gateway.recoveryTimeoutMs = 60;
  f.gateway.deferredHandoffRecoveryDelayMs = 5;
  f.gateway.client.channels.fetch = async () => {
    const error = new Error('temporary channel outage');
    error.status = 503;
    throw error;
  };
  f.state.markIntakeBoundary('1000', 'unavailable',
    nativeProofDeadlineDetail(NATIVE_PROOF_PHASES.PREFLIGHT, Date.now() - 1), null, null, f.binding);
  f.gateway.scheduleDeferredHandoffRecovery('1000');

  const waitDeadline = Date.now() + 2000;
  while (f.gateway.deferredHandoffRecoveryDeadlines.has('1000')) {
    if (Date.now() >= waitDeadline) throw new Error('channel-failure retry owner did not expire');
    await new Promise(resolve => setTimeout(resolve, 10));
  }

  assert.equal(f.state.getIntakeWatermark('1000').state, 'unavailable');
  assert.match(f.state.getIntakeWatermark('1000').detail, /^Native proof recovery v1: /);
  assert.equal(f.preflights, 1, 'channel failures must not start a second native preflight');
});

test('ordinary-handoff replaces the native proof reason after a terminal channel failure', { timeout: 5000 }, async t => {
  const f = boundedRetryFixture(t, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  await f.gateway.start(f.secret);
  const preflightsBefore = f.preflights;
  f.gateway.recoveryTimeoutMs = 60;
  f.gateway.deferredHandoffRecoveryDelayMs = 5;
  f.gateway.client.channels.fetch = async () => null;
  f.state.markIntakeBoundary('1000', 'unavailable',
    nativeProofDeadlineDetail(NATIVE_PROOF_PHASES.PREFLIGHT, Date.now() - 1), null, null, f.binding);
  f.gateway.scheduleDeferredHandoffRecovery('1000');

  const waitDeadline = Date.now() + 2000;
  while (f.gateway.deferredHandoffRecoveryDeadlines.has('1000')) {
    if (Date.now() >= waitDeadline) throw new Error('terminal channel failure retry owner did not finish');
    await new Promise(resolve => setTimeout(resolve, 10));
  }

  assert.equal(f.state.getIntakeWatermark('1000').detail, 'Discord channel is unavailable');
  assert.equal(f.preflights, preflightsBefore, 'terminal channel failures must not start native preflight');
});

test('stopping cancels a pending native proof retry owner', { timeout: 5000 }, async t => {
  const f = boundedRetryFixture(t, '66666666-6666-4666-8666-666666666666');
  await f.gateway.start(f.secret);
  f.setFailProof(true);
  f.gateway.deferredHandoffRecoveryDelayMs = 60_000;
  f.state.markIntakeBoundary('1000', 'unavailable',
    nativeProofDeadlineDetail(NATIVE_PROOF_PHASES.PREFLIGHT, Date.now() - 1), null, null, f.binding);
  f.gateway.scheduleDeferredHandoffRecovery('1000');
  assert.equal(f.gateway.deferredHandoffRecoveryDeadlines.has('1000'), true);

  await f.gateway.stop();

  assert.equal(f.gateway.deferredHandoffRecoveryDeadlines.size, 0);
  assert.equal(f.gateway.deferredHandoffRecoveryChannels.size, 0);
  assert.equal(f.gateway.pendingHandoffRecoveryChannels.size, 0);
  assert.equal(f.gateway.deferredHandoffRecoveryTimer, null);
});

test('handoff fence wins over an expired native proof retry owner', { timeout: 5000 }, async t => {
  const f = boundedRetryFixture(t, '77777777-7777-4777-8777-777777777777');
  await f.gateway.start(f.secret);
  const preflightsBefore = f.preflights;
  f.setFailProof(true);
  f.gateway.recoveryTimeoutMs = 60;
  f.gateway.deferredHandoffRecoveryDelayMs = 5;
  f.state.markIntakeBoundary('1000', 'unavailable',
    nativeProofDeadlineDetail(NATIVE_PROOF_PHASES.PREFLIGHT, Date.now() - 1), null, null, f.binding);
  f.gateway.scheduleDeferredHandoffRecovery('1000');
  assert.ok(f.state.pauseOrdinaryHandoffIntake('1000', f.binding));

  const waitDeadline = Date.now() + 2000;
  while (f.gateway.deferredHandoffRecoveryDeadlines.has('1000')) {
    if (Date.now() >= waitDeadline) throw new Error('handoff retry owner did not expire');
    await new Promise(resolve => setTimeout(resolve, 10));
  }

  assert.equal(f.state.getIntakeWatermark('1000').detail, 'ordinary handoff fence');
  assert.equal(f.state.getBinding('1000').readiness, 'pending');
  assert.equal(f.preflights, preflightsBefore);
});

test('concurrent ready recovery clears a stale proof owner', { timeout: 5000 }, async t => {
  const f = boundedRetryFixture(t, '13131313-1313-4131-8131-131313131313');
  await f.gateway.start(f.secret);
  f.gateway.recoveryTimeoutMs = 1000;
  f.gateway.deferredHandoffRecoveryDelayMs = 0;
  f.state.markIntakeBoundary('1000', 'unavailable',
    nativeProofDeadlineDetail(NATIVE_PROOF_PHASES.PREFLIGHT, Date.now() + 1000), null, null, f.binding);
  f.gateway.scheduleDeferredHandoffRecovery('1000');
  assert.equal(f.gateway.deferredHandoffRecoveryDeadlines.has('1000'), true);

  f.state.markIntakeBoundary('1000', 'ready', 'concurrent recovery', null, null, f.binding);

  const waitDeadline = Date.now() + 2000;
  while (f.gateway.deferredHandoffRecoveryDeadlines.has('1000')) {
    if (Date.now() >= waitDeadline) throw new Error('concurrent ready recovery did not clear owner');
    await new Promise(resolve => setTimeout(resolve, 10));
  }

  assert.equal(f.state.getBinding('1000').readiness, 'ready');
});
