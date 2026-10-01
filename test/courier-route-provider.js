const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { encodeAgentMessage, KINDS } = require('../src/agent-message');
const { acknowledgmentCommand } = require('../src/acknowledgment');
const { agentCompletionCommand, codexPrompt, readInitialCursor, CodexProvider } = require('../src/native');
const { parseArgs, resolveCourierRoute, start } = require('../src/cli');
const {
  COURIER_OUTCOMES,
  COURIER_SOURCE_KINDS,
  MESSAGE_STATES,
  SurfaceState,
  THREAD_STATES
} = require('../src/state');
const { createSurfaceConsumer } = require('../src/discord');
const { persistGuardRefusal } = require('../src/courier-guard');
const { TOKEN, PARENT_NATIVE, SOURCE_NATIVE, COURIER_NATIVE, RECIPIENT_THREAD, WRONG_RECIPIENT_THREAD, fixture, humanMessage, interactionMessage, materializedDecisionMessage, parentPrompt, preparedInput, consumerFor } = require('./courier-route-fixture');
test('Codex courier queue uses a fixed forwarding call and exact parent payload', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-courier-provider-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calls = [];
  const provider = new CodexProvider({
    command: '/isolated/codex',
    root: path.join(dir, '.codex', 'sessions'),
    run: async (command, args, options) => {
      calls.push({ command, args, options });
      return { status: COURIER_OUTCOMES.SUBMITTED };
    }
  });
  const envelope = {
    type: 'discord-surface:courier:v1',
    attemptId: 'courier-attempt-1',
    messageId: 'parent-message-1',
    prompt: 'exact parent prompt with marker',
    route: { routeId: 'route-1', routeGeneration: 1 },
    parent: {
      guildId: '100',
      channelId: '1000',
      provider: 'codex',
      nativeId: PARENT_NATIVE,
      generation: 1
    },
    deliveryChannelId: '2000',
    sourceDestination: { guildId: '100', channelId: '2000' },
    source: { kind: 'agent', authorId: 'agent-bot' },
    packet: null,
    wire: 'exact parent prompt with marker',
    payloadHash: 'payload-hash-1',
    observerCursor: null,
    recipient: { threadId: RECIPIENT_THREAD, hostId: 'host-local' },
    courier: {
      provider: 'codex',
      nativeId: COURIER_NATIVE,
      workspace: dir,
      sessionRoot: path.join(dir, '.codex', 'sessions'),
      recipientThreadId: RECIPIENT_THREAD,
      hostId: 'host-local'
    }
  };
  const result = await provider.dispatchCourier(envelope);
  assert.equal(result.status, COURIER_OUTCOMES.SUBMITTED);
  assert.equal(calls.length, 1);
  const queuedPrompt = calls[0].args[calls[0].args.indexOf('--message') + 1];
  assert.notEqual(queuedPrompt, envelope.prompt);
  assert.match(queuedPrompt, /send_message_to_thread tool exactly once/);
  const toolInputLine = queuedPrompt.split('\n').find(line => line.startsWith('Tool input: '));
  assert.ok(toolInputLine);
  assert.deepEqual(JSON.parse(toolInputLine.slice('Tool input: '.length)), {
    threadId: RECIPIENT_THREAD,
    prompt: envelope.prompt,
    hostId: 'host-local'
  });
  const custodyLine = queuedPrompt.split('\n').find(line => line.startsWith('Courier custody: '));
  assert.ok(custodyLine);
  const custody = JSON.parse(custodyLine.slice('Courier custody: '.length));
  assert.equal(custody.payloadHash, envelope.payloadHash);
  assert.deepEqual(custody.recipient, envelope.recipient);
  assert.deepEqual(calls[0].args, ['queue', '--thread', COURIER_NATIVE, '--message', queuedPrompt, '--cd', dir]);
  assert.equal(calls[0].options.cwd, dir);
  assert.ok(calls[0].options.env.CODEX_HOME.endsWith('/.codex'));

  const mismatchedFixedIdentity = { ...envelope, recipient: { threadId: WRONG_RECIPIENT_THREAD, hostId: 'host-local' } };
  const fixedIdentityRejected = await provider.dispatchCourier(mismatchedFixedIdentity);
  assert.equal(fixedIdentityRejected.status, COURIER_OUTCOMES.NOT_SUBMITTED);
  assert.equal(calls.length, 1);

  const mismatchedParentIdentity = {
    ...envelope,
    recipient: { threadId: WRONG_RECIPIENT_THREAD, hostId: 'host-local' },
    courier: { ...envelope.courier, recipientThreadId: WRONG_RECIPIENT_THREAD }
  };
  const parentIdentityRejected = await provider.dispatchCourier(mismatchedParentIdentity);
  assert.equal(parentIdentityRejected.status, COURIER_OUTCOMES.NOT_SUBMITTED);
  assert.equal(calls.length, 1);
});
