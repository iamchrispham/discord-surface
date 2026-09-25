const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const installed = path.resolve(__dirname, '..');
const test = require('node:test');
const { SurfaceState } = require(path.join(installed, 'src/state'));
const { DiscordGateway } = require(path.join(installed, 'src/discord'));
const { validateCodexSessionIdentityAsync } = require(path.join(installed, 'src/native'));

test('concurrent recovery abandons a stale owner after an ordinary handoff', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-proof-concurrent-handoff-'));
  const root = path.join(dir, 'sessions');
  const oldId = '44444444-4444-4444-8444-444444444444';
  const newId = '55555555-5555-4555-8555-555555555555';
  fs.mkdirSync(root);
  for (const id of [oldId, newId]) fs.writeFileSync(path.join(root, `${id}.jsonl`), JSON.stringify({ type: 'session_meta', payload: { id, cwd: dir } }) + '\n');
  let state = new SurfaceState(path.join(dir, 'surface.sqlite'));
  let gateway;
  let releaseOld;
  const oldGate = new Promise(resolve => { releaseOld = resolve; });
  let oldPreflightStarted;
  const oldStarted = new Promise(resolve => { oldPreflightStarted = resolve; });
  const preflights = [];
  const channel = { id: '1000', guildId: 'guild', topic: null, permissionsFor: () => ({ has: () => true }), messages: { async fetch() {} } };
  const makeGateway = () => new DiscordGateway({ state,
    client: { user: { id: 'bot' }, channels: { fetch: async () => channel }, on() {}, off() {}, async destroy() {} },
    fetchHistory: async () => [],
    providers: { codex: { async dispatch() { throw new Error('no custody should dispatch'); } } },
    recoveryOptions: { ordinaryNativePreflight: async (binding, options) => {
      preflights.push(binding.nativeId);
      if (binding.nativeId === oldId) {
        oldPreflightStarted();
        await oldGate;
      }
      return validateCodexSessionIdentityAsync(binding.nativeId, binding.workspace, root, options);
    } }
  });
  try {
    state.setConfig({ operatorId: 'operator', guildId: 'guild', secretFile: path.join(dir, 'unused') });
    const original = state.bindOrdinary({ channelId: '1000', guildId: 'guild', provider: 'codex', nativeId: oldId, workspace: dir },
      { sessionId: oldId, threadId: oldId });
    state.setIntakeBaseline('1000', '100', 'fixture baseline');
    gateway = makeGateway();
    await gateway.recoverInbound(new AbortController().signal, 'reconnect', gateway.lifecycleEpoch, null, Date.now() - 1);
    const retry = gateway.recoverTransport('reconnect', gateway.lifecycleEpoch);
    await oldStarted;
    const replacementProof = { file: path.join(root, `${newId}.jsonl`), sessionId: newId, threadId: newId, workspace: dir, sessionRoot: null };
    const successor = state.handoffOrdinary({ channelId: '1000', provider: 'codex', fromNativeId: oldId, fromGeneration: original.generation,
      nativeId: newId, workspace: dir, handoffId: 'handoff-during-recovery', identity: { sessionId: newId, threadId: newId }, nativeProof: replacementProof });
    assert.equal(successor.generation, original.generation + 1);
    releaseOld();
    const result = await retry;
    assert.equal(result.ready, false);
    assert.equal(result.state, 'unavailable');
    assert.equal(state.getIntakeWatermark('1000').state, 'pending');
    const followup = await gateway.recoverTransport('reconnect follow-up', gateway.lifecycleEpoch, ['1000']);
    assert.equal(followup.ready, true);
    assert.equal(state.getBinding('1000').nativeId, newId);
    assert.equal(state.getBinding('1000').generation, original.generation + 1);
    assert.equal(state.getIntakeWatermark('1000').state, 'ready');
    assert.deepEqual(preflights, [oldId, newId]);
  } finally {
    releaseOld?.();
    if (gateway) await gateway.stop();
    state.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
