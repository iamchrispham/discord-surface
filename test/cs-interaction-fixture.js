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

const NATIVE_ID = '9caa5d21-2169-429d-918b-5f08651b5dbd';

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-cs-interaction-'));
  const state = new SurfaceState(path.join(dir, 'surface.sqlite'));
  state.setConfig({ operatorId: 'operator', guildId: 'guild', secretFile: path.join(dir, 'discord.secret') });
  state.bind({
    channelId: 'channel', guildId: 'guild', provider: 'codex', nativeId: NATIVE_ID, workspace: dir
  }, { intakeCutoff: '100' });
  return { dir, state };
}

function interaction(id = 'interaction-1', full = false, overrides = {}) {
  return {
    type: 2,
    id,
    applicationId: 'application',
    guildId: 'guild',
    channelId: 'channel',
    commandName: 'cs',
    token: `token-${id}`,
    user: { id: 'operator' },
    options: { data: full ? [{ name: 'full', type: 5, value: true }] : [] },
    ...overrides
  };
}

function componentInteraction(id = 'component-1', overrides = {}) {
  return {
    type: 3,
    id,
    applicationId: 'application',
    guildId: 'guild',
    channelId: 'channel',
    token: `token-${id}`,
    user: { id: 'operator' },
    message: { id: 'presentation-message' },
    componentType: COMPONENT_TYPES.BUTTON,
    customId: 'presentation-reference',
    ...overrides
  };
}

function latestDetail(state, messageId, kind) {
  const row = state.listReceipts().filter(item => item.discord_id === messageId && item.kind === kind).at(-1);
  return row ? JSON.parse(row.detail) : null;
}

function callbackOutcome(state, messageId) {
  return latestDetail(state, messageId, 'transport-receipt-outcome');
}

function acceptWithCallback(state, id = 'interaction-1', responseMessageId = 'response-1') {
  const parsed = parseCsInteraction(interaction(id), 'application');
  const accepted = state.acceptInteraction(parsed, state.getBinding('channel'));
  assert.equal(accepted.accepted, true);
  assert.equal(state.beginInteractionCallback(id).started, true);
  state.recordInteractionCallbackOutcome(id, INTERACTION_OUTCOMES.SENT, {
    responseMessageId,
    visibility: 'available'
  });
  return state.getMessage(id);
}

function closeFixture(fixtureState) {
  try { fixtureState.state.close(); } catch {}
}

module.exports = { NATIVE_ID, fixture, interaction, componentInteraction, latestDetail, callbackOutcome, acceptWithCallback, closeFixture };
