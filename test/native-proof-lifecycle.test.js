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

for (const phase of ['preflight', 'before-binding', 'existing-gap', 'reopen', 'pending-reopen', 'missing', 'concurrent', 'workspace-mismatch', 'ambiguous', 'permission', 'identity-mismatch', 'cancelled', 'startup']) {
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
  let blockedTranscriptDirectory = null;
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
    let cancelNextPreflight = false;
    const replies = [];
    const channel = { id: '1000', guildId: 'guild', topic: null, permissionsFor: () => ({ has: () => true }),
      messages: { async fetch() { return { async react() {} }; } },
      async send(body) { replies.push(body); return { id: 'reply-101' }; } };
    const gatewayOptions = {
      client: {
        user: { id: 'bot' },
        channels: { fetch: async () => channel },
        application: { commands: { async fetch() { return []; }, async create() {} } },
        async login() {},
        on() {}, off() {}, async destroy() {}
      },
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
      recoveryOptions: {
        ...(phase === 'existing-gap' ? { maxPages: 1, pageLimit: 1 } : {}),
        ordinaryNativePreflight: async (current, options) => {
        preflights++;
        if (!expire && phase === 'cancelled' && cancelNextPreflight) {
          cancelNextPreflight = false;
          options = { ...options, signal: AbortSignal.abort() };
        }
        if (expire && phase === 'preflight') {
          const originalOpen = fs.promises.open;
          fs.promises.open = async (...args) => {
            await new Promise(resolve => setTimeout(resolve, 10));
            return originalOpen(...args);
          };
          try {
            return await validateCodexSessionIdentityAsync(current.nativeId, current.workspace, root,
              { ...options, deadline: Date.now() + 1 });
          } finally {
            fs.promises.open = originalOpen;
          }
        }
        return validateCodexSessionIdentityAsync(current.nativeId, current.workspace, root,
          { ...options, deadline: expire ? Date.now() - 1 : options.deadline });
      } }
    };
    gateway = new DiscordGateway({ ...gatewayOptions, state });
    if (phase === 'startup') {
      const secretFile = path.join(dir, 'discord.env');
      fs.writeFileSync(secretFile, 'DISCORD_TOKEN=fixture-token\n', { mode: 0o600 });
      await gateway.start(secretFile);
      assert.equal(gateway.started, true);
      assert.equal(gateway.ready, true);
      assert.equal(state.getMessage('101').state, 'accepted');
      expire = false;
      const recovery = await gateway.beginReconnectRecovery('resume');
      assert.equal(recovery.ready, true);
      assert.equal(state.getIntakeWatermark('1000').state, 'ready');
      await gateway.consumer.waitForNativeWork();
      assert.equal(dispatches, 1);
      assert.equal(state.getMessage('101').state, 'replied');
      assert.equal(replies.filter(row => row.content === 'recovered answer').length, 1);
      return;
    }
    const first = !['before-binding', 'existing-gap'].includes(phase)
      ? await gateway.recoverTransport('reconnect', gateway.lifecycleEpoch)
      : await gateway.recoverInbound(new AbortController().signal, 'reconnect', gateway.lifecycleEpoch, null, Date.now() - 1);
    if (phase === 'existing-gap') {
      expire = false;
      const retry = await gateway.recoverTransport('reconnect', gateway.lifecycleEpoch);
      assert.equal(retry.ready, false);
      assert.equal(state.getIntakeWatermark('1000').state, 'gap');
      assert.match(state.getIntakeWatermark('1000').detail, /history page bound/);
      assert.equal(preflights, 1);
      assert.ok(historyReads > 0);
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
    if (phase === 'identity-mismatch') {
      fs.writeFileSync(path.join(root, `${nativeId}.jsonl`), JSON.stringify({ type: 'session_meta', payload: {
        id: nativeId, session_id: '88888888-8888-4888-8888-888888888888', cwd: dir
      } }) + '\n');
    }
    if (phase === 'permission') {
      blockedTranscriptDirectory = path.join(root, 'blocked');
      fs.mkdirSync(blockedTranscriptDirectory);
      fs.renameSync(path.join(root, `${nativeId}.jsonl`), path.join(blockedTranscriptDirectory, `${nativeId}.jsonl`));
      fs.chmodSync(blockedTranscriptDirectory, 0o000);
    }
    if (phase === 'cancelled') cancelNextPreflight = true;
    const recover = phase === 'permission'
      ? async (operation) => {
        const originalOpendir = fs.promises.opendir;
        const deniedRoot = path.resolve(root);
        fs.promises.opendir = async (...args) => {
          const candidate = args[0];
          const resolvedCandidate = typeof candidate === 'string' ? path.resolve(candidate) : null;
          if (resolvedCandidate === deniedRoot || resolvedCandidate?.startsWith(`${deniedRoot}${path.sep}`)) {
            const error = new Error(`EACCES: permission denied, opendir '${candidate}'`);
            error.code = 'EACCES';
            throw error;
          }
          return originalOpendir.apply(fs.promises, args);
        };
        try {
          return await operation();
        } finally {
          fs.promises.opendir = originalOpendir;
        }
      }
      : async operation => operation();
    const second = phase === 'concurrent'
      ? (await Promise.all([gateway.recoverTransport('reconnect', gateway.lifecycleEpoch), gateway.recoverTransport('reconnect', gateway.lifecycleEpoch)]))[0]
      : await recover(() => gateway.recoverTransport('reconnect', gateway.lifecycleEpoch));
    if (['missing', 'workspace-mismatch', 'ambiguous', 'permission', 'identity-mismatch', 'cancelled'].includes(phase)) {
      assert.equal(second.ready, false);
      assert.equal(dispatches, 0);
      assert.equal(state.getMessage('101').state, 'accepted');
      assert.equal(state.getBinding('1000').generation, binding.generation);
      if (['missing', 'workspace-mismatch', 'ambiguous', 'permission', 'identity-mismatch'].includes(phase)) {
        await gateway.stop();
        state.close();
        state = new SurfaceState(path.join(dir, 'surface.sqlite'));
        gateway = new DiscordGateway({ ...gatewayOptions, state });
        const reopened = await recover(() => gateway.recoverTransport('reconnect', gateway.lifecycleEpoch));
        assert.equal(reopened.ready, false);
        assert.equal(state.getMessage('101').state, 'accepted');
        assert.equal(state.getIntakeWatermark('1000').state, 'unavailable');
        assert.equal(state.getBinding('1000').generation, binding.generation);
      } else {
        await gateway.stop();
        state.close();
        state = new SurfaceState(path.join(dir, 'surface.sqlite'));
        gateway = new DiscordGateway({ ...gatewayOptions, state });
        const reopened = await gateway.recoverTransport('reconnect', gateway.lifecycleEpoch);
        assert.equal(reopened.ready, true);
        assert.equal(state.getIntakeWatermark('1000').state, 'ready');
      }
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
    if (blockedTranscriptDirectory) fs.chmodSync(blockedTranscriptDirectory, 0o700);
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

test('stopping native retry during preflight preserves custody across restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-proof-interrupted-retry-'));
  const root = path.join(dir, 'sessions');
  const db = path.join(dir, 'surface.sqlite');
  const secret = path.join(dir, 'discord.env');
  const nativeId = '33333333-3333-4333-8333-333333333333';
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, `${nativeId}.jsonl`), JSON.stringify({ type: 'session_meta', payload: { id: nativeId, cwd: dir } }) + '\n');
  fs.writeFileSync(secret, 'DISCORD_TOKEN=fixture-token\n', { mode: 0o600 });
  let state = new SurfaceState(db);
  let gateway;
  let preflightStarted;
  let releasePreflight;
  const started = new Promise(resolve => { preflightStarted = resolve; });
  const gate = new Promise(resolve => { releasePreflight = resolve; });
  let block = false;
  let dispatches = 0;
  const replies = [];
  const channel = { id: '1000', guildId: 'guild', topic: null, permissionsFor: () => ({ has: () => true }),
    messages: { async fetch() { return { async react() {} }; } },
    async send(body) { replies.push(body); return { id: 'reply-101' }; } };
  const makeGateway = () => new DiscordGateway({ state,
    client: {
      user: { id: 'bot' }, channels: { fetch: async () => channel },
      application: { commands: { async fetch() { return []; }, async create() {} } },
      async login() {}, on() {}, off() {}, async destroy() {}
    },
    fetchHistory: async (_channel, options) => BigInt(options.after || '0') < 101n
      ? [{ id: '101', channelId: '1000', guildId: 'guild', content: 'retained instruction', author: { id: 'operator', bot: false }, channel }]
      : [],
    providers: { codex: {
      async dispatch(message) {
        dispatches++;
        recordNativeAcknowledgment(state, { messageId: message.id, provider: 'codex', nativeId, generation: message.generation });
        return { status: 'submitted' };
      },
      async observe() { return { text: 'recovered answer' }; }
    } },
    recoveryOptions: { ordinaryNativePreflight: async (binding, options) => {
      if (block) {
        preflightStarted();
        await Promise.race([gate, new Promise(resolve => options.signal?.addEventListener('abort', resolve, { once: true }))]);
      }
      return validateCodexSessionIdentityAsync(binding.nativeId, binding.workspace, root, options);
    } }
  });
  try {
    state.setConfig({ operatorId: 'operator', guildId: 'guild', secretFile: secret });
    const binding = state.bindOrdinary({ channelId: '1000', guildId: 'guild', provider: 'codex', nativeId, workspace: dir },
      { sessionId: nativeId, threadId: nativeId });
    state.setIntakeBaseline('1000', '100', 'fixture baseline');
    assert.equal(state.acceptDiscordMessage({ id: '101', channelId: '1000', guildId: 'guild', authorId: 'operator', isBot: false,
      content: 'retained instruction' }, { ready: false }).accepted, true);
    gateway = makeGateway();
    await gateway.recoverInbound(new AbortController().signal, 'reconnect', gateway.lifecycleEpoch, null, Date.now() - 1);
    assert.match(state.getIntakeWatermark('1000').detail, /Native proof recovery v1:/);
    block = true;
    const retry = gateway.recoverTransport('reconnect', gateway.lifecycleEpoch);
    await started;
    await gateway.stop();
    await retry;
    assert.equal(state.getMessage('101').state, 'accepted');
    assert.match(state.getIntakeWatermark('1000').detail, /Native proof recovery v1:/);

    state.close();
    state = new SurfaceState(db);
    block = false;
    gateway = makeGateway();
    await gateway.start(secret);
    await gateway.reconcilePending();
    await gateway.consumer.waitForNativeWork();
    assert.equal(state.getIntakeWatermark('1000').state, 'ready');
    assert.equal(state.getMessage('101').state, 'replied');
    assert.equal(dispatches, 1);
    assert.equal(replies.filter(row => row.content === 'recovered answer').length, 1);
    assert.equal(state.getBinding('1000').generation, binding.generation);
  } finally {
    releasePreflight?.();
    if (gateway) await gateway.stop();
    state.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

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
