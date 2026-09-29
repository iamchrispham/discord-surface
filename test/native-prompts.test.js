const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');

const facade = require('../src/native');
const prompts = require('../dist/native/prompts.js');
const { createWatcherNotice } = require('../src/watcher-notice');
const { ENVELOPE_TYPE } = require('../dist/state/courier-route/constants.js');
const { KINDS } = require('../src/agent-message');

const source = { guildId: '100', channelId: '101', provider: 'claude', nativeId: '11111111-1111-1111-1111-111111111111', generation: 4 };
const target = { guildId: '100', channelId: '102', provider: 'claude', nativeId: '11111111-1111-1111-1111-111111111111', generation: 4 };
const watcherNotice = createWatcherNotice({
  armKey: 'arm-4',
  triggerKey: 'trigger-7',
  source,
  target,
  text: 'Review completed with a bounded refusal.'
});
const ordinary = {
  id: 'human-1',
  channelId: '102',
  guildId: '100',
  provider: 'codex',
  nativeId: '22222222-2222-2222-2222-222222222222',
  generation: 7,
  workspace: '/tmp/work',
  content: 'Inspect this request.',
  attachments: [],
  state: 'accepted'
};
const attachment = {
  ...ordinary,
  id: 'attachment-1',
  attachments: [{ url: 'https://example.com/report.png', filename: 'report.png', contentType: 'image/png', size: 42 }]
};
const agentRequest = {
  ...ordinary,
  id: 'agent-request-event',
  content: 'carrier',
  agentMessage: {
    id: 'agent-request',
    kind: KINDS.REQUEST,
    source: { guildId: '100', channelId: '101', provider: 'claude', nativeId: '33333333-3333-3333-3333-333333333333', generation: 2 },
    target: { guildId: '100', channelId: '102', provider: 'codex', nativeId: '22222222-2222-2222-2222-222222222222', generation: 7 },
    replyTo: null,
    text: 'Inspect the implementation.'
  }
};
const agentResult = {
  ...ordinary,
  id: 'agent-result-event',
  content: 'carrier',
  agentMessage: {
    id: 'agent-result',
    kind: KINDS.RESULT,
    source: { guildId: '100', channelId: '101', provider: 'claude', nativeId: '33333333-3333-3333-3333-333333333333', generation: 2 },
    target: { guildId: '100', channelId: '102', provider: 'codex', nativeId: '22222222-2222-2222-2222-222222222222', generation: 7 },
    replyTo: 'agent-request',
    text: 'Implementation is ready.'
  }
};
const decision = {
  ...ordinary,
  id: 'decision-event',
  content: 'carrier',
  decisionResult: {
    qid: 'qid:4',
    questionGeneration: 'generation:4',
    target: 'discord:100/101',
    canonicalSource: 'history',
    canonicalReference: 'history://answer/4',
    answer: 'promote',
    questionMessageId: 'question-4',
    interactionId: 'interaction-4',
    selectedKey: 'yes'
  }
};
const watcher = { ...ordinary, id: 'watcher-event', provider: 'claude', nativeId: target.nativeId, generation: target.generation, watcherNotice };
const acknowledgment = ['/usr/local/bin/node', '/tmp/cli.js', 'native-ack', '--db', '/tmp/state with spaces.sqlite', '--provider', 'codex', '--message-id', ordinary.id, '--native-id', ordinary.nativeId, '--generation', String(ordinary.generation)];
const completion = ['/usr/local/bin/node', '/tmp/cli.js', 'agent-complete', '--state-dir', '/tmp/state with spaces', '--db', '/tmp/state with spaces.sqlite', '--provider', 'codex', '--message-id', agentResult.id, '--native-id', agentResult.nativeId, '--generation', String(agentResult.generation)];
const courier = {
  type: ENVELOPE_TYPE,
  attemptId: 'attempt-4',
  messageId: 'courier-event',
  prompt: 'Forward this exact payload.',
  route: { routeId: 'route-4', routeGeneration: 1 },
  parent: { guildId: '100', channelId: '101', provider: 'codex', nativeId: '22222222-2222-2222-2222-222222222222', generation: 7 },
  deliveryChannelId: '101',
  sourceDestination: { guildId: '100', channelId: '101' },
  source: { kind: 'human', id: 'source-4' },
  packet: null,
  wire: 'wire-4',
  payloadHash: 'hash-4',
  observerCursor: null,
  recipient: { threadId: '22222222-2222-2222-2222-222222222222', hostId: 'host-4' },
  courier: { provider: 'codex', nativeId: '44444444-4444-4444-4444-444444444444', workspace: '/tmp/work', sessionRoot: null, recipientThreadId: '22222222-2222-2222-2222-222222222222', hostId: 'host-4' }
};

const expectedExports = [
  'CODEX_VALIDATION_KINDS', 'ClaudeProvider', 'CodexProvider', 'DISPATCH_STATUSES',
  'agentCompletionCommand', 'attachmentPrompt', 'claudeEvent', 'codexPrompt',
  'courierForwardingPrompt', 'dispatchAndObserve', 'finalText', 'findCodexSessionFile',
  'messageRequest', 'observeCodexReply', 'observeSubmitted', 'postUnixJson',
  'probeClaudeChannel', 'probeUnixSocket', 'readClaudeSessionIdentity',
  'readCodexSessionIdentity', 'readCodexSessionIdentityAsync', 'readInitialCursor',
  'runCodex', 'sessionRoot', 'validateClaudeSessionIdentity',
  'validateCodexSessionIdentity', 'validateCodexSessionIdentityAsync', 'waitForReply',
  'walk', 'walkAsync', 'watcherNoticeCompletionCommand'
];

const expectedDigests = {
  agentCompletionCommand: '56b96f154bb4b4d72371fb2b2dd76e553463f47e7203d1b5ae3dab80cb3eeefa',
  watcherNoticeCompletionCommand: '7163a2ff34056a8df0c7c03f28e6906bbc92c335d807c389e1448d6e797b8b4b',
  courierForwardingPrompt: '00a4064173913f094c396da42a14de9121933f57c94e752aaaa2117194b27ce3',
  attachmentPrompt: '51bed8777c238572c49865aa895a615f05842d43f194ee5f3f42b96ae0f0132e',
  messageRequestHuman: '79057b1e52d3d81405bb67993c5087743594770f62ca344e556eb223fc4c2ce2',
  messageRequestAgentRequest: '32b43ea820c9baaa1dd5f8e6ad46de267398d8b43e95f0dae7c864db65bb12b9',
  messageRequestAgentResult: '3d716e555095170db45917e68da407e44dca8ff7f16010dc86309bd0f2e1e80f',
  messageRequestDecision: '61bf6fab877b903ac62e83f33903465896b3942f3374b986da8380b5d83d469a',
  messageRequestWatcher: '778ebfecc08c0621fb1e6ee1ac96cfb417aad3576c1f1c6a55e52a47b9d32b9d',
  codexPromptHuman: '214cc1a09949c904d2144fc85a729826e661ea84f89569d5acb88c47f1088b39',
  codexPromptAttachment: '236c32b2160a03dc257ef12ec93463c79faed582466f47c54a84fb144c21b04b',
  codexPromptAgentRequest: 'f88be9cbd8f9992529e72a7837a4a4f1c4fcd9236a3d2e75bfba01a184e32de9',
  codexPromptAgentResult: 'f88215d73e2a267afba9c33a5cf2a32c814e35d31afcec3c20111245518accec',
  codexPromptDecision: 'fa9ba7f924595df3cfab549840962960ae5cc3f5fab299412dc51dc8c4ce9510',
  codexPromptWatcher: '1543b2feeb6703bad23cee4311317ac4c1c7967711796b99194b38c58f268f34',
  claudeEventHuman: '3cf57a00278c64f0f1f5e4e180189002af5e7a97584e42326741bf752c71ddcc',
  claudeEventAttachment: 'd04456537d38c4309bae542a35f13c52cbbaa2f3e83c062cec959f7a8db24f6d',
  claudeEventAgentRequest: 'ca2735d786851d9b7acdc1edef74111a7078e560c4832437d5acbef56daa6be4',
  claudeEventAgentResult: '29ca2a9e852ee48191e8065d34736c92c7f8bf735cf067b904c7e519fbd40fa5',
  claudeEventDecision: '9fa9567ee39e6e4824c584991a8dad2c5267be9c3aa282ba2021e30de868e610',
  claudeEventWatcher: '45d9fbf706942a0fd9be6523d7b8dc61dc1b059e290d9a403be2010599dd3d14'
};

function digest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value).split(process.execPath).join('<node>')).digest('hex');
}

test('native facade preserves the public export inventory', () => {
  assert.deepEqual(Object.keys(facade).sort(), expectedExports);
  for (const name of ['agentCompletionCommand', 'attachmentPrompt', 'claudeEvent', 'codexPrompt', 'courierForwardingPrompt', 'messageRequest', 'watcherNoticeCompletionCommand']) {
    assert.equal(facade[name], prompts[name], `${name} should be the facade implementation`);
  }
});

test('native presentation matches the 314de71 baseline bytes', () => {
  const values = {
    agentCompletionCommand: facade.agentCompletionCommand(agentResult, '/tmp/state.sqlite', '/tmp/cli.js', '/tmp/state'),
    watcherNoticeCompletionCommand: facade.watcherNoticeCompletionCommand(watcher, '/tmp/state.sqlite', '/tmp/cli.js', '/tmp/state'),
    courierForwardingPrompt: facade.courierForwardingPrompt(courier),
    attachmentPrompt: facade.attachmentPrompt(attachment),
    messageRequestHuman: facade.messageRequest(ordinary),
    messageRequestAgentRequest: facade.messageRequest(agentRequest),
    messageRequestAgentResult: facade.messageRequest(agentResult),
    messageRequestDecision: facade.messageRequest(decision),
    messageRequestWatcher: facade.messageRequest(watcher),
    codexPromptHuman: facade.codexPrompt(ordinary, acknowledgment),
    codexPromptAttachment: facade.codexPrompt(attachment),
    codexPromptAgentRequest: facade.codexPrompt(agentRequest, acknowledgment, completion),
    codexPromptAgentResult: facade.codexPrompt(agentResult, null, completion),
    codexPromptDecision: facade.codexPrompt(decision),
    codexPromptWatcher: facade.codexPrompt(watcher),
    claudeEventHuman: facade.claudeEvent(ordinary, null),
    claudeEventAttachment: facade.claudeEvent(attachment, null),
    claudeEventAgentRequest: facade.claudeEvent(agentRequest, completion),
    claudeEventAgentResult: facade.claudeEvent(agentResult, completion),
    claudeEventDecision: facade.claudeEvent(decision, null),
    claudeEventWatcher: facade.claudeEvent(watcher, facade.watcherNoticeCompletionCommand(watcher, '/tmp/state.sqlite', '/tmp/cli.js', '/tmp/state'))
  };
  assert.deepEqual(Object.fromEntries(Object.entries(values).map(([key, value]) => [key, digest(value)])), expectedDigests);
});

test('default completion commands resolve the packaged source CLI', () => {
  const repoRoot = path.resolve(__dirname, '..');
  const cliPath = path.join(repoRoot, 'src', 'cli.js');
  assert.equal(path.resolve(facade.agentCompletionCommand(ordinary, '/tmp/state.sqlite')[1]), cliPath);
  assert.equal(path.resolve(facade.watcherNoticeCompletionCommand(watcher, '/tmp/state.sqlite')[1]), cliPath);
});

test('agent pickup requires a correlated result while human pickup keeps replies', () => {
  const requestPrompt = facade.codexPrompt(agentRequest, acknowledgment, completion);
  const resultPrompt = facade.codexPrompt(agentResult, acknowledgment, completion);
  const humanPrompt = facade.codexPrompt(ordinary, acknowledgment);
  const directRequest = facade.claudeEvent(agentRequest, completion).content;
  const directResult = facade.claudeEvent(agentResult, completion).content;

  for (const prompt of [requestPrompt, directRequest]) {
    assert.match(prompt, /agent-send --agent-reply-to agent-request/);
    assert.match(prompt, /agent-complete/);
    assert.match(prompt, /After agent-send reports sent/);
    assert.doesNotMatch(prompt, /Choose exactly one: normal final|either use the reply tool|Use the reply tool with messageId/);
  }
  for (const prompt of [resultPrompt, directResult]) {
    assert.match(prompt, /agent-complete/);
    assert.match(prompt, /Do not send another agent packet or post an ordinary Discord reply/);
    assert.doesNotMatch(prompt, /Choose exactly one: normal final|either use the reply tool|Use the reply tool with messageId/);
  }
  assert.doesNotMatch(requestPrompt, /Final reply: start with/);
  assert.doesNotMatch(resultPrompt, /Final reply: start with/);
  assert.match(humanPrompt, /Final reply: start with/);
  assert.match(facade.claudeEvent(ordinary).content, /Use the reply tool with messageId/);
});
