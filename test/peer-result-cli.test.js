'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { fixture, addRecipient } = require('./fixtures/peer-fixture');
const { SurfaceState } = require('../src/state');
const { encodeAgentMessage, KINDS } = require('../src/agent-message');
const { createPeerResultCommand } = require('../src/cli/peer-result');

const CLI = path.resolve(__dirname, '../src/cli.js');
const NATIVE = '11111111-1111-1111-1111-111111111111';
const OTHER = '22222222-2222-2222-2222-222222222222';

function prepared(t, provider = 'codex') {
  const f = fixture(t);
  f.state.db.prepare("UPDATE bindings SET provider=? WHERE channel_id='101'").run(provider);
  f.enroll('102');
  const target = addRecipient(f);
  const caller = f.state.getBinding('101');
  const request = { id: 'cli-inspection', kind: KINDS.REQUEST,
    source: { guildId: '100', channelId: '102', provider, nativeId: NATIVE, generation: caller.generation },
    target: { guildId: '100', channelId: '202', provider: 'codex', nativeId: target.nativeId, generation: target.generation },
    routingVersion: 2, replyTo: null, text: 'inspect the result' };
  const detail = { journal: 'direct-post-v1', requestId: request.id, guildId: caller.guildId,
    channelId: caller.channelId, provider: caller.provider, nativeId: caller.nativeId, generation: caller.generation,
    partIndex: 0, partCount: 1, attemptId: 'cli-attempt', agentPacket: request };
  f.state.receipt(null, 'direct-post-attempt', detail);
  f.state.receipt(null, 'direct-post-outcome', { ...detail, outcome: 'sent', messageId: '10001' });
  const packet = { id: 'cli-result', kind: KINDS.RESULT, source: request.target, target: request.source,
    routingVersion: 2, sourceParentChannelId: '201', replyTo: request.id, text: 'correlated reply' };
  const accepted = f.state.acceptDiscordMessage({ id: '10002', guildId: '100', channelId: '102',
    authorId: '901', isBot: true, content: encodeAgentMessage(packet, 'fixture') }, { agentToken: 'fixture' });
  assert.equal(accepted.accepted, true, JSON.stringify(accepted));
  return { ...f, packet, request, db: path.join(caller.workspace, 'surface.sqlite') };
}

function runCli(f, argv, environment = {}) {
  const deadline = path.join(path.dirname(f.db), 'cli-deadline.cjs');
  fs.writeFileSync(deadline, 'setTimeout(() => process.exit(124), 4000).unref();\n');
  return spawnSync(process.execPath, ['--require', deadline, CLI, ...argv], {
    env: { ...process.env, ...environment },
    encoding: 'utf8', timeout: 6000, maxBuffer: 65536
  });
}

function invoke(f, flags = [], identity = NATIVE) {
  return runCli(f, ['peer-result', '--provider', 'codex', '--db', f.db,
    '--correlation-id', f.request.id, ...flags], { CODEX_THREAD_ID: identity, CODEX_SESSION_ID: identity });
}

test('public CLI reads the current caller result without credentials or custody changes', t => {
  const f = prepared(t);
  const before = f.state.listReceipts();
  assert.equal(fs.existsSync(f.state.requireConfig().secretFile), false);
  const result = invoke(f);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.correlationId, f.request.id);
  assert.equal(output.sendOutcome, 'sent');
  assert.equal(output.results.length, 1);
  assert.equal(output.results[0].text, f.packet.text);
  assert.equal(output.results[0].state, 'accepted');
  assert.equal(output.results[0].nativeAcknowledged, false);
  assert.equal(output.results[0].completed, false);
  assert.deepEqual(f.state.listReceipts(), before);
  assert.equal(f.state.getMessage('10002').state, 'accepted');
});

test('public CLI refuses another caller correlation and cannot select a native UUID', t => {
  const f = prepared(t);
  const before = f.state.listReceipts();
  const other = invoke(f, [], OTHER);
  assert.equal(other.status, 1);
  assert.equal(other.stdout, '');
  const override = invoke(f, ['--native-id', NATIVE], OTHER);
  assert.equal(override.status, 1);
  assert.equal(override.stdout, '');
  assert.deepEqual(f.state.listReceipts(), before);
});

test('public CLI refuses absent or conflicting native invocation identity', t => {
  const f = prepared(t);
  const missing = invoke(f, [], '');
  assert.equal(missing.status, 1);
  assert.equal(missing.stdout, '');
  const result = runCli(f, ['peer-result', '--provider', 'codex', '--db', f.db,
    '--correlation-id', f.request.id], { CODEX_THREAD_ID: NATIVE, CODEX_SESSION_ID: OTHER });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
});

test('public CLI rejects unknown and repeated flags before opening a database', t => {
  const f = prepared(t);
  const untouched = path.join(path.dirname(f.db), 'unopened.sqlite');
  for (const flags of [['--typo', 'value'], ['--provider', 'claude']]) {
    const result = runCli(f, ['peer-result', '--provider', 'codex', '--db', untouched,
      '--correlation-id', f.request.id, ...flags]);
    assert.equal(result.status, 1);
    assert.equal(fs.existsSync(untouched), false);
  }
});

function commandHarness(f, extras = {}) {
  let opened;
  const printed = [];
  const command = createPeerResultCommand({
    required(args, key) {
      if (typeof args[key] !== 'string' || !args[key]) throw new Error('missing argument');
      return args[key];
    },
    openState() { opened = new SurfaceState(f.db); return { state: opened }; },
    print(value) { printed.push(value); },
    ...extras
  });
  return { command, printed, opened: () => opened };
}

const args = { provider: 'codex', 'correlation-id': 'cli-inspection' };
const dependencies = { callerDependencies: { environment: { CODEX_THREAD_ID: NATIVE, CODEX_SESSION_ID: NATIVE } } };

test('command closes its database after success and rejected input', async t => {
  const f = prepared(t);
  for (const input of [args, { ...args, 'correlation-id': 'unknown' }, { ...args, provider: 'wrong' }]) {
    const h = commandHarness(f);
    if (input === args) assert.equal((await h.command(input, dependencies)).results[0].text, f.packet.text);
    else await assert.rejects(h.command(input, dependencies));
    assert.throws(() => h.opened().getConfig());
  }
});

test('command reuses the Claude caller resolver', async t => {
  const f = prepared(t, 'claude');
  const h = commandHarness(f, { resolveCurrentClaudeCaller: async () => ({ harness: 'claude-code', sessionId: NATIVE }) });
  assert.equal((await h.command({ ...args, provider: 'claude' })).results[0].text, f.packet.text);
  assert.throws(() => h.opened().getConfig());
});

test('command refuses a caller generation change before printing and closes state', async t => {
  const f = prepared(t);
  const h = commandHarness(f);
  let calls = 0;
  await assert.rejects(h.command(args, { callerDependencies: {
    async resolveCodexCaller() {
      if (++calls === 2) f.state.db.prepare("UPDATE bindings SET generation=generation+1 WHERE channel_id='101'").run();
      return { sessionId: NATIVE, threadId: NATIVE, turnId: 'fixture-turn' };
    }
  } }), /caller changed/);
  assert.equal(h.printed.length, 0);
  assert.throws(() => h.opened().getConfig());
});

test('output failure still closes the database', async t => {
  const f = prepared(t);
  const failure = new Error('output closed');
  const h = commandHarness(f, { print() { throw failure; } });
  await assert.rejects(h.command(args, dependencies), error => error === failure);
  assert.throws(() => h.opened().getConfig());
});
