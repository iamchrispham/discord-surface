const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createOrdinaryCodexRequestFromEnvironment, resolveExistingChannel, resolveInvocationIdentity } = require('../src/ordinary-codex');
const { DiscordGateway } = require('../src/discord');
const { validateCodexSessionIdentity } = require('../src/native');
const { SurfaceState, READINESS, StaleGenerationError } = require('../src/state');
const { runDirectPost } = require('../src/direct-post');
const facade = require('../src/ordinary-codex');
const emitted = require('../dist/ordinary-codex');

const CODEX = '9caa5d21-2169-429d-918b-5f08651b5dbd';
const CODEX_V7 = '01a0701c-5714-7671-a455-db7d67f9fa78';
const OTHER = '79e3da8e-94b4-4aff-8f88-b45b3a451dd1';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinary-codex-'));
  const state = new SurfaceState(path.join(dir, 'surface.sqlite'));
  state.setConfig({ operatorId: 'operator', guildId: 'guild', secretFile: path.join(dir, 'discord.env') });
  const identity = { sessionId: CODEX, threadId: CODEX };
  t.after(() => {
    state.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, identity, state };
}

function ordinary(fixtureState, channelId = 'ordinary-channel', nativeId = CODEX) {
  return fixtureState.state.bindOrdinary({
    channelId, guildId: 'guild', provider: 'codex', nativeId, workspace: fixtureState.dir
  }, { sessionId: nativeId, threadId: nativeId });
}

function transcript(t, workspace, id = CODEX, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinary-transcript-'));
  const file = path.join(root, `${id}.jsonl`);
  fs.writeFileSync(file, `${JSON.stringify({ type: 'session_meta', payload: {
    session_id: id, id, cwd: workspace, ...overrides
  } })}\n`);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, file };
}

test('typed ordinary request rejects missing or conflicting invocation identity', () => {
  assert.throws(() => resolveInvocationIdentity({ CODEX_SESSION_ID: CODEX, PWD: '/tmp/workspace' }), /CODEX_THREAD_ID/);
  assert.throws(() => resolveInvocationIdentity({ CODEX_SESSION_ID: CODEX, CODEX_THREAD_ID: OTHER, PWD: '/tmp/workspace' }), /conflict/);
  assert.throws(() => createOrdinaryCodexRequestFromEnvironment({
    channelId: 'channel', guildId: 'guild', workspace: '/tmp/workspace', nativeId: OTHER,
    environment: { CODEX_SESSION_ID: CODEX, CODEX_THREAD_ID: CODEX, PWD: '/tmp/workspace' }
  }), /conflicts/);
  const request = createOrdinaryCodexRequestFromEnvironment({
    channelId: 'channel', guildId: 'guild', workspace: '/tmp/workspace',
    environment: { CODEX_SESSION_ID: CODEX, CODEX_THREAD_ID: CODEX, PWD: '/tmp/workspace' }
  });
  assert.deepEqual(request.identity, { sessionId: CODEX, threadId: CODEX });
  assert.equal(request.nativeId, CODEX);
  assert.equal(resolveInvocationIdentity({ CODEX_SESSION_ID: CODEX_V7, CODEX_THREAD_ID: CODEX_V7, PWD: '/tmp/workspace' }).sessionId, CODEX_V7);
});

test('ordinary CommonJS facade exposes emitted code and fails closed when output is absent', () => {
  assert.equal(facade.resolveExistingChannel, emitted.resolveExistingChannel);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinary-codex-missing-'));
  try {
    fs.mkdirSync(path.join(root, 'src'));
    fs.copyFileSync(path.resolve(__dirname, '../src/ordinary-codex.js'), path.join(root, 'src/ordinary-codex.js'));
    const result = spawnSync(process.execPath, ['-e', "require('./src/ordinary-codex')"], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /run npm run build before starting/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('channel resolution accepts exact ID, mention, and one name only in the configured guild', () => {
  const channels = [
    { id: '123', guildId: 'guild', name: 'ops' },
    { id: '456', guildId: 'guild', name: 'dev' },
    { id: '999', guildId: 'guild', name: 'ops' },
    { id: '789', guildId: 'other-guild', name: 'ops' }
  ];
  assert.equal(resolveExistingChannel('123', 'guild', channels).name, 'ops');
  assert.equal(resolveExistingChannel('<#456>', 'guild', channels).name, 'dev');
  assert.equal(resolveExistingChannel('dev', 'guild', channels).id, '456');
  assert.throws(() => resolveExistingChannel('ops', 'guild', channels), /ambiguous/);
  assert.throws(() => resolveExistingChannel('<#789>', 'guild', channels), /outside/);
  assert.throws(() => resolveExistingChannel('missing', 'guild', channels), /unknown/);
});

test('ordinary bind starts pending with paired null conductor identity and holds intake', t => {
  const f = fixture(t);
  const binding = ordinary(f);
  assert.equal(binding.readiness, READINESS.PENDING);
  assert.equal(binding.conductorId, null);
  assert.equal(binding.repoKey, null);
  assert.equal(f.state.isOrdinaryBinding(binding), true);
  const accepted = f.state.acceptDiscordMessage({
    id: 'pending-input', guildId: 'guild', channelId: binding.channelId,
    authorId: 'operator', isBot: false, content: 'held'
  }, { ready: false });
  assert.equal(accepted.accepted, true);
  assert.equal(f.state.claimDispatch('pending-input').reason, 'binding-not-ready');
  assert.equal(f.state.getMessage('pending-input').state, 'accepted');
  assert.throws(() => f.state.bindOrdinary({
    channelId: 'second-channel', guildId: 'guild', provider: 'codex', nativeId: CODEX, workspace: f.dir
  }, f.identity), /already owned/);
  assert.throws(() => f.state.bindOrdinary({
    channelId: binding.channelId, guildId: 'guild', provider: 'codex', nativeId: OTHER, workspace: f.dir
  }, { sessionId: OTHER, threadId: OTHER }), /already bound/);
});

test('native preflight requires exact session metadata and workspace', t => {
  const f = fixture(t);
  const matching = transcript(t, f.dir);
  const proof = validateCodexSessionIdentity(CODEX, f.dir, matching.root);
  assert.equal(proof.file, matching.file);
  const wrongWorkspace = transcript(t, '/tmp/other-workspace');
  assert.throws(() => validateCodexSessionIdentity(CODEX, f.dir, wrongWorkspace.root), /workspace/);
  const wrongIdentity = transcript(t, f.dir, CODEX, { id: OTHER });
  assert.throws(() => validateCodexSessionIdentity(CODEX, f.dir, wrongIdentity.root), /identity/);
});

test('ordinary readiness requires native proof before the intake boundary can become ready', t => {
  const f = fixture(t);
  const binding = ordinary(f);
  assert.throws(() => f.state.markIntakeBoundary(binding.channelId, 'ready', 'history complete', null, null, binding), /preflight/);
  assert.throws(() => f.state.recordOrdinaryPreflight(binding, { file: '/tmp/exact.jsonl', sessionId: OTHER, threadId: OTHER, workspace: f.dir }), /does not match/);
  f.state.recordOrdinaryPreflight(binding, { file: '/tmp/exact.jsonl', sessionId: CODEX, threadId: CODEX, workspace: f.dir });
  f.state.markIntakeBoundary(binding.channelId, 'ready', 'history complete', null, null, binding);
  assert.equal(f.state.getBinding(binding.channelId).readiness, READINESS.READY);
});

test('Gateway repeats ordinary native preflight on reconnect before promoting intake', async t => {
  const f = fixture(t);
  const session = transcript(t, f.dir);
  const binding = ordinary(f);
  const held = f.state.acceptDiscordMessage({
    id: 'held-input', guildId: 'guild', channelId: binding.channelId,
    authorId: 'operator', isBot: false, content: 'held until native proof'
  }, { ready: false });
  assert.equal(held.accepted, true);
  let preflights = 0;
  let dispatches = 0;
  let replies = 0;
  const channel = {
    id: binding.channelId,
    guildId: 'guild',
    topic: null,
    permissionsFor: () => ({ has: () => true }),
    async send() { replies += 1; return { id: `reply-${replies}` }; }
  };
  const client = {
    user: { id: 'bot' },
    channels: { fetch: async () => channel },
    on() {}, off() {}, async destroy() {}
  };
  const gateway = new DiscordGateway({
    state: f.state,
    client,
    fetchHistory: async () => [],
    providers: { codex: {
      async dispatch() { dispatches += 1; return { status: 'submitted' }; },
      async observe() { return { text: 'answer' }; }
    } },
    recoveryOptions: {
      codexSessionRoot: session.root,
      ordinaryNativePreflight: async current => {
        preflights += 1;
        return validateCodexSessionIdentity(current.nativeId, current.workspace, session.root);
      }
    }
  });
  const first = await gateway.recoverTransport('startup', 0);
  assert.equal(first.ready, true);
  assert.equal(f.state.getBinding(binding.channelId).readiness, READINESS.READY);
  assert.equal(preflights, 1);
  const reconciled = await gateway.reconcilePending();
  assert.deepEqual(reconciled, []);
  assert.equal(dispatches, 1);
  assert.ok(replies >= 1);
  assert.equal(f.state.getMessage('held-input').state, 'replied');
  gateway.pauseConnection('reconnect');
  assert.equal(f.state.getBinding(binding.channelId).readiness, READINESS.RECOVERING);
  const second = await gateway.recoverTransport('reconnect', 0);
  assert.equal(second.ready, true);
  assert.equal(preflights, 2);
  assert.equal(f.state.getMessage('held-input').state, 'replied');
  await gateway.stop();
});

test('ordinary post uses explicit binding custody and suppresses duplicate and unknown resend', async t => {
  const f = fixture(t);
  const binding = ordinary(f);
  const textFile = path.join(f.dir, 'milestone.txt');
  fs.writeFileSync(textFile, 'ordinary milestone');
  let calls = 0;
  const unknownFetch = async () => {
    calls += 1;
    throw Object.assign(new Error('network uncertain'), { outcome: 'unknown' });
  };
  const first = await runDirectPost({ state: f.state, token: 'fixture', nativeId: CODEX, generation: binding.generation,
    channelId: binding.channelId, provider: 'codex', ordinary: true, textFile, dedupeKey: 'ordinary-unknown', fetchImpl: unknownFetch });
  assert.equal(first.status, 'unknown');
  const retry = await runDirectPost({ state: f.state, token: 'fixture', nativeId: CODEX, generation: binding.generation,
    channelId: binding.channelId, provider: 'codex', ordinary: true, textFile, dedupeKey: 'ordinary-unknown', fetchImpl: unknownFetch });
  assert.equal(retry.status, 'unknown');
  assert.equal(calls, 1);
  const sentFetch = async () => {
    calls += 1;
    return { ok: true, status: 200, json: async () => ({ id: `sent-${calls}` }) };
  };
  const sent = await runDirectPost({ state: f.state, token: 'fixture', nativeId: CODEX, generation: binding.generation,
    channelId: binding.channelId, provider: 'codex', ordinary: true, textFile, dedupeKey: 'ordinary-sent', fetchImpl: sentFetch });
  const duplicate = await runDirectPost({ state: f.state, token: 'fixture', nativeId: CODEX, generation: binding.generation,
    channelId: binding.channelId, provider: 'codex', ordinary: true, textFile, dedupeKey: 'ordinary-sent', fetchImpl: sentFetch });
  assert.equal(sent.status, 'sent');
  assert.equal(duplicate.duplicate, true);
  assert.equal(calls, 2);
  f.state.rebind({ channelId: binding.channelId, guildId: 'guild', provider: 'codex', nativeId: OTHER, workspace: f.dir });
  await assert.rejects(() => runDirectPost({ state: f.state, token: 'fixture', nativeId: CODEX, generation: binding.generation,
    channelId: binding.channelId, provider: 'codex', ordinary: true, textFile, dedupeKey: 'ordinary-stale', fetchImpl: sentFetch }),
  error => error instanceof StaleGenerationError);
});
