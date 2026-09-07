const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createOrdinaryClaudeRequest, ordinaryBindingDecision, resolveExistingChannel } = require('../src/ordinary-codex');
const { createClaudeMonitor } = require('../src/claude-monitor');
const { ordinaryClaudeBind } = require('../src/cli');
const { DiscordGateway } = require('../src/discord');
const { ClaudeProvider, dispatchAndObserve, postUnixJson, probeUnixSocket, validateClaudeSessionIdentity, waitForReply } = require('../src/native');
const { MESSAGE_STATES, READINESS, SurfaceState, StaleGenerationError } = require('../src/state');
const { runDirectPost } = require('../src/direct-post');

const CLAUDE = '79e3da8e-94b4-4aff-8f88-b45b3a451dd1';
const OTHER = '9caa5d21-2169-429d-918b-5f08651b5dbd';
const CLI_PATH = path.resolve(__dirname, '../src/cli.js');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(10);
  }
  throw new Error('timed out waiting for ordinary Claude condition');
}

function transcript(t, workspace, nativeId = CLAUDE, cwd = workspace) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinary-claude-transcript-'));
  const file = path.join(root, 'session.jsonl');
  fs.writeFileSync(file, [
    JSON.stringify({ type: 'custom-title', sessionId: nativeId }),
    JSON.stringify({ type: 'attachment', sessionId: nativeId, cwd, entrypoint: 'cli', version: '1.0.0', attachment: { hookEvent: 'SessionStart' } })
  ].join('\n') + '\n');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, file };
}

function fixture(t, { bind = true, endpoint = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinary-claude-'));
  const db = path.join(dir, 'surface.sqlite');
  const state = new SurfaceState(db);
  state.setConfig({ operatorId: 'operator', guildId: 'guild', secretFile: path.join(dir, 'discord.env') });
  const socketPath = endpoint || path.join(dir, 'claude.sock');
  const session = transcript(t, dir);
  let binding = null;
  if (bind) {
    binding = state.bindOrdinaryClaude({ channelId: 'claude-channel', guildId: 'guild', provider: 'claude', nativeId: CLAUDE, workspace: dir, endpoint: socketPath },
      { sessionId: CLAUDE, threadId: CLAUDE, harness: 'claude-code' });
    state.recordOrdinaryPreflight(binding, {
      file: session.file, sessionId: CLAUDE, threadId: CLAUDE, workspace: dir, endpoint: socketPath, harness: 'claude-code'
    });
  }
  t.after(() => {
    try { state.close(); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, db, state, socketPath, session, binding };
}

function fakeClient(channel) {
  return class FakeClient {
    constructor() {
      this.guilds = { fetch: async () => ({ channels: {
        fetch: async selection => selection ? channel : new Map([[channel.id, channel]])
      } }) };
    }
    async login() {}
    async destroy() {}
  };
}

test('ordinary Claude request requires exact harness, UUID, endpoint, and transcript workspace', t => {
  const f = fixture(t, { bind: false });
  const proof = validateClaudeSessionIdentity(CLAUDE, f.session.file);
  assert.equal(proof.sessionId, CLAUDE);
  assert.equal(proof.threadId, CLAUDE);
  assert.equal(proof.workspace, f.dir);
  assert.throws(() => validateClaudeSessionIdentity(CLAUDE, f.session.file, '/tmp/other-workspace'), /does not match/);
  const wrong = transcript(t, f.dir, OTHER);
  assert.throws(() => validateClaudeSessionIdentity(CLAUDE, wrong.file), /identity or workspace/);
  assert.throws(() => createOrdinaryClaudeRequest({
    channelId: 'channel', guildId: 'guild', nativeId: OTHER, workspace: f.dir, endpoint: f.socketPath,
    identity: { sessionId: CLAUDE, threadId: CLAUDE, harness: 'claude-code' }
  }), /conflicts/);
  assert.throws(() => createOrdinaryClaudeRequest({
    channelId: 'channel', guildId: 'guild', workspace: f.dir, endpoint: f.socketPath,
    identity: { sessionId: CLAUDE, threadId: CLAUDE, harness: 'codex' }
  }), /harness/);
});

test('ordinary Claude selection and same-owner decision preserve channel custody', () => {
  const channels = [
    { id: '123', guildId: 'guild', name: 'ops', messageCapable: true },
    { id: '456', guildId: 'guild', name: 'dev', messageCapable: true },
    { id: '789', guildId: 'other', name: 'ops', messageCapable: true },
    { id: 'cat', guildId: 'guild', name: 'category', messageCapable: false }
  ];
  assert.equal(resolveExistingChannel('123', 'guild', channels).id, '123');
  assert.equal(resolveExistingChannel('<#456>', 'guild', channels).id, '456');
  assert.equal(resolveExistingChannel('#dev', 'guild', channels).id, '456');
  assert.throws(() => resolveExistingChannel('<#789>', 'guild', channels), /outside/);
  assert.throws(() => resolveExistingChannel('#category', 'guild', channels), /message-capable/);
  const request = {
    provider: 'claude', channelId: 'channel', guildId: 'guild', nativeId: CLAUDE, workspace: '/tmp/workspace', endpoint: '/tmp/claude.sock',
    identity: { sessionId: CLAUDE, threadId: CLAUDE, harness: 'claude-code' }
  };
  assert.equal(ordinaryBindingDecision(null, request), 'bind');
  assert.equal(ordinaryBindingDecision({ ...request, active: true }, request, true), 'reuse');
  assert.equal(ordinaryBindingDecision({ ...request, active: false }, request, true), 'rebind');
  assert.throws(() => ordinaryBindingDecision({ ...request, endpoint: '/tmp/other.sock', active: true }, request, true), /already bound/);
  assert.throws(() => ordinaryBindingDecision({ ...request, conductorId: 'owner', active: true }, request, false), /already bound/);
});

test('ordinary Claude bind uses exact caller and transcript, reuses and rebinds only same owner', async t => {
  const f = fixture(t, { bind: false });
  const channel = { id: 'claude-channel', guildId: 'guild', name: 'dev', isTextBased: () => true };
  const deps = {
    resolveClaudeCaller: () => ({ sessionId: CLAUDE, harness: 'claude-code', caller: { pid: 12, processStartTime: 34 } }),
    requireInstalled: () => ({ Client: fakeClient(channel), GatewayIntentBits: { Guilds: 1 } }),
    readSecret: () => 'fixture-token',
    gatewayProcessStatus: () => ({ state: 'stopped' }),
    print: () => {}
  };
  const args = { 'state-dir': f.dir, channel: '#dev', transcript: f.session.file, socket: f.socketPath };
  const first = await ordinaryClaudeBind(args, deps);
  const second = await ordinaryClaudeBind(args, deps);
  assert.equal(first.reused, false);
  assert.equal(second.reused, true);
  assert.equal(first.binding.provider, 'claude');
  assert.equal(first.binding.readiness, READINESS.PENDING);
  assert.equal(first.nativeProof.status, 'verified');
  assert.equal(first.monitor.status, 'pending');
  const tombstone = new SurfaceState(f.db);
  tombstone.unbind(channel.id);
  tombstone.close();
  const rebound = await ordinaryClaudeBind(args, deps);
  assert.equal(rebound.reused, false);
  assert.equal(rebound.binding.generation, 2);
  const otherSession = transcript(t, f.dir, OTHER);
  await assert.rejects(() => ordinaryClaudeBind({ ...args, transcript: otherSession.file }, {
    ...deps,
    resolveClaudeCaller: () => ({ sessionId: OTHER, harness: 'claude-code', caller: { pid: 12, processStartTime: 34 } })
  }), /already bound/);
});

test('ordinary Claude Monitor readiness is unavailable without a live socket and holds intake', async t => {
  const f = fixture(t);
  const channel = {
    id: f.binding.channelId,
    guildId: 'guild',
    permissionsFor: () => ({ has: () => true })
  };
  const gateway = new DiscordGateway({
    state: f.state,
    client: { user: { id: 'bot' }, channels: { fetch: async () => channel }, on() {}, off() {}, async destroy() {} },
    fetchHistory: async () => [],
    providers: { claude: { async dispatch() { throw new Error('must stay held'); } } }
  });
  gateway.historyPermission = () => ({ known: true, allowed: true });
  const recovery = await gateway.recoverTransport('monitor-unavailable', 0);
  assert.equal(recovery.ready, false);
  assert.equal(f.state.getBinding(f.binding.channelId).readiness, READINESS.UNAVAILABLE);
  const accepted = f.state.acceptDiscordMessage({
    id: 'held-without-monitor', guildId: 'guild', channelId: f.binding.channelId,
    authorId: 'operator', isBot: false, content: 'hold this'
  }, { ready: false });
  assert.equal(accepted.accepted, true);
  assert.equal(f.state.claimDispatch(accepted.message.id).reason, 'binding-not-ready');
  assert.equal(f.state.getMessage(accepted.message.id).state, MESSAGE_STATES.ACCEPTED);
  await assert.rejects(() => probeUnixSocket(f.socketPath), /connect|socket|ENOENT|refused/i);
  await gateway.stop();
});

test('ordinary Claude Monitor process promotes readiness and revokes it on stop', async t => {
  const f = fixture(t);
  f.state.close();
  const child = spawn(process.execPath, [CLI_PATH, 'claude-monitor', '--state-dir', f.dir, '--db', f.db, '--native-id', CLAUDE, '--socket', f.socketPath], {
    stdio: ['ignore', 'pipe', 'pipe']
  });
  t.after(async () => {
    if (child.exitCode === null) child.kill('SIGTERM');
  });
  const observed = new SurfaceState(f.db);
  await waitFor(() => fs.existsSync(f.socketPath) && observed.getBinding(f.binding.channelId)?.readiness === READINESS.READY);
  assert.equal(observed.getBinding(f.binding.channelId).readiness, READINESS.READY);
  child.kill('SIGTERM');
  await new Promise((resolve, reject) => {
    child.once('close', resolve);
    child.once('error', reject);
  });
  await waitFor(() => observed.getBinding(f.binding.channelId)?.readiness === READINESS.UNAVAILABLE);
  assert.equal(fs.existsSync(f.socketPath), false);
  observed.close();
});

test('real ClaudeProvider and Claude Monitor path preserves exact reply custody', async t => {
  const f = fixture(t);
  const stdout = new EventEmitter();
  const events = [];
  stdout.write = (chunk, callback) => {
    events.push(JSON.parse(String(chunk)));
    callback?.();
    return true;
  };
  const monitor = createClaudeMonitor({ state: f.state, nativeId: CLAUDE, socketPath: f.socketPath, stateDir: f.dir, dbPath: f.db, stdout });
  await monitor.start();
  f.state.setBindingReadiness(f.binding.channelId, READINESS.READY, 'test Monitor ready', f.binding);
  const intake = f.state.acceptDiscordMessage({
    id: 'ordinary-claude-event', guildId: 'guild', channelId: f.binding.channelId,
    authorId: 'operator', isBot: false, content: 'answer this'
  });
  assert.equal(intake.accepted, true);
  const provider = new ClaudeProvider({ waitForReply: (id, options) => waitForReply(f.state, id, options) });
  const work = dispatchAndObserve(f.state, intake.message.id, { claude: provider }, { timeoutMs: 3000, pollMs: 5 });
  await waitFor(() => events.length === 1);
  const pointer = events[0];
  const payload = JSON.parse(fs.readFileSync(pointer.payloadPath, 'utf8'));
  assert.equal(payload.meta.nativeId, CLAUDE);
  assert.equal(payload.meta.messageId, intake.message.id);
  const duplicate = await postUnixJson(f.socketPath, { nativeId: CLAUDE, messageId: intake.message.id, generation: 1, content: 'duplicate' });
  assert.equal(duplicate.statusCode, 202);
  f.state.recordNativeReply({ provider: 'claude', messageId: intake.message.id, nativeId: CLAUDE, generation: 1, text: 'Claude answer' });
  const result = await work;
  assert.equal(result.message.state, MESSAGE_STATES.REPLY_READY);
  assert.equal(f.state.getMessage(intake.message.id).replyText, 'Claude answer');
  await monitor.stop();
});

test('ordinary Claude post preserves dedupe and stale generation custody', async t => {
  const f = fixture(t);
  const textFile = path.join(f.dir, 'milestone.txt');
  fs.writeFileSync(textFile, 'ordinary Claude milestone');
  let calls = 0;
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ id: `milestone-${++calls}` }) });
  const first = await runDirectPost({ state: f.state, token: 'fixture', nativeId: CLAUDE, generation: 1, channelId: f.binding.channelId,
    provider: 'claude', ordinary: true, textFile, dedupeKey: 'ordinary-claude-milestone', fetchImpl });
  const duplicate = await runDirectPost({ state: f.state, token: 'fixture', nativeId: CLAUDE, generation: 1, channelId: f.binding.channelId,
    provider: 'claude', ordinary: true, textFile, dedupeKey: 'ordinary-claude-milestone', fetchImpl });
  assert.equal(first.status, 'sent');
  assert.equal(duplicate.duplicate, true);
  assert.equal(calls, 1);
  f.state.unbind(f.binding.channelId);
  const rebound = f.state.rebindOrdinaryClaude({ channelId: f.binding.channelId, guildId: 'guild', provider: 'claude', nativeId: CLAUDE, workspace: f.dir, endpoint: f.socketPath },
    { sessionId: CLAUDE, threadId: CLAUDE, harness: 'claude-code' });
  assert.equal(rebound.generation, 2);
  await assert.rejects(() => runDirectPost({ state: f.state, token: 'fixture', nativeId: CLAUDE, generation: 1, channelId: f.binding.channelId,
    provider: 'claude', ordinary: true, textFile, dedupeKey: 'stale-claude', fetchImpl }), error => error instanceof StaleGenerationError);
});
