const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { encodeAgentMessage, KINDS } = require('../src/agent-message');
const { claudeEvent, codexPrompt } = require('../src/native');
const { DECISION_REASONS: DOMAIN_DECISION_REASONS } = require('../src/state/decision');
const {
  DECISION_NATIVE_OUTCOMES,
  DECISION_RECEIPT_KINDS,
  DECISION_REASONS: STATE_DECISION_REASONS,
  DECISION_STATES,
  DECISION_TRANSPORT_OUTCOMES,
  DECISION_WINNER_SOURCES,
  MESSAGE_STATES,
  UnresolvedWorkError,
  SurfaceState
} = require('../src/state');

const NATIVE_ID = '9caa5d21-2169-429d-918b-5f08651b5dbd';

function fixture({ guildId = 'guild', channelId = 'channel' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-decision-state-'));
  const dbPath = path.join(dir, 'surface.sqlite');
  const state = new SurfaceState(dbPath);
  state.setConfig({
    operatorId: 'operator',
    guildId,
    secretFile: path.join(dir, 'discord.secret')
  });
  state.bind({
    channelId,
    guildId,
    provider: 'codex',
    nativeId: NATIVE_ID,
    workspace: dir
  }, { intakeCutoff: '100' });
  state.setBindingReadiness(channelId, 'ready');
  return { dir, dbPath, state };
}

function closeFixture({ dir, state }) {
  try { state.close(); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

function presentation(state, overrides = {}) {
  return {
    presentationId: 'presentation-1',
    requestId: 'request-1',
    qid: 'qid-1',
    questionGeneration: 'question-generation-1',
    target: 'target-1',
    guildId: 'guild',
    channelId: 'channel',
    binding: state.getBinding('channel'),
    keys: ['approve', 'decline'],
    ...overrides
  };
}

function click(state, overrides = {}) {
  return {
    interactionId: 'interaction-1',
    presentationId: 'presentation-1',
    selectedKey: 'approve',
    actorId: 'operator',
    guildId: 'guild',
    channelId: 'channel',
    messageId: 'message-1',
    binding: state.getBinding('channel'),
    ...overrides
  };
}

function decisionInteraction(state, overrides = {}) {
  return {
    interactionId: 'decision-interaction-1',
    presentationId: 'presentation-1',
    selectedKey: 'approve',
    actorId: 'operator',
    guildId: 'guild',
    channelId: 'channel',
    questionMessageId: 'message-1',
    binding: state.getBinding('channel'),
    qid: 'qid-1',
    questionGeneration: 'question-generation-1',
    target: 'target-1',
    canonicalSource: DECISION_WINNER_SOURCES.CURRENT,
    canonicalReference: 'answer-1',
    answer: 'canonical answer',
    ...overrides
  };
}

function decisionJson(text) {
  const line = text.split('\n').find(value => value.startsWith('Decision JSON: '));
  assert.ok(line, 'decision JSON line missing');
  return JSON.parse(line.slice('Decision JSON: '.length));
}

function presented(state) {
  const registered = state.registerDecisionPresentation(presentation(state));
  assert.equal(registered.created, true);
  return state.recordDecisionPresentationOutcome(
    'presentation-1',
    DECISION_TRANSPORT_OUTCOMES.SENT,
    'message-1'
  );
}

function materializedWinner(overrides = {}) {
  return {
    qid: 'qid-1',
    questionGeneration: 'question-generation-1',
    target: 'target-1',
    source: DECISION_WINNER_SOURCES.CURRENT,
    materialized: true,
    reference: 'answer-1',
    answer: 'canonical answer',
    ...overrides
  };
}

function canonicalRoute(dir, suffix = 'one') {
  return {
    executable: path.join(dir, suffix, 'tg-canonical.mjs'),
    stateRoot: path.join(dir, suffix, 'state'),
    telegramRoot: path.join(dir, suffix, 'telegram')
  };
}

module.exports = { NATIVE_ID, fixture, closeFixture, presentation, click, decisionInteraction, decisionJson, presented, materializedWinner, canonicalRoute };
