const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SurfaceState, READINESS } = require('../src/state');
const { presentDecision, parseDecisionRequest, readDecisionRequest } = require('../src/decision-present');
const { decisionPresent } = require('../src/cli');
const { decodeDecisionCustomId } = require('../src/discord-interaction');

const NATIVE = '9caa5d21-2169-429d-918b-5f08651b5dbd';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decision-present-'));
  const db = path.join(dir, 'surface.sqlite');
  const state = new SurfaceState(db);
  const secretFile = path.join(dir, 'secret.env');
  fs.writeFileSync(secretFile, 'DISCORD_TOKEN=fixture-token\n', { mode: 0o600 });
  state.setConfig({ operatorId: 'operator', guildId: 'guild', secretFile });
  const binding = state.bindOrdinary({ channelId: 'channel', guildId: 'guild', provider: 'codex', nativeId: NATIVE, workspace: dir },
    { sessionId: NATIVE, threadId: NATIVE });
  state.recordOrdinaryPreflight(binding, { file: path.join(dir, 'fixture.jsonl'), sessionId: NATIVE, threadId: NATIVE, workspace: dir });
  state.setBindingReadiness('channel', READINESS.READY);
  const canonical = { stateRoot: path.join(dir, 'canonical'), environment: { TELEGRAM_ROOT: path.join(dir, 'producer'), TG_CANONICAL_STATE_ROOT: undefined } };
  const request = { namespace: 'discord-p2', requestId: 'presentation-test', target: 'run:p2-presentation',
    head: '-', question: 'Promote this change?', menu: [{ key: 'promote', consequence: 'publish the reviewed change' }, 'hold'],
    channelId: 'channel', provider: 'codex', nativeId: NATIVE, generation: 1 };
  t.after(() => { state.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, db, state, canonical, request };
}

test('producer sends canonical menu once and reopens saved presentation without a second post', { timeout: 15000 }, async t => {
  const f = fixture(t);
  const posts = [];
  const fetchImpl = async (_url, options) => {
    posts.push(JSON.parse(options.body));
    return { ok: true, json: async () => ({ id: '123456789' }) };
  };
  const args = { ...f, token: 'fixture-token', authorizeOrdinary: async binding => assert.equal(binding.nativeId, NATIVE), fetchImpl };
  const first = await presentDecision(args);
  assert.equal(first.presentationOutcome, 'sent');
  assert.deepEqual(first.keys, ['promote', 'hold', 'research']);
  assert.match(posts[0].content, /promote: publish the reviewed change/);
  assert.match(posts[0].content, /research: you decide/);
  assert.deepEqual(posts[0].allowed_mentions, { parse: [] });
  assert.equal(posts[0].enforce_nonce, true);
  const buttons = posts[0].components.flatMap(row => row.components);
  assert.deepEqual(buttons.map(button => button.label), first.keys);
  assert.deepEqual(buttons.map(button => decodeDecisionCustomId(button.custom_id).selectedIndex), [0, 1, 2]);
  const reopened = new SurfaceState(f.db);
  try {
    const driftRoot = path.join(f.dir, 'new-ambient-root');
    const again = await presentDecision({ ...args, state: reopened, canonical: { environment: { TELEGRAM_ROOT: driftRoot, TG_CANONICAL_STATE_ROOT: driftRoot } } });
    assert.equal(fs.existsSync(driftRoot), false);
    assert.equal(again.messageId, first.messageId);
    assert.equal(posts.length, 1);
    assert.equal(again.canonicalRoute.stateRoot, f.canonical.stateRoot);
    assert.equal(again.canonicalRoute.telegramRoot, f.canonical.environment.TELEGRAM_ROOT);
    assert.equal(again.content, posts[0].content);
    await assert.rejects(presentDecision({ ...args, request: { ...f.request, question: 'A different question?' } }), /canonical registration incomplete/);
    assert.equal(posts.length, 1);
  } finally { reopened.close(); }
});

test('ambiguous send remains unknown across a repeat and authority failure sends nothing', { timeout: 15000 }, async t => {
  const f = fixture(t);
  let calls = 0;
  const args = { ...f, token: 'fixture-token', authorizeOrdinary: async () => {},
    fetchImpl: async () => { calls += 1; throw new Error('connection lost after send'); } };
  const first = await presentDecision(args);
  assert.equal(first.presentationOutcome, 'unknown');
  const second = await presentDecision(args);
  assert.equal(second.presentationOutcome, 'unknown');
  assert.equal(calls, 1);
  await assert.rejects(presentDecision({ ...args, request: { ...f.request, generation: 2 } }), /no active ordinary/);
  assert.equal(calls, 1);
});

test('public CLI uses ordinary invocation identity and restores signal listeners after completion', { timeout: 15000 }, async t => {
  const f = fixture(t);
  const file = path.join(f.dir, 'request.json');
  fs.writeFileSync(file, JSON.stringify(f.request));
  const args = { db: f.db, 'request-file': file, 'canonical-state-root': f.canonical.stateRoot };
  const baseline = ['SIGINT', 'SIGTERM'].map(name => process.listenerCount(name));
  let posts = 0;
  const dependencies = { environment: f.canonical.environment,
    resolveInvocationIdentity: () => ({ sessionId: NATIVE, threadId: 'different-task' }),
    fetchImpl: async () => { posts += 1; return { ok: true, json: async () => ({ id: '123456790' }) }; } };
  await assert.rejects(decisionPresent(args, dependencies), /identity does not match/);
  assert.equal(fs.existsSync(f.canonical.stateRoot), false);
  assert.equal(posts, 0);
  dependencies.resolveInvocationIdentity = () => ({ sessionId: NATIVE, threadId: NATIVE });
  const sent = await decisionPresent(args, dependencies);
  assert.equal(sent.messageId, '123456790');
  assert.equal(posts, 1);
  assert.deepEqual(['SIGINT', 'SIGTERM'].map(name => process.listenerCount(name)), baseline);
});

test('request boundary refuses invented fields, invalid vocabulary and oversized files', t => {
  const f = fixture(t);
  assert.throws(() => parseDecisionRequest({ ...f.request, provider: 'other' }), /provider/);
  assert.throws(() => parseDecisionRequest({ ...f.request, generation: '1' }), /generation/);
  assert.throws(() => parseDecisionRequest({ ...f.request, qid: 'caller-owned' }), /unknown.*field/);
  assert.throws(() => parseDecisionRequest({ ...f.request, menu: Array(26).fill('hold') }), /1 to 25/);
  const file = path.join(f.dir, 'oversized.json');
  fs.writeFileSync(file, ' '.repeat(65537));
  assert.throws(() => readDecisionRequest(file), /64 KiB/);
});
