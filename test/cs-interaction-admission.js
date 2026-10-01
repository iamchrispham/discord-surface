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

test('inactive binding rejects interaction admission while active binding control succeeds', () => {
  const inactiveFixture = fixture();
  try {
    inactiveFixture.state.unbind('channel');
    const parsed = parseCsInteraction(interaction('inactive-binding'), 'application');
    const rejected = inactiveFixture.state.acceptInteraction(parsed, inactiveFixture.state.getBinding('channel'));
    assert.equal(rejected.accepted, false);
    assert.equal(rejected.reason, 'inactive-binding');
    assert.equal(inactiveFixture.state.getMessage('inactive-binding'), null);
    assert.equal(inactiveFixture.state.listReceipts().filter(row => row.discord_id === 'inactive-binding' && row.kind === 'interaction-origin').length, 0);
  } finally {
    closeFixture(inactiveFixture);
  }

  const activeFixture = fixture();
  try {
    const parsed = parseCsInteraction(interaction('active-binding'), 'application');
    const accepted = activeFixture.state.acceptInteraction(parsed, activeFixture.state.getBinding('channel'));
    assert.equal(accepted.accepted, true);
    assert.equal(activeFixture.state.getMessage('active-binding').content, '/cs');
  } finally {
    closeFixture(activeFixture);
  }
});

test('interaction admission is atomic, duplicate-safe, and outside history evidence', () => {
  const fixtureState = fixture();
  const { state } = fixtureState;
  try {
    const before = state.getIntakeWatermark('channel');
    const parsed = parseCsInteraction(interaction('custody-1'), 'application');
    const accepted = state.acceptInteraction(parsed, state.getBinding('channel'));
    assert.equal(accepted.accepted, true);
    assert.equal(state.getMessage('custody-1').content, '/cs');
    assert.equal(state.getMessage('custody-1').state, MESSAGE_STATES.ACCEPTED);
    assert.deepEqual(state.getIntakeWatermark('channel'), before);
    assert.equal(state.hasIntakeEvidence('custody-1'), false);
    assert.equal(state.listReceipts().filter(row => row.discord_id === 'custody-1' && row.kind === 'interaction-origin').length, 1);
    assert.equal(state.beginInteractionCallback('custody-1').started, true);
    state.recordInteractionCallbackOutcome('custody-1', INTERACTION_OUTCOMES.SENT, {
      responseMessageId: 'response-custody-1', visibility: 'available'
    });
    assert.equal(state.hasIntakeEvidence('custody-1'), false);
    assert.equal(state.hasIntakeEvidence('response-custody-1'), true);

    const duplicate = state.acceptInteraction(parsed, state.getBinding('channel'));
    assert.equal(duplicate.accepted, false);
    assert.equal(duplicate.duplicate, true);
    assert.equal(state.listMessages().length, 1);
    assert.equal(state.listReceipts().filter(row => row.discord_id === 'custody-1' && row.kind === 'interaction-origin').length, 1);
  } finally {
    closeFixture(fixtureState);
  }
});
