const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const ts = require('typescript');
const { handoffInternal, parseArgs, GATEWAY_CAPABILITIES } = require('../src/cli');
const { writePid } = require('../src/cli/runtime-custody');
const { READINESS } = require('../src/state');
const { ordinaryBindingDecision } = require('../src/ordinary-codex');
const { CLAUDE, OTHER, fixture, transcript } = require('./ordinary-claude-scenarios/fixture.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const SRC_ROOT = path.join(REPO_ROOT, 'src');
const ORDINARY_CALLSITE_COUNTS = new Map([
  ['src/cli/ordinary-handoff.js\u0000handoffOrdinary', 2],
  ['src/cli/ordinary-claude-handoff.js\u0000handoffOrdinary', 1],
  ['src/ordinary-bind/index.js\u0000ordinaryBindingDecision', 3],
  ['src/ordinary-bind/codex.js\u0000ordinaryBindingDecision', 3]
]);

function parseOrdinaryCallsites(file, source) {
  const kind = file.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
  const callsites = [];
  const visit = node => {
    if (ts.isCallExpression(node)) {
      const expression = node.expression;
      if (ts.isPropertyAccessExpression(expression) && expression.name.text === 'handoffOrdinary' &&
        ts.isIdentifier(expression.expression) && expression.expression.text === 'state') {
        callsites.push({ file, kind: 'handoffOrdinary' });
      }
      if (ts.isIdentifier(expression) && expression.text === 'ordinaryBindingDecision') {
        callsites.push({ file, kind: 'ordinaryBindingDecision' });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return callsites;
}

function sourceFiles(root) {
  return fs.readdirSync(root, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap(entry => {
      const full = path.join(root, entry.name);
      if (entry.isDirectory()) return sourceFiles(full);
      return /\.(?:js|ts)$/.test(entry.name) ? [full] : [];
    });
}

function classifyOrdinaryCallsites(callsites) {
  const counts = new Map();
  for (const callsite of callsites) {
    const key = `${callsite.file}\u0000${callsite.kind}`;
    if (!ORDINARY_CALLSITE_COUNTS.has(key)) throw new Error(`unclassified ordinary callsite: ${key}`);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  assert.deepEqual(counts, ORDINARY_CALLSITE_COUNTS, 'ordinary callsites classify exactly');
}

function enumerateOrdinaryCallsites() {
  return sourceFiles(SRC_ROOT).flatMap(full => {
    const file = path.relative(REPO_ROOT, full).split(path.sep).join('/');
    return parseOrdinaryCallsites(file, fs.readFileSync(full, 'utf8'));
  });
}

function supportedHandoffCapabilities() {
  return [GATEWAY_CAPABILITIES.ordinaryBindWake, GATEWAY_CAPABILITIES.runtimeBindLock,
    GATEWAY_CAPABILITIES.ordinaryClaudeBind, GATEWAY_CAPABILITIES.ordinaryClaudeHandoff];
}

function setup(t) {
  const f = fixture(t);
  const successor = transcript(t, f.dir, OTHER);
  const args = {
    ordinary: true, provider: 'claude', 'state-dir': f.dir, db: f.db,
    'channel-id': f.binding.channelId, 'from-native-id': CLAUDE, 'from-generation': '1',
    'native-id': OTHER, workspace: f.dir, endpoint: path.join(f.dir, 'successor.sock'),
    transcript: successor.file, 'handoff-id': 'claude-successor'
  };
  const calls = { acquired: 0, released: 0, login: 0, destroyed: 0, resolvedCaller: 0, wakes: [], outputs: [] };
  const signals = new EventEmitter();
  let runtime = {
    state: 'running', pid: 42,
    capabilities: supportedHandoffCapabilities()
  };
  const channel = {
    id: args['channel-id'], name: args['channel-id'], guildId: 'guild', isTextBased: () => true,
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
    resolveClaudeCaller: async () => {
      calls.resolvedCaller += 1;
      return { harness: 'claude-code', sessionId: OTHER };
    },
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
    messages: f.state.db.prepare('SELECT * FROM messages ORDER BY discord_id').all()
  };
}

test('ordinary handoff and binding decision callsites stay finite', () => {
  const baseline = enumerateOrdinaryCallsites();
  classifyOrdinaryCallsites(baseline);
  const syntheticHandoff = parseOrdinaryCallsites('src/ordinary-bind/new-owner.js', 'state.handoffOrdinary({});');
  assert.equal(syntheticHandoff.length, 1);
  assert.throws(() => classifyOrdinaryCallsites([...baseline, ...syntheticHandoff]), /unclassified ordinary callsite/);
  const syntheticDecision = parseOrdinaryCallsites('src/ordinary-bind/new-decision-owner.js', 'ordinaryBindingDecision(null, null);');
  assert.equal(syntheticDecision.length, 1);
  assert.throws(() => classifyOrdinaryCallsites([...baseline, ...syntheticDecision]), /unclassified ordinary callsite/);
});

test('runtime PID advertisement includes ordinary Claude handoff capability', t => {
  const f = fixture(t, { bind: false });
  const pidFile = path.join(f.dir, 'runtime.pid');
  writePid(pidFile, 'guild', f.dir, f.db);
  const record = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
  assert.equal(GATEWAY_CAPABILITIES.ordinaryClaudeHandoff, 'ordinary-claude-handoff-v1');
  assert.ok(record.capabilities.includes(GATEWAY_CAPABILITIES.ordinaryClaudeHandoff));
});

test('ordinary Claude handoff canonicalizes an absolute endpoint', async t => {
  const f = setup(t);
  const endpoint = `${f.dir}/nested/../successor.sock`;
  const result = await handoffInternal({ ...f.args, endpoint }, f.dependencies);
  assert.equal(result.binding.endpoint, path.resolve(endpoint));
});

test('ordinary Claude handoff refuses a relative endpoint', async t => {
  const f = setup(t);
  const before = history(f);
  await assert.rejects(() => handoffInternal({ ...f.args, endpoint: 'successor.sock' }, f.dependencies), /absolute/);
  assert.equal(f.calls.resolvedCaller, 0);
  assert.equal(f.calls.login, 0);
  assert.equal(f.state.getBinding(f.binding.channelId).generation, 1);
  assert.deepEqual(history(f), before);
});

test('ordinary Claude handoff refuses missing and empty endpoints before caller resolution', async t => {
  for (const endpoint of [undefined, '']) {
    const f = setup(t);
    const before = history(f);
    await assert.rejects(() => handoffInternal({ ...f.args, endpoint }, f.dependencies), /missing --endpoint/);
    assert.equal(f.calls.resolvedCaller, 0);
    assert.equal(f.calls.login, 0);
    assert.equal(f.state.getBinding(f.binding.channelId).generation, 1);
    assert.deepEqual(history(f), before);
  }
});

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

test('ordinary Claude handoff refuses old, missing, and empty running capabilities', async t => {
  const supported = supportedHandoffCapabilities();
  const runtimes = [
    { state: 'running', pid: 42, capabilities: supported.filter(capability => capability !== GATEWAY_CAPABILITIES.ordinaryClaudeHandoff) },
    { state: 'running', pid: 42, capabilities: supported.filter(capability => capability !== GATEWAY_CAPABILITIES.runtimeBindLock) },
    { state: 'running', pid: 42, capabilities: supported.filter(capability => capability !== GATEWAY_CAPABILITIES.ordinaryClaudeBind) },
    { state: 'running', pid: 42 },
    { state: 'running', pid: 42, capabilities: [] }
  ];
  for (const runtime of runtimes) {
    const f = setup(t);
    f.setRuntime(runtime);
    f.dependencies.resolveClaudeCaller = async () => { throw new Error('must not resolve caller'); };
    await assert.rejects(() => handoffInternal(f.args, f.dependencies), /does not support ordinary (binding wake|Claude handoff)/);
    assert.equal(f.calls.acquired, 0);
    assert.equal(f.calls.login, 0);
    assert.equal(f.calls.wakes.length, 0);
    assert.equal(f.state.getBinding(f.binding.channelId).generation, 1);
  }
});

test('ordinary Claude handoff refuses same-PID capability loss under the lock', async t => {
  const f = setup(t);
  const acquire = f.dependencies.acquireHeldLockUntilAvailable;
  f.dependencies.acquireHeldLockUntilAvailable = async (lockPath, stopped) => {
    const lock = await acquire(lockPath, stopped);
    f.setRuntime({ state: 'running', pid: 42, capabilities: supportedHandoffCapabilities().slice(0, -1) });
    return lock;
  };
  f.dependencies.resolveClaudeCaller = async () => { throw new Error('must not resolve caller'); };
  await assert.rejects(() => handoffInternal(f.args, f.dependencies), /does not support ordinary Claude handoff/);
  assert.equal(f.calls.acquired, 1);
  assert.equal(f.calls.released, 1);
  assert.equal(f.calls.login, 0);
  assert.equal(f.state.getBinding(f.binding.channelId).generation, 1);
});

test('stopped Gateway needs no handoff capability', async t => {
  const f = setup(t);
  f.setRuntime({ state: 'stopped', pid: null, capabilities: [] });
  f.dependencies.acquireHeldLockUntilAvailable = async (lockPath, stopped) => {
    assert.equal(lockPath, path.join(f.dir, 'runtime.lock'));
    assert.equal(stopped(), false);
    f.calls.acquired += 1;
    return { release() { f.calls.released += 1; } };
  };
  f.dependencies.requestGatewayRecovery = (_paths, options) => {
    assert.equal(options.expectedPid, undefined);
    return { requested: true };
  };
  const result = await handoffInternal(f.args, f.dependencies);
  assert.equal(result.binding.generation, 2);
  assert.equal(f.calls.acquired, 1);
  assert.equal(f.calls.released, 1);
});

test('ordinary Claude handoff rechecks the Gateway PID after channel access', async t => {
  const f = setup(t);
  f.setFetchChannel(async () => {
    f.setRuntime({ state: 'running', pid: 43,
      capabilities: supportedHandoffCapabilities() });
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
  f.dependencies.requireInstalled = () => { throw new Error('Discord unavailable during exact retry'); };
  f.setFetchChannel(() => { throw new Error('Discord channel unavailable during exact retry'); });
  const result = await handoffInternal(f.args, f.dependencies);
  assert.equal(result.handoffReconciled, true);
  assert.equal(result.binding.generation, 2);
  assert.equal(f.calls.login, 1);
  assert.deepEqual(history(f), before);
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

test('ordinary binding advice refuses cross-provider handoffs', () => {
  const claudeExisting = { provider: 'claude', nativeId: CLAUDE, channelId: 'channel', guildId: 'guild',
    workspace: '/workspace', endpoint: '/tmp/old.sock', active: true, generation: 1 };
  const codexExisting = { ...claudeExisting, provider: 'codex', endpoint: undefined };
  const claudeRequest = { provider: 'claude', nativeId: OTHER, channelId: 'channel', guildId: 'guild',
    workspace: '/workspace', endpoint: '/tmp/new.sock', identity: { sessionId: OTHER, threadId: OTHER, harness: 'claude-code' } };
  const codexRequest = { ...claudeRequest, provider: 'codex', endpoint: undefined, sessionRoot: '/workspace/.codex' };
  for (const [existing, request] of [[codexExisting, claudeRequest], [claudeExisting, codexRequest]]) {
    assert.throws(() => ordinaryBindingDecision(existing, request, true), error => {
      assert.match(error.message, /incompatible owner/);
      assert.doesNotMatch(error.message, /handoff --ordinary/);
      return true;
    });
  }
});

test('ordinary binding advice rejects same-UUID mismatches after valid identity decisions', () => {
  const claudeExisting = { provider: 'claude', nativeId: CLAUDE, channelId: 'channel', guildId: 'guild',
    workspace: '/workspace', endpoint: '/tmp/old.sock', active: true, generation: 1 };
  const claudeRequest = { provider: 'claude', nativeId: CLAUDE, channelId: 'channel', guildId: 'guild',
    workspace: '/workspace', endpoint: '/tmp/new.sock', identity: { sessionId: CLAUDE, threadId: CLAUDE, harness: 'claude-code' } };
  assert.throws(() => ordinaryBindingDecision(claudeExisting, claudeRequest, true), /same native session/);

  const codexExisting = { provider: 'codex', nativeId: OTHER, channelId: 'channel', guildId: 'guild',
    workspace: '/workspace', sessionRoot: '/workspace/.codex', active: true, generation: 1 };
  const codexRequest = { provider: 'codex', nativeId: OTHER, channelId: 'channel', guildId: 'guild',
    workspace: '/other-workspace', sessionRoot: '/workspace/.codex', identity: { sessionId: OTHER, threadId: OTHER } };
  assert.throws(() => ordinaryBindingDecision(codexExisting, codexRequest, true), /same native session/);
  assert.throws(() => ordinaryBindingDecision(codexExisting, {
    ...codexRequest, workspace: codexExisting.workspace, sessionRoot: '/workspace/.next-codex'
  }, true), /same native session/);

  const reuse = ordinaryBindingDecision(claudeExisting, {
    ...claudeRequest, endpoint: claudeExisting.endpoint
  }, true);
  assert.equal(reuse, 'reuse');
  const rebind = ordinaryBindingDecision({ ...claudeExisting, active: false }, {
    ...claudeRequest, endpoint: claudeExisting.endpoint
  }, true);
  assert.equal(rebind, 'rebind');
  const relocation = ordinaryBindingDecision(codexExisting, {
    ...codexRequest, workspace: codexExisting.workspace, sessionRoot: '/workspace/.next-codex'
  }, true, {
    file: '/tmp/codex-session.jsonl', sessionId: OTHER, threadId: OTHER,
    workspace: codexExisting.workspace, sessionRoot: '/workspace/.next-codex'
  });
  assert.equal(relocation, 'rebind');
});
