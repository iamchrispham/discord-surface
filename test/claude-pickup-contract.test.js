'use strict';

// Focused behavioral contract for the shared Claude pickup acknowledgment branch.
// The suite exercises the real default MCP handshake and real Monitor payload
// generation, and real recordNativeAcknowledgment against disposable state.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
const { z } = require('zod');

const { SurfaceState, MESSAGE_STATES, READINESS } = require('../src/state');
const { THREAD_STATES } = require('../src/state/thread-enrollment');
const { KINDS, encodeAgentMessage } = require('../src/agent-message');
const { runWatcherNoticePost } = require('../src/direct-post');
const { createDefaultMcp, CLAUDE_PICKUP_ACKNOWLEDGMENT } = require('../src/claude-channel');
const { createMonitorMcp } = require('../src/claude-monitor');
const { ClaudeChannel } = require('../src/claude-channel');
const { ClaudeProvider, agentCompletionCommand, watcherNoticeCompletionCommand } = require('../src/native');
const { acknowledgmentCommand, recordNativeAcknowledgment } = require('../src/acknowledgment');

const CLAUDE_ID = '79e3da8e-94b4-4aff-8f88-b45b3a451dd1';
const OTHER_CLAUDE_ID = '7b7b7b7b-7b7b-4b7b-8b7b-7b7b7b7b7b7b';
const CODEX_ID = '9caa5d21-2169-429d-918b-5f08651b5dbd';
const GUILD_ID = '100';
const OWNER_CHANNEL = '101';
const CHILD_CHANNEL = '102';
const TOKEN = 'pickup-contract-credential';
const CLI_PATH = path.resolve(__dirname, '../src/cli.js');

// Exact mandated sentence sequence; the production owner must emit this verbatim.
const SHARED_CONDITION =
  'Proceed with this notification only if acknowledgment returns recorded=true. ' +
  'If duplicate=true, stop handling this notification without executing its request or posting or completing it again. ' +
  'If acknowledgment fails or its result is missing or ambiguous, stop and report the error without executing the request. ' +
  'Acknowledgment records receipt, not completed work. It never authorizes retrying interrupted work.';

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pickup-contract-'));
  const db = path.join(dir, 'surface.sqlite');
  const state = new SurfaceState(db);
  state.setConfig({ operatorId: '900', guildId: GUILD_ID, secretFile: path.join(dir, 'secret') });
  state.bind({
    channelId: OWNER_CHANNEL, guildId: GUILD_ID, provider: 'claude', nativeId: CLAUDE_ID,
    workspace: dir, endpoint: path.join(dir, 'claude.sock')
  });
  let binding = state.getBinding(OWNER_CHANNEL);
  binding = state.setBindingReadiness(OWNER_CHANNEL, READINESS.READY, 'pickup contract fixture ready', binding);
  state.enrollThread({ threadId: CHILD_CHANNEL, parentChannelId: OWNER_CHANNEL, guildId: GUILD_ID }, binding);
  state.setThreadBaseline(CHILD_CHANNEL, '1000', binding);
  state.markThreadBoundary(CHILD_CHANNEL, THREAD_STATES.READY, 'pickup contract fixture adopted', null, null, binding);
  return { dir, db, state, binding };
}

function dispose(f) {
  try { f.state.close(); } catch {}
  fs.rmSync(f.dir, { recursive: true, force: true });
}

function submitHuman(f, id, content = 'Ordinary human pickup request.') {
  const accepted = f.state.acceptDiscordMessage({
    id, guildId: GUILD_ID, channelId: OWNER_CHANNEL, authorId: '900', isBot: false, attachments: [], content
  });
  assert.equal(accepted.accepted, true, `human intake rejected: ${accepted.reason}`);
  assert.equal(f.state.claimDispatch(id).claimed, true);
  f.state.markSubmitted(id);
  return f.state.getMessage(id);
}

function submitAgentResult(f, id) {
  const packet = {
    id: `contract-result-${id}`,
    kind: KINDS.RESULT,
    source: { guildId: GUILD_ID, channelId: '201', provider: 'codex', nativeId: CODEX_ID, generation: 1 },
    target: {
      guildId: GUILD_ID, channelId: CHILD_CHANNEL, provider: 'claude',
      nativeId: CLAUDE_ID, generation: f.binding.generation
    },
    replyTo: 'contract-remote-request',
    text: 'Authenticated agent completion body.'
  };
  const accepted = f.state.acceptDiscordMessage({
    id, guildId: GUILD_ID, channelId: CHILD_CHANNEL, authorId: '901', isBot: true,
    attachments: [], content: encodeAgentMessage(packet, TOKEN)
  }, { agentToken: TOKEN });
  assert.equal(accepted.accepted, true, `agent result intake rejected: ${accepted.reason}`);
  assert.equal(f.state.claimDispatch(id).claimed, true);
  f.state.markSubmitted(id);
  return f.state.getMessage(id);
}

async function submitWatcherNotice(f, id) {
  const armKey = `pickup-contract-arm-${id}`;
  const triggerKey = `pickup-contract-trigger-${id}`;
  const textFile = path.join(f.dir, `${id}.txt`);
  fs.writeFileSync(textFile, 'Watcher notice body.');
  const armed = f.state.armWatcherNotice({
    armKey, parentChannelId: OWNER_CHANNEL, childChannelId: CHILD_CHANNEL,
    provider: 'claude', nativeId: CLAUDE_ID, generation: f.binding.generation,
    caller: { harness: 'claude-code', sessionId: CLAUDE_ID, threadId: CLAUDE_ID }
  });
  assert.equal(armed.armed, true);
  let postedBody = null;
  const sent = await runWatcherNoticePost({
    state: f.state, token: TOKEN, armKey, triggerKey, textFile,
    fetchImpl: async (_url, options) => {
      if (options.method === 'GET') return { ok: true, status: 200, json: async () => ({ id: CHILD_CHANNEL, guild_id: GUILD_ID }) };
      postedBody = JSON.parse(options.body);
      return { ok: true, status: 200, json: async () => ({ id }) };
    }
  });
  assert.equal(sent.status, 'sent');
  const accepted = f.state.acceptDiscordMessage({
    id, guildId: GUILD_ID, channelId: CHILD_CHANNEL, authorId: '901', isBot: true,
    attachments: [], content: postedBody.content
  }, { agentToken: TOKEN });
  assert.equal(accepted.accepted, true, `watcher notice intake rejected: ${accepted.reason}`);
  assert.equal(f.state.claimDispatch(id).claimed, true);
  f.state.markSubmitted(id);
  const message = f.state.getMessage(id);
  assert.ok(message.watcherNotice);
  return message;
}

function captureStdout() {
  const stdout = new EventEmitter();
  const pointers = [];
  stdout.write = (chunk, callback) => {
    pointers.push(JSON.parse(String(chunk)));
    callback?.();
    return true;
  };
  return { stdout, pointers };
}

function assertAcknowledgmentCommand(payload, message, f) {
  const command = payload.acknowledgment.command;
  const expected = acknowledgmentCommand(
    { id: message.id, nativeId: CLAUDE_ID, generation: message.generation, provider: 'claude' },
    path.resolve(f.db), path.resolve(CLI_PATH)
  );
  assert.deepEqual(command, expected);
  assert.equal(command[0], process.execPath);
  assert.equal(command[1], path.resolve(CLI_PATH));
  assert.equal(command[2], 'native-ack');
  assert.deepEqual(command.slice(3), [
    '--db', path.resolve(f.db),
    '--provider', 'claude',
    '--message-id', message.id,
    '--native-id', CLAUDE_ID,
    '--generation', String(message.generation)
  ]);
}

function assertSharedBranchInstruction(instructions, workMarker) {
  assert.ok(instructions.includes(SHARED_CONDITION), `shared condition missing from: ${instructions}`);
  const ackIndex = instructions.indexOf('acknowledgment.command');
  const conditionIndex = instructions.indexOf(SHARED_CONDITION);
  const workIndex = instructions.indexOf(workMarker);
  assert.ok(ackIndex >= 0, `ack step missing from: ${instructions}`);
  assert.ok(workIndex >= 0, `work marker ${JSON.stringify(workMarker)} missing from: ${instructions}`);
  assert.ok(ackIndex < conditionIndex, 'ACK step must precede the shared condition');
  assert.ok(conditionIndex < workIndex, 'shared condition must precede the work instruction');
}

// F1: the emitted pointer is metadata only. Every branch must delegate to the
// payload and must not restate an unconditional reply, completion, or consume.
function assertPointerDelegates(pointer, payload) {
  const instructions = pointer.instructions;
  assert.equal(typeof instructions, 'string');
  assert.match(instructions, /payload\.instructions/, `pointer must delegate to payload.instructions: ${instructions}`);
  assert.match(instructions, /Read the payload at payloadPath with Read/, `pointer must direct a payload read: ${instructions}`);
  assert.doesNotMatch(instructions, /Run acknowledgment\.command/, `pointer must not restate the ACK step: ${instructions}`);
  assert.doesNotMatch(instructions, /run completion\.command once/, `pointer must not restate an unconditional completion: ${instructions}`);
  assert.doesNotMatch(instructions, /answer through reply\.command/, `pointer must not restate an unconditional reply: ${instructions}`);
  assert.doesNotMatch(instructions, /use reply\.command or completion\.command/, `pointer must not restate the kind choice: ${instructions}`);
  assert.deepEqual(pointer.meta, { messageId: payload.meta.messageId, nativeId: payload.meta.nativeId, generation: payload.meta.generation });
  assert.equal(pointer.type, 'discord-surface/claude-monitor');
  assert.equal(pointer.payloadPath, path.resolve(pointer.payloadPath));
  assert.deepEqual(pointer.watcherNotice, payload.watcherNotice);
}

// F2: share one extraction of the ACK tool step so the direct event assertion
// pins the exact tool name and argument boundaries, not just the sentence.
function assertDirectEventAcknowledgment(content, messageId, generation, workMarker) {
  const ackStep = content.split('\n').find(line => line.startsWith('At pickup, call acknowledge with messageId'));
  assert.ok(ackStep, `direct event ACK tool step missing from: ${content}`);
  assert.ok(ackStep.includes(`messageId "${messageId}"`), `ACK tool step must carry the exact messageId: ${ackStep}`);
  assert.ok(ackStep.includes(`generation ${generation}`), `ACK tool step must carry the exact generation: ${ackStep}`);
  assert.ok(ackStep.includes(CLAUDE_PICKUP_ACKNOWLEDGMENT), `ACK tool step must carry the exact shared condition: ${ackStep}`);
  const ackIndex = content.indexOf('At pickup, call acknowledge with messageId');
  const conditionIndex = content.indexOf(CLAUDE_PICKUP_ACKNOWLEDGMENT);
  const workIndex = content.indexOf(workMarker);
  assert.ok(conditionIndex >= 0, 'shared condition missing from direct event');
  assert.ok(workIndex >= 0, `per-kind work marker ${JSON.stringify(workMarker)} missing from direct event: ${content}`);
  assert.ok(ackIndex < conditionIndex, 'ACK tool step must precede the shared condition');
  assert.ok(conditionIndex < workIndex, 'per-kind work instruction must follow the shared condition');
}

async function captureDirectNotifications(f, messages, completionFor) {
  const server = createDefaultMcp({ nativeId: CLAUDE_ID, state: f.state });
  const client = new Client({ name: 'pickup-contract-direct-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const received = [];
  // Named-handler form: the SDK registers the handler by the schema's method
  // literal, so the assertion cannot ride on the catch-all fallback path.
  client.setNotificationHandler(
    z.object({ method: z.literal('notifications/claude/channel'), params: z.object({}).passthrough() }),
    async notification => { received.push(notification); }
  );
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const channel = new ClaudeChannel({ state: f.state, nativeId: CLAUDE_ID, socketPath: f.binding.endpoint, mcp: server });
  channel.ready = true;
  const posted = [];
  const provider = new ClaudeProvider({
    completionFor,
    post: async (_endpoint, body) => {
      posted.push(body);
      await channel.handleEvent(body);
      return { statusCode: 202, wrote: true };
    }
  });
  try {
    const outcomes = [];
    for (const message of messages) {
      outcomes.push(await provider.dispatch({ ...message, endpoint: f.binding.endpoint }));
    }
    return { received, posted, outcomes };
  } finally {
    await channel.stop();
    await client.close();
    await server.close();
  }
}

test('real default MCP handshake exposes the shared ACK branch and delegates post-ACK work', async () => {
  const f = fixture();
  try {
    submitHuman(f, '2001', 'MCP handshake pickup request.');
    const server = createDefaultMcp({ nativeId: CLAUDE_ID, state: f.state });
    const client = new Client({ name: 'pickup-contract-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const instructions = client.getInstructions();
      assert.equal(typeof instructions, 'string');
      assert.ok(instructions.includes(SHARED_CONDITION), `MCP instructions missing shared condition: ${instructions}`);
      const ackIndex = instructions.indexOf('For each event, call acknowledge at pickup');
      const conditionIndex = instructions.indexOf(SHARED_CONDITION);
      const delegationIndex = instructions.indexOf("follow the event's kind-specific instructions exactly");
      assert.ok(ackIndex >= 0, `ACK-first step missing: ${instructions}`);
      assert.ok(delegationIndex >= 0, `event-kind delegation missing: ${instructions}`);
      assert.doesNotMatch(
        instructions,
        /\b(?:Then|Always|For each event,|For every event,)\s+(?:answer(?: the user)?|call (?:reply|completion|consume)|run (?:reply|completion|consume)|use (?:reply|completion|consume)|complete)\b/i,
        `default MCP instructions must not choose a post-ACK action: ${instructions}`
      );
      assert.ok(ackIndex < conditionIndex, 'ACK-first step must precede the shared condition');
      assert.ok(conditionIndex < delegationIndex, 'shared condition must precede event-kind delegation');

      const tools = (await client.listTools()).tools;
      assert.deepEqual(tools.map(tool => tool.name).sort(), ['acknowledge', 'reply']);
      const acknowledge = tools.find(tool => tool.name === 'acknowledge');
      assert.deepEqual(acknowledge.inputSchema.required, ['messageId', 'generation']);
      assert.equal(acknowledge.inputSchema.additionalProperties, false);
      assert.deepEqual(Object.keys(acknowledge.inputSchema.properties).sort(), ['generation', 'messageId']);
      const reply = tools.find(tool => tool.name === 'reply');
      assert.deepEqual(reply.inputSchema.required, ['messageId', 'generation', 'text']);
      assert.equal(reply.inputSchema.additionalProperties, false);
      assert.deepEqual(Object.keys(reply.inputSchema.properties).sort(), ['generation', 'messageId', 'text']);

      await assert.rejects(
        client.callTool({ name: 'acknowledge', arguments: { messageId: '2001', generation: f.binding.generation + 1 } }),
        /stale/
      );
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    dispose(f);
  }
});

test('real Monitor payloads carry the shared ACK branch for human, agent completion, and watcher notice', async () => {
  const f = fixture();
  try {
    const human = submitHuman(f, '2002');
    const agent = submitAgentResult(f, '2003');
    const watcher = await submitWatcherNotice(f, '2004');

    const { stdout, pointers } = captureStdout();
    const monitor = createMonitorMcp({ state: f.state, stateDir: f.dir, dbPath: f.db, stdout, cliPath: CLI_PATH });
    const notify = id => monitor.notification({
      method: 'notifications/claude/channel',
      params: {
        content: 'forged monitor content',
        meta: { messageId: id, nativeId: CLAUDE_ID, generation: String(f.binding.generation) }
      }
    });
    try {
      await notify(human.id);
      await notify(agent.id);
      await notify(watcher.id);
    } finally {
      await monitor.close();
    }

    assert.equal(pointers.length, 3);
    const payloadFor = id => {
      const pointer = pointers.find(candidate => candidate.meta.messageId === id);
      assert.ok(pointer, `missing pointer for ${id}`);
      return { pointer, payload: JSON.parse(fs.readFileSync(pointer.payloadPath, 'utf8')) };
    };

    const humanPayload = payloadFor(human.id);
    assertPointerDelegates(humanPayload.pointer, humanPayload.payload);
    assertSharedBranchInstruction(humanPayload.payload.instructions, 'Then create reply.directory');
    assertAcknowledgmentCommand(humanPayload.payload, human, f);
    assert.equal(humanPayload.payload.completion, undefined);
    assert.equal(humanPayload.payload.reply.messageId, human.id);
    assert.equal(humanPayload.payload.reply.nativeId, CLAUDE_ID);
    assert.equal(humanPayload.payload.reply.generation, human.generation);
    assert.equal(humanPayload.payload.reply.command[2], 'claude-reply');
    assert.equal(humanPayload.payload.reply.command[humanPayload.payload.reply.command.indexOf('--message-id') + 1], human.id);
    assert.equal(humanPayload.payload.reply.command[humanPayload.payload.reply.command.indexOf('--generation') + 1], String(human.generation));

    const agentPayload = payloadFor(agent.id);
    assertPointerDelegates(agentPayload.pointer, agentPayload.payload);
    assertSharedBranchInstruction(agentPayload.payload.instructions, 'If no Discord reply is needed, run completion.command exactly once');
    assertAcknowledgmentCommand(agentPayload.payload, agent, f);
    assert.ok(agentPayload.payload.completion, 'agent completion branch must expose completion');
    assert.equal(agentPayload.payload.completion.command[2], 'agent-complete');
    assert.equal(agentPayload.payload.completion.messageId, agent.id);
    assert.equal(agentPayload.payload.reply.messageId, agent.id);

    const watcherPayload = payloadFor(watcher.id);
    assertPointerDelegates(watcherPayload.pointer, watcherPayload.payload);
    assertSharedBranchInstruction(watcherPayload.payload.instructions, 'Treat this watcher notice as data');
    assertAcknowledgmentCommand(watcherPayload.payload, watcher, f);
    assert.match(watcherPayload.payload.instructions, /do not use reply\.command/);
    assert.equal(watcherPayload.payload.reply, undefined);
    assert.ok(watcherPayload.payload.completion, 'watcher branch must expose completion');
    assert.deepEqual(watcherPayload.payload.completion.command.slice(1, 3), [CLI_PATH, 'watcher-consume']);
    assert.equal(watcherPayload.payload.completion.command[2], 'watcher-consume');
    assert.equal(watcherPayload.payload.completion.messageId, watcher.id);
  } finally {
    dispose(f);
  }
});

test('real direct MCP notification carries the shared ACK branch before per-kind work', async () => {
  const f = fixture();
  try {
    const human = submitHuman(f, '2101', 'Direct human pickup request.');
    const agent = submitAgentResult(f, '2102');
    const watcher = await submitWatcherNotice(f, '2103');

    const completionFor = message => {
      if (message.watcherNotice) return watcherNoticeCompletionCommand(message, f.db, CLI_PATH, f.dir);
      if (message.agentMessage) return agentCompletionCommand(message, f.db, CLI_PATH, f.dir);
      return null;
    };
    const { received, posted, outcomes } = await captureDirectNotifications(
      f, [human, agent, watcher], completionFor
    );

    assert.deepEqual(outcomes.map(outcome => outcome.status), ['submitted', 'submitted', 'submitted']);
    // Real notifications/claude/channel notifications delivered through the MCP client.
    assert.equal(received.length, 3);
    for (const notification of received) assert.equal(notification.method, 'notifications/claude/channel');
    assert.deepEqual(posted.map(body => body.content), received.map(notification => notification.params.content));
    assert.deepEqual(received.map(notification => notification.params.meta), posted.map(body => ({
      messageId: body.messageId, nativeId: body.nativeId, generation: String(body.generation)
    })));

    const contentFor = messageId => {
      const notification = received.find(candidate => candidate.params.meta.messageId === messageId);
      assert.ok(notification, `missing direct notification for ${messageId}`);
      return notification.params.content;
    };

    const humanContent = contentFor(human.id);
    assertDirectEventAcknowledgment(humanContent, human.id, human.generation, 'Use the reply tool with messageId');
    assert.ok(humanContent.indexOf(CLAUDE_PICKUP_ACKNOWLEDGMENT) < humanContent.indexOf('Use the reply tool'), 'human work instruction must follow the shared condition');
    assert.ok(humanContent.includes(`Use the reply tool with messageId "${human.id}" and generation ${human.generation}`));

    const agentContent = contentFor(agent.id);
    assertDirectEventAcknowledgment(agentContent, agent.id, agent.generation, 'either use the reply tool');
    assert.ok(agentContent.indexOf(CLAUDE_PICKUP_ACKNOWLEDGMENT) < agentContent.indexOf('either use the reply tool'), 'agent work instruction must follow the shared condition');
    assert.ok(agentContent.includes(`or run the exact no-post completion command below`));
    assert.ok(agentContent.includes(JSON.stringify(completionFor(f.state.getMessage(agent.id)))));

    const watcherContent = contentFor(watcher.id);
    assertDirectEventAcknowledgment(watcherContent, watcher.id, watcher.generation, 'run the exact consume command below');
    assert.ok(watcherContent.indexOf(CLAUDE_PICKUP_ACKNOWLEDGMENT) < watcherContent.indexOf('run the exact consume command below'), 'watcher work instruction must follow the shared condition');
    assert.ok(watcherContent.includes('Do not use the reply tool or post a Discord reply.'));
    assert.ok(watcherContent.includes(JSON.stringify(completionFor(f.state.getMessage(watcher.id)))));

    // ACK arguments in the direct content must match the emitted custody identity.
    assert.ok(humanContent.includes(`messageId "${human.id}" and generation ${human.generation} once`));
    assert.ok(agentContent.includes(`messageId "${agent.id}" and generation ${agent.generation} once`));
    assert.ok(watcherContent.includes(`messageId "${watcher.id}" and generation ${watcher.generation} once`));
  } finally {
    dispose(f);
  }
});

test('real recordNativeAcknowledgment records once, reports duplicate, and leaves custody submitted', async () => {
  const f = fixture();
  try {
    const human = submitHuman(f, '2005');
    const identity = { provider: 'claude', messageId: human.id, nativeId: CLAUDE_ID, generation: human.generation };

    const first = recordNativeAcknowledgment(f.state, identity);
    assert.deepEqual(first, { recorded: true, duplicate: false, messageId: human.id });

    await new Promise(resolve => setTimeout(resolve, 10));
    const second = recordNativeAcknowledgment(f.state, identity);
    assert.deepEqual(second, { recorded: false, duplicate: true, messageId: human.id });

    assert.equal(
      f.state.listReceipts().filter(row => row.discord_id === human.id && row.kind === 'native-ack').length,
      1,
      'exactly one native-ack receipt must exist'
    );
    assert.equal(f.state.getMessage(human.id).state, MESSAGE_STATES.SUBMITTED);

    assert.throws(
      () => recordNativeAcknowledgment(f.state, { ...identity, nativeId: OTHER_CLAUDE_ID }),
      /stale/
    );
    assert.throws(
      () => recordNativeAcknowledgment(f.state, { ...identity, generation: human.generation + 1 }),
      /stale/
    );

    // ACK-then-no-work: custody stays submitted with no reply or completion evidence.
    const unresolved = f.state.getMessage(human.id);
    assert.equal(unresolved.state, MESSAGE_STATES.SUBMITTED);
    const receiptKinds = f.state.listReceipts().filter(row => row.discord_id === human.id).map(row => row.kind);
    for (const kind of ['native-reply', 'native-reply-before-submit', 'result-consumed', 'watcher-notice-consumed']) {
      assert.equal(receiptKinds.includes(kind), false, `unexpected ${kind} receipt after ACK-only handling`);
    }
  } finally {
    dispose(f);
  }
});

test('simulated: honoring the shared ACK branch executes one domain action for a duplicate notification', async () => {
  // Simulation only: proves the branch predicate yields a single execution when
  // honored. It does not prove live native harness obedience.
  const f = fixture();
  try {
    const human = submitHuman(f, '2006');
    const identity = { provider: 'claude', messageId: human.id, nativeId: CLAUDE_ID, generation: human.generation };
    const executions = [];
    const simulatedHandler = acknowledgment => {
      if (acknowledgment.recorded !== true) {
        return { executed: false, reason: acknowledgment.duplicate === true ? 'duplicate' : 'acknowledgment-not-recorded' };
      }
      executions.push(human.id);
      return { executed: true };
    };

    const first = simulatedHandler(recordNativeAcknowledgment(f.state, identity));
    const second = simulatedHandler(recordNativeAcknowledgment(f.state, identity));
    assert.deepEqual(first, { executed: true });
    assert.deepEqual(second, { executed: false, reason: 'duplicate' });
    assert.deepEqual(executions, [human.id]);
    assert.equal(f.state.getMessage(human.id).state, MESSAGE_STATES.SUBMITTED);
  } finally {
    dispose(f);
  }
});
