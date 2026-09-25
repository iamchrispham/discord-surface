const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const installed = path.resolve(__dirname, '..');
const test = require('node:test');
const { recordNativeAcknowledgment } = require(path.join(installed, 'src/acknowledgment'));
const { SurfaceState } = require(path.join(installed, 'src/state'));
const { DiscordGateway } = require(path.join(installed, 'src/discord'));
const { validateCodexSessionIdentityAsync } = require(path.join(installed, 'src/native'));

for (const phase of ['preflight', 'before-binding', 'existing-gap', 'reopen', 'pending-reopen', 'missing', 'concurrent', 'workspace-mismatch', 'ambiguous', 'permission', 'cancelled']) {
test(`native deadline recovery preserves custody: ${phase}`, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-proof-deadline-'));
  const root = path.join(dir, 'sessions');
  fs.mkdirSync(root);
  const nativeId = '11111111-1111-4111-8111-111111111111';
  fs.writeFileSync(path.join(root, `${nativeId}.jsonl`), JSON.stringify({
    type: 'session_meta', payload: { id: nativeId, cwd: dir }
  }) + '\n');
  let state = new SurfaceState(path.join(dir, 'surface.sqlite'));
  let gateway;
  try {
    state.setConfig({ operatorId: 'operator', guildId: 'guild', secretFile: path.join(dir, 'unused') });
    const binding = state.bindOrdinary({ channelId: '1000', guildId: 'guild', provider: 'codex', nativeId, workspace: dir },
      { sessionId: nativeId, threadId: nativeId });
    state.setIntakeBaseline('1000', '100', 'fixture baseline');
    const accepted = state.acceptDiscordMessage({ id: '101', channelId: '1000', guildId: 'guild',
      authorId: 'operator', isBot: false, content: 'retained instruction' }, { ready: false });
    assert.equal(accepted.accepted, true);
    let expire = true;
    let preflights = 0;
    let dispatches = 0;
    let historyReads = 0;
    const replies = [];
    const channel = { id: '1000', guildId: 'guild', topic: null, permissionsFor: () => ({ has: () => true }),
      messages: { async fetch() { return { async react() {} }; } },
      async send(body) { replies.push(body); return { id: 'reply-101' }; } };
    const gatewayOptions = {
      client: { user: { id: 'bot' }, channels: { fetch: async () => channel }, on() {}, off() {}, async destroy() {} },
      fetchHistory: async (_channel, options) => {
        historyReads++;
        return BigInt(options.after || '0') < 101n
          ? [{ id: '101', channelId: '1000', guildId: 'guild', content: 'retained instruction', author: { id: 'operator', bot: false }, channel }]
          : [];
      },
      providers: { codex: {
        async dispatch(message) {
          assert.equal(expire, false, 'no dispatch before valid proof');
          dispatches++;
          assert.equal(message.nativeId, nativeId);
          assert.equal(message.generation, binding.generation);
          recordNativeAcknowledgment(state, { messageId: message.id, provider: 'codex', nativeId, generation: binding.generation });
          return { status: 'submitted' };
        },
        async observe() { return { text: 'recovered answer' }; }
      } },
      recoveryOptions: { ordinaryNativePreflight: async (current, options) => {
        preflights++;
        if (!expire && phase === 'permission') throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
        if (!expire && phase === 'cancelled') options = { ...options, signal: AbortSignal.abort() };
        return validateCodexSessionIdentityAsync(current.nativeId, current.workspace, root,
          { ...options, deadline: expire ? Date.now() - 1 : options.deadline });
      } }
    };
    gateway = new DiscordGateway({ ...gatewayOptions, state });
    if (phase === 'existing-gap') state.markIntakeBoundary('1000', 'gap', 'genuine missing Discord history');
    const first = !['before-binding', 'existing-gap'].includes(phase)
      ? await gateway.recoverTransport('reconnect', gateway.lifecycleEpoch)
      : await gateway.recoverInbound(new AbortController().signal, 'reconnect', gateway.lifecycleEpoch, null, Date.now() - 1);
    if (phase === 'existing-gap') {
      assert.equal(state.getIntakeWatermark('1000').detail, 'genuine missing Discord history');
      expire = false;
      assert.equal((await gateway.recoverTransport('reconnect', gateway.lifecycleEpoch)).ready, false);
      assert.equal(preflights, 0);
      assert.equal(dispatches, 0);
      assert.equal(state.getMessage('101').state, 'accepted');
      return;
    }
    assert.equal(first.ready, false);
    assert.equal(first.state, 'unavailable');
    const held = state.getIntakeWatermark('1000');
    assert.match(held.detail, /Native proof recovery v1:/);
    expire = false;
    const fresh = await validateCodexSessionIdentityAsync(nativeId, dir, root, { deadline: Date.now() + 1000 });
    assert.equal(fresh.sessionId, nativeId);
    if (phase === 'pending-reopen') {
      state.markIntakeBoundary('1000', 'pending', held.detail, held.gap_from, held.gap_to, binding);
    }
    if (['reopen', 'pending-reopen'].includes(phase)) {
      await gateway.stop();
      state.close();
      state = new SurfaceState(path.join(dir, 'surface.sqlite'));
      gateway = new DiscordGateway({ ...gatewayOptions, state });
    }
    if (phase === 'missing') fs.unlinkSync(path.join(root, `${nativeId}.jsonl`));
    if (phase === 'workspace-mismatch') {
      fs.writeFileSync(path.join(root, `${nativeId}.jsonl`), JSON.stringify({ type: 'session_meta', payload: { id: nativeId, cwd: '/wrong-workspace' } }) + '\n');
    }
    if (phase === 'ambiguous') fs.copyFileSync(path.join(root, `${nativeId}.jsonl`), path.join(root, `second-${nativeId}.jsonl`));
    const second = phase === 'concurrent'
      ? (await Promise.all([gateway.recoverTransport('reconnect', gateway.lifecycleEpoch), gateway.recoverTransport('reconnect', gateway.lifecycleEpoch)]))[0]
      : await gateway.recoverTransport('reconnect', gateway.lifecycleEpoch);
    if (['missing', 'workspace-mismatch', 'ambiguous', 'permission', 'cancelled'].includes(phase)) {
      assert.equal(second.ready, false);
      assert.equal(dispatches, 0);
      assert.equal(state.getMessage('101').state, 'accepted');
      assert.equal(state.getBinding('1000').generation, binding.generation);
      return;
    }
    assert.equal(second.ready, true);
    assert.equal(second.state, 'ready');
    assert.ok(historyReads > 0);
    assert.equal(state.getIntakeWatermark('1000').recovered_through_id, '101');
    const expectedPreflights = { 'before-binding': 1, concurrent: 3 };
    assert.equal(preflights, expectedPreflights[phase] || 2, 'each recovery pass must validate native identity');
    assert.equal(state.getMessage('101').state, 'accepted');
    assert.equal(state.getBinding('1000').generation, binding.generation);
    assert.equal(dispatches, 0);
    await gateway.reconcilePending(undefined, { allowPaused: true, readyOnly: true });
    await gateway.consumer.waitForNativeWork();
    await gateway.reconcilePending(undefined, { allowPaused: true, readyOnly: true });
    assert.equal(dispatches, 1);
    assert.equal(state.getMessage('101').state, 'replied');
    assert.equal(replies.filter(row => row.content === 'recovered answer').length, 1);
  } finally {
    if (gateway) await gateway.stop();
    state.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

}

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
          await new Promise(resolve => {
            const timer = setTimeout(() => { timers.delete(timer); resolve(); }, 1100);
            timers.add(timer);
          });
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
