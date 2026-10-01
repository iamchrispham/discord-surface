const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SurfaceState, MESSAGE_STATES } = require('../src/state');
const { DiscordGateway, createSurfaceConsumer } = require('../src/discord');
const {
  COMPONENT_TYPES,
  CS_COMMAND,
  DEFERRED_UPDATE_CALLBACK_TYPE,
  INTERACTION_OUTCOMES,
  SAVED_CALLBACK_CONTENT,
  decodeDecisionCustomId,
  encodeDecisionCustomId,
  parseComponentInteraction,
  parseCsInteraction,
  sendComponentCallback,
  sendInteractionCallback,
  upsertGuildCsCommand
} = require('../src/discord-interaction');
const {
  ACK,
  ACK_WAITING,
  createAcknowledgmentDelivery,
  isAcknowledgmentPending,
  recordNativeAcknowledgment
} = require('../src/acknowledgment');

const { NATIVE_ID, fixture, interaction, componentInteraction, latestDetail, callbackOutcome, acceptWithCallback, closeFixture } = require('./cs-interaction-fixture');

test('strict /cs parser and single-command guild upsert preserve command scope', async () => {
  const parsed = parseCsInteraction(interaction('parse-full', true), 'application');
  assert.equal(parsed.content, '/cs full');
  assert.equal(parsed.full, true);
  assert.equal(CS_COMMAND.type, 1);
  assert.equal(parseCsInteraction(interaction('parse-string', false, {
    options: { data: [{ name: 'full', type: 5, value: 'true' }] }
  }), 'application'), null);
  assert.equal(parseCsInteraction(interaction('parse-extra', false, {
    options: { data: [{ name: 'full', type: 5, value: true }, { name: 'other', type: 5, value: false }] }
  }), 'application'), null);
  assert.equal(parseCsInteraction(interaction('parse-dm', false, { guildId: null }), 'application'), null);

  const edited = [];
  const manager = {
    async fetch() { return [{ id: 'other-id', name: 'other' }, { id: 'user-cs-id', name: 'cs', type: 2 }, { id: 'cs-id', name: 'cs', type: 1, async edit(command) { edited.push(command); } }]; },
    async create() { throw new Error('create must not replace an existing command'); }
  };
  await upsertGuildCsCommand(manager, 'guild');
  assert.deepEqual(edited, [CS_COMMAND]);

  let created;
  await upsertGuildCsCommand({
    async fetch() { return [{ id: 'other-id', name: 'other' }]; },
    async create(command, guildId) { created = { command, guildId }; return created; }
  }, 'guild');
  assert.deepEqual(created, { command: CS_COMMAND, guildId: 'guild' });
});

test('decision button identity round-trips every supported choice without carrying answer text', () => {
  for (const presentationId of ['c-2bb89b345bb193375e39e999', 'q'.repeat(48)]) {
    for (let selectedIndex = 0; selectedIndex < 25; selectedIndex += 1) {
      const encoded = encodeDecisionCustomId(presentationId, selectedIndex);
      assert.ok(encoded.length <= 100);
      const parsed = parseComponentInteraction(componentInteraction('decision-codec', { customId: encoded }), 'application');
      assert.ok(parsed);
      assert.deepEqual(decodeDecisionCustomId(parsed.customId), { presentationId, selectedIndex });
    }
  }
});

test('decision button identity refuses malformed or coerced indices and question identities', () => {
  for (const value of [null, 0, {}, 'q', 'd::0', 'x:q:0', 'd:q:0:extra', 'd:q:25', 'd:q:-1',
    'd:q:00', 'd:q:1.0', 'd:q:1e1', 'd:q: 1', 'd:q:1\n', 'd:q\n:0', 'd:q/:0', `d:${'q'.repeat(49)}:0`]) {
    assert.equal(decodeDecisionCustomId(value), null);
  }
  for (const [qid, index] of [['q', '1'], ['q', 25], ['q', -1], ['q', 0.5], ['q', NaN],
    ['q', Infinity], [123, 0], [{ toString: () => 'q' }, 0], ['q:other', 0]]) {
    assert.throws(() => encodeDecisionCustomId(qid, index));
  }
});

test('component parser preserves source identity and opaque presentation reference', () => {
  const parsed = parseComponentInteraction(componentInteraction('component-parse'), 'application');
  assert.deepEqual(parsed, {
    id: 'component-parse',
    guildId: 'guild',
    channelId: 'channel',
    userId: 'operator',
    token: 'token-component-parse',
    applicationId: 'application',
    messageId: 'presentation-message',
    componentType: COMPONENT_TYPES.BUTTON,
    customId: 'presentation-reference',
    presentationId: 'presentation-reference'
  });
  assert.equal(parseComponentInteraction(componentInteraction('wrong-app'), 'other'), null);
  assert.equal(parseComponentInteraction(componentInteraction('missing-app', { applicationId: null }), 'application'), null);
  assert.equal(parseComponentInteraction(componentInteraction('missing-source', { message: null }), 'application'), null);
  assert.equal(parseComponentInteraction(componentInteraction('wrong-type', { componentType: 4 }), 'application'), null);
  assert.equal(parseComponentInteraction(componentInteraction('oversized-id', { customId: 'x'.repeat(101) }), 'application'), null);
});

test('parsed component identity reaches the local decision admission boundary', () => {
  const fixtureState = fixture();
  const { state } = fixtureState;
  try {
    const binding = state.getBinding('channel');
    const presentation = state.registerDecisionPresentation({
      presentationId: 'presentation-reference',
      requestId: 'decision-request',
      qid: 'question-1',
      questionGeneration: 'generation-1',
      target: 'target-a',
      guildId: 'guild',
      channelId: 'channel',
      messageId: 'presentation-message',
      binding,
      keys: ['approve']
    });
    assert.equal(presentation.created, true);
    state.recordDecisionPresentationOutcome('presentation-reference', 'sent', 'presentation-message');
    const parsed = parseComponentInteraction(componentInteraction('component-admit'), 'application');
    assert.ok(parsed);
    const input = {
      interactionId: parsed.id,
      presentationId: parsed.presentationId,
      selectedKey: 'approve',
      actorId: parsed.userId,
      guildId: parsed.guildId,
      channelId: parsed.channelId,
      messageId: parsed.messageId,
      binding
    };
    assert.equal(state.admitDecisionClickAndBeginCallback(input).accepted, true);
    for (const field of ['guildId', 'channelId', 'actorId', 'messageId']) {
      const next = { ...input, interactionId: `component-${field}`, [field]: 'wrong' };
      assert.equal(state.admitDecisionClick(next).accepted, false);
    }
    const forged = parseComponentInteraction(componentInteraction('component-forged', { customId: 'not-persisted' }), 'application');
    assert.ok(forged);
    assert.equal(state.admitDecisionClick({ ...input, interactionId: forged.id, presentationId: forged.presentationId }).accepted, false);
  } finally {
    closeFixture(fixtureState);
  }
});
