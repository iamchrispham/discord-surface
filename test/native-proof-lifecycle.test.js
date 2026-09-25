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
const { NATIVE_PROOF_PHASES, nativeProofDeadlineDetail } = require(path.join(installed, 'src/discord/native-proof-recovery'));

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
    let transcriptOpenStarted = false;
    let permissionInjected = false;
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
          const originalOpendir = fs.promises.opendir;
          fs.promises.opendir = async (...args) => {
            transcriptOpenStarted = true;
            const opening = originalOpendir(...args);
            await new Promise(resolve => setTimeout(resolve, 25));
            return opening;
          };
          try {
            return await validateCodexSessionIdentityAsync(current.nativeId, current.workspace, root,
              { ...options, deadline: Date.now() + 10 });
          } finally {
            fs.promises.opendir = originalOpendir;
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
      assert.equal(first.ready, false);
      assert.equal(first.state, 'unavailable');
      assert.equal(preflights, 0);
      expire = false;
      const retry = await gateway.recoverTransport('reconnect', gateway.lifecycleEpoch);
      assert.equal(retry.ready, false);
      assert.equal(state.getIntakeWatermark('1000').state, 'gap');
      assert.match(state.getIntakeWatermark('1000').detail, /history page bound/);
      assert.equal(preflights, 1);
      assert.doesNotMatch(state.getIntakeWatermark('1000').detail, /Native proof recovery v1:/);
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
      const nativeOpendir = fs.promises.opendir;
      fs.promises.opendir = async (directory, ...options) => {
        if (directory === root && !permissionInjected) {
          permissionInjected = true;
          fs.promises.opendir = nativeOpendir;
          const error = new Error(`EACCES: permission denied, opendir '${directory}'`);
          error.code = 'EACCES';
          throw error;
        }
        return nativeOpendir.call(fs.promises, directory, ...options);
      };
    }
    if (phase === 'cancelled') cancelNextPreflight = true;
    const second = phase === 'concurrent'
      ? (await Promise.all([gateway.recoverTransport('reconnect', gateway.lifecycleEpoch), gateway.recoverTransport('reconnect', gateway.lifecycleEpoch)]))[0]
      : await gateway.recoverTransport('reconnect', gateway.lifecycleEpoch);
    if (['missing', 'workspace-mismatch', 'ambiguous', 'permission', 'identity-mismatch', 'cancelled'].includes(phase)) {
      assert.equal(second.ready, false);
      assert.equal(dispatches, 0);
      assert.equal(state.getMessage('101').state, 'accepted');
      assert.equal(state.getBinding('1000').generation, binding.generation);
      if (phase === 'permission') assert.equal(permissionInjected, true);
      if (['missing', 'workspace-mismatch', 'ambiguous', 'permission', 'identity-mismatch'].includes(phase)) {
        const beforeReopenPreflights = preflights;
        await gateway.stop();
        state.close();
        state = new SurfaceState(path.join(dir, 'surface.sqlite'));
        gateway = new DiscordGateway({ ...gatewayOptions, state });
        const reopened = await gateway.recoverTransport('reconnect', gateway.lifecycleEpoch);
        assert.equal(reopened.ready, false);
        assert.equal(state.getMessage('101').state, 'accepted');
        assert.equal(state.getIntakeWatermark('1000').state, 'unavailable');
        assert.equal(state.getBinding('1000').generation, binding.generation);
        assert.equal(preflights, beforeReopenPreflights);
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
    if (phase === 'preflight') assert.equal(transcriptOpenStarted, true);
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
