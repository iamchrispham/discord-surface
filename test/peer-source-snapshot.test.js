'use strict';

// PR109 F1: peer preflight and publication consume one prepared UTF-8 source
// with its original resolved pathname. 12 top-level cases, no subtests.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Ajv = require('ajv');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
const { SurfaceState, READINESS } = require('../src/state');
const { THREAD_STATES } = require('../src/state/thread-enrollment');
const { createPeerService } = require('../src/peer/service');
const { createPeerMcp } = require('../src/peer/server');
const { runDirectPost, readTextFile } = require('../src/direct-post');
const { decodeAgentMessage } = require('../src/agent-message');

const SOURCE_NATIVE_ID = '11111111-1111-1111-1111-111111111111';
const RECIPIENT_NATIVE_ID = '22222222-2222-2222-2222-222222222222';

function makeFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peer-source-snapshot-'));
  const state = new SurfaceState(path.join(dir, 'surface.sqlite'));
  t.after(() => { state.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  state.setConfig({ guildId: '100', operatorId: '900', secretFile: path.join(dir, 'secret') });
  state.bind({ guildId: '100', channelId: '101', provider: 'claude', nativeId: SOURCE_NATIVE_ID, workspace: dir,
    endpoint: path.join(dir, 'channel.sock'), conductorId: 'test-conductor', repoKey: 'github.com/test/repo' });
  const source = state.setBindingReadiness('101', READINESS.READY, 'fixture', state.getBinding('101'));
  state.enrollThread({ threadId: '102', parentChannelId: '101', guildId: '100' }, source);
  state.markThreadBoundary('102', THREAD_STATES.READY, 'fixture', null, null, source);
  state.bind({ guildId: '100', channelId: '201', provider: 'codex', nativeId: RECIPIENT_NATIVE_ID, workspace: '/tmp',
    conductorId: 'recipient', repoKey: 'github.com/test/recipient' });
  const recipient = state.setBindingReadiness('201', READINESS.READY, 'fixture', state.getBinding('201'));
  state.enrollThread({ threadId: '202', parentChannelId: '201', guildId: '100' }, recipient);
  state.markThreadBoundary('202', THREAD_STATES.READY, 'fixture', null, null, recipient);
  return { dir, state, source, recipient };
}

function callerService(f, extras = {}) {
  return createPeerService({ state: f.state, provider: 'claude', token: 'fixture',
    callerDependencies: { resolveClaudeCaller: async () => ({ harness: 'claude-code', sessionId: SOURCE_NATIVE_ID }) },
    fetchImpl: async () => { assert.fail('unexpected network call'); }, ...extras });
}

function recipientService(f, extras = {}) {
  return createPeerService({ state: f.state, provider: 'codex', token: 'fixture',
    callerDependencies: { environment: { CODEX_THREAD_ID: RECIPIENT_NATIVE_ID } },
    fetchImpl: async () => { assert.fail('unexpected network call'); }, ...extras });
}

function childAddress(f, channelId) {
  return { guildId: '100', channelId, provider: 'codex', nativeId: RECIPIENT_NATIVE_ID, generation: f.recipient.generation };
}

function sourceChildAddress(f) {
  return { guildId: '100', channelId: '102', provider: 'claude', nativeId: SOURCE_NATIVE_ID, generation: f.source.generation };
}

// Mocked Discord transport: GET channel verification, POST multipart publication.
function peerTransport(hooks = {}) {
  const posts = [];
  const fetchImpl = async (url, options) => {
    if (options.method === 'GET') return { ok: true, status: 200, json: async () => ({ id: url.split('/').at(-1), guild_id: '100' }) };
    if (options.method !== 'POST') { assert.fail(`unexpected ${options.method} ${url}`); }
    const wire = await options.body.get('files[0]').text();
    posts.push({ url, wire });
    if (hooks.onPost) await hooks.onPost({ url, wire });
    return { ok: true, status: 200, json: async () => ({ id: `snapshot-${posts.length}` }) };
  };
  return { fetchImpl, posts };
}

// Simulate a file that changes between the producer read and the consumer read:
// patch fs.readFileSync so the first read of `file` returns its bytes and then
// rewrites the file on disk. With the F1 handoff there is exactly one read.
function mutateAfterFirstRead(file, replacement) {
  const original = fs.readFileSync;
  let reads = 0;
  fs.readFileSync = function patched(target, ...args) {
    const value = original.call(this, target, ...args);
    if (path.resolve(String(target)) === path.resolve(file)) {
      reads += 1;
      if (reads === 1) fs.writeFileSync(file, replacement);
    }
    return value;
  };
  return { reads: () => reads, restore: () => { fs.readFileSync = original; } };
}

function unlinkAfterFirstRead(file) {
  const original = fs.readFileSync;
  let reads = 0;
  fs.readFileSync = function patched(target, ...args) {
    const value = original.call(this, target, ...args);
    if (path.resolve(String(target)) === path.resolve(file)) {
      reads += 1;
      if (reads === 1) fs.unlinkSync(file);
    }
    return value;
  };
  return { reads: () => reads, restore: () => { fs.readFileSync = original; } };
}

function countRecoveries(state) {
  const original = state.recoverDirectPostReceipts.bind(state);
  const counter = { calls: 0 };
  state.recoverDirectPostReceipts = (...args) => { counter.calls += 1; return original(...args); };
  return counter;
}

async function enrollRequest(f, dedupeKey, text) {
  const transport = peerTransport();
  const caller = callerService(f, { fetchImpl: transport.fetchImpl });
  assert.equal((await caller.send({ peer: { conductorId: 'recipient' }, text, dedupe_key: dedupeKey })).status, 'sent');
  assert.equal(transport.posts.length, 1);
  assert.equal(f.state.acceptDiscordMessage({ id: 'accepted-request', guildId: '100', channelId: '202', authorId: '901',
    isBot: true, content: transport.posts[0].wire }, { agentToken: 'fixture' }).accepted, true);
  return transport.posts[0].wire;
}

test('1 peer request publishes the first-read text after the source file is replaced', async t => {
  const f = makeFixture(t);
  const file = path.join(f.dir, 'request.txt');
  fs.writeFileSync(file, 'original request');
  const hook = mutateAfterFirstRead(file, 'replaced request');
  const transport = peerTransport();
  const peer = callerService(f, { fetchImpl: transport.fetchImpl });
  let result;
  try {
    result = await peer.send({ peer: { conductorId: 'recipient' }, text_file: file, dedupe_key: 'snapshot-request' });
  } finally { hook.restore(); }
  assert.equal(result.status, 'sent');
  assert.equal(hook.reads(), 1);
  assert.equal(fs.readFileSync(file, 'utf8'), 'replaced request');
  assert.equal(transport.posts.length, 1);
  assert.equal(decodeAgentMessage(transport.posts[0].wire, 'fixture', childAddress(f, '202')).text, 'original request');
});

test('2 peer result publishes the first-read text after the source file is replaced', async t => {
  const f = makeFixture(t);
  await enrollRequest(f, 'snapshot-result-request', 'immutable request');
  const file = path.join(f.dir, 'result.txt');
  fs.writeFileSync(file, 'original result');
  const hook = mutateAfterFirstRead(file, 'replaced result');
  const transport = peerTransport();
  const recipient = recipientService(f, { fetchImpl: transport.fetchImpl });
  let result;
  try {
    result = await recipient.send({ reply_to: 'snapshot-result-request', text_file: file, dedupe_key: 'snapshot-result' });
  } finally { hook.restore(); }
  assert.equal(result.status, 'sent');
  assert.equal(hook.reads(), 1);
  assert.equal(transport.posts.length, 1);
  assert.equal(decodeAgentMessage(transport.posts[0].wire, 'fixture', sourceChildAddress(f)).text, 'original result');
});

test('3 child post request publishes the first-read text after the source file is replaced', async t => {
  const f = makeFixture(t);
  const file = path.join(f.dir, 'child-request.txt');
  fs.writeFileSync(file, 'original child request');
  const hook = mutateAfterFirstRead(file, 'replaced child request');
  const transport = peerTransport();
  const peer = callerService(f, { fetchImpl: transport.fetchImpl });
  let result;
  try {
    result = await peer.post({ role: 'child', peer: { conductorId: 'recipient' }, text_file: file, dedupe_key: 'snapshot-child-request' });
  } finally { hook.restore(); }
  assert.equal(result.status, 'sent');
  assert.equal(hook.reads(), 1);
  assert.equal(transport.posts.length, 1);
  assert.equal(decodeAgentMessage(transport.posts[0].wire, 'fixture', childAddress(f, '202')).text, 'original child request');
});

test('4 child post result publishes the first-read text after the source file is replaced', async t => {
  const f = makeFixture(t);
  await enrollRequest(f, 'snapshot-child-result-request', 'immutable child request');
  const file = path.join(f.dir, 'child-result.txt');
  fs.writeFileSync(file, 'original child result');
  const hook = mutateAfterFirstRead(file, 'replaced child result');
  const transport = peerTransport();
  const recipient = recipientService(f, { fetchImpl: transport.fetchImpl });
  let result;
  try {
    result = await recipient.post({ role: 'child', reply_to: 'snapshot-child-result-request', text_file: file,
      dedupe_key: 'snapshot-child-result' });
  } finally { hook.restore(); }
  assert.equal(result.status, 'sent');
  assert.equal(hook.reads(), 1);
  assert.equal(transport.posts.length, 1);
  assert.equal(decodeAgentMessage(transport.posts[0].wire, 'fixture', sourceChildAddress(f)).text, 'original child result');
});

test('5 unlinking the source after the first read still publishes the prepared text', async t => {
  const f = makeFixture(t);
  const file = path.join(f.dir, 'removed.txt');
  fs.writeFileSync(file, 'text that survives removal');
  const hook = unlinkAfterFirstRead(file);
  const transport = peerTransport();
  const peer = callerService(f, { fetchImpl: transport.fetchImpl });
  let result;
  try {
    result = await peer.send({ peer: { conductorId: 'recipient' }, text_file: file, dedupe_key: 'snapshot-unlinked' });
  } finally { hook.restore(); }
  assert.equal(result.status, 'sent');
  assert.equal(hook.reads(), 1);
  assert.equal(fs.existsSync(file), false);
  assert.equal(transport.posts.length, 1);
  assert.equal(decodeAgentMessage(transport.posts[0].wire, 'fixture', childAddress(f, '202')).text, 'text that survives removal');
});

test('6 relative and resolved spellings of one file publish once with the original absolute sourcePath', async t => {
  const f = makeFixture(t);
  const file = path.join(f.dir, 'spelling.txt');
  fs.writeFileSync(file, 'one body two spellings');
  const relative = path.relative(process.cwd(), file);
  assert.notEqual(relative, path.resolve(file));
  const transport = peerTransport();
  const peer = callerService(f, { fetchImpl: transport.fetchImpl });
  const first = await peer.send({ peer: { conductorId: 'recipient' }, text_file: relative, dedupe_key: 'snapshot-spelling' });
  const second = await peer.send({ peer: { conductorId: 'recipient' }, text_file: path.resolve(file), dedupe_key: 'snapshot-spelling' });
  assert.equal(first.status, 'sent');
  assert.equal(second.status, 'sent');
  assert.equal(second.duplicate, true);
  assert.equal(transport.posts.length, 1);
  const attempt = f.state.directPostRows('snapshot-spelling').find(row => row.kind === 'direct-post-attempt');
  assert.equal(attempt.detail.sourcePath, path.resolve(file));
  assert.equal(decodeAgentMessage(transport.posts[0].wire, 'fixture', childAddress(f, '202')).text, 'one body two spellings');
});

test('7 changed content under the same dedupe key is refused before a second send', async t => {
  const f = makeFixture(t);
  const file = path.join(f.dir, 'immutable.txt');
  fs.writeFileSync(file, 'content one');
  const transport = peerTransport();
  const peer = callerService(f, { fetchImpl: transport.fetchImpl });
  assert.equal((await peer.send({ peer: { conductorId: 'recipient' }, text_file: file, dedupe_key: 'snapshot-immutable' })).status, 'sent');
  fs.writeFileSync(file, 'content two');
  await assert.rejects(peer.send({ peer: { conductorId: 'recipient' }, text_file: file, dedupe_key: 'snapshot-immutable' }),
    /identity conflicts with existing custody/);
  assert.equal(transport.posts.length, 1);
  assert.equal(f.state.directPostRows('snapshot-immutable').filter(row => row.kind === 'direct-post-outcome').length, 1);
});

test('8 oversized file input with an abandoned attempt refuses before recovery and mutates no receipt', async t => {
  const f = makeFixture(t);
  f.state.receipt(null, 'direct-post-attempt', { journal: 'direct-post-v1', requestId: 'abandoned-attempt',
    attemptId: 'abandoned-attempt-1', ownerPid: 999999, ownerStartTime: 'never', ownerCommand: 'dead-command', status: 'attempted' });
  const recoveries = countRecoveries(f.state);
  const file = path.join(f.dir, 'oversized.txt');
  fs.writeFileSync(file, 'a'.repeat(1500));
  let network = 0;
  const peer = callerService(f, { fetchImpl: async () => { network += 1; assert.fail('oversized peer send reached network'); } });
  const before = f.state.listReceipts();
  await assert.rejects(peer.send({ peer: { conductorId: 'recipient' }, text_file: file, dedupe_key: 'snapshot-oversized-file' }),
    /peer text exceeds signed packet limit/);
  assert.equal(network, 0);
  assert.equal(recoveries.calls, 0);
  assert.deepEqual(f.state.listReceipts(), before);
});

test('9 oversized inline text with an abandoned attempt refuses before recovery and mutates no receipt', async t => {
  const f = makeFixture(t);
  f.state.receipt(null, 'direct-post-attempt', { journal: 'direct-post-v1', requestId: 'abandoned-inline',
    attemptId: 'abandoned-inline-1', ownerPid: 999999, ownerStartTime: 'never', ownerCommand: 'dead-command', status: 'attempted' });
  const recoveries = countRecoveries(f.state);
  let network = 0;
  const peer = callerService(f, { fetchImpl: async () => { network += 1; assert.fail('oversized inline send reached network'); } });
  const before = f.state.listReceipts();
  await assert.rejects(peer.send({ peer: { conductorId: 'recipient' }, text: 'a'.repeat(1500), dedupe_key: 'snapshot-oversized-inline' }),
    /peer text exceeds signed packet limit/);
  assert.equal(network, 0);
  assert.equal(recoveries.calls, 0);
  assert.deepEqual(f.state.listReceipts(), before);
});

test('10 preparedTextSource with attachment input is rejected before recovery and file admission', async t => {
  const f = makeFixture(t);
  const caption = path.join(f.dir, 'caption.txt');
  const attachment = path.join(f.dir, 'attachment.bin');
  fs.writeFileSync(caption, 'caption body');
  fs.writeFileSync(attachment, Buffer.from([1, 2, 3]));
  const recoveries = countRecoveries(f.state);
  let network = 0;
  const before = f.state.listReceipts();
  await assert.rejects(runDirectPost({ state: f.state, token: 'fixture', nativeId: SOURCE_NATIVE_ID, generation: f.source.generation,
    textFile: caption, attachmentFile: attachment, dedupeKey: 'snapshot-conflict-file', preparedTextSource: readTextFile(caption),
    fetchImpl: async () => { network += 1; assert.fail('rejected combination reached network'); } }),
  /prepared text source cannot be combined with file or resume input/);
  assert.equal(network, 0);
  assert.equal(recoveries.calls, 0);
  assert.equal(f.state.directPostFilePreparation('snapshot-conflict-file'), null);
  assert.deepEqual(f.state.listReceipts(), before);
});

test('11 preparedTextSource with resume input is rejected before recovery and file admission', async t => {
  const f = makeFixture(t);
  const caption = path.join(f.dir, 'resume-caption.txt');
  fs.writeFileSync(caption, 'resume caption body');
  const recoveries = countRecoveries(f.state);
  let network = 0;
  const before = f.state.listReceipts();
  await assert.rejects(runDirectPost({ state: f.state, token: 'fixture', nativeId: SOURCE_NATIVE_ID, generation: f.source.generation,
    resume: true, dedupeKey: 'snapshot-conflict-resume', preparedTextSource: readTextFile(caption),
    fetchImpl: async () => { network += 1; assert.fail('rejected resume reached network'); } }),
  /prepared text source cannot be combined with file or resume input/);
  assert.equal(network, 0);
  assert.equal(recoveries.calls, 0);
  assert.equal(f.state.directPostFilePreparation('snapshot-conflict-resume'), null);
  assert.deepEqual(f.state.listReceipts(), before);
});

test('12 external preparedTextSource-shaped field is refused by the peer allowlist and the MCP schema', async t => {
  const f = makeFixture(t);
  const before = f.state.listReceipts();
  let network = 0;
  const peer = callerService(f, { fetchImpl: async () => { network += 1; assert.fail('allowlist refusal reached network'); } });
  const external = { sourcePath: '/tmp/external.txt', text: 'external', textHash: 'external-hash', parts: ['external'] };
  await assert.rejects(peer.send({ peer: { conductorId: 'recipient' }, text: 'hello', dedupe_key: 'snapshot-external',
    preparedTextSource: external }), /invalid peer send arguments/);
  assert.equal(network, 0);
  assert.deepEqual(f.state.listReceipts(), before);

  const server = createPeerMcp({ list: async () => [], send: async () => { throw new Error('unused'); },
    result: async () => ({}), post: async () => ({}) });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'snapshot-schema', version: '1' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const tools = (await client.listTools()).tools;
    const peerSend = tools.find(tool => tool.name === 'peer_send').inputSchema;
    const post = tools.find(tool => tool.name === 'post').inputSchema;
    assert.equal(peerSend.additionalProperties, false);
    assert.equal(post.additionalProperties, false);
    assert.equal(Object.hasOwn(peerSend.properties, 'preparedTextSource'), false);
    assert.equal(Object.hasOwn(post.properties, 'preparedTextSource'), false);
    const baselines = [
      [peerSend, { peer: { conductorId: 'recipient' }, text: 'hello', dedupe_key: 'snapshot-external' }],
      [post, { role: 'child', peer: { conductorId: 'recipient' }, text_file: '/tmp/request.txt', dedupe_key: 'snapshot-external' }]
    ];
    for (const [schema, valid] of baselines) {
      const validate = new Ajv({ strict: false }).compile(schema);
      assert.equal(validate(valid), true, 'baseline arguments validate');
      assert.equal(validate({ ...valid, preparedTextSource: external }), false, 'external field is refused');
    }
  } finally {
    await client.close();
    await server.close();
  }
});
