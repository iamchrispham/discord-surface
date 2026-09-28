const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { SurfaceState, MESSAGE_STATES, READINESS, INTERACTION_ORIGIN, NATIVE_ACK_RECEIPT, COURIER_RECEIPT_KINDS } = require('../src/state');
const { encodeAgentMessage, decodeAgentMessage, KINDS } = require('../src/agent-message');
const { AGENT_ROUTING_VERSION } = require('../src/state/agent-routing');
const { CODEX_ID, CLAUDE_ID, SUCCESSOR_ID, fixture } = require('./surface-fixtures');

const AGENT_TOKEN = 'successor-custody-fixture-token';

function clone(value) {
  return value === null || value === undefined ? value : JSON.parse(JSON.stringify(value));
}

function conductorFixture(t, channelId) {
  const { dir, db, state } = fixture();
  const conductorId = `${channelId}-conductor`;
  state.bind({ channelId, guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir, conductorId, repoKey: 'repo:alpha' }, { intakeCutoff: '100' });
  state.setIntakeBaseline(channelId, '100', 'previous completed recovery');
  state.markIntakeBoundary(channelId, 'ready');
  const open = [state];
  t.after(() => {
    for (const instance of open) { try { instance.close(); } catch {} }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, db, state, channelId, conductorId, open, binding: state.getBinding(channelId) };
}

function acceptHuman(state, channelId, id, { content = 'human instruction', attachments = [], authorId = 'operator-1' } = {}) {
  const result = state.acceptDiscordMessage({ id, guildId: 'guild-1', channelId, authorId, isBot: false, content, attachments });
  assert.equal(result.accepted, true);
  return state.getMessage(id);
}

function handoffInput(f, overrides = {}) {
  return {
    channelId: f.channelId,
    provider: 'codex',
    conductorId: f.conductorId,
    repoKey: 'repo:alpha',
    fromNativeId: CODEX_ID,
    fromGeneration: 1,
    nativeId: SUCCESSOR_ID,
    workspace: f.dir,
    handoffId: `${f.channelId}-handoff-1`,
    intakeCutoff: '200',
    ...overrides
  };
}

function transferReceipts(state, messageId) {
  return state.listReceipts().filter(row => row.kind === 'conductor-custody-transferred' && (messageId === undefined || row.discord_id === messageId));
}

function ackReceipts(state, messageId) {
  return state.listReceipts().filter(row => row.kind === NATIVE_ACK_RECEIPT && row.discord_id === messageId);
}

function replyReceipts(state, messageId) {
  return state.listReceipts().filter(row => (row.kind === 'native-reply' || row.kind === 'native-reply-before-submit') && row.discord_id === messageId);
}

function acceptedReceipt(state, messageId) {
  return state.listReceipts().find(row => row.kind === 'accepted' && row.discord_id === messageId);
}

function assertRefusalUnchanged(f, messageId, call) {
  const bindingBefore = clone(f.state.getBinding(f.channelId));
  const messageBefore = clone(f.state.getMessage(messageId));
  assert.throws(call);
  assert.deepEqual(f.state.getBinding(f.channelId), bindingBefore);
  assert.deepEqual(f.state.getMessage(messageId), messageBefore);
  assert.equal(transferReceipts(f.state, messageId).length, 0);
}

test('refuses a default omitted carryAcceptedHuman handoff while accepted human work is unresolved', t => {
  const f = conductorFixture(t, 'custody-default-omitted');
  acceptHuman(f.state, f.channelId, '101');
  assertRefusalUnchanged(f, '101', () => f.state.handoffConductor(handoffInput(f)));
});

test('refuses a carryAcceptedHuman handoff while submitted human work is unresolved', t => {
  const f = conductorFixture(t, 'custody-submitted');
  acceptHuman(f.state, f.channelId, '101');
  assert.equal(f.state.claimDispatch('101').claimed, true);
  f.state.markSubmitted('101');
  assert.equal(f.state.getMessage('101').state, MESSAGE_STATES.SUBMITTED);
  assertRefusalUnchanged(f, '101', () => f.state.handoffConductor(handoffInput(f, { carryAcceptedHuman: true })));
});

test('refuses a carryAcceptedHuman handoff while dispatching human work is unresolved', t => {
  const f = conductorFixture(t, 'custody-dispatching');
  acceptHuman(f.state, f.channelId, '101');
  assert.equal(f.state.claimDispatch('101').claimed, true);
  assert.equal(f.state.getMessage('101').state, MESSAGE_STATES.DISPATCHING);
  assertRefusalUnchanged(f, '101', () => f.state.handoffConductor(handoffInput(f, { carryAcceptedHuman: true })));
});

test('refuses a carryAcceptedHuman handoff while uncertain human work is unresolved', t => {
  const f = conductorFixture(t, 'custody-uncertain');
  acceptHuman(f.state, f.channelId, '101');
  assert.equal(f.state.claimDispatch('101').claimed, true);
  f.state.markUncertain('101', new Error('transport outcome unknown'));
  assert.equal(f.state.getMessage('101').state, MESSAGE_STATES.UNCERTAIN);
  assertRefusalUnchanged(f, '101', () => f.state.handoffConductor(handoffInput(f, { carryAcceptedHuman: true })));
});

test('refuses a carryAcceptedHuman handoff while an accepted row carries native-ack evidence', t => {
  const f = conductorFixture(t, 'custody-native-ack');
  const message = acceptHuman(f.state, f.channelId, '101');
  f.state.receipt('101', NATIVE_ACK_RECEIPT, { provider: message.provider, nativeId: message.nativeId, generation: message.generation, source: 'fixture-native-ack' });
  assert.equal(f.state.hasNativeAcknowledgment(message), true);
  assertRefusalUnchanged(f, '101', () => f.state.handoffConductor(handoffInput(f, { carryAcceptedHuman: true })));
});

test('refuses a carryAcceptedHuman handoff while an accepted row carries a direct courier-forward-claim receipt', t => {
  const f = conductorFixture(t, 'custody-forward-claim');
  acceptHuman(f.state, f.channelId, '101');
  // Courier forward claims are only minted by the authenticated hook, so the fixture
  // writes the real persisted receipt shape directly from src/state/courier-route/forward.ts.
  f.state.receipt('101', COURIER_RECEIPT_KINDS.FORWARD_CLAIM, {
    attemptId: 'custody-forward-attempt-1',
    routeId: 'custody-forward-route-1',
    routeGeneration: 1,
    callerSessionId: CLAUDE_ID,
    recipient: { threadId: CODEX_ID, hostId: 'host-local' },
    generation: 1,
    payloadHash: 'custody-forward-payload-hash',
    toolUseId: null,
    turnId: null
  });
  assert.equal(f.state.hasCourierForwardClaim('101'), true);
  assertRefusalUnchanged(f, '101', () => f.state.handoffConductor(handoffInput(f, { carryAcceptedHuman: true })));
});

test('refuses a carryAcceptedHuman handoff while an accepted operator row carries decoded agent-message provenance', t => {
  const f = conductorFixture(t, 'custody-agent-message');
  acceptHuman(f.state, f.channelId, '101', { authorId: 'operator-1' });
  // Agent addresses are decimal Discord snowflakes, so the decoded packet carries
  // numeric route addresses independent of this fixture's symbolic binding channel.
  const target = { guildId: '900', channelId: '901', provider: 'codex', nativeId: CODEX_ID, generation: 1 };
  const packet = {
    id: 'custody-agent-packet-1',
    kind: KINDS.REQUEST,
    source: { guildId: '900', channelId: '902', provider: 'claude', nativeId: CLAUDE_ID, generation: 1 },
    target,
    replyTo: null,
    text: 'Structurally complete agent request provenance.'
  };
  const decoded = decodeAgentMessage(encodeAgentMessage(packet, AGENT_TOKEN), AGENT_TOKEN, target);
  assert.deepEqual(decoded, packet);
  f.state.receipt('101', 'agent-message', { packet: decoded, authorId: 'operator-1', routingVersion: AGENT_ROUTING_VERSION });
  assert.ok(f.state.getAgentMessage('101'));
  assertRefusalUnchanged(f, '101', () => f.state.handoffConductor(handoffInput(f, { carryAcceptedHuman: true })));
});

test('refuses a carryAcceptedHuman handoff while an accepted row carries interaction-origin provenance', t => {
  const f = conductorFixture(t, 'custody-interaction-origin');
  const accepted = f.state.acceptInteraction({ id: '101', guildId: 'guild-1', channelId: f.channelId, userId: 'operator-1', content: '/cs', full: false }, f.binding);
  assert.equal(accepted.accepted, true);
  assert.equal(f.state.isInteractionMessage('101'), true);
  assert.ok(f.state.listReceipts().some(row => row.kind === INTERACTION_ORIGIN && row.discord_id === '101'));
  assertRefusalUnchanged(f, '101', () => f.state.handoffConductor(handoffInput(f, { carryAcceptedHuman: true })));
});

test('expected red: parent accepted-human custody transfers to the successor', { todo: 'issue132 implementation pending' }, t => {
  const f = conductorFixture(t, 'successor-parent-transfer');
  const attachments = [{ url: 'https://cdn.example.test/carry.txt', filename: 'carry.txt', contentType: 'text/plain', size: 24 }];
  const message = acceptHuman(f.state, f.channelId, '101', { content: 'carry this accepted human work', attachments });
  const rowId = f.state.getMessageRowId('101');

  f.state.handoffConductor(handoffInput(f, { carryAcceptedHuman: true }));

  const binding = f.state.getBinding(f.channelId);
  assert.equal(binding.nativeId, SUCCESSOR_ID);
  assert.equal(binding.generation, 2);
  const transferred = f.state.getMessage('101');
  assert.equal(transferred.nativeId, SUCCESSOR_ID);
  assert.equal(transferred.generation, 2);
  assert.equal(transferred.state, MESSAGE_STATES.ACCEPTED);
  assert.equal(transferred.content, message.content);
  assert.deepEqual(transferred.attachments, message.attachments);
  assert.equal(transferred.createdAt, message.createdAt);
  assert.equal(f.state.getMessageRowId('101'), rowId);
  assert.equal(transferred.provider, 'codex');
  assert.equal(transferred.repoKey, 'repo:alpha');
  assert.equal(transferred.conductorId, f.conductorId);
  assert.equal(transferred.deliveryChannelId, f.channelId);
  const transfers = transferReceipts(f.state, '101');
  assert.equal(transfers.length, 1);
  const detail = JSON.parse(transfers[0].detail);
  assert.equal(detail.handoffId, `${f.channelId}-handoff-1`);
  assert.equal(detail.fromNativeId, CODEX_ID);
  assert.equal(detail.fromGeneration, 1);
  assert.equal(detail.nativeId, SUCCESSOR_ID);
  assert.equal(detail.generation, 2);
  assert.equal(ackReceipts(f.state, '101').length, 0);
  assert.equal(replyReceipts(f.state, '101').length, 0);
});

test('expected red: enrolled child accepted-human custody transfers and serves under the successor generation', { todo: 'issue132 implementation pending' }, t => {
  const f = conductorFixture(t, 'successor-child-transfer');
  const child = 'successor-child-thread';
  assert.ok(f.state.enrollThread({ threadId: child, parentChannelId: f.channelId, guildId: 'guild-1', adoptionCutoff: '100' }));
  f.state.markThreadBoundary(child, READINESS.READY, null, null, null, null);
  const message = acceptHuman(f.state, child, '105', { content: 'child accepted human work' });
  assert.equal(message.deliveryChannelId, child);
  assert.equal(message.channelId, f.channelId);
  assert.ok(BigInt(message.id) < BigInt('200'));

  f.state.handoffConductor(handoffInput(f, { carryAcceptedHuman: true }));

  const transferred = f.state.getMessage('105');
  assert.equal(transferred.deliveryChannelId, child);
  assert.equal(transferred.channelId, f.channelId);
  assert.equal(transferred.nativeId, SUCCESSOR_ID);
  assert.equal(transferred.generation, 2);

  f.state.setBindingReadiness(f.channelId, READINESS.READY);
  f.state.markThreadBoundary(child, READINESS.READY, null, null, null, null);
  assert.equal(f.state.claimDispatch('105').claimed, true);
  assert.equal(f.state.markSubmitted('105').state, MESSAGE_STATES.SUBMITTED);
  assert.throws(() => f.state.recordNativeReply({ provider: 'codex', messageId: '105', nativeId: CODEX_ID, generation: 1, text: 'stale reply' }), /stale/);
});

test('expected red: repeated handoff with one handoffId transfers custody exactly once across restart', { todo: 'issue132 implementation pending' }, t => {
  const f = conductorFixture(t, 'successor-idempotent');
  acceptHuman(f.state, f.channelId, '101');
  const input = handoffInput(f, { carryAcceptedHuman: true });
  f.state.handoffConductor(input);
  const reconciled = f.state.handoffConductor(input);
  assert.equal(reconciled.handoffReconciled, true);

  f.state.close();
  const reopened = new SurfaceState(f.db);
  f.open.push(reopened);
  const binding = reopened.getBinding(f.channelId);
  assert.equal(binding.nativeId, SUCCESSOR_ID);
  assert.equal(binding.generation, 2);
  assert.equal(transferReceipts(reopened, '101').length, 1);
  const queued = reopened.listMessages().filter(item => item.state === MESSAGE_STATES.ACCEPTED && item.nativeId === SUCCESSOR_ID);
  assert.equal(queued.length, 1);
  assert.equal(reopened.listMessages().length, 1);
});

test('expected red: transfer receipt failure rolls custody back to the predecessor', { todo: 'issue132 implementation pending' }, t => {
  const f = conductorFixture(t, 'successor-receipt-failure');
  acceptHuman(f.state, f.channelId, '101');
  const bindingBefore = clone(f.state.getBinding(f.channelId));
  const messageBefore = clone(f.state.getMessage('101'));
  const acceptedBefore = clone(acceptedReceipt(f.state, '101'));

  let injected = false;
  const original = f.state.receipt.bind(f.state);
  f.state.receipt = (discordId, kind, detail) => {
    if (kind === 'conductor-custody-transferred' && !injected) {
      injected = true;
      throw new Error('injected transfer receipt failure');
    }
    return original(discordId, kind, detail);
  };
  t.after(() => { f.state.receipt = original; });

  assert.throws(() => f.state.handoffConductor(handoffInput(f, { carryAcceptedHuman: true })));
  assert.ok(injected);
  assert.deepEqual(f.state.getBinding(f.channelId), bindingBefore);
  assert.deepEqual(f.state.getMessage('101'), messageBefore);
  assert.deepEqual(clone(acceptedReceipt(f.state, '101')), acceptedBefore);
});

test('expected red: second-connection claim after snapshot refuses the handoff atomically', { todo: 'issue132 implementation pending' }, t => {
  const f = conductorFixture(t, 'successor-claim-seam');
  acceptHuman(f.state, f.channelId, '101');
  const bindingBefore = clone(f.state.getBinding(f.channelId));
  const other = new SurfaceState(f.db);
  f.open.push(other);

  let injected = false;
  const original = f.state.transaction.bind(f.state);
  f.state.transaction = fn => {
    if (!injected) {
      injected = true;
      assert.equal(other.claimDispatch('101').claimed, true);
    }
    return original(fn);
  };
  t.after(() => { f.state.transaction = original; });

  assert.throws(() => f.state.handoffConductor(handoffInput(f, { carryAcceptedHuman: true })));
  assert.ok(injected);
  assert.deepEqual(f.state.getBinding(f.channelId), bindingBefore);
  assert.equal(f.state.getMessage('101').state, MESSAGE_STATES.DISPATCHING);
  assert.ok(f.state.listReceipts().some(row => row.kind === 'dispatching' && row.discord_id === '101'));
});

test('expected red: second-connection admission after snapshot refuses the handoff atomically', { todo: 'issue132 implementation pending' }, t => {
  const f = conductorFixture(t, 'successor-admission-seam');
  acceptHuman(f.state, f.channelId, '101');
  const bindingBefore = clone(f.state.getBinding(f.channelId));
  const other = new SurfaceState(f.db);
  f.open.push(other);

  let injected = false;
  const original = f.state.transaction.bind(f.state);
  f.state.transaction = fn => {
    if (!injected) {
      injected = true;
      const admitted = other.acceptDiscordMessage({ id: '102', guildId: 'guild-1', channelId: f.channelId, authorId: 'operator-1', isBot: false, content: 'arrived during handoff' });
      assert.equal(admitted.accepted, true);
    }
    return original(fn);
  };
  t.after(() => { f.state.transaction = original; });

  assert.throws(() => f.state.handoffConductor(handoffInput(f, { carryAcceptedHuman: true })));
  assert.ok(injected);
  assert.deepEqual(f.state.getBinding(f.channelId), bindingBefore);
  const first = f.state.getMessage('101');
  assert.equal(first.nativeId, CODEX_ID);
  assert.equal(first.generation, 1);
  const extra = f.state.getMessage('102');
  assert.ok(extra);
  assert.equal(extra.nativeId, CODEX_ID);
  assert.equal(extra.generation, 1);
  assert.equal(extra.state, MESSAGE_STATES.ACCEPTED);
});
