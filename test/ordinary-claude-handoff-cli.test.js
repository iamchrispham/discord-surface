const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const { handoffInternal, parseArgs, GATEWAY_CAPABILITIES } = require('../src/cli');
const { READINESS } = require('../src/state');
const { ordinaryBindingDecision } = require('../src/ordinary-codex');
const { CLAUDE, OTHER, fixture, transcript } = require('./ordinary-claude-scenarios/fixture.cjs');

function setup(t) {
  const f = fixture(t);
  const successor = transcript(t, f.dir, OTHER);
  const args = {
    ordinary: true, provider: 'claude', 'state-dir': f.dir, db: f.db,
    'channel-id': f.binding.channelId, 'from-native-id': CLAUDE, 'from-generation': '1',
    'native-id': OTHER, workspace: f.dir, endpoint: path.join(f.dir, 'successor.sock'),
    transcript: successor.file, 'handoff-id': 'claude-successor'
  };
  const calls = { acquired: 0, released: 0, login: 0, destroyed: 0, wakes: [], outputs: [] };
  const signals = new EventEmitter();
  let runtime = {
    state: 'running', pid: 42,
    capabilities: [GATEWAY_CAPABILITIES.ordinaryBindWake, GATEWAY_CAPABILITIES.runtimeBindLock,
      GATEWAY_CAPABILITIES.ordinaryClaudeBind]
  };
  const channel = {
    id: args['channel-id'], guildId: 'guild', isTextBased: () => true,
    send: () => { throw new Error('preserving handoff must not publish a cutoff fence'); },
    messages: { fetch: () => { throw new Error('handoff must leave history for bounded recovery'); } }
  };
  let fetchChannel = async () => channel;
  class Client {
    constructor() {
      this.guilds = { fetch: async () => ({ channels: { fetch: (...values) => fetchChannel(...values) } }) };
    }
    async login() { calls.login += 1; }
    async destroy() { calls.destroyed += 1; }
  }
  const dependencies = {
    signalSource: signals,
    gatewayProcessStatus: () => runtime,
    acquireHeldLockUntilAvailable: async (lockPath, stopped) => {
      assert.equal(lockPath, path.join(f.dir, 'runtime-bind.lock'));
      assert.equal(stopped(), false);
      calls.acquired += 1;
      return { release() { calls.released += 1; } };
    },
    resolveClaudeCaller: async () => ({ harness: 'claude-code', sessionId: OTHER }),
    requireInstalled: name => {
      assert.equal(name, 'discord.js');
      return { Client, GatewayIntentBits: { Guilds: 1 } };
    },
    readSecret: () => 'disposable-test-secret',
    requestGatewayRecovery: (paths, options) => {
      calls.wakes.push(options.expectedPid);
      assert.equal(options.expectedPid, 42);
      return { requested: true };
    },
    print: value => calls.outputs.push(value)
  };
  return { ...f, args, dependencies, calls, channel, signals,
    setRuntime: value => { runtime = value; },
    setFetchChannel: value => { fetchChannel = value; } };
}

function history(f) {
  return {
    watermark: f.state.getIntakeWatermark(f.binding.channelId),
    children: f.state.listThreadEnrollments(f.binding.channelId),
    messages: f.state.db.prepare('SELECT * FROM messages ORDER BY id').all()
  };
}

test('public ordinary Claude handoff preserves an unavailable parent and child history gap', async t => {
  const f = setup(t);
  f.state.setIntakeBaseline(f.binding.channelId, '200', 'observed after endpoint loss', f.binding);
  f.state.markIntakeBoundary(f.binding.channelId, READINESS.UNAVAILABLE,
    'Claude endpoint unavailable before event write: connect ENOENT', '100', '200', f.binding);
  f.state.enrollThread({ threadId: 'child', parentChannelId: f.binding.channelId, guildId: 'guild', adoptionCutoff: '110' }, f.binding);
  f.state.markThreadBoundary('child', 'unavailable', 'child history unavailable', '110', '170', f.binding);
  const before = history(f);
  const result = await handoffInternal(f.args, f.dependencies);
  assert.equal(result.binding.nativeId, OTHER);
  assert.equal(result.binding.endpoint, f.args.endpoint);
  assert.equal(result.binding.generation, 2);
  assert.equal(result.binding.readiness, READINESS.PENDING);
  assert.equal(f.state.isOrdinaryBindingRecord(result.binding), true);
  assert.deepEqual(history(f), before);
  assert.deepEqual(f.calls.wakes, [42]);
  assert.equal(f.calls.released, 1);
  assert.equal(f.calls.destroyed, 1);
});

test('ordinary Claude handoff exact retry keeps one generation and binds the endpoint', async t => {
  const f = setup(t);
  await handoffInternal(f.args, f.dependencies);
  const before = history(f);
  const retried = await handoffInternal(f.args, f.dependencies);
  assert.equal(retried.handoffReconciled, true);
  assert.equal(retried.binding.generation, 2);
  assert.deepEqual(history(f), before);
  await assert.rejects(() => handoffInternal({ ...f.args, endpoint: path.join(f.dir, 'different.sock') }, f.dependencies), /handoff|successor|endpoint/);
  assert.equal(f.state.getBinding(f.binding.channelId).endpoint, f.args.endpoint);
  assert.equal(f.state.getBinding(f.binding.channelId).generation, 2);
});

test('ordinary Claude handoff derives an omitted workspace from its exact transcript', async t => {
  const f = setup(t);
  const { workspace, ...args } = f.args;
  const result = await handoffInternal(args, f.dependencies);
  assert.equal(result.binding.workspace, workspace);
  assert.equal(result.binding.nativeId, OTHER);
  assert.equal(result.binding.generation, 2);
});

test('ordinary Claude handoff refuses a spoofed caller before any Discord access', async t => {
  const f = setup(t);
  f.dependencies.resolveClaudeCaller = async () => ({ harness: 'claude-code', sessionId: CLAUDE });
  const before = history(f);
  await assert.rejects(() => handoffInternal(f.args, f.dependencies), /current Claude caller/);
  assert.equal(f.calls.login, 0);
  assert.equal(f.calls.released, 1);
  assert.equal(f.state.getBinding(f.binding.channelId).generation, 1);
  assert.deepEqual(history(f), before);
});

test('ordinary Claude handoff uses the real successor transcript and exact workspace', async t => {
  const f = setup(t);
  const wrongSession = transcript(t, f.dir, CLAUDE);
  await assert.rejects(() => handoffInternal({ ...f.args, transcript: wrongSession.file }, f.dependencies));
  const wrongWorkspace = transcript(t, f.dir, OTHER, path.join(f.dir, 'another-workspace'));
  await assert.rejects(() => handoffInternal({ ...f.args, transcript: wrongWorkspace.file }, f.dependencies));
  assert.equal(f.calls.login, 0);
  assert.equal(f.state.getBinding(f.binding.channelId).generation, 1);
  assert.equal(f.calls.released, 2);
});

test('ordinary Claude handoff rejects stale source generation without changing history', async t => {
  const f = setup(t);
  const before = history(f);
  await assert.rejects(() => handoffInternal({ ...f.args, 'from-generation': '2' }, f.dependencies), /stale/);
  assert.equal(f.state.getBinding(f.binding.channelId).nativeId, CLAUDE);
  assert.deepEqual(history(f), before);
  assert.equal(f.calls.wakes.length, 0);
});

test('ordinary Claude handoff retains accepted old-generation work', async t => {
  const f = setup(t);
  f.state.acceptDiscordMessage({ id: '900101', guildId: 'guild', channelId: f.binding.channelId,
    authorId: 'operator', isBot: false, content: 'unresolved instruction' });
  const before = history(f);
  await assert.rejects(() => handoffInternal(f.args, f.dependencies), /unresolved/);
  assert.equal(f.state.getBinding(f.binding.channelId).generation, 1);
  assert.deepEqual(history(f), before);
  assert.equal(f.calls.wakes.length, 0);
});

test('ordinary Claude handoff refuses missing runtime lock capability before identity or network work', async t => {
  const f = setup(t);
  f.setRuntime({ state: 'running', pid: 42,
    capabilities: [GATEWAY_CAPABILITIES.ordinaryBindWake, GATEWAY_CAPABILITIES.ordinaryClaudeBind] });
  f.dependencies.resolveClaudeCaller = async () => { throw new Error('must not resolve caller'); };
  await assert.rejects(() => handoffInternal(f.args, f.dependencies), /does not support ordinary Claude handoff/);
  assert.equal(f.calls.acquired, 0);
  assert.equal(f.calls.login, 0);
  assert.equal(f.state.getBinding(f.binding.channelId).generation, 1);
});

test('ordinary Claude handoff rechecks the Gateway PID after channel access', async t => {
  const f = setup(t);
  f.setFetchChannel(async () => {
    f.setRuntime({ state: 'running', pid: 43,
      capabilities: [GATEWAY_CAPABILITIES.ordinaryBindWake, GATEWAY_CAPABILITIES.runtimeBindLock,
        GATEWAY_CAPABILITIES.ordinaryClaudeBind] });
    return f.channel;
  });
  const before = history(f);
  await assert.rejects(() => handoffInternal(f.args, f.dependencies), /Gateway changed/);
  assert.equal(f.state.getBinding(f.binding.channelId).generation, 1);
  assert.deepEqual(history(f), before);
  assert.equal(f.calls.released, 1);
  assert.equal(f.calls.destroyed, 1);
  assert.equal(f.calls.wakes.length, 0);
});

test('ordinary Claude handoff cancellation before mutation releases resources and preserves state', async t => {
  const f = setup(t);
  f.setFetchChannel(async () => {
    f.signals.emit('SIGTERM');
    return f.channel;
  });
  const before = history(f);
  await assert.rejects(() => handoffInternal(f.args, f.dependencies), /was stopped/);
  assert.equal(f.state.getBinding(f.binding.channelId).generation, 1);
  assert.deepEqual(history(f), before);
  assert.equal(f.calls.released, 1);
  assert.equal(f.calls.destroyed, 1);
});

test('ordinary Claude handoff wake failure retains its committed successor for exact retry', async t => {
  const f = setup(t);
  const wake = f.dependencies.requestGatewayRecovery;
  f.dependencies.requestGatewayRecovery = () => { throw new Error('wake unavailable'); };
  const before = history(f);
  await assert.rejects(() => handoffInternal(f.args, f.dependencies), /wake unavailable/);
  assert.equal(f.state.getBinding(f.binding.channelId).nativeId, OTHER);
  assert.equal(f.state.getBinding(f.binding.channelId).generation, 2);
  assert.equal(f.state.getBinding(f.binding.channelId).readiness, READINESS.PENDING);
  assert.deepEqual(history(f), before);
  f.dependencies.requestGatewayRecovery = wake;
  const result = await handoffInternal(f.args, f.dependencies);
  assert.equal(result.handoffReconciled, true);
  assert.equal(result.binding.generation, 2);
});

test('ordinary handoff flag policy keeps Claude evidence separate from Codex session-root', () => {
  const common = ['handoff', '--ordinary', '--provider', 'claude', '--endpoint', '/tmp/new.sock', '--transcript', '/tmp/current.jsonl'];
  assert.equal(parseArgs(common).args.transcript, '/tmp/current.jsonl');
  assert.throws(() => parseArgs([...common, '--session-root', '/tmp/codex']), /unknown --session-root/);
  assert.throws(() => parseArgs(['handoff', '--ordinary', '--provider', 'codex', '--transcript', '/tmp/current.jsonl']), /unknown --transcript/);
  assert.equal(parseArgs(['handoff', '--ordinary', '--provider', 'codex', '--session-root', '/tmp/codex']).args['session-root'], '/tmp/codex');
});

test('ordinary Claude bind refusal points to the explicit proof-bearing handoff', () => {
  const existing = { provider: 'claude', nativeId: CLAUDE, channelId: 'channel', guildId: 'guild',
    workspace: '/workspace', endpoint: '/tmp/old.sock', active: true, generation: 1 };
  const request = { provider: 'claude', nativeId: OTHER, channelId: 'channel', guildId: 'guild',
    workspace: '/workspace', endpoint: '/tmp/new.sock', identity: { sessionId: OTHER, threadId: OTHER, harness: 'claude-code' } };
  assert.throws(() => ordinaryBindingDecision(existing, request, true), error => {
    assert.match(error.message, /handoff --ordinary --provider claude/);
    assert.match(error.message, /--from-generation 1/);
    assert.match(error.message, /--endpoint \/tmp\/new.sock --transcript/);
    return true;
  });
});
