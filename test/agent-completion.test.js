const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { issueAgentAddress, encodeAgentMessage, KINDS } = require('../src/agent-message');
const { SurfaceState, MESSAGE_STATES, READINESS, StateCorruptError } = require('../src/state');
const { acknowledgmentCommand, recordNativeAcknowledgment } = require('../src/acknowledgment');
const { agentComplete, GATEWAY_CAPABILITIES } = require('../src/cli');
const { agentCompletionCommand, claudeEvent, codexPrompt } = require('../src/native');
const { runDirectPost } = require('../src/direct-post');
const { createSurfaceConsumer } = require('../src/discord');

const source = { guildId: '100', channelId: '101', provider: 'codex', nativeId: '11111111-1111-1111-1111-111111111111', generation: 1 };
const target = { guildId: '100', channelId: '102', provider: 'claude', nativeId: '22222222-2222-2222-2222-222222222222', generation: 2 };
const token = 'isolated-test-credential';

test('native owners receive the exact no-post completion command', () => {
  const message = {
    id: 'completion-packet-event', provider: target.provider, nativeId: target.nativeId, generation: target.generation,
    workspace: '/tmp', content: 'Handle this packet.', state: MESSAGE_STATES.SUBMITTED,
    agentMessage: { id: 'completion-packet', kind: KINDS.RESULT, source, target, replyTo: null, text: 'Handle this packet.' }
  };
  const completion = agentCompletionCommand(message, '/custom/state/surface.sqlite', '/custom/cli.js', '/custom/state');
  assert.deepEqual(completion.slice(1, 8), [
    '/custom/cli.js', 'agent-complete', '--state-dir', '/custom/state', '--db', '/custom/state/surface.sqlite', '--provider'
  ]);
  assert.equal(completion[completion.indexOf('--message-id') + 1], message.id);
  const instruction = JSON.stringify(completion);
  assert.match(codexPrompt(message, null, completion), new RegExp(instruction.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  const event = claudeEvent(message, completion);
  assert.match(event.content, new RegExp(instruction.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.deepEqual(event.completion, completion);

  const acknowledgment = acknowledgmentCommand(message, '/custom/state with spaces/surface.sqlite', '/custom/cli=entry.js');
  const prompt = codexPrompt(message, acknowledgment, completion);
  const commands = [...prompt.matchAll(/exact argv: (\[.*\])/g)].map(match => JSON.parse(match[1]));
  assert.deepEqual(commands, [acknowledgment, completion]);
  assert.ok(prompt.includes(`Final reply: start with [[discord-surface:${message.id}]] on its own line.`));
  assert.match(prompt, /ACK means received, not completed/);
  assert.match(prompt, /Choose exactly one:/);
  assert.match(prompt, /If fully handled without a Discord reply, run once/);
  assert.match(prompt, /Then no normal final response/);
  assert.ok(prompt.indexOf(JSON.stringify(acknowledgment)) < prompt.indexOf(message.agentMessage.text));
});

test('agent retry preserves a predecessor journal without inventing completion evidence', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-handled-upgrade-'));
  const state = new SurfaceState(path.join(dir, 'surface.sqlite'));
  try {
    state.setConfig({ operatorId: '900', guildId: source.guildId, secretFile: path.join(dir, 'secret') });
    const owners = bindAgentOwners(state, dir);
    const request = { id: 'a2-upgrade-request', kind: KINDS.REQUEST, source: owners.source, target: owners.target, replyTo: null, text: 'Handle this predecessor request.' };
    const requestMessageId = 'a2-upgrade-request-event';
    assert.equal(state.acceptDiscordMessage({ id: requestMessageId, guildId: owners.target.guildId, channelId: owners.target.channelId,
      authorId: '901', isBot: true, attachments: [], content: encodeAgentMessage(request, token) }, { agentToken: token }).accepted, true);
    const textFile = path.join(dir, 'a2-upgrade-result.txt');
    fs.writeFileSync(textFile, 'Predecessor-compatible result.');
    let sends = 0;
    const input = { state, token, nativeId: owners.target.nativeId, generation: owners.target.generation,
      channelId: owners.target.channelId, provider: owners.target.provider, textFile, dedupeKey: 'a2-upgrade-result',
      agentTarget: issueAgentAddress(owners.source, token), agentKind: KINDS.RESULT, agentReplyTo: request.id,
      fetchImpl: async (_url, options) => {
        if (options.method === 'POST') sends += 1;
        return { ok: true, status: 200, json: async () => options.method === 'GET'
          ? { id: owners.source.channelId, guild_id: owners.source.guildId } : { id: 'a2-upgrade-result-event' } };
      } };
    assert.equal((await runDirectPost(input)).status, 'sent');
    const before = state.directPostRows('a2-upgrade-result');
    const attemptBefore = before.find(row => row.kind === 'direct-post-attempt').detail;
    const outcomeBefore = before.find(row => row.kind === 'direct-post-outcome').detail;
    assert.ok(attemptBefore.agentPacket);
    state.db.prepare("SELECT id, detail FROM receipts WHERE discord_id IS NULL AND kind IN ('direct-post-attempt', 'direct-post-outcome') AND json_extract(detail, '$.requestId')=?")
      .all('a2-upgrade-result').forEach(row => {
        const detail = JSON.parse(row.detail);
        delete detail.agentPacket;
        state.db.prepare('UPDATE receipts SET detail=? WHERE id=?').run(JSON.stringify(detail), row.id);
      });
    const retry = await runDirectPost(input);
    assert.equal(retry.duplicate, true);
    assert.equal(retry.status, 'sent');
    assert.equal(sends, 1);
    const after = state.directPostRows('a2-upgrade-result');
    assert.equal(after.length, before.length);
    assert.equal(after.find(row => row.kind === 'direct-post-attempt').detail.nonce, attemptBefore.nonce);
    assert.equal(after.find(row => row.kind === 'direct-post-outcome').detail.messageId, outcomeBefore.messageId);
    assert.equal(after.find(row => row.kind === 'direct-post-attempt').detail.agentPacket, undefined);

    assert.equal(state.claimDispatch(requestMessageId).claimed, true);
    state.markSubmitted(requestMessageId);
    recordNativeAcknowledgment(state, { provider: owners.target.provider, messageId: requestMessageId,
      nativeId: owners.target.nativeId, generation: owners.target.generation });
    assert.throws(() => state.completeAgentHandledWithoutPost({ messageId: requestMessageId,
      provider: owners.target.provider, nativeId: owners.target.nativeId, generation: owners.target.generation }), /immutable correlated result/);
    assert.equal(state.getMessage(requestMessageId).state, MESSAGE_STATES.SUBMITTED);
  } finally { state.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

function bindAgentOwners(state, dir) {
  state.bind({ ...source, workspace: dir, conductorId: 'a2-source', repoKey: 'repo:a2-source' });
  state.bind({ ...target, workspace: dir, endpoint: '/tmp/agent-a2-target.sock', conductorId: 'a2-target', repoKey: 'repo:a2-target' });
  let sourceBinding = state.getBinding(source.channelId);
  let targetBinding = state.getBinding(target.channelId);
  sourceBinding = state.setBindingReadiness(source.channelId, READINESS.READY, 'A2 fixture ready', sourceBinding);
  targetBinding = state.setBindingReadiness(target.channelId, READINESS.READY, 'A2 fixture ready', targetBinding);
  return {
    source: { ...source, generation: sourceBinding.generation },
    target: { ...target, generation: targetBinding.generation }
  };
}

test('authenticated agent result reaches an explicit no-post terminal state', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-handled-result-'));
  const state = new SurfaceState(path.join(dir, 'surface.sqlite'));
  try {
    state.setConfig({ operatorId: '900', guildId: source.guildId, secretFile: path.join(dir, 'secret') });
    const owners = bindAgentOwners(state, dir);
    const resultPacket = {
      id: 'a2-result', kind: KINDS.RESULT, source: owners.source, target: owners.target,
      replyTo: 'remote-request', text: 'Authenticated result.'
    };
    const messageId = 'a2-result-event';
    const intake = state.acceptDiscordMessage({
      id: messageId, guildId: owners.target.guildId, channelId: owners.target.channelId,
      authorId: '901', isBot: true, attachments: [], content: encodeAgentMessage(resultPacket, token)
    }, { agentToken: token });
    assert.equal(intake.accepted, true);
    assert.equal(state.claimDispatch(messageId).claimed, true);
    state.markSubmitted(messageId);
    const complete = () => state.completeAgentHandledWithoutPost({
      messageId, provider: owners.target.provider, nativeId: owners.target.nativeId, generation: owners.target.generation
    });
    assert.throws(complete, /matching native acknowledgment/);
    recordNativeAcknowledgment(state, { provider: owners.target.provider, messageId, nativeId: owners.target.nativeId, generation: owners.target.generation });

    state.db.prepare('UPDATE messages SET reply_nonce=? WHERE discord_id=?').run('reply-custody-nonce', messageId);
    assert.throws(complete, /empty reply custody/);
    state.db.prepare('UPDATE messages SET reply_nonce=NULL, reply_next_part=1 WHERE discord_id=?').run(messageId);
    assert.throws(complete, /empty reply custody/);
    state.db.prepare('UPDATE messages SET reply_next_part=0 WHERE discord_id=?').run(messageId);
    state.db.prepare('INSERT INTO reply_parts(discord_id, part_index, content, nonce, state, updated_at) VALUES(?, ?, ?, ?, ?, ?)')
      .run(messageId, 0, 'owned reply part', 'reply-custody-part-nonce', 'pending', new Date().toISOString());
    assert.throws(complete, /empty reply custody/);
    state.db.prepare('DELETE FROM reply_parts WHERE discord_id=?').run(messageId);

    const completed = complete();
    assert.equal(completed.completed, true);
    assert.equal(completed.disposition, 'result-consumed');
    assert.equal(completed.message.state, MESSAGE_STATES.AGENT_HANDLED_WITHOUT_POST);
    assert.equal(completed.evidence.receiptId > 0, true);
    assert.equal(state.listReceipts().filter(row => row.discord_id === messageId && row.kind === 'result-consumed').length, 1);
    assert.deepEqual(state.recoveryCandidates(), []);
    assert.equal(state.hasUnresolved(owners.target.channelId), false);
    assert.throws(() => state.recordNativeReply({
      provider: owners.target.provider, messageId, nativeId: owners.target.nativeId,
      generation: owners.target.generation, text: 'Late reply must not reopen custody.'
    }), /reply is not accepted/);
    const duplicate = state.completeAgentHandledWithoutPost({
      messageId, provider: owners.target.provider, nativeId: owners.target.nativeId, generation: owners.target.generation
    });
    assert.equal(duplicate.duplicate, true);
    assert.equal(state.getMessage(messageId).state, MESSAGE_STATES.AGENT_HANDLED_WITHOUT_POST);
    const currentBinding = state.getBinding(owners.target.channelId);
    state.unbind(owners.target.channelId, { expectedBinding: currentBinding });
    assert.throws(complete, /stale|current|authorization/i);
  } finally { state.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('agent completion refuses native file custody admitted before reply record', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-handled-native-file-'));
  const state = new SurfaceState(path.join(dir, 'surface.sqlite'));
  try {
    state.setConfig({ operatorId: '900', guildId: source.guildId, secretFile: path.join(dir, 'secret') });
    const owners = bindAgentOwners(state, dir);
    const packet = { id: 'a2-file-result', kind: KINDS.RESULT, source: owners.source, target: owners.target,
      replyTo: 'remote-request', text: 'File result.' };
    const messageId = 'a2-file-result-event';
    assert.equal(state.acceptDiscordMessage({ id: messageId, guildId: owners.target.guildId, channelId: owners.target.channelId,
      authorId: '901', isBot: true, attachments: [], content: encodeAgentMessage(packet, token) }, { agentToken: token }).accepted, true);
    assert.equal(state.claimDispatch(messageId).claimed, true);
    state.markSubmitted(messageId);
    recordNativeAcknowledgment(state, { provider: owners.target.provider, messageId,
      nativeId: owners.target.nativeId, generation: owners.target.generation });
    const sourceFile = path.join(dir, 'answer.bin');
    fs.writeFileSync(sourceFile, Buffer.from('held before record'));
    state.prepareNativeReplyFile({ provider: owners.target.provider, messageId, nativeId: owners.target.nativeId,
      generation: owners.target.generation, stateDir: dir, sourcePath: sourceFile, caption: 'file result' });
    assert.throws(() => state.completeAgentHandledWithoutPost({ messageId, provider: owners.target.provider,
      nativeId: owners.target.nativeId, generation: owners.target.generation }), /native reply file custody/);
    assert.equal(state.getMessage(messageId).state, MESSAGE_STATES.SUBMITTED);
  } finally { state.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('agent completion fails closed on malformed native file custody', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-handled-native-file-corrupt-'));
  const state = new SurfaceState(path.join(dir, 'surface.sqlite'));
  try {
    state.setConfig({ operatorId: '900', guildId: source.guildId, secretFile: path.join(dir, 'secret') });
    const owners = bindAgentOwners(state, dir);
    const packet = { id: 'a2-corrupt-file-result', kind: KINDS.RESULT, source: owners.source, target: owners.target,
      replyTo: 'remote-request', text: 'Corrupt file result.' };
    const messageId = 'a2-corrupt-file-result-event';
    assert.equal(state.acceptDiscordMessage({ id: messageId, guildId: owners.target.guildId, channelId: owners.target.channelId,
      authorId: '901', isBot: true, attachments: [], content: encodeAgentMessage(packet, token) }, { agentToken: token }).accepted, true);
    assert.equal(state.claimDispatch(messageId).claimed, true);
    state.markSubmitted(messageId);
    recordNativeAcknowledgment(state, { provider: owners.target.provider, messageId,
      nativeId: owners.target.nativeId, generation: owners.target.generation });
    state.receipt(messageId, 'native-reply-file-preparation', {
      journal: 'native-reply-file-v1', phase: 'not-a-native-file-phase', preparationId: 'malformed-preparation'
    });
    assert.throws(() => state.completeAgentHandledWithoutPost({ messageId, provider: owners.target.provider,
      nativeId: owners.target.nativeId, generation: owners.target.generation }), StateCorruptError);
    assert.equal(state.getMessage(messageId).state, MESSAGE_STATES.SUBMITTED);
  } finally { state.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('agent request completion requires a full reversed result receipt', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-handled-request-'));
  const state = new SurfaceState(path.join(dir, 'surface.sqlite'));
  try {
    state.setConfig({ operatorId: '900', guildId: source.guildId, secretFile: path.join(dir, 'secret') });
    const owners = bindAgentOwners(state, dir);
    const request = { id: 'a2-request', kind: KINDS.REQUEST, source: owners.source, target: owners.target, replyTo: null, text: 'Handle this request.' };
    const requestMessageId = 'a2-request-event';
    assert.equal(state.acceptDiscordMessage({
      id: requestMessageId, guildId: owners.target.guildId, channelId: owners.target.channelId,
      authorId: '901', isBot: true, attachments: [], content: encodeAgentMessage(request, token)
    }, { agentToken: token }).accepted, true);
    assert.equal(state.claimDispatch(requestMessageId).claimed, true);
    state.markSubmitted(requestMessageId);
    recordNativeAcknowledgment(state, { provider: owners.target.provider, messageId: requestMessageId, nativeId: owners.target.nativeId, generation: owners.target.generation });
    assert.throws(() => state.completeAgentHandledWithoutPost({
      messageId: requestMessageId, provider: owners.target.provider, nativeId: owners.target.nativeId, generation: owners.target.generation
    }), /immutable correlated result/);
    assert.equal(state.getMessage(requestMessageId).state, MESSAGE_STATES.SUBMITTED);

    const wrongReply = {
      id: 'a2-wrong-reply-result', kind: KINDS.RESULT, source: owners.target, target: owners.source,
      replyTo: 'a2-different-request', text: 'Unrelated result.'
    };
    assert.equal(state.acceptDiscordMessage({
      id: 'a2-wrong-reply-event', guildId: owners.source.guildId, channelId: owners.source.channelId,
      authorId: '902', isBot: true, attachments: [], content: encodeAgentMessage(wrongReply, token)
    }, { agentToken: token }).accepted, true);
    assert.throws(() => state.completeAgentHandledWithoutPost({
      messageId: requestMessageId, provider: owners.target.provider, nativeId: owners.target.nativeId, generation: owners.target.generation
    }), /immutable correlated result/);

    const result = {
      id: 'a2-received-result', kind: KINDS.RESULT, source: owners.target, target: owners.source,
      replyTo: request.id, text: 'The request is complete.'
    };
    const resultMessageId = 'a2-received-result-event';
    assert.equal(state.acceptDiscordMessage({
      id: resultMessageId, guildId: owners.source.guildId, channelId: owners.source.channelId,
      authorId: '902', isBot: true, attachments: [], content: encodeAgentMessage(result, token)
    }, { agentToken: token }).accepted, true);
    const completed = state.completeAgentHandledWithoutPost({
      messageId: requestMessageId, provider: owners.target.provider, nativeId: owners.target.nativeId, generation: owners.target.generation
    });
    assert.equal(completed.completed, true);
    assert.equal(completed.evidence.kind, 'received-result');
    assert.equal(completed.evidence.packetId, result.id);
    assert.equal(completed.evidence.replyTo, request.id);
    assert.deepEqual(completed.evidence.source, request.target);
    assert.deepEqual(completed.evidence.target, request.source);
    assert.equal(state.getMessage(requestMessageId).state, MESSAGE_STATES.AGENT_HANDLED_WITHOUT_POST);
    assert.equal(state.getMessage(resultMessageId).state, MESSAGE_STATES.ACCEPTED);
  } finally { state.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('request completion accepts a Discord-id alias with nonce-only direct-result reconciliation', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-handled-unknown-result-'));
  const state = new SurfaceState(path.join(dir, 'surface.sqlite'));
  try {
    state.setConfig({ operatorId: '900', guildId: source.guildId, secretFile: path.join(dir, 'secret') });
    const owners = bindAgentOwners(state, dir);
    const request = { id: 'a2-unknown-request', kind: KINDS.REQUEST, source: owners.source, target: owners.target, replyTo: null, text: 'Wait for a reliable result.' };
    const messageId = 'a2-unknown-request-event';
    assert.equal(state.acceptDiscordMessage({ id: messageId, guildId: owners.target.guildId, channelId: owners.target.channelId,
      authorId: '901', isBot: true, attachments: [], content: encodeAgentMessage(request, token) }, { agentToken: token }).accepted, true);
    assert.equal(state.claimDispatch(messageId).claimed, true);
    state.markSubmitted(messageId);
    recordNativeAcknowledgment(state, { provider: owners.target.provider, messageId,
      nativeId: owners.target.nativeId, generation: owners.target.generation });
    const textFile = path.join(dir, 'a2-unknown-result.txt');
    fs.writeFileSync(textFile, 'Uncertain result.');
    const result = await runDirectPost({ state, token, nativeId: owners.target.nativeId, generation: owners.target.generation,
      channelId: owners.target.channelId, provider: owners.target.provider, textFile, dedupeKey: 'a2-unknown-result',
      agentTarget: issueAgentAddress(owners.source, token), agentKind: KINDS.RESULT, agentReplyTo: messageId,
      fetchImpl: async (_url, options) => {
        if (options.method === 'POST') throw Object.assign(new Error('transport outcome unknown'), { outcome: 'unknown' });
        return { ok: true, status: 200, json: async () => ({ id: owners.source.channelId, guild_id: owners.source.guildId }) };
      } });
    assert.equal(result.status, 'unknown');
    assert.equal(state.directPostRows('a2-unknown-result').at(-1).detail.outcome, 'unknown');
    const attempt = state.directPostRows('a2-unknown-result').find(row => row.kind === 'direct-post-attempt');
    assert.equal(attempt.detail.agentPacket.replyTo, request.id);
    assert.throws(() => state.completeAgentHandledWithoutPost({ messageId,
      provider: owners.target.provider, nativeId: owners.target.nativeId, generation: owners.target.generation }), /immutable correlated result/);
    state.reconcileDirectPostOutcome('a2-unknown-result', attempt.detail.attemptId, 'sent', {
      source: 'operator-reconciliation', nonce: attempt.detail.nonce
    });
    const completed = state.completeAgentHandledWithoutPost({ messageId,
      provider: owners.target.provider, nativeId: owners.target.nativeId, generation: owners.target.generation });
    assert.equal(completed.evidence.kind, 'sent-result');
    assert.equal(completed.evidence.nonce, attempt.detail.nonce);
    assert.equal(completed.evidence.messageId, undefined);
    assert.equal(state.getMessage(messageId).state, MESSAGE_STATES.AGENT_HANDLED_WITHOUT_POST);
  } finally { state.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('agent-complete guards mutation on Gateway capability and requests a wake', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-complete-cli-'));
  const db = path.join(dir, 'surface.sqlite');
  let state = new SurfaceState(db);
  try {
    state.setConfig({ operatorId: '900', guildId: source.guildId, secretFile: path.join(dir, 'secret') });
    const owners = bindAgentOwners(state, dir);
    const request = { id: 'a2-cli-request', kind: KINDS.REQUEST, source: owners.source, target: owners.target, replyTo: null, text: 'Complete from CLI.' };
    const messageId = 'a2-cli-request-event';
    assert.equal(state.acceptDiscordMessage({
      id: messageId, guildId: owners.target.guildId, channelId: owners.target.channelId,
      authorId: '901', isBot: true, attachments: [], content: encodeAgentMessage(request, token)
    }, { agentToken: token }).accepted, true);
    assert.equal(state.claimDispatch(messageId).claimed, true);
    state.markSubmitted(messageId);
    recordNativeAcknowledgment(state, { provider: owners.target.provider, messageId, nativeId: owners.target.nativeId, generation: owners.target.generation });
    const resultFile = path.join(dir, 'a2-cli-result.txt');
    fs.writeFileSync(resultFile, 'CLI result.');
    const sent = await runDirectPost({
      state, token, nativeId: owners.target.nativeId, generation: owners.target.generation,
      channelId: owners.target.channelId, provider: owners.target.provider, textFile: resultFile,
      dedupeKey: 'a2-cli-result', agentTarget: issueAgentAddress(owners.source, token),
      agentKind: KINDS.RESULT, agentReplyTo: request.id,
      fetchImpl: async (_url, options) => ({ ok: true, status: 200, json: async () => options.method === 'GET'
        ? { id: owners.source.channelId, guild_id: owners.source.guildId } : { id: 'a2-cli-sent-result' } })
    });
    assert.equal(sent.status, 'sent');
    const argsFor = id => ({ 'message-id': id, provider: owners.target.provider,
      'native-id': owners.target.nativeId, generation: String(owners.target.generation) });
    const stoppedResult = { id: 'a2-cli-stopped-result', kind: KINDS.RESULT, source: owners.source, target: owners.target,
      replyTo: 'remote-request', text: 'Complete while Gateway is stopped.' };
    const stoppedMessageId = 'a2-cli-stopped-result-event';
    assert.equal(state.acceptDiscordMessage({
      id: stoppedMessageId, guildId: owners.target.guildId, channelId: owners.target.channelId,
      authorId: '901', isBot: true, attachments: [], content: encodeAgentMessage(stoppedResult, token)
    }, { agentToken: token }).accepted, true);
    assert.equal(state.claimDispatch(stoppedMessageId).claimed, true);
    state.markSubmitted(stoppedMessageId);
    recordNativeAcknowledgment(state, { provider: owners.target.provider, messageId: stoppedMessageId,
      nativeId: owners.target.nativeId, generation: owners.target.generation });
    const stopped = agentComplete({ ...argsFor(stoppedMessageId), 'state-dir': dir }, {
      gatewayProcessStatus: () => ({ state: 'stopped', pid: null }),
      print: () => {}
    });
    assert.equal(stopped.completed, true);
    assert.equal(stopped.gatewayWake.requested, false);
    state.close();
    state = null;

    const args = { ...argsFor(messageId), 'state-dir': dir };
    const unknown = () => agentComplete(args, {
      gatewayProcessStatus: () => ({}),
      print: () => {}
    });
    assert.throws(unknown, /Gateway status is unknown/);
    const unsupported = () => agentComplete(args, {
      gatewayProcessStatus: () => ({ state: 'running', pid: 7301, capabilities: [] }),
      print: () => {}
    });
    assert.throws(unsupported, /does not support agent handled-without-post completion/);
    state = new SurfaceState(db);
    assert.equal(state.getMessage(messageId).state, MESSAGE_STATES.SUBMITTED);
    state.close();
    state = null;

    let wakeOptions;
    const output = [];
    const completed = agentComplete(args, {
      gatewayProcessStatus: () => ({ state: 'running', pid: 7301, capabilities: [GATEWAY_CAPABILITIES.agentHandledWithoutPost] }),
      requestGatewayRecovery: (_paths, options) => {
        wakeOptions = options;
        return { requested: true, pid: 7301, signal: 'SIGUSR2' };
      },
      print: value => output.push(value)
    });
    assert.equal(completed.completed, true);
    assert.equal(completed.gatewayWake.requested, true);
    assert.equal(wakeOptions.expectedPid, 7301);
    assert.equal(wakeOptions.requiredCapability, GATEWAY_CAPABILITIES.agentHandledWithoutPost);
    assert.equal(output.length, 1);
    state = new SurfaceState(db);
    assert.equal(state.getMessage(messageId).state, MESSAGE_STATES.AGENT_HANDLED_WITHOUT_POST);
  } finally { state?.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('no-post completion releases a queued same-owner message through the wake path', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-handled-queue-'));
  const state = new SurfaceState(path.join(dir, 'surface.sqlite'));
  let firstObserveStartedResolve;
  let releaseFirstObserve;
  const firstObserveStarted = new Promise(resolve => { firstObserveStartedResolve = resolve; });
  try {
    state.setConfig({ operatorId: '900', guildId: source.guildId, secretFile: path.join(dir, 'secret') });
    const owners = bindAgentOwners(state, dir);
    const firstPacket = { id: 'a2-queue-first', kind: KINDS.RESULT, source: owners.source, target: owners.target,
      replyTo: 'first-request', text: 'First result.' };
    const secondPacket = { id: 'a2-queue-second', kind: KINDS.RESULT, source: owners.source, target: owners.target,
      replyTo: 'second-request', text: 'Second result.' };
    const dispatches = [];
    const observations = [];
    const replies = [];
    const consumer = createSurfaceConsumer({
      state,
      providers: {
        claude: {
          async dispatch(message) { dispatches.push(message.id); return { status: 'submitted' }; },
          observe(message, _outcome, { signal }) {
            observations.push(message.id);
            if (message.id !== 'a2-queue-first-event') return { text: 'Second native answer.' };
            firstObserveStartedResolve();
            return new Promise(resolve => {
              releaseFirstObserve = resolve;
              signal?.addEventListener('abort', () => resolve({ stopped: true }), { once: true });
            });
          }
        }
      },
      agentCredential: () => token,
      sendTransportReceipt: async () => ({ id: 'transport-receipt' }),
      sendReply: async (message, reply) => { replies.push(message.id); return { id: `reply-${reply.id}` }; }
    });
    const eventFor = (id, value) => ({ id, guildId: owners.target.guildId, channelId: owners.target.channelId,
      author: { id: '901', bot: true }, content: encodeAgentMessage(value, token), attachments: [], channel: {} });
    const first = consumer.handleMessage(eventFor('a2-queue-first-event', firstPacket));
    await firstObserveStarted;
    const firstMessage = state.getMessage('a2-queue-first-event');
    recordNativeAcknowledgment(state, { provider: owners.target.provider, messageId: firstMessage.id,
      nativeId: owners.target.nativeId, generation: owners.target.generation });
    const second = consumer.handleMessage(eventFor('a2-queue-second-event', secondPacket));
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(dispatches, ['a2-queue-first-event']);
    state.completeAgentHandledWithoutPost({ messageId: firstMessage.id, provider: owners.target.provider,
      nativeId: owners.target.nativeId, generation: owners.target.generation });
    assert.equal(consumer.releaseHandledWithoutPost(), false);
    for (let attempt = 0; attempt < 100 && dispatches.length < 2; attempt += 1) await new Promise(resolve => setTimeout(resolve, 1));
    assert.deepEqual(dispatches, ['a2-queue-first-event', 'a2-queue-second-event']);
    const secondResult = await second;
    assert.equal(secondResult.message.state, MESSAGE_STATES.REPLIED);
    assert.equal(state.getMessage(firstMessage.id).state, MESSAGE_STATES.AGENT_HANDLED_WITHOUT_POST);
    assert.deepEqual(observations, ['a2-queue-first-event', 'a2-queue-second-event']);
    assert.deepEqual(replies, ['a2-queue-second-event']);
    releaseFirstObserve?.({ stopped: true });
    await first;
  } finally { state.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('handled completion leaves later accepted owner work recoverable after restart', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-handled-restart-'));
  const db = path.join(dir, 'surface.sqlite');
  let state = new SurfaceState(db);
  try {
    state.setConfig({ operatorId: '900', guildId: source.guildId, secretFile: path.join(dir, 'secret') });
    const owners = bindAgentOwners(state, dir);
    const eventFor = (id, packetValue) => ({ id, guildId: owners.target.guildId, channelId: owners.target.channelId,
      authorId: '901', isBot: true, attachments: [], content: encodeAgentMessage(packetValue, token) });
    const firstPacket = { id: 'a2-restart-first', kind: KINDS.RESULT, source: owners.source, target: owners.target,
      replyTo: 'restart-first-request', text: 'First result is consumed.' };
    const secondPacket = { id: 'a2-restart-second', kind: KINDS.RESULT, source: owners.source, target: owners.target,
      replyTo: 'restart-second-request', text: 'Second result remains queued.' };
    assert.equal(state.acceptDiscordMessage(eventFor('a2-restart-first-event', firstPacket), { agentToken: token }).accepted, true);
    assert.equal(state.acceptDiscordMessage(eventFor('a2-restart-second-event', secondPacket), { agentToken: token }).accepted, true);
    assert.equal(state.claimDispatch('a2-restart-first-event').claimed, true);
    state.markSubmitted('a2-restart-first-event');
    recordNativeAcknowledgment(state, { provider: owners.target.provider, messageId: 'a2-restart-first-event',
      nativeId: owners.target.nativeId, generation: owners.target.generation });
    state.completeAgentHandledWithoutPost({ messageId: 'a2-restart-first-event', provider: owners.target.provider,
      nativeId: owners.target.nativeId, generation: owners.target.generation });
    assert.deepEqual(state.recoveryCandidates().map(message => message.id), ['a2-restart-second-event']);
    state.close();
    state = new SurfaceState(db);
    assert.deepEqual(state.recoveryCandidates().map(message => message.id), ['a2-restart-second-event']);
  } finally { state?.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});


test('agent completion stays eligible after newest capacity refusal cleanup and reopen', async t => {
  for (const provider of ['codex', 'claude']) await t.test(provider, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-handled-released-refusal-'));
    const db = path.join(dir, 'surface.sqlite');
    let state = new SurfaceState(db);
    try {
      state.setConfig({ operatorId: '900', guildId: source.guildId, secretFile: path.join(dir, 'secret') });
      const bound = bindAgentOwners(state, dir);
      const owners = provider === 'claude' ? bound : { source: bound.target, target: bound.source };
      const ownerIdentity = state.directPostOwnerIdentity(process.pid);
      for (let index = 0; index < 8; index += 1) {
        const preparationId = `55555555-5555-4555-8555-${String(index).padStart(12, '0')}`;
        state.beginDirectPostFilePreparation({
          preparationId, requestId: `completion-capacity-${index}`, custodyRoot: dir,
          sourcePath: path.join(dir, `${preparationId}.bin`),
          stagedPath: path.join(dir, '.direct-post-files', `${preparationId}.bin`),
          filename: `${preparationId}.bin`, size: 0, caption: 'held direct file', captionHash: `caption-${index}`,
          ...owners.target, operatorId: '900', inReplyTo: null, ...ownerIdentity
        });
      }
      const messageId = 'released-refusal-result-event';
      const packet = { id: 'released-refusal-result', kind: KINDS.RESULT,
        source: owners.source, target: owners.target, replyTo: 'remote-request', text: 'Result.' };
      assert.equal(state.acceptDiscordMessage({ id: messageId, guildId: owners.target.guildId,
        channelId: owners.target.channelId, authorId: '901', isBot: true, attachments: [],
        content: encodeAgentMessage(packet, token) }, { agentToken: token }).accepted, true);
      assert.equal(state.claimDispatch(messageId).claimed, true);
      state.markSubmitted(messageId);
      const identity = { messageId, provider, nativeId: owners.target.nativeId, generation: owners.target.generation };
      recordNativeAcknowledgment(state, identity);
      const sourceFile = path.join(dir, 'answer.bin');
      fs.writeFileSync(sourceFile, 'refused result bytes');
      const input = { ...identity, stateDir: dir, sourcePath: sourceFile, caption: 'first caption' };
      assert.throws(() => state.prepareNativeReplyFile(input), /file custody capacity is exhausted/);
      const older = state.nativeReplyFilePreparation(messageId);
      assert.throws(() => state.prepareNativeReplyFile({ ...input, caption: 'changed caption' }), /file custody capacity is exhausted/);
      const latest = state.nativeReplyFilePreparation(messageId);
      assert.notEqual(latest.preparationId, older.preparationId);
      assert.throws(() => state.completeAgentHandledWithoutPost(identity), /native reply file custody/);
      state.directPostOwnerAlive = () => false;
      state.releaseNativeReplyFilePreparation(messageId, latest.preparationId);
      state.close();
      state = new SurfaceState(db);
      const completed = state.completeAgentHandledWithoutPost(identity);
      assert.equal(completed.completed, true);
      assert.equal(completed.disposition, 'result-consumed');
      assert.equal(completed.message.state, MESSAGE_STATES.AGENT_HANDLED_WITHOUT_POST);
      assert.deepEqual(state.listReplyParts(messageId), []);
      assert.equal(state.activeFilePreparationCount(), 8);
    } finally { state.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
