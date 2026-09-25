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
