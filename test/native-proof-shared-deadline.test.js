const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const installed = path.resolve(__dirname, '..');
const test = require('node:test');
const { SurfaceState } = require(path.join(installed, 'src/state'));
const { DiscordGateway } = require(path.join(installed, 'src/discord'));
const { validateCodexSessionIdentityAsync } = require(path.join(installed, 'src/native'));

async function runSharedBudget(slowFirst) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-proof-shared-budget-'));
  const root = path.join(dir, 'sessions');
  fs.mkdirSync(root);
  const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
  const channels = ['1000', '2000'];
  const state = new SurfaceState(path.join(dir, 'surface.sqlite'));
  let gateway;
  const timers = new Set();
  try {
    state.setConfig({ operatorId: 'operator', guildId: 'guild', secretFile: path.join(dir, 'unused') });
    for (let i = 0; i < ids.length; i++) {
      fs.writeFileSync(path.join(root, `${ids[i]}.jsonl`), JSON.stringify({ type: 'session_meta', payload: { id: ids[i], cwd: dir } }) + '\n');
      state.bindOrdinary({ channelId: channels[i], guildId: 'guild', provider: 'codex', nativeId: ids[i], workspace: dir }, { sessionId: ids[i], threadId: ids[i] });
      state.setIntakeBaseline(channels[i], '100', 'fixture baseline');
      assert.equal(state.acceptDiscordMessage({ id: String(101 + i), channelId: channels[i], guildId: 'guild', authorId: 'operator', isBot: false, content: 'retained instruction' }, { ready: false }).accepted, true);
    }
    const preflights = [];
    let dispatches = 0;
    let transcriptOpenStarted = false;
    gateway = new DiscordGateway({ state,
      client: { user: { id: 'bot' }, channels: { fetch: async id => ({ id, guildId: 'guild', topic: null, permissionsFor: () => ({ has: () => true }) }) }, on() {}, off() {}, async destroy() {} },
      fetchHistory: async (channel, options) => {
        const id = channel.id === '1000' ? '101' : '102';
        return BigInt(options.after || '0') < BigInt(id)
          ? [{ id, channelId: channel.id, guildId: 'guild', content: 'retained instruction', author: { id: 'operator', bot: false }, channel }]
          : [];
      },
      providers: { codex: { async dispatch() { dispatches++; throw new Error('recovery must not dispatch'); } } },
      recoveryOptions: { timeoutMs: 1000, ordinaryNativePreflight: async (binding, options) => {
        preflights.push(binding.channelId);
        if (slowFirst && binding.channelId === '1000') {
          const originalOpen = fs.promises.open;
          fs.promises.open = async (...args) => {
            transcriptOpenStarted = true;
            const opening = originalOpen(...args);
            await new Promise(resolve => {
              const timer = setTimeout(() => { timers.delete(timer); resolve(); }, 1100);
              timers.add(timer);
            });
            return opening;
          };
          try {
            return await validateCodexSessionIdentityAsync(binding.nativeId, binding.workspace, root, options);
          } finally {
            fs.promises.open = originalOpen;
          }
        }
        return validateCodexSessionIdentityAsync(binding.nativeId, binding.workspace, root, options);
      } }
    });
    const first = await gateway.recoverTransport('reconnect', gateway.lifecycleEpoch);
    const held = state.getIntakeWatermark('2000');
    if (slowFirst) {
      assert.equal(first.ready, false);
      assert.equal(held.state, 'unavailable');
      assert.match(held.detail, /Native proof recovery v1:/);
      assert.deepEqual(preflights, ['1000']);
      assert.equal(transcriptOpenStarted, true);
    } else {
      assert.equal(first.ready, true);
      assert.equal(held.state, 'ready');
      assert.deepEqual(preflights, channels);
    }
    const proof = await validateCodexSessionIdentityAsync(ids[1], dir, root, { deadline: Date.now() + 1000 });
    assert.equal(proof.sessionId, ids[1]);
    const before = preflights.length;
    const second = await gateway.recoverTransport('reconnect', gateway.lifecycleEpoch, ['2000']);
    if (slowFirst) {
      assert.equal(second.ready, true);
      assert.equal(state.getIntakeWatermark('2000').state, 'ready');
      assert.equal(preflights.length, before + 1);
    } else assert.equal(second.ready, true);
    assert.equal(state.getMessage('102').state, 'accepted');
    assert.equal(dispatches, 0);
    assert.equal(state.getBinding('2000').generation, 1);
  } finally {
    if (gateway) await gateway.stop();
    for (const timer of timers) clearTimeout(timer);
    state.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
test('shared deadline does not permanently hold an unattempted binding', async () => {
  await runSharedBudget(false);
  await runSharedBudget(true);
});
test('shared deadline keeps a conductor binding in a terminal gap', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-proof-shared-conductor-'));
  const root = path.join(dir, 'sessions');
  const slowId = '66666666-6666-4666-8666-666666666666';
  const conductorId = '77777777-7777-4777-8777-777777777777';
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, `${slowId}.jsonl`), JSON.stringify({ type: 'session_meta', payload: { id: slowId, cwd: dir } }) + '\n');
  const state = new SurfaceState(path.join(dir, 'surface.sqlite'));
  let gateway;
  const timers = new Set();
  try {
    state.setConfig({ operatorId: 'operator', guildId: 'guild', secretFile: path.join(dir, 'unused') });
    state.bindOrdinary({ channelId: '1000', guildId: 'guild', provider: 'codex', nativeId: slowId, workspace: dir },
      { sessionId: slowId, threadId: slowId });
    state.bind({ channelId: '2000', guildId: 'guild', provider: 'codex', nativeId: conductorId, workspace: dir,
      conductorId: 'conductor-2000', repoKey: 'repo:2000' });
    state.setIntakeBaseline('1000', '100', 'fixture baseline');
    state.setIntakeBaseline('2000', '100', 'fixture baseline');
    const preflights = [];
    gateway = new DiscordGateway({ state,
      client: { user: { id: 'bot' }, channels: { fetch: async id => ({ id, guildId: 'guild', topic: null, permissionsFor: () => ({ has: () => true }) }) }, on() {}, off() {}, async destroy() {} },
      fetchHistory: async () => [],
      providers: { codex: { async dispatch() { throw new Error('conductor binding must not dispatch'); } } },
      recoveryOptions: { timeoutMs: 1000, ordinaryNativePreflight: async (binding, options) => {
        preflights.push(binding.channelId);
        if (binding.channelId === '1000') await new Promise(resolve => {
          const timer = setTimeout(() => { timers.delete(timer); resolve(); }, 1100);
          timers.add(timer);
        });
        return validateCodexSessionIdentityAsync(binding.nativeId, binding.workspace, root, options);
      } }
    });
    const result = await gateway.recoverTransport('reconnect', gateway.lifecycleEpoch);
    assert.equal(result.ready, false);
    assert.deepEqual(preflights, ['1000']);
    assert.equal(state.getBinding('2000').conductorId, 'conductor-2000');
    assert.equal(state.getIntakeWatermark('2000').state, 'gap');
    assert.doesNotMatch(state.getIntakeWatermark('2000').detail, /Native proof recovery v1:/);
  } finally {
    if (gateway) await gateway.stop();
    for (const timer of timers) clearTimeout(timer);
    state.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
