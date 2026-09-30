const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { SurfaceState, READINESS, DIRECT_POST_OUTCOMES: stateOutcomes } = require('../src/state');
const { main } = require('../src/cli');
const { runDirectPost } = require('../src/direct-post');
const { decodeAgentMessage, encodeAgentMessage, issueAgentAddress, KINDS } = require('../src/agent-message');
const { AGENT_ATTACHMENT_CONTENT_TYPE, AGENT_ATTACHMENT_FILENAME } = require('../src/agent-attachment');
const { AGENT_PRESENTATIONS } = require('../src/agent-presentation');
const { createDirectPostHandlers, DIRECT_POST_OUTCOMES } = require('../src/state/direct-post');
const { fixture, agentFixture, response, fetchRecorder, CODEX, CLAUDE } = require('./direct-post-fixture');

test('direct post inspection preserves captured dependency kinds after factory creation', () => {
  const BindingError = class extends Error {};
  const StaleGenerationError = class extends Error {};
  const StateCorruptError = class extends Error {};
  const dependencies = {
    BindingError,
    StaleGenerationError,
    StateCorruptError,
    DIRECT_POST_ATTEMPT: 'direct-post-attempt',
    DIRECT_POST_OUTCOME: 'direct-post-outcome',
    DIRECT_POST_OUTCOMES: ['sent', 'not_sent', 'rejected', 'rate_limited', 'unknown', 'stale'],
    assertText(value, name, max = 512) {
      if (typeof value !== 'string' || value.length === 0 || value.length > max) throw new TypeError(`${name} invalid`);
      return value;
    },
    bindingMatchesExpected: () => true,
    parseJson(value, fallback) {
      if (typeof value !== 'string') return fallback;
      try { return JSON.parse(value); } catch { return fallback; }
    },
    now: () => '2026-09-13T00:00:00.000Z'
  };
  const binding = {
    active: true,
    channelId: 'channel-1',
    guildId: 'guild-1',
    provider: 'codex',
    nativeId: CODEX,
    generation: 1,
    conductorId: null,
    repoKey: null
  };
  const meta = {
    requestId: 'request-1',
    inReplyTo: null,
    attemptId: 'attempt-1',
    sourcePath: '/tmp/source.md',
    textHash: 'text-hash',
    operatorId: 'operator-1',
    partHash: 'part-hash',
    channelId: 'channel-1',
    guildId: 'guild-1',
    provider: 'codex',
    nativeId: CODEX,
    generation: 1,
    conductorId: null,
    repoKey: null,
    partIndex: 0,
    partCount: 1,
    nonce: 'nonce-1',
    binding
  };
  const attempt = { journal: 'direct-post-v1', ...meta, status: 'attempted' };
  const outcome = { ...attempt, outcome: 'sent' };
  const rows = [
    { id: 1, kind: 'direct-post-attempt', detail: attempt, createdAt: '2026-09-13T00:00:00.000Z' },
    { id: 2, kind: 'direct-post-outcome', detail: outcome, createdAt: '2026-09-13T00:00:01.000Z' }
  ];
  const receipts = [];
  const state = {
    db: { prepare: () => ({ all: () => [] }) },
    transaction: operation => operation(),
    directPostRows: () => rows.map(row => ({ ...row, detail: { ...row.detail } })),
    directPostBindingCurrent: () => true,
    directPostOwnerIdentity: () => ({ ownerPid: 123 }),
    receipt: (discordId, kind, detail) => receipts.push({ discordId, kind, detail })
  };
  const handlers = createDirectPostHandlers(dependencies);
  dependencies.DIRECT_POST_ATTEMPT = 'mutated-attempt-kind';
  dependencies.DIRECT_POST_OUTCOME = 'mutated-outcome-kind';

  assert.deepEqual(handlers.beginDirectPostPart(state, meta), {
    claimed: false,
    status: 'sent',
    attemptId: 'attempt-1',
    nonce: 'nonce-1',
    outcome
  });
  assert.deepEqual(receipts, []);
});

test('direct post facade exposes the frozen owner outcome vocabulary', () => {
  const owner = require('../dist/state/direct-post.js');
  assert.strictEqual(stateOutcomes, DIRECT_POST_OUTCOMES);
  assert.strictEqual(DIRECT_POST_OUTCOMES, owner.DIRECT_POST_OUTCOMES);
  assert.deepEqual(DIRECT_POST_OUTCOMES, ['sent', 'not_sent', 'rejected', 'rate_limited', 'unknown', 'stale']);
  assert.equal(Object.isFrozen(DIRECT_POST_OUTCOMES), true);
  assert.throws(() => DIRECT_POST_OUTCOMES.push('bogus'), TypeError);
  assert.deepEqual(DIRECT_POST_OUTCOMES, owner.DIRECT_POST_OUTCOMES);
});

test('post sends multipart text in order and records durable per-part outcomes', async t => {
  const f = fixture(t);
  fs.writeFileSync(f.textFile, `first\n${'x'.repeat(2100)}`);
  const recorder = fetchRecorder();
  const result = await runDirectPost({ state: f.state, token: 'fixture', nativeId: f.nativeId, generation: 1, textFile: f.textFile, fetchImpl: recorder.fetchImpl });
  assert.ok(result.parts.length >= 2);
  assert.equal(recorder.calls.map(call => call.body.content).join(''), `first\n${'x'.repeat(2100)}`);
  assert.ok(recorder.calls.every(call => call.body.content.length <= 2000));
  assert.ok(recorder.calls.every(call => call.body.allowed_mentions.parse.length === 0));
  assert.ok(recorder.calls.every(call => !('message_reference' in call.body)));
  assert.equal(result.recorded, true);
  assert.equal(result.duplicate, false);
  assert.equal(result.state, 'sent');
  assert.equal(f.state.listReceipts().filter(row => row.kind === 'direct-post-outcome').length, recorder.calls.length);
});

test('opt-in agent attachment carries the exact wire beside a deterministic preview', async t => {
  const f = agentFixture(t);
  const destination = { guildId: '100', channelId: '102', provider: 'claude', nativeId: CLAUDE, generation: 1 };
  const text = 'Read the task and preserve its addressed destination.';
  fs.writeFileSync(f.textFile, text);
  const calls = [];
  let multipartBody;
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (options.method === 'GET') return { ok: true, status: 200, json: async () => ({ id: destination.channelId, guild_id: destination.guildId }) };
    multipartBody = options.body;
    return response('attachment-message');
  };
  const result = await runDirectPost({
    state: f.state,
    token: 'fixture',
    nativeId: f.nativeId,
    generation: 1,
    agentThreadId: f.agentThreadId,
    textFile: f.textFile,
    dedupeKey: 'attachment-request',
    agentTarget: issueAgentAddress(destination, 'fixture'),
    agentPresentation: AGENT_PRESENTATIONS.ATTACHMENT,
    fetchImpl
  });
  assert.equal(result.status, 'sent');
  assert.equal(calls.length, 2);
  assert.ok(multipartBody instanceof FormData);
  const payload = JSON.parse(multipartBody.get('payload_json'));
  const file = multipartBody.get('files[0]');
  const wire = Buffer.from(await file.arrayBuffer()).toString('utf8');
  const packet = decodeAgentMessage(wire, 'fixture', destination);
  assert.equal(packet.text, text);
  assert.equal(file.name, AGENT_ATTACHMENT_FILENAME);
  assert.equal(file.type, AGENT_ATTACHMENT_CONTENT_TYPE);
  assert.equal(payload.content, 'Agent request from codex to claude: Read the task and preserve its addressed destination.');
  assert.doesNotMatch(payload.content, /discord-tether:agent:v1:|attachment-request|9caa5d21/);
  assert.equal(calls[1].options.headers['Content-Type'], undefined);
  const attempt = f.state.directPostRows('attachment-request').find(row => row.kind === 'direct-post-attempt').detail;
  assert.equal(attempt.presentation, AGENT_PRESENTATIONS.ATTACHMENT);
  assert.equal(attempt.partHash, crypto.createHash('sha256').update(JSON.stringify(wire)).digest('hex'));
  assert.equal(attempt.textHash, crypto.createHash('sha256').update(JSON.stringify(JSON.stringify(packet))).digest('hex'));
});

test('changing carrier after an unknown attachment POST does not bypass custody', async t => {
  const f = agentFixture(t);
  const destination = { guildId: '100', channelId: '102', provider: 'claude', nativeId: CLAUDE, generation: 1 };
  fs.writeFileSync(f.textFile, 'uncertain attachment request');
  let postCalls = 0;
  const firstFetch = async (_url, options) => {
    if (options.method === 'GET') return { ok: true, status: 200, json: async () => ({ id: destination.channelId, guild_id: destination.guildId }) };
    postCalls += 1;
    throw Object.assign(new Error('connection closed after write'), { name: 'TypeError' });
  };
  const input = {
    state: f.state,
    token: 'fixture',
    nativeId: f.nativeId,
    generation: 1,
    agentThreadId: f.agentThreadId,
    textFile: f.textFile,
    dedupeKey: 'uncertain-attachment-request',
    agentTarget: issueAgentAddress(destination, 'fixture')
  };
  const first = await runDirectPost({ ...input, agentPresentation: AGENT_PRESENTATIONS.ATTACHMENT, fetchImpl: firstFetch });
  assert.equal(first.status, 'unknown');
  const second = await runDirectPost({ ...input, fetchImpl: async () => { throw new Error('carrier switch must not POST'); } });
  assert.equal(second.status, 'unknown');
  assert.equal(postCalls, 1);
});

test('reply target uses the bound channel and participates in explicit identity', async t => {
  const f = fixture(t);
  fs.writeFileSync(f.textFile, 'reply milestone');
  const recorder = fetchRecorder();
  const first = await runDirectPost({ state: f.state, token: 'fixture', nativeId: f.nativeId, generation: 1, textFile: f.textFile,
    dedupeKey: 'reply-key', inReplyTo: 'predecessor-message', fetchImpl: recorder.fetchImpl });
  assert.deepEqual(recorder.calls[0].body.message_reference, {
    message_id: 'predecessor-message', channel_id: 'channel', fail_if_not_exists: true
  });
  assert.equal(first.recorded, true);
  assert.equal(first.duplicate, false);
  const repeated = await runDirectPost({ state: f.state, token: 'fixture', nativeId: f.nativeId, generation: 1, textFile: f.textFile,
    dedupeKey: 'reply-key', inReplyTo: 'predecessor-message', fetchImpl: recorder.fetchImpl });
  assert.equal(repeated.recorded, false);
  assert.equal(repeated.duplicate, true);
  assert.equal(repeated.state, 'sent');
  await assert.rejects(runDirectPost({ state: f.state, token: 'fixture', nativeId: f.nativeId, generation: 1, textFile: f.textFile,
    dedupeKey: 'reply-key', inReplyTo: 'different-message', fetchImpl: recorder.fetchImpl }), /identity conflicts/);
  assert.equal(recorder.calls.length, 1);
});

test('derived JavaScript fallback identity separates reply targets', async t => {
  const f = fixture(t);
  fs.writeFileSync(f.textFile, 'derived reply milestone');
  const recorder = fetchRecorder();
  const first = await runDirectPost({ state: f.state, token: 'fixture', nativeId: f.nativeId, generation: 1, textFile: f.textFile,
    inReplyTo: 'first-target', fetchImpl: recorder.fetchImpl });
  const second = await runDirectPost({ state: f.state, token: 'fixture', nativeId: f.nativeId, generation: 1, textFile: f.textFile,
    inReplyTo: 'second-target', fetchImpl: recorder.fetchImpl });
  assert.notEqual(first.requestId, second.requestId);
  assert.equal(first.recorded, true);
  assert.equal(second.recorded, true);
  assert.equal(recorder.calls.length, 2);
});

test('claude-post selection rejects codex and generic post rejects ambiguous native owners', async t => {
  const f = fixture(t, 'claude');
  f.state.bind({ channelId: 'codex-channel', guildId: 'guild', provider: 'codex', nativeId: CLAUDE, workspace: f.dir, conductorId: 'other', repoKey: 'repo:other' }, { intakeCutoff: '100' });
  fs.writeFileSync(f.textFile, 'milestone');
  await assert.rejects(runDirectPost({ state: f.state, token: 'fixture', nativeId: CLAUDE, generation: 1, textFile: f.textFile, fetchImpl: fetchRecorder().fetchImpl }), /channel-id/);
  const recorder = fetchRecorder();
  const result = await runDirectPost({ state: f.state, token: 'fixture', nativeId: CLAUDE, generation: 1, channelId: 'channel', provider: 'claude', textFile: f.textFile, fetchImpl: recorder.fetchImpl });
  assert.equal(result.parts[0].status, 'sent');
});

test('stale owner and invalid file fail before any network', async t => {
  const f = fixture(t);
  const recorder = fetchRecorder();
  await assert.rejects(runDirectPost({ state: f.state, token: 'fixture', nativeId: f.nativeId, generation: 2, textFile: f.textFile, fetchImpl: recorder.fetchImpl }), /no active conductor/);
  await assert.rejects(runDirectPost({ state: f.state, token: 'fixture', nativeId: f.nativeId, generation: 1, textFile: path.join(f.dir, 'missing.txt'), fetchImpl: recorder.fetchImpl }), /text file is unavailable/);
  fs.writeFileSync(f.textFile, 'x'.repeat(10001));
  await assert.rejects(runDirectPost({ state: f.state, token: 'fixture', nativeId: f.nativeId, generation: 1, textFile: f.textFile, fetchImpl: recorder.fetchImpl }), /10000 character/);
  assert.equal(recorder.calls.length, 0);
});

test('same request claims one sender, abort records unknown, and rerun never blindly resends', async t => {
  const f = fixture(t);
  fs.writeFileSync(f.textFile, 'uncertain milestone');
  const recorder = fetchRecorder({ pending: true });
  const controller = new AbortController();
  const first = runDirectPost({ state: f.state, token: 'fixture', nativeId: f.nativeId, generation: 1, textFile: f.textFile, fetchImpl: recorder.fetchImpl, signal: controller.signal });
  while (recorder.calls.length === 0) await new Promise(resolve => setTimeout(resolve, 2));
  const second = await runDirectPost({ state: f.state, token: 'fixture', nativeId: f.nativeId, generation: 1, textFile: f.textFile, fetchImpl: recorder.fetchImpl });
  assert.equal(second.parts[0].status, 'in_flight');
  assert.equal(second.recorded, false);
  assert.equal(second.duplicate, false);
  assert.equal(second.state, 'in_flight');
  assert.equal(recorder.calls.length, 1);
  controller.abort();
  const uncertain = await first;
  assert.equal(uncertain.status, 'unknown');
  assert.equal(uncertain.recorded, false);
  assert.equal(uncertain.duplicate, false);
  const rerun = await runDirectPost({ state: f.state, token: 'fixture', nativeId: f.nativeId, generation: 1, textFile: f.textFile, fetchImpl: recorder.fetchImpl });
  assert.equal(rerun.parts[0].status, 'unknown');
  assert.equal(rerun.recorded, false);
  assert.equal(rerun.duplicate, false);
  assert.equal(recorder.calls.length, 1);
});

test('not-sent parts retry on explicit command rerun and changing explicit request content is rejected', async t => {
  const f = fixture(t);
  fs.writeFileSync(f.textFile, 'retryable');
  const recorder = fetchRecorder({ responses: [response('bad', 400), response('good')] });
  const first = await runDirectPost({ state: f.state, token: 'fixture', nativeId: f.nativeId, generation: 1, textFile: f.textFile, fetchImpl: recorder.fetchImpl, requestId: 'explicit-request' });
  assert.equal(first.parts[0].status, 'not_sent');
  assert.equal(first.recorded, false);
  assert.equal(first.duplicate, false);
  const retry = await runDirectPost({ state: f.state, token: 'fixture', nativeId: f.nativeId, generation: 1, textFile: f.textFile, fetchImpl: recorder.fetchImpl, requestId: 'explicit-request' });
  assert.equal(retry.parts[0].status, 'sent');
  assert.equal(retry.recorded, true);
  assert.equal(retry.duplicate, false);
  fs.writeFileSync(f.textFile, 'changed');
  await assert.rejects(runDirectPost({ state: f.state, token: 'fixture', nativeId: f.nativeId, generation: 1, textFile: f.textFile, fetchImpl: recorder.fetchImpl, requestId: 'explicit-request' }), /identity conflicts/);
  assert.equal(recorder.calls.length, 2);
});

test('CLI --db and claude-post use the bound channel without native work', async t => {
  const f = fixture(t, 'claude');
  fs.writeFileSync(f.textFile, 'CLI milestone');
  const recorder = fetchRecorder();
  const originalFetch = globalThis.fetch;
  const originalArgv = process.argv;
  globalThis.fetch = recorder.fetchImpl;
  process.argv = ['node', 'src/cli.js', 'claude-post', '--db', path.join(f.dir, 'surface.sqlite'), '--native-id', f.nativeId, '--generation', '1', '--text-file', f.textFile,
    '--dedupe-key', 'cli-key', '--in-reply-to', 'prior-cli-message'];
  try {
    const result = await main();
    assert.equal(result.parts[0].status, 'sent');
    assert.equal(result.recorded, true);
    assert.equal(result.duplicate, false);
    assert.deepEqual(recorder.calls[0].body.message_reference, {
      message_id: 'prior-cli-message', channel_id: 'channel', fail_if_not_exists: true
    });
  } finally {
    globalThis.fetch = originalFetch;
    process.argv = originalArgv;
  }
  assert.equal(recorder.calls.length, 1);
});

test('claude-post rejects unknown attachment flag with nearest valid flag', async t => {
  const f = fixture(t, 'claude');
  const imageFile = path.join(f.dir, 'frame.png');
  fs.writeFileSync(f.textFile, 'milestone');
  fs.writeFileSync(imageFile, Buffer.from('frame'));
  const recorder = fetchRecorder();
  const originalFetch = globalThis.fetch;
  const originalArgv = process.argv;
  globalThis.fetch = recorder.fetchImpl;
  process.argv = ['node', 'src/cli.js', 'claude-post', '--db', path.join(f.dir, 'surface.sqlite'), '--native-id', f.nativeId, '--generation', '1', '--text-file', f.textFile,
    '--dedupe-key', 'unknown-flag-error', '--attachment', imageFile];
  try {
    await assert.rejects(main(), /--attachment\b[\s\S]*--attachment-file/);
  } finally {
    globalThis.fetch = originalFetch;
    process.argv = originalArgv;
  }
});

test('claude-post unknown attachment flag cannot reach Discord', async t => {
  const f = fixture(t, 'claude');
  const imageFile = path.join(f.dir, 'frame.png');
  fs.writeFileSync(f.textFile, 'milestone');
  fs.writeFileSync(imageFile, Buffer.from('frame'));
  const recorder = fetchRecorder();
  const originalFetch = globalThis.fetch;
  const originalArgv = process.argv;
  globalThis.fetch = recorder.fetchImpl;
  process.argv = ['node', 'src/cli.js', 'claude-post', '--db', path.join(f.dir, 'surface.sqlite'), '--native-id', f.nativeId, '--generation', '1', '--text-file', f.textFile,
    '--dedupe-key', 'unknown-flag-network', '--attachment', imageFile];
  try {
    await main().catch(() => {});
  } finally {
    globalThis.fetch = originalFetch;
    process.argv = originalArgv;
  }
  assert.equal(recorder.calls.length, 0);
});

test('claude-post unknown attachment flag leaves receipts unchanged', async t => {
  const f = fixture(t, 'claude');
  const imageFile = path.join(f.dir, 'frame.png');
  fs.writeFileSync(f.textFile, 'milestone');
  fs.writeFileSync(imageFile, Buffer.from('frame'));
  const recorder = fetchRecorder();
  const originalFetch = globalThis.fetch;
  const originalArgv = process.argv;
  globalThis.fetch = recorder.fetchImpl;
  process.argv = ['node', 'src/cli.js', 'claude-post', '--db', path.join(f.dir, 'surface.sqlite'), '--native-id', f.nativeId, '--generation', '1', '--text-file', f.textFile,
    '--dedupe-key', 'unknown-flag-receipt', '--attachment', imageFile];
  const before = f.state.listReceipts();
  try {
    await main().catch(() => {});
  } finally {
    globalThis.fetch = originalFetch;
    process.argv = originalArgv;
  }
  assert.deepEqual(f.state.listReceipts(), before);
});

test('CLI requires one dedupe key and rejects conflicting aliases before network', async t => {
  const f = fixture(t, 'claude');
  fs.writeFileSync(f.textFile, 'CLI key validation');
  const recorder = fetchRecorder();
  const originalFetch = globalThis.fetch;
  const originalArgv = process.argv;
  globalThis.fetch = recorder.fetchImpl;
  const base = ['node', 'src/cli.js', 'claude-post', '--db', path.join(f.dir, 'surface.sqlite'), '--native-id', f.nativeId,
    '--generation', '1', '--text-file', f.textFile];
  const invoke = async argv => {
    process.argv = argv;
    try { return await main(); }
    finally { process.argv = originalArgv; }
  };
  try {
    await assert.rejects(invoke(base), /dedupe-key or request-id is required/);
    await assert.rejects(invoke([...base, '--dedupe-key', 'canonical', '--request-id', 'legacy']), /must match/);
    const legacy = await invoke([...base, '--request-id', 'legacy-key']);
    assert.equal(legacy.requestId, 'legacy-key');
    assert.equal(legacy.recorded, true);
  } finally {
    globalThis.fetch = originalFetch;
    process.argv = originalArgv;
  }
  assert.equal(recorder.calls.length, 1);
});
