const test = require('node:test');
const assert = require('node:assert/strict');

const { KINDS } = require('../src/agent-message');
const { DECISION_WINNER_SOURCES } = require('../src/state');
const { claudeEvent, codexPrompt, messageRequest } = require('../src/native');

const decisionResult = {
  qid: 'qid:opaque/42',
  questionGeneration: 'generation:opaque.7-9',
  target: 'discord:guild/channel?x=1',
  canonicalSource: DECISION_WINNER_SOURCES.HISTORY,
  canonicalReference: 'history://canonical/answer?ref=opaque:7',
  answer: 'promote\ncanonical "answer"',
  questionMessageId: 'question:opaque/1',
  interactionId: 'interaction:opaque/9',
  selectedKey: 'decline'
};

function baseMessage(overrides = {}) {
  return {
    id: 'transport-message-1',
    nativeId: '11111111-1111-1111-1111-111111111111',
    generation: 7,
    content: 'carrier-click-content',
    attachments: [],
    decisionResult,
    ...overrides
  };
}

function decisionJson(text) {
  const line = text.split('\n').find(value => value.startsWith('Decision JSON: '));
  assert.ok(line, 'decision JSON line missing');
  return JSON.parse(line.slice('Decision JSON: '.length));
}

test('decision request preserves canonical identity and carrier provenance', { timeout: 120_000 }, () => {
  const request = messageRequest(baseMessage());

  assert.match(request, /^Saved canonical decision continuation\./);
  assert.match(request, /Apply the saved answer only to the exact canonical question/);
  assert.match(request, /selected key records the carrier click/);
  assert.deepEqual(decisionJson(request), decisionResult);
  assert.notEqual(decisionResult.selectedKey, decisionResult.answer);
  assert.doesNotMatch(request, /carrier-click-content/);
});

test('both native vendors receive the same exact decision payload', { timeout: 120_000 }, () => {
  const message = baseMessage();
  const codex = codexPrompt(message);
  const claude = claudeEvent(message);

  assert.match(codex, /^This is a saved canonical decision continuation for native session 11111111-1111-1111-1111-111111111111\./);
  assert.match(codex, /Handle the saved canonical decision continuation using its exact identity and canonical answer\./);
  assert.match(codex, /Preserve this session\. Do not start another session/);
  assert.doesNotMatch(codex, /Answer the user request in your normal final response/);
  assert.deepEqual(decisionJson(codex), decisionResult);

  assert.match(claude.content, /^Saved canonical decision continuation transport-message-1 for native Claude session 11111111-1111-1111-1111-111111111111\./);
  assert.match(claude.content, /Preserve the exact canonical identity and answer from the decision JSON\./);
  assert.match(claude.content, /Preserve this session\. Do not start or resume another session\./);
  assert.doesNotMatch(claude.content, /^Inbound Discord message/m);
  assert.deepEqual(decisionJson(claude.content), decisionResult);
});

test('ordinary and agent messages keep their existing native routing', { timeout: 120_000 }, () => {
  const ordinary = baseMessage({ decisionResult: undefined, content: 'ordinary request' });
  assert.equal(messageRequest(ordinary), 'ordinary request');
  assert.match(codexPrompt(ordinary), /Answer the user request in your normal final response\./);
  assert.match(claudeEvent(ordinary).content, /^Inbound Discord message transport-message-1/);

  const agent = baseMessage({
    decisionResult: undefined,
    content: 'agent carrier content',
    agentMessage: {
      kind: KINDS.RESULT,
      id: 'agent-message-1',
      source: {
        guildId: '100',
        channelId: '101',
        provider: 'codex',
        nativeId: '22222222-2222-2222-2222-222222222222',
        generation: 8,
      },
      target: {
        provider: 'claude',
        nativeId: '33333333-3333-3333-3333-333333333333',
        generation: 7,
        guildId: '100',
        channelId: '102'
      },
      replyTo: 'agent-request-1',
      text: 'agent task context',
    }
  });
  assert.match(messageRequest(agent), /^Agent result agent-message-1 from codex session 22222222-2222-2222-2222-222222222222/);
  assert.match(codexPrompt(agent), /Handle the agent context in your normal final response\./);
  assert.match(claudeEvent(agent).content, /^Inbound Discord message transport-message-1/);
  assert.match(claudeEvent(agent).content, /agent task context/);
});
