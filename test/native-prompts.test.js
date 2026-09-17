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
  messageRequestAgentRequest: '5624d5e6fdba87af22888bc4a55353456c3bd4b5115897bdd90543d2d588abdb',
  messageRequestAgentResult: 'a98c54b515af664b948fdb42d55e42073179611139b0ab1541d457ec0458f5c7',
  messageRequestDecision: '61bf6fab877b903ac62e83f33903465896b3942f3374b986da8380b5d83d469a',
  messageRequestWatcher: '778ebfecc08c0621fb1e6ee1ac96cfb417aad3576c1f1c6a55e52a47b9d32b9d',
  codexPromptHuman: '214cc1a09949c904d2144fc85a729826e661ea84f89569d5acb88c47f1088b39',
  codexPromptAttachment: '236c32b2160a03dc257ef12ec93463c79faed582466f47c54a84fb144c21b04b',
  codexPromptAgentRequest: '7854014437cc92c4993d42fee8c35853e157160f20562ba6564cbdfb65e18e13',
  codexPromptAgentResult: '7c742e49ca3f3bcb6d09f58ead922b716b40b0e914b9ff2371e4629f523a1b56',
  codexPromptDecision: 'fa9ba7f924595df3cfab549840962960ae5cc3f5fab299412dc51dc8c4ce9510',
  codexPromptWatcher: '1543b2feeb6703bad23cee4311317ac4c1c7967711796b99194b38c58f268f34',
  claudeEventHuman: 'f6f0487075495408788b080a16657ed3516d21fe2c35ec89c771bc05ca8c66a8',
  claudeEventAttachment: '2d0e0e10e2be3436b64aff319aba11368ff199760247ec9cf0c564fb1d825c29',
  claudeEventAgentRequest: '5f792f9c01b4156369cc0a2a1456d5bf5dec179f84a2825a23d8c5e344e0168b',
  claudeEventAgentResult: '8b1a686265734d581bba59397dbad23f036119a3288c02c7f5b098bdf33fb833',
  claudeEventDecision: '2c84ce456e54ba279e5119138854d2c35a92a91c6eb2952b2b4b9f34c617b148',
  claudeEventWatcher: 'a8ac1649cb028b0fadfdbf9ba04066cac0353047258a70b3fdd008138b08ae58'
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
